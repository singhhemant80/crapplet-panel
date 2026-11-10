import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import net from "net";
import { prisma } from "../src/db";
import { saveMailConfig, generateDkimKey, clearMailCache, getMailConfig } from "../src/modules/email/mail-config";
import { htmlToText, sendTemplatedEmail, classifyError } from "../src/modules/email/mailer";
import { checkDeliverability, mergeSpf, spfLookups, type Resolver } from "../src/modules/email/deliverability";

/** Minimal SMTP server: records envelope + data; rejects nobody@… with a hard bounce. */
const received: { from: string; to: string[]; data: string; ehlo: string }[] = [];
let server: net.Server;
let port = 0;
before(async () => {
  server = net.createServer((s) => {
    let cur = { from: "", to: [] as string[], data: "", ehlo: "" };
    let inData = false;
    let buf = "";
    s.write("220 test ESMTP\r\n");
    s.on("data", (chunk) => {
      buf += chunk.toString();
      if (inData) {
        const end = buf.indexOf("\r\n.\r\n");
        if (end === -1) return;
        cur.data = buf.slice(0, end);
        buf = buf.slice(end + 5);
        inData = false;
        received.push(cur);
        cur = { from: "", to: [], data: "", ehlo: cur.ehlo };
        s.write("250 2.0.0 Ok: queued as TEST123\r\n");
      }
      let i;
      while (!inData && (i = buf.indexOf("\r\n")) !== -1) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const cmd = line.toUpperCase();
        if (cmd.startsWith("EHLO")) {
          cur.ehlo = line.slice(5);
          s.write("250-test\r\n250-AUTH PLAIN LOGIN\r\n250 8BITMIME\r\n");
        } else if (cmd.startsWith("AUTH")) s.write("235 2.7.0 Authentication successful\r\n");
        else if (cmd.startsWith("MAIL FROM")) {
          cur.from = line.match(/<([^>]*)>/)?.[1] ?? "";
          s.write("250 Ok\r\n");
        } else if (cmd.startsWith("RCPT TO")) {
          const to = line.match(/<([^>]*)>/)?.[1] ?? "";
          if (to.startsWith("nobody@")) s.write("550 5.1.1 <" + to + ">: Recipient address rejected: User unknown\r\n");
          else {
            cur.to.push(to);
            s.write("250 Ok\r\n");
          }
        } else if (cmd === "DATA") {
          inData = true;
          s.write("354 End data with <CR><LF>.<CR><LF>\r\n");
        } else if (cmd === "RSET" || cmd === "NOOP") s.write("250 Ok\r\n");
        else if (cmd === "QUIT") {
          s.write("221 Bye\r\n");
          s.end();
        } else s.write("502 Unknown\r\n");
      }
    });
    s.on("error", () => {});
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  port = (server.address() as net.AddressInfo).port;
});

const RUN = Date.now().toString(36);
after(async () => {
  await prisma.setting.deleteMany({ where: { key: "mail" } });
  await prisma.emailLog.deleteMany({ where: { to: { contains: RUN } } });
  server.close();
  await prisma.$disconnect();
});

test("plain-text part is generated from the HTML", () => {
  const t = htmlToText(`<p>Hi Asha,</p><p>Invoice <b>CC/1</b> is ready.</p><p><a href="https://x.in/pay">Pay now</a></p><ul><li>One</li></ul>`);
  assert.match(t, /Hi Asha,\n/);
  assert.match(t, /Pay now \(https:\/\/x\.in\/pay\)/);
  assert.match(t, /• One/);
  assert.doesNotMatch(t, /</);
});

test("SPF helpers merge mechanisms before 'all' and count lookups", () => {
  assert.equal(mergeSpf(undefined, ["include:zoho.in"]), "v=spf1 include:zoho.in mx ~all");
  assert.equal(mergeSpf("v=spf1 include:_spf.google.com ~all", ["include:zoho.in"]), "v=spf1 include:_spf.google.com include:zoho.in ~all");
  assert.equal(mergeSpf("v=spf1 include:zoho.in -all", ["include:zoho.in"]), "v=spf1 include:zoho.in -all");
  assert.equal(spfLookups("v=spf1 a mx include:a.com include:b.com ip4:1.2.3.4 ~all"), 4);
});

test("SMTP errors are classified: hard bounce vs temporary", () => {
  assert.deepEqual(
    (({ permanent, bounce }) => ({ permanent, bounce }))(classifyError({ responseCode: 550, response: "550 5.1.1 User unknown" })),
    { permanent: true, bounce: true },
  );
  assert.equal(classifyError({ responseCode: 421, response: "421 try later" }).permanent, false);
  assert.match(classifyError({ code: "EAUTH", response: "535 Authentication Failed" }).message, /app-specific password/);
});

function fakeDns(zone: Record<string, string[]>, extra: Partial<Resolver> = {}): Resolver {
  const nx = () => Promise.reject(Object.assign(new Error("ENOTFOUND"), { code: "ENOTFOUND" }));
  return {
    resolveTxt: (n) => (zone[n] ? Promise.resolve(zone[n].map((v) => [v])) : nx()),
    resolveMx: (n) => (zone[`MX ${n}`] ? Promise.resolve(zone[`MX ${n}`].map((e, i) => ({ exchange: e, priority: 10 * (i + 1) }))) : nx()),
    resolve4: () => nx(),
    resolveCname: () => nx(),
    reverse: () => nx(),
    ...extra,
  };
}

test("deliverability check flags missing SPF/DMARC and gives the records to add", async () => {
  const cfg = { ...(await getMailConfig()), enabled: true, preset: "zoho_in", host: "smtp.zoho.in", port: 587, security: "starttls" as const, user: "billing@shop.in", fromName: "Shop", fromEmail: "billing@shop.in", providerDkimSelector: "zmail" };
  const bad = await checkDeliverability(cfg, fakeDns({}));
  const by = Object.fromEntries(bad.checks.map((c) => [c.key, c]));
  assert.equal(by.spf.status, "error");
  assert.equal(by.spf.record?.value, "v=spf1 include:zoho.in mx ~all");
  assert.equal(by.dmarc.status, "error");
  assert.equal(by.dkim.status, "error");
  assert.equal(by.mx.status, "warn");
  assert.equal(bad.summary.verdict, "Likely to land in spam");

  const good = await checkDeliverability(
    cfg,
    fakeDns({
      "shop.in": ["v=spf1 include:zoho.in ~all", "google-site-verification=x"],
      "zmail._domainkey.shop.in": ["v=DKIM1; k=rsa; p=MIIB"],
      "_dmarc.shop.in": ["v=DMARC1; p=quarantine; rua=mailto:d@shop.in"],
      "MX shop.in": ["mx.zoho.in", "mx2.zoho.in"],
    }),
  );
  assert.deepEqual(good.checks.filter((c) => c.status !== "ok").map((c) => c.key), []);
  assert.equal(good.summary.verdict, "Ready for the inbox");

  const free = await checkDeliverability({ ...cfg, fromEmail: "crapplet@gmail.com" }, fakeDns({}));
  assert.equal(free.checks.find((c) => c.key === "from")?.status, "error");

  const twoSpf = await checkDeliverability(cfg, fakeDns({ "shop.in": ["v=spf1 include:zoho.in ~all", "v=spf1 a -all"] }));
  assert.match(twoSpf.checks.find((c) => c.key === "spf")!.detail, /2 SPF records/);
});

test("emails go out authenticated: text part, DKIM signature, own Message-ID, bounce address, EHLO name", async () => {
  const k = generateDkimKey();
  await saveMailConfig({
    enabled: true, preset: "custom", host: "127.0.0.1", port, security: "none", user: "u", pass: "p",
    fromName: "Crapplet Cloud", fromEmail: "billing@crapplet.co.in", replyTo: "support@crapplet.co.in", returnPath: "bounces@crapplet.co.in",
    dkim: { enabled: true, selector: "cc1", privateKey: k.privateKey, publicKey: k.publicKey },
  });
  clearMailCache();
  const to = `asha-${RUN}@example.com`;
  const r = await sendTemplatedEmail({ template: "auth.welcome", to, vars: { name: "Asha" } });
  assert.ok("messageId" in r);
  const m = received.at(-1)!;
  assert.equal(m.from, "bounces@crapplet.co.in");
  assert.deepEqual(m.to, [to]);
  assert.equal(m.ehlo, "crapplet.co.in");
  assert.match(m.data, /^DKIM-Signature: v=1; a=rsa-sha256; c=relaxed\/relaxed; d=crapplet\.co\.in;\s+q=dns\/txt; s=cc1;/m);
  assert.match(m.data, /^From: Crapplet Cloud <billing@crapplet\.co\.in>/m);
  assert.match(m.data, /^Reply-To: support@crapplet\.co\.in/m);
  assert.match(m.data, /^Message-ID: <[0-9a-f-]+@crapplet\.co\.in>/m);
  assert.match(m.data, /^Auto-Submitted: auto-generated/m);
  assert.match(m.data, /Content-Type: text\/plain/);
  assert.match(m.data, /Content-Type: text\/html/);
  const log = await prisma.emailLog.findFirstOrThrow({ where: { to }, orderBy: { createdAt: "desc" } });
  assert.equal(log.status, "SENT");
  assert.match(log.response ?? "", /queued as TEST123/);
  assert.equal((log.job as { template: string }).template, "auth.welcome");
});

test("hard bounces stop retries and later mail to that address is suppressed", async () => {
  const to = `nobody@${RUN}.example.com`;
  await assert.rejects(sendTemplatedEmail({ template: "auth.welcome", to, vars: { name: "X" } }), (e: Error) => e.name === "UnrecoverableError");
  assert.equal((await prisma.emailLog.findFirstOrThrow({ where: { to } })).status, "BOUNCED");
  const again = await sendTemplatedEmail({ template: "auth.welcome", to, vars: { name: "X" } });
  assert.deepEqual(again, { suppressed: true });
  assert.equal((await prisma.emailLog.findFirstOrThrow({ where: { to }, orderBy: { createdAt: "desc" } })).status, "SUPPRESSED");
});
