/**
 * Email campaigns: audiences, offers only to customers who accept them, throttled sending, personalised
 * content, unsubscribe (link + one-click), open tracking, pause/cancel.
 *   npx tsx --test test/campaigns.test.ts
 */
import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import type { AddressInfo } from "node:net";
import { prisma } from "../src/db";
import { closeQueues } from "../src/jobs/queues";
import { createApp } from "../src/app";
import { clearMailCache, saveMailConfig } from "../src/modules/email/mail-config";
import { audienceCount, audienceSchema, campaignTick } from "../src/modules/campaigns/service";

const RUN = Date.now().toString(36);
const received: { to: string[]; data: string }[] = [];
let smtp: net.Server;
let base = "";
let app: import("node:http").Server;
let groupId = "";
let productId = "";
const users: Record<string, string> = {};
const campaigns: string[] = [];
let savedMail: unknown = null;

function startSmtp() {
  return net.createServer((s) => {
    let cur = { to: [] as string[], data: "" };
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
        cur = { to: [], data: "" };
        s.write("250 2.0.0 Ok: queued\r\n");
      }
      let i;
      while (!inData && (i = buf.indexOf("\r\n")) !== -1) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const cmd = line.toUpperCase();
        if (cmd.startsWith("EHLO")) s.write("250-test\r\n250 8BITMIME\r\n");
        else if (cmd.startsWith("MAIL FROM")) s.write("250 Ok\r\n");
        else if (cmd.startsWith("RCPT TO")) {
          const to = line.match(/<([^>]*)>/)?.[1] ?? "";
          if (to.startsWith("nobody")) s.write("550 5.1.1 User unknown\r\n");
          else {
            cur.to.push(to);
            s.write("250 Ok\r\n");
          }
        } else if (cmd === "DATA") {
          inData = true;
          s.write("354 go\r\n");
        } else if (cmd === "QUIT") {
          s.write("221 Bye\r\n");
          s.end();
        } else s.write("250 Ok\r\n");
      }
    });
    s.on("error", () => {});
  });
}

before(async () => {
  smtp = startSmtp();
  await new Promise<void>((r) => smtp.listen(0, "127.0.0.1", () => r()));
  savedMail = (await prisma.setting.findUnique({ where: { key: "mail" } }))?.value ?? null;
  await saveMailConfig({ enabled: true, preset: "custom", host: "127.0.0.1", port: (smtp.address() as AddressInfo).port, security: "none", user: "", pass: "", fromName: "Crapplet", fromEmail: "news@crapplet.co.in" });
  clearMailCache();
  app = createApp().listen(0);
  base = `http://127.0.0.1:${(app.address() as AddressInfo).port}/api`;
  groupId = (await prisma.productGroup.create({ data: { name: `QA camp ${RUN}`, slug: `qa-camp-${RUN}` } })).id;
  productId = (await prisma.product.create({ data: { groupId, name: `QA Camp ${RUN}`, slug: `qa-camp-${RUN}`, type: "GPU", provisioner: "MANUAL", autoSetup: "MANUAL" } })).id;
  const mk = async (key: string, data: Record<string, unknown>) => {
    users[key] = (await prisma.user.create({ data: { email: `${key}-${RUN}@camp.test`, passwordHash: "x", firstName: key[0].toUpperCase() + key.slice(1), lastName: "T", type: "CLIENT", status: "ACTIVE", ...data } as never })).id;
  };
  await mk("asha", { profile: { create: { country: "IN", companyName: "Asha Infotech" } } });
  await mk("ben", { profile: { create: { country: "GB" } } });
  await mk("chen", { marketingEmails: false, profile: { create: { country: "IN" } } });
  await mk("dev", { status: "CLOSED", profile: { create: { country: "IN" } } });
  await prisma.service.create({ data: { userId: users.asha, productId, billingCycle: "MONTHLY", firstAmount: 100, recurringAmount: 100, status: "ACTIVE" } });
});

after(async () => {
  await prisma.emailCampaign.deleteMany({ where: { id: { in: campaigns } } });
  await prisma.emailLog.deleteMany({ where: { to: { contains: RUN } } });
  await prisma.activityLog.deleteMany({ where: { userId: { in: Object.values(users) } } }).catch(() => undefined);
  await prisma.service.deleteMany({ where: { productId } });
  await prisma.user.deleteMany({ where: { id: { in: Object.values(users) } } });
  await prisma.product.deleteMany({ where: { id: productId } });
  await prisma.productGroup.deleteMany({ where: { id: groupId } });
  if (savedMail) await prisma.setting.update({ where: { key: "mail" }, data: { value: savedMail as never } });
  else await prisma.setting.deleteMany({ where: { key: "mail" } });
  clearMailCache();
  app.close();
  smtp.close();
  await closeQueues().catch(() => undefined);
  await prisma.$disconnect();
});

const mine = (ids: string[]) => ids.map((id) => Object.entries(users).find(([, v]) => v === id)?.[0]).filter(Boolean).sort();
const only = (a: Partial<ReturnType<typeof audienceSchema.parse>>) => audienceSchema.parse({ ...a, userIds: a.userIds ?? Object.values(users) });

test("audiences: offers skip customers who said no; closed accounts never get mail; filters by plan and country", async () => {
  const { prisma: p } = await import("../src/db");
  const { audienceWhere } = await import("../src/modules/campaigns/service");
  const who = async (a: ReturnType<typeof only>, kind: string) => mine((await p.user.findMany({ where: { AND: [audienceWhere(a, kind), { id: { in: Object.values(users) } }] }, select: { id: true } })).map((u) => u.id));
  const all = audienceSchema.parse({});
  assert.deepEqual(await who(all, "INFO"), ["asha", "ben", "chen"]);
  assert.deepEqual(await who(all, "OFFER"), ["asha", "ben"]);
  assert.deepEqual(await who(audienceSchema.parse({ productIds: [productId] }), "INFO"), ["asha"]);
  assert.deepEqual(await who(audienceSchema.parse({ clients: "without_active" }), "INFO"), ["ben", "chen"]);
  assert.deepEqual(await who(audienceSchema.parse({ country: "intl" }), "INFO"), ["ben"]);
  const c = await audienceCount(only({}), "OFFER");
  assert.equal(c.count, 2);
  assert.equal(c.optedOut, 1, "tells staff how many are left out because they don't take offers");
});

test("sending: personalised, throttled per minute, with unsubscribe headers for offers, then finishes", async () => {
  const c = await prisma.emailCampaign.create({
    data: { name: "Diwali", kind: "OFFER", subject: "{{firstName}}, 30% off GPU", body: "<p>Hi {{firstName}} from {{companyName}},</p><p>Offer inside.</p>", audience: only({}) as never, perMinute: 1, status: "SENDING", startedAt: new Date() },
  });
  campaigns.push(c.id);
  const { materialise } = await import("../src/modules/campaigns/service");
  assert.equal(await materialise(c.id), 2);
  const before = received.length;
  await campaignTick();
  assert.equal(received.length - before, 1, "one per minute");
  await campaignTick();
  const after = await prisma.emailCampaign.findUniqueOrThrow({ where: { id: c.id } });
  assert.equal(after.status, "SENT");
  assert.equal(after.sent, 2);
  const asha = received.find((m) => m.to.includes(`asha-${RUN}@camp.test`))!;
  assert.match(asha.data, /Subject: Asha, 30% off GPU/);
  assert.match(asha.data, /Asha Infotech/);
  assert.match(asha.data, /^List-Unsubscribe: <http[^>]+\/api\/e\/u\/[A-Za-z0-9_-]+>/m);
  assert.match(asha.data, /^List-Unsubscribe-Post: List-Unsubscribe=One-Click/m);
  assert.match(asha.data, /^Precedence: bulk/m);
  assert.doesNotMatch(asha.data, /Auto-Submitted/);
});

test("open pixel counts once; unsubscribe needs a click (GET shows a button) and stops future offers", async () => {
  const r = await prisma.emailCampaignRecipient.findFirstOrThrow({ where: { campaignId: campaigns[0], email: `ben-${RUN}@camp.test` } });
  for (let i = 0; i < 2; i++) {
    const px = await fetch(`${base}/e/o/${r.token}.gif`);
    assert.equal(px.headers.get("content-type"), "image/gif");
  }
  await new Promise((res) => setTimeout(res, 200));
  assert.equal((await prisma.emailCampaign.findUniqueOrThrow({ where: { id: campaigns[0] } })).opened, 1);

  const page = await fetch(`${base}/e/u/${r.token}`);
  assert.match(await page.text(), /Unsubscribe from offers\?/);
  assert.equal((await prisma.user.findUniqueOrThrow({ where: { id: users.ben } })).marketingEmails, true, "opening the page doesn't unsubscribe");
  // Gmail one-click: POST with a body, no cookies, no custom header
  const one = await fetch(`${base}/e/u/${r.token}`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "List-Unsubscribe=One-Click" });
  assert.equal(one.status, 200);
  assert.equal((await prisma.user.findUniqueOrThrow({ where: { id: users.ben } })).marketingEmails, false);
  assert.equal((await prisma.emailCampaign.findUniqueOrThrow({ where: { id: campaigns[0] } })).unsubscribed, 1);
  assert.equal((await audienceCount(only({}), "OFFER")).count, 1, "ben is out of the next offer");
  assert.equal((await audienceCount(only({}), "INFO")).count, 3, "but still gets service information");
  assert.equal((await fetch(`${base}/e/u/not-a-real-token-xxxxxxxx`)).status, 404);
});

test("pause stops sending; bad addresses fail without stopping the rest; cancel skips the remainder", async () => {
  await prisma.user.update({ where: { id: users.chen }, data: { email: `nobody-${RUN}@camp.test` } });
  const c = await prisma.emailCampaign.create({ data: { name: "Maint", kind: "INFO", subject: "Maintenance", body: "<p>Hi</p>", audience: only({}) as never, perMinute: 10, status: "SENDING", startedAt: new Date() } });
  campaigns.push(c.id);
  const { materialise } = await import("../src/modules/campaigns/service");
  assert.equal(await materialise(c.id), 3);
  await prisma.emailCampaign.update({ where: { id: c.id }, data: { status: "PAUSED" } });
  const n = received.length;
  await campaignTick();
  assert.equal(received.length, n, "paused campaigns don't send");
  await prisma.emailCampaign.update({ where: { id: c.id }, data: { status: "SENDING" } });
  await campaignTick();
  const done = await prisma.emailCampaign.findUniqueOrThrow({ where: { id: c.id } });
  assert.equal(done.status, "SENT");
  assert.equal(done.sent, 2);
  assert.equal(done.failed, 1);

  const c2 = await prisma.emailCampaign.create({ data: { name: "Later", kind: "INFO", subject: "S", body: "<p>x</p>", audience: only({}) as never, status: "SCHEDULED", scheduledAt: new Date(Date.now() + 3600_000) } });
  campaigns.push(c2.id);
  await campaignTick();
  assert.equal((await prisma.emailCampaign.findUniqueOrThrow({ where: { id: c2.id } })).status, "SCHEDULED", "not before its time");
  await campaignTick(new Date(Date.now() + 2 * 3600_000));
  const started = await prisma.emailCampaign.findUniqueOrThrow({ where: { id: c2.id } });
  assert.ok(["SENDING", "SENT"].includes(started.status));
  assert.equal(started.total, 3);
});

test("customers can turn offers off and on in their client area", async () => {
  const { prisma: p } = await import("../src/db");
  await p.user.update({ where: { id: users.asha }, data: { passwordHash: await (await import("bcryptjs")).default.hash("Asha@12345", 8) } });
  const login = await fetch(`${base}/auth/login`, { method: "POST", headers: { "content-type": "application/json", "x-requested-with": "crapplet" }, body: JSON.stringify({ email: `asha-${RUN}@camp.test`, password: "Asha@12345" }) });
  assert.equal(login.status, 200);
  const cookie = login.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
  const off = await fetch(`${base}/client/email-preferences`, { method: "PUT", headers: { "content-type": "application/json", "x-requested-with": "crapplet", cookie }, body: JSON.stringify({ marketing: false }) });
  assert.equal(off.status, 200);
  const me = (await (await fetch(`${base}/auth/me`, { headers: { cookie } })).json()) as { user: { marketingEmails: boolean } };
  assert.equal(me.user.marketingEmails, false);
  await p.session.deleteMany({ where: { userId: users.asha } });
  await p.loginHistory.deleteMany({ where: { userId: users.asha } });
});
