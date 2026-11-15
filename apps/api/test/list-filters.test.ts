/**
 * Admin list filters: date ranges (IST days, "to" inclusive) and the new filters on transactions,
 * invoices, services, customers, orders, tickets, activity log and payment reviews.
 *   npx tsx --test test/list-filters.test.ts
 */
import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { prisma } from "../src/db";
import { dateRange } from "../src/lib/filters";

const RUN = Date.now().toString(36);
const PW = "Staff@12345";
let base = "";
let app: http.Server;
const ids: Record<string, string> = {};
/** 10 Nov 2026, 23:30 IST = 18:00 UTC — belongs to 10 Nov in India */
const LATE_10 = new Date("2026-11-10T18:00:00Z");
/** 11 Nov 2026, 00:30 IST = 10 Nov 19:00 UTC — belongs to 11 Nov in India */
const EARLY_11 = new Date("2026-11-10T19:00:00Z");

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
const get = async (path: string) => {
  const r = await staff.req("GET", path);
  assert.equal(r.status, 200, `${path}: ${JSON.stringify(r.json)}`);
  return r.json;
};

before(async () => {
  const { createApp } = await import("../src/app");
  app = createApp().listen(0);
  base = `http://127.0.0.1:${(app.address() as AddressInfo).port}/api`;
  const bcrypt = (await import("bcryptjs")).default;
  ids.role = (await prisma.role.create({ data: { name: `QA filters ${RUN}`, permissions: ["*"] } })).id;
  ids.staff = (await prisma.user.create({ data: { email: `lf-staff-${RUN}@t.test`, passwordHash: await bcrypt.hash(PW, 10), firstName: "Filter", lastName: "Staff", type: "STAFF", status: "ACTIVE", roleId: ids.role } })).id;
  ids.user = (await prisma.user.create({ data: { email: `lf-${RUN}@t.test`, passwordHash: "x", firstName: "Filter", lastName: RUN, type: "CLIENT", status: "ACTIVE", createdAt: LATE_10, profile: { create: { country: "IN", state: "Uttar Pradesh", stateCode: "09", gstin: "09AAAAA0000A1Z5" } } } })).id;
  const mk = (n: number, at: Date, extra: Record<string, unknown> = {}) => prisma.invoice.create({ data: { userId: ids.user, proformaNumber: `LF-${RUN}-${n}`, issueDate: at, dueDate: new Date(at.getTime() + 7 * 86400_000), createdAt: at, subtotal: 10000 * n, total: 10000 * n, currency: "INR", ...extra } });
  ids.inv1 = (await mk(1, LATE_10, { status: "PAID", amountPaid: 10000, paidAt: EARLY_11 })).id;
  ids.inv2 = (await mk(2, EARLY_11)).id;
  ids.inv3 = (await mk(3, EARLY_11, { currency: "USD", isWalletTopup: true })).id;
  await prisma.transaction.createMany({
    data: [
      { userId: ids.user, invoiceId: ids.inv1, type: "PAYMENT", gateway: "cashfree", gatewayTxnId: `lf-${RUN}-a`, amount: 10000, fee: 230, currency: "INR", createdAt: LATE_10 },
      { userId: ids.user, invoiceId: ids.inv2, type: "PAYMENT", gateway: "razorpay", gatewayTxnId: `lf-${RUN}-b`, amount: 20000, currency: "INR", createdAt: EARLY_11 },
      { userId: ids.user, invoiceId: ids.inv2, type: "REFUND", gateway: "razorpay", gatewayTxnId: `lf-${RUN}-c`, amount: -5000, currency: "INR", createdAt: EARLY_11 },
      { userId: ids.user, invoiceId: ids.inv2, type: "CREDIT_APPLIED", gateway: "credit", gatewayTxnId: `lf-${RUN}-d`, amount: 3000, currency: "INR", createdAt: EARLY_11 },
    ],
  });
  ids.dept = (await prisma.ticketDepartment.create({ data: { name: `QA LF ${RUN}`, email: `lf-d-${RUN}@t.test` } })).id;
  ids.ticket = (await prisma.ticket.create({ data: { number: `LF-${RUN}`, userId: ids.user, departmentId: ids.dept, subject: "filter me", createdAt: LATE_10 } })).id;
  await prisma.activityLog.create({ data: { actorId: ids.staff, userId: ids.user, action: "invoice.updated", entity: "invoice", entityId: ids.inv1, ip: "203.0.113.77", createdAt: EARLY_11 } });
  await prisma.activityLog.create({ data: { userId: ids.user, action: "auth.login", ip: "203.0.113.77", createdAt: LATE_10 } });
  await prisma.paymentIntent.create({ data: { userId: ids.user, invoiceId: ids.inv2, gateway: "upi", amount: 20000, currency: "INR", status: "REJECTED", reference: `UTR${RUN}` } });
  assert.equal((await staff.req("POST", "/auth/login", { email: `lf-staff-${RUN}@t.test`, password: PW })).status, 200);
  assert.equal((await staff.req("POST", "/auth/reauth", { password: PW })).status, 200);
});

after(async () => {
  const u = ids.user;
  await prisma.paymentIntent.deleteMany({ where: { userId: u } });
  await prisma.transaction.deleteMany({ where: { userId: u } });
  await prisma.invoiceItem.deleteMany({ where: { invoice: { userId: u } } });
  await prisma.invoice.deleteMany({ where: { userId: u } });
  await prisma.ticket.deleteMany({ where: { userId: u } });
  await prisma.ticketDepartment.deleteMany({ where: { id: ids.dept } });
  for (const id of [u, ids.staff]) {
    await prisma.activityLog.deleteMany({ where: { OR: [{ userId: id }, { actorId: id }] } }).catch(() => undefined);
    await prisma.loginHistory.deleteMany({ where: { userId: id } });
    await prisma.session.deleteMany({ where: { userId: id } });
  }
  await prisma.clientProfile.deleteMany({ where: { userId: u } });
  await prisma.user.deleteMany({ where: { id: { in: [u, ids.staff] } } });
  await prisma.role.deleteMany({ where: { id: ids.role } });
  app.close();
  const { closeQueues } = await import("../src/jobs/queues");
  await closeQueues().catch(() => undefined);
  await prisma.$disconnect();
});

test("date ranges are Indian days; 'to' covers the whole day", () => {
  const r = dateRange({ from: "2026-11-11", to: "2026-11-11" })!;
  assert.equal(r.gte!.toISOString(), "2026-11-10T18:30:00.000Z");
  assert.equal(r.lt!.toISOString(), "2026-11-11T18:30:00.000Z");
  assert.equal(dateRange({}), undefined);
  assert.equal(dateRange({ from: "11/11/2026" }), undefined, "junk is ignored");
  assert.ok(LATE_10 < r.gte! && EARLY_11 >= r.gte!);
});

test("transactions: date, type, gateway, search, and totals for what's shown", async () => {
  const day11 = await get(`/admin/transactions?userId=${ids.user}&from=2026-11-11&to=2026-11-11`);
  assert.equal(day11.total, 3, "10 Nov 23:30 IST is not on the 11th");
  const t = day11.totals.find((x: any) => x.currency === "INR");
  assert.deepEqual([t.received, t.refunded, t.net, t.creditApplied, t.count], [20000, 5000, 15000, 3000, 3]);
  assert.equal((await get(`/admin/transactions?userId=${ids.user}&type=REFUND`)).total, 1);
  assert.equal((await get(`/admin/transactions?userId=${ids.user}&gateway=cashfree`)).totals[0].fees, 230);
  assert.equal((await get(`/admin/transactions?q=lf-${RUN}-b`)).total, 1, "by reference");
  assert.equal((await get(`/admin/transactions?q=LF-${RUN}-1`)).total, 1, "by invoice number");
  assert.equal((await get(`/admin/transactions?q=lf-${RUN}@t.test`)).total, 4, "by customer email");
});

test("invoices: by issued / paid date, currency and kind", async () => {
  assert.equal((await get(`/admin/invoices?userId=${ids.user}&from=2026-11-10&to=2026-11-10`)).total, 1, "issued on the 10th (IST)");
  assert.equal((await get(`/admin/invoices?userId=${ids.user}&dateField=paid&from=2026-11-11&to=2026-11-11`)).total, 1, "paid on the 11th");
  assert.equal((await get(`/admin/invoices?userId=${ids.user}&currency=USD`)).total, 1);
  assert.equal((await get(`/admin/invoices?userId=${ids.user}&kind=billing`)).total, 2);
  assert.equal((await get(`/admin/invoices?userId=${ids.user}&kind=topup`)).total, 1);
});

test("customers by join date and type; tickets by date opened", async () => {
  const c = await get(`/admin/clients?q=lf-${RUN}&from=2026-11-10&to=2026-11-10&kind=business`);
  assert.equal(c.total, 1);
  assert.equal((await get(`/admin/clients?q=lf-${RUN}&from=2026-11-11`)).total, 0);
  assert.equal((await get(`/admin/clients?q=lf-${RUN}&kind=individual`)).total, 0);
  assert.equal((await get(`/admin/tickets?userId=${ids.user}&status=&from=2026-11-10&to=2026-11-10`)).total, 1);
  assert.equal((await get(`/admin/tickets?userId=${ids.user}&status=&from=2026-11-11`)).total, 0);
});

test("activity log: area, who, search and date", async () => {
  const byStaff = await get(`/admin/activity?q=203.0.113.77&actor=${ids.staff}`);
  assert.equal(byStaff.total, 1);
  assert.equal(byStaff.items[0].actorName, "Filter Staff");
  assert.equal((await get(`/admin/activity?q=203.0.113.77&actor=system`)).total, 1);
  assert.equal((await get(`/admin/activity?q=203.0.113.77&action=invoice.`)).total, 1);
  assert.equal((await get(`/admin/activity?q=203.0.113.77&from=2026-11-10&to=2026-11-10`)).total, 1);
});

test("payment reviews: waiting by default, rejected history on request", async () => {
  assert.ok(!(await get(`/admin/payment-reviews?q=lf-${RUN}`)).intents.length, "nothing waiting");
  const rej = await get(`/admin/payment-reviews?status=REJECTED&q=lf-${RUN}`);
  assert.equal(rej.intents.length, 1);
  assert.equal((await get(`/admin/payment-reviews?status=all&q=lf-${RUN}`)).intents.length, 1);
});

test("services and orders accept date ranges", async () => {
  assert.equal((await get(`/admin/services?from=2000-01-01&to=2000-01-02`)).total, 0);
  assert.equal((await get(`/admin/services?dateField=due&from=2000-01-01&to=2000-01-02`)).total, 0);
  assert.equal((await get(`/admin/orders?from=2000-01-01&to=2000-01-02`)).total, 0);
});
