/**
 * "Emails aren't arriving": the health check names the cause (worker down, sending off, unreadable
 * password, failures), queued emails can be sent from the page, and with no worker new emails go out directly.
 *   npx tsx --test test/email-health.test.ts
 */
import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "../src/db";
import { closeQueues, emailQueue } from "../src/jobs/queues";

const RUN = Date.now().toString(36);
let saved: unknown = null;

before(async () => {
  saved = (await prisma.setting.findUnique({ where: { key: "mail" } }))?.value ?? null;
});
after(async () => {
  for (const j of await emailQueue().getJobs(["waiting", "delayed", "prioritized", "paused", "failed"], 0, 2000, false)) if (String(j?.data?.to ?? "").includes(RUN)) await j.remove().catch(() => undefined);
  await prisma.emailLog.deleteMany({ where: { to: { contains: RUN } } });
  if (saved === null) await prisma.setting.deleteMany({ where: { key: "mail" } });
  else await prisma.setting.update({ where: { key: "mail" }, data: { value: saved as never } });
  const { clearMailCache } = await import("../src/modules/email/mail-config");
  clearMailCache();
  await closeQueues().catch(() => undefined);
  await prisma.$disconnect();
});

test("sending switched off and an unreadable password are reported", async () => {
  const { saveMailConfig, clearMailCache } = await import("../src/modules/email/mail-config");
  await saveMailConfig({ enabled: false, host: "smtp.example.test", port: 587, security: "starttls", user: "u@example.test", pass: "secret-pass", fromEmail: "billing@example.test" } as never);
  clearMailCache();
  const { emailHealth } = await import("../src/modules/email/health");
  let h = await emailHealth();
  assert.equal(h.ok, false);
  assert.ok(h.problems.some((p) => p.title === "Sending is switched off"));
  assert.equal(h.config.passwordSaved, true);

  // a password saved with another ENCRYPTION_KEY can't be decrypted
  const row = await prisma.setting.findUniqueOrThrow({ where: { key: "mail" } });
  await prisma.setting.update({ where: { key: "mail" }, data: { value: { ...(row.value as object), enabled: true, passEnc: "v1:garbage:notdecryptable" } as never } });
  clearMailCache();
  h = await emailHealth();
  assert.ok(h.problems.some((p) => p.title === "The saved SMTP password can't be read"), JSON.stringify(h.problems));
  assert.equal(h.config.passwordUnreadable, true);
});

test("waiting emails with no worker: reported, and 'send now' sends them (logged)", async () => {
  const { saveMailConfig, clearMailCache } = await import("../src/modules/email/mail-config");
  await saveMailConfig({ enabled: false, host: "", fromEmail: "billing@example.test" } as never); // log-only, so nothing leaves the test
  clearMailCache();
  const { queueEmail } = await import("../src/modules/email/mailer");
  await queueEmail("auth.verify_email", `eh-${RUN}@t.test`, { name: "A", link: "https://x/verify?t=1" });
  const { emailHealth, sendWaitingNow } = await import("../src/modules/email/health");
  const h = await emailHealth();
  assert.ok(h.queue.waiting >= 1);
  if (h.queue.workers === 0) assert.ok(h.problems.some((p) => p.title.startsWith("The email worker isn't running")), JSON.stringify(h.problems));
  const r = await sendWaitingNow(5000);
  assert.ok(r.sent >= 1);
  const log = await prisma.emailLog.findFirst({ where: { to: `eh-${RUN}@t.test` } });
  assert.equal(log?.status, "LOGGED");
});

test("with no worker connected, a new email is sent directly instead of waiting", async () => {
  const { emailWorkers } = await import("../src/modules/email/health");
  if ((await emailWorkers()) !== 0) return; // a worker is running on this machine — nothing to prove
  process.env.MAIL_DIRECT_IF_NO_WORKER = "1";
  const { queueEmail } = await import("../src/modules/email/mailer");
  await queueEmail("auth.verify_email", `eh2-${RUN}@t.test`, { name: "B", link: "https://x/verify?t=2" });
  delete process.env.MAIL_DIRECT_IF_NO_WORKER;
  for (let i = 0; i < 20 && !(await prisma.emailLog.findFirst({ where: { to: `eh2-${RUN}@t.test` } })); i++) await new Promise((r) => setTimeout(r, 150));
  assert.ok(await prisma.emailLog.findFirst({ where: { to: `eh2-${RUN}@t.test` } }), "sent (logged) right away");
  const jobs = await emailQueue().getJobs(["waiting"], 0, 2000, false);
  assert.ok(!jobs.some((j) => j?.data?.to === `eh2-${RUN}@t.test`), "not left in the queue");
});
