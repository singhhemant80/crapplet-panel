/**
 * Billing health check (finds what doesn't add up, fixes the safe cases), the renewal job's
 * "already billed" guard, and the customer statement's balance.
 *   npx tsx --test test/billing-health.test.ts
 */
import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { prisma } from "../src/db";
import { applyCreditToInvoice, applyPayment, createInvoice } from "../src/modules/billing/invoices";
import { billingHealth, fixBillingHealth } from "../src/modules/billing/health";
import { generateRenewalInvoices } from "../src/jobs/billing";

const RUN = Date.now().toString(36);
const PW = "Staff@12345";
let base = "";
let app: http.Server;
const ids: Record<string, string> = {};
const DAY = 86400_000;

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
const svc = (extra: Record<string, unknown>) => prisma.service.create({ data: { userId: ids.user, productId: ids.product, status: "ACTIVE", billingCycle: "MONTHLY", firstAmount: 50000, recurringAmount: 50000, currency: "INR", ...extra } }).then((s) => s.id);
const inv = (items: { relId?: string; periodStart?: Date | null; periodEnd?: Date | null; rupees: number; type?: "SERVICE" | "CUSTOM" }[]) =>
  prisma.$transaction((tx) => createInvoice(tx, { userId: ids.user, items: items.map((i) => ({ type: i.type ?? "SERVICE", relId: i.relId ?? null, description: `QA ${RUN}`, unitPrice: i.rupees * 100, taxable: false, periodStart: i.periodStart ?? null, periodEnd: i.periodEnd ?? null })) }));
const check = async (key: string) => (await billingHealth()).checks.find((c) => c.key === key)!;

before(async () => {
  const { createApp } = await import("../src/app");
  app = createApp().listen(0);
  base = `http://127.0.0.1:${(app.address() as AddressInfo).port}/api`;
  const bcrypt = (await import("bcryptjs")).default;
  ids.role = (await prisma.role.create({ data: { name: `QA health ${RUN}`, permissions: ["*"] } })).id;
  ids.staff = (await prisma.user.create({ data: { email: `bh-staff-${RUN}@t.test`, passwordHash: await bcrypt.hash(PW, 10), firstName: "B", lastName: "H", type: "STAFF", status: "ACTIVE", roleId: ids.role } })).id;
  ids.user = (await prisma.user.create({ data: { email: `bh-${RUN}@t.test`, passwordHash: "x", firstName: "Health", lastName: "Check", type: "CLIENT", status: "ACTIVE", profile: { create: { country: "IN", state: "Uttar Pradesh", stateCode: "09" } } } })).id;
  ids.group = (await prisma.productGroup.create({ data: { name: `QA bh ${RUN}`, slug: `qa-bh-${RUN}` } })).id;
  ids.product = (await prisma.product.create({ data: { groupId: ids.group, name: `QA Colo ${RUN}`, slug: `qa-bh-${RUN}`, type: "COLOCATION", provisioner: "MANUAL", autoSetup: "MANUAL", taxable: false } })).id;
  assert.equal((await staff.req("POST", "/auth/login", { email: `bh-staff-${RUN}@t.test`, password: PW })).status, 200);
  assert.equal((await staff.req("POST", "/auth/reauth", { password: PW })).status, 200);
});

after(async () => {
  const u = ids.user;
  await prisma.creditNote.deleteMany({ where: { userId: u } });
  await prisma.transaction.deleteMany({ where: { userId: u } });
  await prisma.creditLedger.deleteMany({ where: { userId: u } });
  await prisma.invoiceItem.deleteMany({ where: { invoice: { userId: u } } });
  await prisma.invoice.deleteMany({ where: { userId: u } });
  const sv = await prisma.service.findMany({ where: { userId: u }, select: { id: true } });
  await prisma.provisioningLog.deleteMany({ where: { serviceId: { in: sv.map((s) => s.id) } } });
  await prisma.automationEvent.deleteMany({ where: { userId: u } }).catch(() => undefined);
  await prisma.service.deleteMany({ where: { userId: u } });
  await prisma.product.deleteMany({ where: { id: ids.product } });
  await prisma.productGroup.deleteMany({ where: { id: ids.group } });
  for (const id of [u, ids.staff]) {
    await prisma.activityLog.deleteMany({ where: { OR: [{ userId: id }, { actorId: id }] } }).catch(() => undefined);
    await prisma.loginHistory.deleteMany({ where: { userId: id } });
    await prisma.session.deleteMany({ where: { userId: id } });
  }
  await prisma.clientProfile.deleteMany({ where: { userId: u } });
  if (ids.stUser) {
    await prisma.transaction.deleteMany({ where: { userId: ids.stUser } });
    await prisma.creditLedger.deleteMany({ where: { userId: ids.stUser } });
    await prisma.invoiceItem.deleteMany({ where: { invoice: { userId: ids.stUser } } });
    await prisma.invoice.deleteMany({ where: { userId: ids.stUser } });
    await prisma.clientProfile.deleteMany({ where: { userId: ids.stUser } });
    await prisma.user.deleteMany({ where: { id: ids.stUser } });
  }
  await prisma.user.deleteMany({ where: { id: { in: [u, ids.staff] } } });
  await prisma.role.deleteMany({ where: { id: ids.role } });
  app.close();
  const { closeQueues } = await import("../src/jobs/queues");
  await closeQueues().catch(() => undefined);
  await prisma.$disconnect();
});

test("unpaid invoices already covered are marked paid, numbered, and renew the service", async () => {
  const s = await svc({ nextDueDate: new Date(Date.now() - 2 * DAY) });
  const start = new Date(Date.now() - 2 * DAY);
  const i = await inv([{ relId: s, periodStart: start, periodEnd: new Date(start.getTime() + 30 * DAY), rupees: 500 }]);
  await prisma.invoice.update({ where: { id: i.id }, data: { amountPaid: 50000 } }); // e.g. paid but the status update was lost
  assert.ok((await check("unpaid_covered")).rows.some((r) => r.id === i.id));
  const r = await fixBillingHealth("unpaid_covered");
  assert.ok(r.fixed >= 1);
  const after = await prisma.invoice.findUniqueOrThrow({ where: { id: i.id } });
  assert.equal(after.status, "PAID");
  assert.ok(after.number, "tax invoice number assigned");
  assert.ok((await prisma.service.findUniqueOrThrow({ where: { id: s } })).nextDueDate! > new Date(Date.now() + 20 * DAY), "service renewed");
});

test("a service paid beyond its due date gets the due date moved to the end of the paid period", async () => {
  const paidUntil = new Date(Date.now() + 25 * DAY);
  const s = await svc({ nextDueDate: new Date(Date.now() - 5 * DAY) });
  const i = await inv([{ relId: s, periodStart: null, periodEnd: paidUntil, rupees: 500 }]);
  await applyPayment({ invoiceId: i.id, amount: 50000, gateway: "manual", gatewayTxnId: `bh-${RUN}-1` });
  await prisma.service.update({ where: { id: s }, data: { nextDueDate: new Date(Date.now() - 5 * DAY) } }); // knocked back
  assert.ok((await check("due_behind")).rows.some((r) => r.id === s));
  await fixBillingHealth("due_behind");
  assert.equal((await prisma.service.findUniqueOrThrow({ where: { id: s } })).nextDueDate!.getTime(), paidUntil.getTime());
  ids.paidSvc = s;
});

test("renewals are never raised for a period already paid on the order invoice", async () => {
  // the order invoice paid until +25d; pretend the due date was edited back into that period
  await prisma.service.update({ where: { id: ids.paidSvc }, data: { nextDueDate: new Date(Date.now() + 2 * DAY) } });
  await generateRenewalInvoices({ userId: ids.user });
  const renewals = await prisma.invoiceItem.count({ where: { relId: ids.paidSvc, periodStart: { not: null } } });
  assert.equal(renewals, 0, "no invoice for a period the customer already paid");
});

test("the same period billed twice: the newer unpaid copy is cancelled, the original kept", async () => {
  const s = await svc({ nextDueDate: new Date(Date.now() + 40 * DAY) });
  const start = new Date(Date.now() + 3 * DAY);
  const first = await inv([{ relId: s, periodStart: start, periodEnd: new Date(start.getTime() + 30 * DAY), rupees: 500 }]);
  await new Promise((r) => setTimeout(r, 20));
  const dup = await inv([{ relId: s, periodStart: new Date(start.getTime() + 2 * DAY), periodEnd: new Date(start.getTime() + 32 * DAY), rupees: 500 }]);
  const c = await check("duplicate_renewals");
  assert.ok(c.rows.some((r) => r.id === dup.id));
  assert.ok(!c.rows.some((r) => r.id === first.id));
  await fixBillingHealth("duplicate_renewals");
  assert.equal((await prisma.invoice.findUniqueOrThrow({ where: { id: dup.id } })).status, "CANCELLED");
  assert.equal((await prisma.invoice.findUniqueOrThrow({ where: { id: first.id } })).status, "UNPAID");
});

test("unpaid invoices for ended services are cancelled", async () => {
  const s = await svc({ status: "TERMINATED" });
  const i = await inv([{ relId: s, rupees: 500 }]);
  assert.ok((await check("ended_billed")).rows.some((r) => r.id === i.id));
  await fixBillingHealth("ended_billed");
  assert.equal((await prisma.invoice.findUniqueOrThrow({ where: { id: i.id } })).status, "CANCELLED");
});

test("a credit balance that doesn't match its history gets one correcting line — the balance itself is kept", async () => {
  await prisma.clientProfile.update({ where: { userId: ids.user }, data: { creditBalance: { increment: 12345 } } }); // a raw edit, no ledger
  const bal = (await prisma.clientProfile.findUniqueOrThrow({ where: { userId: ids.user } })).creditBalance;
  assert.ok((await check("credit_ledger")).rows.some((r) => r.id === ids.user));
  await fixBillingHealth("credit_ledger");
  assert.equal((await prisma.clientProfile.findUniqueOrThrow({ where: { userId: ids.user } })).creditBalance, bal);
  assert.ok(!(await check("credit_ledger")).rows.some((r) => r.id === ids.user));
});

test("the statement counts money once: credit used on an invoice isn't a second payment, top-ups aren't debts", async () => {
  const uid = (await prisma.user.create({ data: { email: `bh-st-${RUN}@t.test`, passwordHash: "x", firstName: "St", type: "CLIENT", status: "ACTIVE", profile: { create: { country: "IN" } } } })).id;
  ids.stUser = uid;
  const mk = (rupees: number, topup = false) => prisma.$transaction((tx) => createInvoice(tx, { userId: uid, isWalletTopup: topup, items: [{ type: topup ? "WALLET" : "CUSTOM", description: `QA ${RUN}`, unitPrice: rupees * 100, taxable: false }] } as any));
  // an overpayment (→ ₹300 credit), then ₹200 of it used on another invoice
  const a = await mk(1000);
  await applyPayment({ invoiceId: a.id, amount: 130000, gateway: "manual", gatewayTxnId: `bh-${RUN}-over` });
  const b = await mk(200);
  await applyCreditToInvoice(uid, b.id);
  // a ₹500 wallet top-up, and one unpaid ₹700 invoice
  const t = await mk(500, true);
  await applyPayment({ invoiceId: t.id, amount: 50000, gateway: "manual", gatewayTxnId: `bh-${RUN}-top` });
  await mk(700);
  const credit = (await prisma.clientProfile.findUniqueOrThrow({ where: { userId: uid } })).creditBalance;
  assert.equal(credit, 60000, "₹100 left from the overpayment + ₹500 top-up");
  const r = await staff.req("GET", `/admin/clients/${uid}/statement`);
  assert.equal(r.status, 200);
  assert.equal(r.json.balance, 70000 - 60000, "₹700 owed − ₹600 credit");
  assert.ok(r.json.rows.some((x: any) => x.kind === "info" && x.debit === 0 && x.credit === 0), "credit use listed for reference only");
  assert.ok(!r.json.rows.some((x: any) => x.kind === "invoice" && x.id === t.id), "the top-up invoice isn't a debt");
});

test("staff see the check over the API; only billing managers can run fixes", async () => {
  const r = await staff.req("GET", "/admin/billing/health");
  assert.equal(r.status, 200);
  assert.ok(r.json.checks.length >= 10);
  assert.equal((await staff.req("POST", "/admin/billing/health/fix", { key: "cancelled_paid" })).status, 400, "review-only checks have no fix");
});

test("staff can add, remove and clear a customer's credit, with clear messages", async () => {
  const uid = (await prisma.user.create({ data: { email: `bh-cr-${RUN}@t.test`, passwordHash: "x", firstName: "Cr", type: "CLIENT", status: "ACTIVE", profile: { create: { country: "IN" } } } })).id;
  ids.crUser = uid;
  const call = (body: Record<string, unknown>) => staff.req("POST", `/admin/clients/${uid}/credit`, body);
  assert.equal((await call({ amount: 12889, description: "Goodwill" })).json.balance, 12889);
  const tooMuch = await call({ amount: -20000, description: "Remove" });
  assert.equal(tooMuch.status, 400);
  assert.match(tooMuch.json.error, /Only 128\.89 INR of credit is available/);
  assert.equal((await call({ amount: -2889, description: "Partly" })).json.balance, 10000);
  const noReason = await call({ removeAll: true, description: "x" });
  assert.equal(noReason.status, 400);
  assert.match(JSON.stringify(noReason.json), /short reason/);
  assert.equal((await call({ removeAll: true, description: "Credit added by mistake" })).json.balance, 0);
  assert.equal((await call({ removeAll: true, description: "Again" })).status, 400, "nothing left to remove");
  const log = await prisma.creditLedger.findMany({ where: { userId: uid }, orderBy: { createdAt: "asc" } });
  assert.deepEqual(log.map((l) => l.amount), [12889, -2889, -10000]);
  assert.equal(log[2].description, "Credit added by mistake (staff)");
  await prisma.creditLedger.deleteMany({ where: { userId: uid } });
  await prisma.activityLog.deleteMany({ where: { userId: uid } }).catch(() => undefined);
  await prisma.clientProfile.deleteMany({ where: { userId: uid } });
  await prisma.user.delete({ where: { id: uid } });
});
