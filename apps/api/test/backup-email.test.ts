/**
 * Backups: several times a day / every N hours, and the encrypted email copy
 * (sent to a local fake mail server, database-only when too big, unlocked again on upload).
 *   npx tsx --test test/backup-email.test.ts
 */
import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "crapplet-backup-email-test-"));
process.env.BACKUP_DIR = DIR;

const { prisma } = await import("../src/db");
const { closeQueues } = await import("../src/jobs/queues");
const svc = await import("../src/modules/backup/service");
const restore = await import("../src/modules/backup/restore");
const { saveMailConfig, getMailConfig } = await import("../src/modules/email/mail-config");

const PASS = "correct horse battery staple";
const RUN = Date.now().toString(36);
const TO = `backups-${RUN}@t.test`;

// ── a tiny SMTP server that keeps every message it receives ──
const received: { to: string[]; data: string }[] = [];
let smtp: net.Server;
let savedBackup: unknown;
let savedMail: unknown;

before(async () => {
  smtp = net.createServer((sock) => {
    let to: string[] = [];
    let buf = "";
    let inData = false;
    sock.write("220 fake ESMTP\r\n");
    sock.on("data", (chunk) => {
      buf += chunk.toString("latin1");
      for (;;) {
        if (inData) {
          const end = buf.indexOf("\r\n.\r\n");
          if (end < 0) return;
          received.push({ to, data: buf.slice(0, end) });
          buf = buf.slice(end + 5);
          inData = false;
          to = [];
          sock.write("250 OK queued\r\n");
          continue;
        }
        const nl = buf.indexOf("\r\n");
        if (nl < 0) return;
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 2);
        const cmd = line.slice(0, 4).toUpperCase();
        if (cmd === "EHLO" || cmd === "HELO") sock.write("250-fake\r\n250 SIZE 100000000\r\n");
        else if (cmd === "MAIL") sock.write("250 OK\r\n");
        else if (cmd === "RCPT") (to.push(line.replace(/^.*<|>.*$/g, "")), sock.write("250 OK\r\n"));
        else if (cmd === "DATA") (inData = true, sock.write("354 go\r\n"));
        else if (cmd === "QUIT") (sock.write("221 bye\r\n"), sock.end());
        else sock.write("250 OK\r\n");
      }
    });
    sock.on("error", () => undefined);
  });
  await new Promise<void>((r) => smtp.listen(0, "127.0.0.1", () => r()));
  savedBackup = (await prisma.setting.findUnique({ where: { key: "backup" } }))?.value ?? null;
  savedMail = (await prisma.setting.findUnique({ where: { key: "mail" } }))?.value ?? null;
  const cur = await getMailConfig();
  await saveMailConfig({ ...cur, enabled: true, host: "127.0.0.1", port: (smtp.address() as net.AddressInfo).port, security: "none", user: "", fromEmail: "panel@crapplet.test", fromName: "Panel", dkim: { ...cur.dkim, enabled: false } });
});

after(async () => {
  const put = async (key: string, v: unknown) => (v ? prisma.setting.update({ where: { key }, data: { value: v as never } }) : prisma.setting.deleteMany({ where: { key } }));
  await put("backup", savedBackup);
  await put("mail", savedMail);
  await prisma.emailLog.deleteMany({ where: { to: TO } });
  await prisma.backupRun.deleteMany({ where: { fileName: { in: fs.readdirSync(DIR) } } });
  fs.rmSync(DIR, { recursive: true, force: true });
  smtp.close();
  await closeQueues().catch(() => undefined);
  await prisma.$disconnect();
});

const ist = (h: number, m = 0, dayOffset = 0) => {
  const base = new Date("2026-11-15T00:00:00+05:30").getTime();
  return new Date(base + dayOffset * 86400_000 + (h * 60 + m) * 60_000);
};
const hm = (d: Date | null) => {
  const x = new Date(d!.getTime() + 330 * 60_000);
  return `${x.getUTCDate()} ${String(x.getUTCHours()).padStart(2, "0")}:${String(x.getUTCMinutes()).padStart(2, "0")}`;
};

test("times are cleaned up: padded, sorted, de-duplicated, junk dropped, max 24", () => {
  assert.deepEqual(svc.normTimes(["15:00", "3:05", "15:00", "25:00", "x", " 09:30 "]), ["03:05", "09:30", "15:00"]);
  assert.equal(svc.normTimes(Array.from({ length: 30 }, (_, i) => `${i % 24}:${String(i).padStart(2, "0")}`)).length, 24);
});

test("several times a day: next slot, a missed slot runs once, then the next one", () => {
  const c = { enabled: true, frequency: "times" as const, runAt: "03:00", times: ["03:00", "09:00", "15:00", "21:00"], weekday: 0 };
  // done at 09:02 → next 15:00 the same day
  assert.equal(hm(svc.nextSlot(c, { startedAt: ist(9, 2) }, ist(10))), "15 15:00");
  // at 15:03 the 15:00 slot isn't done yet → due (15:00)
  const due = svc.nextSlot(c, { startedAt: ist(9, 2) }, ist(15, 3))!;
  assert.ok(due <= ist(15, 3));
  // after the late-evening one → 03:00 tomorrow
  assert.equal(hm(svc.nextSlot(c, { startedAt: ist(21, 4) }, ist(23))), "16 03:00");
  // server was off all afternoon: one catch-up for the latest slot only, not one per missed slot
  assert.equal(hm(svc.nextSlot(c, { startedAt: ist(9, 2) }, ist(22))), "15 21:00");
  assert.equal(hm(svc.nextSlot(c, { startedAt: ist(22, 1) }, ist(22, 6))), "16 03:00");
  // a run that started slightly early (clock skew) still counts for that slot
  assert.equal(hm(svc.nextSlot(c, { startedAt: ist(14, 59) }, ist(15, 4))), "15 21:00");
  assert.equal(svc.nextSlot({ ...c, enabled: false }, null, ist(10)), null);
});

test("every 1 / 2 / 3 / 4 hours", () => {
  for (const [f, h] of [["every1h", 1], ["every2h", 2], ["every3h", 3], ["every4h", 4]] as const) {
    const n = svc.nextSlot({ enabled: true, frequency: f, runAt: "03:00", times: [], weekday: 0 }, { startedAt: ist(10) }, ist(10, 30));
    assert.equal(n!.getTime(), ist(10).getTime() + h * 3600_000, f);
  }
});

test("encryption round-trip; the wrong passphrase is refused clearly", async () => {
  const src = path.join(DIR, "plain.txt");
  fs.writeFileSync(src, "hello backup");
  await svc.encryptFile(src, `${src}.enc`, PASS);
  assert.notEqual(fs.readFileSync(`${src}.enc`).toString(), "hello backup");
  await svc.decryptFile(`${src}.enc`, `${src}.out`, PASS);
  assert.equal(fs.readFileSync(`${src}.out`, "utf8"), "hello backup");
  await assert.rejects(svc.decryptFile(`${src}.enc`, `${src}.bad`, "wrong passphrase!"), /passphrase doesn't match/);
  assert.ok(!fs.existsSync(`${src}.bad`));
  for (const f of ["plain.txt", "plain.txt.enc", "plain.txt.out"]) fs.rmSync(path.join(DIR, f), { force: true });
});

test("the passphrase is stored encrypted and never returned", async () => {
  await svc.saveBackupConfig({ email: { enabled: true, to: TO, maxMb: 18 }, secrets: { emailPassphrase: PASS } } as never);
  const row = await prisma.setting.findUniqueOrThrow({ where: { key: "backup" } });
  assert.ok(!JSON.stringify(row.value).includes(PASS));
  const red = svc.redactBackup(await svc.getBackupConfig());
  assert.ok(!JSON.stringify(red).includes(PASS));
  assert.equal(red.saved.emailPassphrase, true);
});

test("each backup is emailed encrypted; it can be decrypted and restored from upload", async () => {
  received.length = 0;
  await svc.saveBackupConfig({ destination: { type: "none" }, includeUploads: false, email: { enabled: true, to: TO, maxMb: 50 } } as never);
  const run = await svc.createBackup({ trigger: "manual" });
  assert.equal(run.status, "COMPLETED");
  assert.equal(run.error, null);
  const d = (run.destinations as { type: string; ok: boolean; location?: string }[]).find((x) => x.type === "email");
  assert.ok(d?.ok, JSON.stringify(run.destinations));
  assert.match(d!.location!, new RegExp(`emailed to ${TO}`));
  assert.equal(received.length, 1);
  assert.deepEqual(received[0].to, [TO]);
  const mail = received[0].data;
  assert.match(mail, /filename="?crapplet-backup-\d{8}-\d{4,6}\.tar\.enc"?/);
  assert.match(mail, /openssl enc -d -aes-256-cbc/);
  assert.doesNotMatch(mail, new RegExp(PASS), "passphrase never in the email");

  // take the attachment out of the MIME message and check it decrypts into a real backup
  const part = mail.split(/\r?\n--/).find((p) => /\.tar\.enc/.test(p) && /base64/i.test(p))!;
  const b64 = part.split(/\r?\n\r?\n/).slice(1).join("").replace(/\s+/g, "");
  const enc = path.join(DIR, "from-mail.tar.enc");
  fs.writeFileSync(enc, Buffer.from(b64, "base64"));
  await svc.decryptFile(enc, path.join(DIR, "from-mail.tar"), PASS);
  const list = execFileSync("tar", ["-tf", path.join(DIR, "from-mail.tar")]).toString();
  assert.match(list, /db\.dump/);
  fs.rmSync(path.join(DIR, "from-mail.tar"), { force: true });

  // upload the .enc on the restore page → unlocked with the saved passphrase and listed
  const size = fs.statSync(enc).size;
  const up = await restore.startUpload("crapplet-backup-from-email.tar.enc", size, "test");
  await restore.uploadChunk(up.id, 0, fs.readFileSync(enc));
  const done = await restore.finishUpload(up.id);
  assert.equal(done.row.status, "COMPLETED");
  assert.ok(fs.existsSync(path.join(DIR, done.row.fileName!)));
  fs.rmSync(enc, { force: true });
});

test("over the size limit: the database alone is emailed; email failures don't lose the backup", async () => {
  received.length = 0;
  // make the full archive big with an uploads folder of random data
  const { config } = await import("../src/config");
  const big = path.join(path.resolve(config.uploadDir), `qa-big-${RUN}.bin`);
  fs.mkdirSync(path.dirname(big), { recursive: true });
  fs.writeFileSync(big, Buffer.alloc(14 * 1024 * 1024, 1).map(() => Math.floor(Math.random() * 256)));
  try {
    // limit between the database dump (grows with the test database) and the full archive
    await svc.saveBackupConfig({ includeUploads: true, email: { enabled: true, to: TO, maxMb: 10 } } as never);
    const run = await svc.createBackup({ trigger: "manual" });
    const d = (run.destinations as { type: string; ok: boolean; location?: string }[]).find((x) => x.type === "email")!;
    assert.ok(d.ok, JSON.stringify(run.destinations));
    assert.match(d.location!, /database only/);
    assert.match(received[0].data, /-database\.tar\.enc/);
    assert.match(received[0].data, /database only/);
  } finally {
    fs.rmSync(big, { force: true });
  }

  // mail server down → backup still saved, the run says the email copy failed
  await saveMailConfig({ port: 1 });
  await svc.saveBackupConfig({ includeUploads: false, email: { enabled: true, to: TO, maxMb: 50 } } as never);
  const r2 = await svc.createBackup({ trigger: "manual" });
  assert.equal(r2.status, "COMPLETED");
  assert.match(r2.error ?? "", /the email copy failed/);
  assert.ok(fs.existsSync(path.join(DIR, r2.fileName!)));
  await saveMailConfig({ port: (smtp.address() as net.AddressInfo).port });
});

test("send test: a small encrypted file reaches the address", async () => {
  received.length = 0;
  const msg = await svc.testEmailBackup();
  assert.match(msg, new RegExp(`Test sent to ${TO}`));
  assert.match(received[0].data, /crapplet-backup-test\.txt\.enc/);
});
