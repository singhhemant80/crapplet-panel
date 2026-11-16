/**
 * Bulk reminders: verification links to many customers, "pay to restore" for suspended services,
 * and order reminders (unpaid invoice / suspended service). Reseller customers are never emailed.
 *   npx tsx --test test/reminders.test.ts
 */
import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { prisma } from "../src/db";
import { emailQueue, closeQueues } from "../src/jobs/queues";

const RUN = Date.now().toString(36);
const PW = "Staff@12345";
const DAY = 86400_000;
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
const jobsTo = async (to: string, template?: string) => (await emailQueue().getJobs(["waiting", "delayed", "prioritized", "paused"], 0, 2000, false)).filter((j) => j.data.to === to && (!template || j.data.template === template));
const client = (k: string, extra: Record<string, unknown> = {}) => prisma.user.create({ data: { email: `rm-${k}-${RUN}@t.test`, passwordHash: "x", firstName: k, type: "CLIENT", status: "ACTIVE", ...extra } }).then((u) => u.id);
const service = (userId: string, status: string, extra: Record<string, unknown> = {}) =>
  prisma.service.create({ data: { userId, productId: ids.product, status: status as never, hostname: `rm-${RUN}.test`, billingCycle: "MONTHLY", firstAmount: 50000, recurringAmount: 50000, currency: "INR", nextDueDate: new Date(Date.now() - 3 * DAY), ...extra } }).then((s) => s.id);
async function invoiceFor(userId: string, serviceId: string | null, total: number) {
  const { createInvoice } = await import("../src/modules/billing/invoices");
  return prisma.$transaction((tx) => createInvoice(tx, { userId, items: [{ type: "SERVICE", relId: serviceId ?? undefined, description: "VPS renewal", unitPrice: total, taxable: false }] }));
}

before(async () => {
  const { createApp } = await import("../src/app");
  app = createApp().listen(0);
  base = `http://127.0.0.1:${(app.address() as AddressInfo).port}/api`;
  const bcrypt = (await import("bcryptjs")).default;
  ids.role = (await prisma.role.create({ data: { name: `QA rm ${RUN}`, permissions: ["*"] } })).id;
  ids.staff = (await prisma.user.create({ data: { email: `rm-staff-${RUN}@t.test`, passwordHash: await bcrypt.hash(PW, 10), firstName: "S", type: "STAFF", status: "ACTIVE", roleId: ids.role } })).id;
  ids.a = await client("a");
  ids.b = await client("b");
  ids.ok = await client("ok", { emailVerifiedAt: new Date() });
  ids.closed = await client("closed", { status: "CLOSED" });
  ids.rsUser = await client("rs");
  ids.reseller = (await prisma.reseller.create({ data: { userId: ids.rsUser, brandName: `RS ${RUN}`, status: "APPROVED" } })).id;
  ids.end = await client("end", { ownerResellerId: ids.reseller });
  ids.group = (await prisma.productGroup.create({ data: { name: `QA RM ${RUN}`, slug: `qa-rm-${RUN}` } })).id;
  ids.product = (await prisma.product.create({ data: { groupId: ids.group, name: `RM VPS ${RUN}`, slug: `qa-rm-${RUN}`, type: "VPS_LINUX", provisioner: "MANUAL", autoSetup: "MANUAL", taxable: false, pricing: { create: [{ currency: "INR", cycle: "MONTHLY", price: 50000 }] } } })).id;
  assert.equal((await staff.req("POST", "/auth/login", { email: `rm-staff-${RUN}@t.test`, password: PW })).status, 200);
});

after(async () => {
  app.close();
  for (const j of await emailQueue().getJobs(["waiting", "delayed", "prioritized", "paused"], 0, 2000, false)) if (String(j.data.to).includes(RUN)) await j.remove().catch(() => undefined);
  const users = [ids.a, ids.b, ids.ok, ids.closed, ids.end, ids.rsUser].filter(Boolean);
  await prisma.verificationToken.deleteMany({ where: { userId: { in: users } } });
  await prisma.order.deleteMany({ where: { userId: { in: users } } });
  await prisma.invoiceItem.deleteMany({ where: { invoice: { userId: { in: users } } } });
  await prisma.invoice.deleteMany({ where: { userId: { in: users } } });
  await prisma.service.deleteMany({ where: { userId: { in: users } } });
  await prisma.product.deleteMany({ where: { id: ids.product } });
  await prisma.productGroup.deleteMany({ where: { id: ids.group } });
  await prisma.activityLog.deleteMany({ where: { actorId: ids.staff } }).catch(() => undefined);
  await prisma.loginHistory.deleteMany({ where: { userId: ids.staff } }).catch(() => undefined);
  await prisma.session.deleteMany({ where: { userId: ids.staff } });
  await prisma.user.deleteMany({ where: { id: ids.end } });
  await prisma.reseller.deleteMany({ where: { id: ids.reseller } });
  await prisma.user.deleteMany({ where: { id: { in: [...users, ids.staff] } } });
  await prisma.role.deleteMany({ where: { id: ids.role } });
  await closeQueues().catch(() => undefined);
  await prisma.$disconnect();
});

test("verification links to selected customers; the wrong ones are skipped with a reason", async () => {
  const r = await staff.req("POST", "/admin/reminders/verification", { ids: [ids.a, ids.b, ids.ok, ids.closed, ids.end] });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.sent, 2);
  assert.equal(r.json.skipped, 3);
  assert.equal(r.json.reasons["Already verified"], 1);
  assert.equal(r.json.reasons["Account closed"], 1);
  assert.equal(r.json.reasons["Reseller's customer — not emailed by us"], 1);
  assert.equal((await jobsTo(`rm-a-${RUN}@t.test`, "auth.verify_email")).length, 1);
  assert.equal((await jobsTo(`rm-end-${RUN}@t.test`)).length, 0, "white-label");

  // again the same day: not re-sent
  const again = await staff.req("POST", "/admin/reminders/verification", { ids: [ids.a] });
  assert.equal(again.json.sent, 0);
  assert.equal(again.json.reasons["Link already sent in the last 24 hours"], 1);
  assert.equal((await jobsTo(`rm-a-${RUN}@t.test`, "auth.verify_email")).length, 1);

  const count = await staff.req("GET", "/admin/reminders/verification");
  assert.ok(count.json.unverified >= 2 && count.json.notSentToday <= count.json.unverified);
  const seg = await staff.req("GET", `/admin/clients?segment=unverified&q=${encodeURIComponent(`rm-a-${RUN}`)}`);
  assert.equal(seg.json.total, 1);
});

test("suspended services: reminder with the amount to pay; others skipped", async () => {
  const susp = await service(ids.a, "SUSPENDED");
  const inv = await invoiceFor(ids.a, susp, 50000);
  const active = await service(ids.a, "ACTIVE");
  const abuse = await service(ids.b, "SUSPENDED"); // no unpaid invoice
  const rsSvc = await service(ids.end, "SUSPENDED");
  await invoiceFor(ids.end, rsSvc, 50000);

  const r = await staff.req("POST", "/admin/reminders/suspended", { ids: [susp, active, abuse, rsSvc] });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.sent, 1);
  assert.deepEqual(r.json.reasons, { "Not suspended": 1, "No unpaid invoice — suspended for another reason": 1, "Sold through a reseller — not emailed by us": 1 });
  const [job] = await jobsTo(`rm-a-${RUN}@t.test`, "service.suspended_reminder");
  assert.ok(job);
  assert.equal(job.data.vars.invoiceId, inv.id);
  assert.match(String(job.data.vars.amountDue), /500/);
  assert.equal((await prisma.invoice.findUniqueOrThrow({ where: { id: inv.id } })).remindersSent, 1);
  assert.equal((await jobsTo(`rm-end-${RUN}@t.test`)).length, 0);

  // the email renders
  const { renderEmail } = await import("../src/modules/email/mailer");
  const html = JSON.stringify(await renderEmail(job.data as never));
  assert.match(html, /still suspended/);
});

test("orders: unpaid → payment reminder; paid with a suspended service → restore reminder; else skipped", async () => {
  const unpaidInv = await invoiceFor(ids.b, null, 70000);
  const unpaid = await prisma.order.create({ data: { number: `RM-1-${RUN}`, userId: ids.b, total: 70000, invoiceId: unpaidInv.id } });
  const svc = await service(ids.b, "SUSPENDED");
  await invoiceFor(ids.b, svc, 50000);
  const paidSusp = await prisma.order.create({ data: { number: `RM-2-${RUN}`, userId: ids.b, total: 50000, status: "ACTIVE", services: { connect: { id: svc } } } });
  const fine = await prisma.order.create({ data: { number: `RM-3-${RUN}`, userId: ids.b, total: 50000, status: "ACTIVE" } });

  const r = await staff.req("POST", "/admin/reminders/orders", { ids: [unpaid.id, paidSusp.id, fine.id] });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.sent, 2);
  assert.equal(r.json.reasons["Nothing to remind about — paid and nothing suspended"], 1);
  const to = `rm-b-${RUN}@t.test`;
  assert.equal((await jobsTo(to, "invoice.reminder")).length + (await jobsTo(to, "invoice.overdue")).length, 1);
  assert.equal((await jobsTo(to, "service.suspended_reminder")).length, 1);
});
