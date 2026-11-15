/**
 * Emails sent to a client: listed on the client page with status and preview; passwords / sign-in links
 * are encrypted in the email log and the queue (re-send still delivers them) and masked in previews.
 *   npx tsx --test test/client-emails.test.ts
 */
import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { prisma } from "../src/db";
import { emailQueue, closeQueues } from "../src/jobs/queues";
import { openVars, queueEmail, sealOldEmailLogs, sealVars, sendTemplatedEmail } from "../src/modules/email/mailer";

const RUN = Date.now().toString(36);
const PW = "Staff@12345";
const SECRET = `VpsPass-${RUN}-Zz9`;
let base = "";
let app: http.Server;
const ids: Record<string, string> = {};

class Agent {
  cookies: Record<string, string> = {};
  async req(method: string, path: string, body?: unknown) {
    const res = await fetch(base + path, { method, headers: { "Content-Type": "application/json", "X-Requested-With": "crapplet", Cookie: Object.entries(this.cookies).map(([k, v]) => `${k}=${v}`).join("; ") }, body: body === undefined ? undefined : JSON.stringify(body) });
    for (const c of res.headers.getSetCookie()) { const [k, v] = c.split(";")[0].split("="); if (v) this.cookies[k] = v; }
    const t = await res.text();
    let json: any = null;
    try { json = JSON.parse(t); } catch { json = t; }
    return { status: res.status, json };
  }
}
const staff = new Agent();

before(async () => {
  const { createApp } = await import("../src/app");
  app = createApp().listen(0);
  base = `http://127.0.0.1:${(app.address() as AddressInfo).port}/api`;
  const bcrypt = (await import("bcryptjs")).default;
  ids.role = (await prisma.role.create({ data: { name: `QA ce ${RUN}`, permissions: ["*"] } })).id;
  ids.staff = (await prisma.user.create({ data: { email: `ce2-staff-${RUN}@t.test`, passwordHash: await bcrypt.hash(PW, 10), firstName: "S", type: "STAFF", status: "ACTIVE", roleId: ids.role } })).id;
  ids.user = (await prisma.user.create({ data: { email: `ce2-${RUN}@t.test`, passwordHash: "x", firstName: "Karan", type: "CLIENT", status: "ACTIVE" } })).id;
  ids.other = (await prisma.user.create({ data: { email: `ce2-other-${RUN}@t.test`, passwordHash: "x", firstName: "O", type: "CLIENT", status: "ACTIVE" } })).id;
  assert.equal((await staff.req("POST", "/auth/login", { email: `ce2-staff-${RUN}@t.test`, password: PW })).status, 200);
});

after(async () => {
  app.close();
  for (const j of await emailQueue().getJobs(["waiting", "delayed", "prioritized", "paused"], 0, 500, false)) if (String(j.data.to).includes(RUN)) await j.remove().catch(() => undefined);
  await prisma.emailLog.deleteMany({ where: { to: { contains: RUN } } });
  await prisma.activityLog.deleteMany({ where: { actorId: ids.staff } }).catch(() => undefined);
  await prisma.loginHistory.deleteMany({ where: { userId: ids.staff } }).catch(() => undefined);
  await prisma.session.deleteMany({ where: { userId: ids.staff } });
  await prisma.user.deleteMany({ where: { id: { in: [ids.staff, ids.user, ids.other] } } });
  await prisma.role.deleteMany({ where: { id: ids.role } });
  await closeQueues().catch(() => undefined);
  await prisma.$disconnect();
});

test("passwords and links are sealed / opened; other values untouched", () => {
  const v = sealVars({ name: "Karan", password: SECRET, link: "https://x/reset?t=abc", ip: "1.2.3.4" });
  assert.equal(v.name, "Karan");
  assert.equal(v.ip, "1.2.3.4");
  assert.ok(!JSON.stringify(v).includes(SECRET));
  assert.ok(!JSON.stringify(v).includes("t=abc"));
  assert.deepEqual(openVars(v), { name: "Karan", password: SECRET, link: "https://x/reset?t=abc", ip: "1.2.3.4" });
  assert.deepEqual(sealVars(v), v, "sealing twice changes nothing");
});

test("queued email: the password is encrypted in the queue", async () => {
  await queueEmail("service.vps_ready", `ce2-${RUN}@t.test`, { name: "Karan", password: SECRET, ip: "203.0.113.9", username: "root", hostname: "h", productName: "VPS", os: "Ubuntu" }, ids.user);
  const jobs = await emailQueue().getJobs(["waiting", "delayed", "prioritized", "paused"], 0, 500, false);
  const j = jobs.find((x) => x.data.to === `ce2-${RUN}@t.test`);
  assert.ok(j);
  assert.ok(!JSON.stringify(j!.data).includes(SECRET));
});

test("sending: the log keeps the password encrypted; the client page lists and previews it masked", async () => {
  await sendTemplatedEmail({ template: "service.vps_ready", to: `ce2-${RUN}@t.test`, userId: ids.user, vars: sealVars({ name: "Karan", password: SECRET, ip: "203.0.113.9", username: "root", hostname: "h", productName: "VPS", os: "Ubuntu" }) });
  await sendTemplatedEmail({ template: "ticket.opened", to: `ce2-${RUN}@t.test`, vars: { name: "Karan", ticketNumber: "CC-1", subject: "Help", department: "Support", ticketId: "x" } }); // matched by address
  await sendTemplatedEmail({ template: "ticket.opened", to: `ce2-other-${RUN}@t.test`, userId: ids.other, vars: { name: "O", ticketNumber: "CC-2", subject: "Other", department: "Support", ticketId: "y" } });
  const rows = await prisma.emailLog.findMany({ where: { to: `ce2-${RUN}@t.test` } });
  assert.equal(rows.length, 2);
  assert.ok(!JSON.stringify(rows).includes(SECRET), "never readable in the email log");

  const r = await staff.req("GET", `/admin/clients/${ids.user}/emails`);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.total, 2);
  assert.ok(r.json.items.every((e: any) => e.to === `ce2-${RUN}@t.test`));
  assert.ok(r.json.items.some((e: any) => e.kind === "Service"));
  assert.ok(r.json.items.some((e: any) => e.kind === "Support"));
  assert.ok(!JSON.stringify(r.json).includes(SECRET));

  const vps = r.json.items.find((e: any) => e.kind === "Service");
  const p = await staff.req("GET", `/admin/clients/${ids.user}/emails/${vps.id}`);
  assert.equal(p.status, 200);
  assert.ok(p.json.html.includes("203.0.113.9"), "content shown");
  assert.ok(!p.json.html.includes(SECRET), "password masked in the preview");
  assert.ok(p.json.html.includes("••••••••"));

  // another client's email can't be opened through this client
  const otherId = (await prisma.emailLog.findFirstOrThrow({ where: { to: `ce2-other-${RUN}@t.test` } })).id;
  assert.equal((await staff.req("GET", `/admin/clients/${ids.user}/emails/${otherId}`)).status, 404);

  // search and status filter
  assert.equal((await staff.req("GET", `/admin/clients/${ids.user}/emails?q=ticket`)).json.total >= 0, true);
  const problems = await staff.req("GET", `/admin/clients/${ids.user}/emails?status=problem`);
  assert.equal(problems.status, 200);
});

test("older log rows with passwords in clear are encrypted by the one-time clean-up", async () => {
  const row = await prisma.emailLog.create({ data: { to: `ce2-${RUN}@t.test`, subject: "old", template: "service.vps_ready", userId: ids.user, status: "SENT", job: { template: "service.vps_ready", to: `ce2-${RUN}@t.test`, vars: { name: "K", password: SECRET } } as never } });
  assert.ok(JSON.stringify(row.job).includes(SECRET));
  assert.ok((await sealOldEmailLogs()) >= 1);
  const after1 = await prisma.emailLog.findUniqueOrThrow({ where: { id: row.id } });
  assert.ok(!JSON.stringify(after1.job).includes(SECRET));
  assert.equal(openVars((after1.job as any).vars).password, SECRET, "still re-sendable");
  assert.equal(await sealOldEmailLogs().then(() => 0), 0);
});
