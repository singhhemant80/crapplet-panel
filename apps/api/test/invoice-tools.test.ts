/**
 * Invoice tools: edit (recompute, paid lock), draft/issue, duplicate, split, merge, delete, bulk,
 * billable items (NOW, NEXT_INVOICE on the renewal, RECURRING) and quotes (send → accept → invoice).
 *   npx tsx --test test/invoice-tools.test.ts
 */
import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { prisma } from "../src/db";

const RUN = Date.now().toString(36);
const PW = "Staff@12345";
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
const client = new Agent();

async function newInvoice(lines: { description: string; unitPrice: number; quantity?: number }[], extra: Record<string, unknown> = {}) {
  const r = await staff.req("POST", "/admin/invoices", { userId: ids.user, sendEmail: false, items: lines.map((l) => ({ taxable: false, ...l })), ...extra });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  return r.json.id as string;
}
const inv = (id: string) => prisma.invoice.findUniqueOrThrow({ where: { id }, include: { items: { orderBy: { id: "asc" } } } });

before(async () => {
  const { createApp } = await import("../src/app");
  app = createApp().listen(0);
  base = `http://127.0.0.1:${(app.address() as AddressInfo).port}/api`;
  const bcrypt = (await import("bcryptjs")).default;
  ids.role = (await prisma.role.create({ data: { name: `QA billing ${RUN}`, permissions: ["*"] } })).id;
  ids.staff = (await prisma.user.create({ data: { email: `it-staff-${RUN}@t.test`, passwordHash: await bcrypt.hash(PW, 10), firstName: "B", lastName: "S", type: "STAFF", status: "ACTIVE", roleId: ids.role } })).id;
  ids.user = (await prisma.user.create({ data: { email: `it-client-${RUN}@t.test`, passwordHash: await bcrypt.hash("Client@12345", 10), firstName: "Inv", lastName: "Tools", type: "CLIENT", status: "ACTIVE", profile: { create: { country: "IN", state: "Uttar Pradesh", stateCode: "09" } } } })).id;
  ids.group = (await prisma.productGroup.create({ data: { name: `QA IT ${RUN}`, slug: `qa-it-${RUN}` } })).id;
  ids.product = (await prisma.product.create({ data: { groupId: ids.group, name: `QA IT VPS ${RUN}`, slug: `qa-it-${RUN}`, type: "VPS_LINUX", provisioner: "MANUAL", autoSetup: "MANUAL", taxable: false } })).id;
  assert.equal((await staff.req("POST", "/auth/login", { email: `it-staff-${RUN}@t.test`, password: PW })).status, 200);
  assert.equal((await staff.req("POST", "/auth/reauth", { password: PW })).status, 200);
  assert.equal((await client.req("POST", "/auth/login", { email: `it-client-${RUN}@t.test`, password: "Client@12345" })).status, 200);
});

after(async () => {
  const u = ids.user;
  await prisma.billableItem.deleteMany({ where: { userId: u } });
  await prisma.quote.deleteMany({ where: { userId: u } });
  await prisma.transaction.deleteMany({ where: { userId: u } });
  await prisma.paymentIntent.deleteMany({ where: { userId: u } });
  await prisma.creditNote.deleteMany({ where: { invoice: { userId: u } } }).catch(() => undefined);
  await prisma.invoiceItem.deleteMany({ where: { invoice: { userId: u } } });
  await prisma.invoice.deleteMany({ where: { userId: u } });
  await prisma.service.deleteMany({ where: { userId: u } });
  await prisma.product.deleteMany({ where: { id: ids.product } });
  await prisma.productGroup.deleteMany({ where: { id: ids.group } });
  for (const id of [ids.user, ids.staff]) {
    await prisma.activityLog.deleteMany({ where: { OR: [{ userId: id }, { actorId: id }] } }).catch(() => undefined);
    await prisma.loginHistory.deleteMany({ where: { userId: id } });
    await prisma.session.deleteMany({ where: { userId: id } });
    await prisma.creditLedger.deleteMany({ where: { userId: id } });
  }
  await prisma.user.deleteMany({ where: { id: { in: [ids.user, ids.staff] } } });
  await prisma.role.deleteMany({ where: { id: ids.role } });
  app.close();
  const { closeQueues } = await import("../src/jobs/queues");
  await closeQueues().catch(() => undefined);
  await prisma.$disconnect();
});

test("an unpaid invoice can be edited — lines, dates, notes — and totals are recomputed; paid ones are locked", async () => {
  const id = await newInvoice([{ description: "Setup work", unitPrice: 50000 }, { description: "Old line", unitPrice: 1000 }]);
  const before = await inv(id);
  assert.equal(before.total, 51000);

  const due = new Date(Date.now() + 20 * 86400_000).toISOString();
  const r = await staff.req("PUT", `/admin/invoices/${id}`, {
    items: [
      { id: before.items[0].id, description: "Setup work (revised)", quantity: 2, unitPrice: 30000, taxable: false },
      { description: "Loyalty discount", quantity: 1, unitPrice: -10000, taxable: false },
    ],
    dueDate: due,
    notes: "Edited by billing",
  });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const after = await inv(id);
  assert.equal(after.items.length, 2, "the omitted line was removed");
  assert.equal(after.total, 50000, "2 × 300 − 100");
  assert.equal(after.notes, "Edited by billing");
  assert.equal(after.dueDate.toISOString(), due);
  assert.ok(after.items.some((i) => i.type === "PROMO" && i.unitPrice === -10000));

  // a negative total is refused
  const neg = await staff.req("PUT", `/admin/invoices/${id}`, { items: [{ description: "Refund", quantity: 1, unitPrice: -500, taxable: false }] });
  assert.equal(neg.status, 400);

  // edits need the password re-confirmed
  const fresh = new Agent();
  await fresh.req("POST", "/auth/login", { email: `it-staff-${RUN}@t.test`, password: PW });
  assert.equal((await fresh.req("PUT", `/admin/invoices/${id}`, { notes: "x" })).status, 403);

  // pay it → locked
  assert.equal((await staff.req("POST", `/admin/invoices/${id}/payment`, { amount: 50000, gateway: "bank", reference: `IT-${RUN}` })).status < 300, true);
  assert.equal((await inv(id)).status, "PAID");
  const locked = await staff.req("PUT", `/admin/invoices/${id}`, { items: [{ description: "x", quantity: 1, unitPrice: 1, taxable: false }] });
  assert.equal(locked.status, 409);
  assert.equal((await staff.req("DELETE", `/admin/invoices/${id}`)).status, 409, "paid invoices are never deleted");
});

test("drafts are hidden from the customer until issued", async () => {
  const id = await newInvoice([{ description: "Draft consulting", unitPrice: 20000 }], { draft: true });
  assert.equal((await inv(id)).status, "DRAFT");
  assert.equal((await client.req("GET", `/client/invoices/${id}`)).status, 404);
  const list = await client.req("GET", "/client/invoices");
  assert.ok(!JSON.stringify(list.json).includes(id));
  assert.equal((await staff.req("POST", `/admin/invoices/${id}/status`, { status: "UNPAID", sendEmail: false })).status, 200);
  assert.equal((await client.req("GET", `/client/invoices/${id}`)).status, 200);
});

test("duplicate, split, merge and delete", async () => {
  const id = await newInvoice([{ description: "A", unitPrice: 1000 }, { description: "B", unitPrice: 2000 }, { description: "C", unitPrice: 3000 }]);
  const dup = await staff.req("POST", `/admin/invoices/${id}/duplicate`);
  assert.equal(dup.status, 201, JSON.stringify(dup.json));
  const d = await inv(dup.json.id);
  assert.deepEqual([d.status, d.total, d.items.length], ["DRAFT", 6000, 3]);

  const src = await inv(id);
  const split = await staff.req("POST", `/admin/invoices/${id}/split`, { itemIds: [src.items[2].id] });
  assert.equal(split.status, 201, JSON.stringify(split.json));
  assert.equal((await inv(id)).total, 3000);
  assert.equal((await inv(split.json.id)).total, 3000);
  assert.equal((await staff.req("POST", `/admin/invoices/${id}/split`, { itemIds: (await inv(id)).items.map((i) => i.id) })).status, 400, "can't move every line");

  const merged = await staff.req("POST", "/admin/invoices/merge", { ids: [id, split.json.id] });
  assert.equal(merged.status, 200, JSON.stringify(merged.json));
  const m = await inv(merged.json.id);
  assert.deepEqual([m.total, m.items.length], [6000, 3]);
  const gone = merged.json.id === id ? split.json.id : id;
  assert.equal(await prisma.invoice.count({ where: { id: gone } }), 0);

  assert.equal((await staff.req("DELETE", `/admin/invoices/${dup.json.id}`)).status, 200);
  assert.equal(await prisma.invoice.count({ where: { id: dup.json.id } }), 0);
});

test("bulk: mark paid, then a second mark-paid is reported per invoice", async () => {
  const a = await newInvoice([{ description: "Bulk 1", unitPrice: 1500 }]);
  const b = await newInvoice([{ description: "Bulk 2", unitPrice: 2500 }]);
  const r = await staff.req("POST", "/admin/invoices/bulk", { ids: [a, b], action: "mark_paid", reference: `BULK-${RUN}` });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal((await inv(a)).status, "PAID");
  assert.equal((await inv(b)).status, "PAID");
  const again = await staff.req("POST", "/admin/invoices/bulk", { ids: [a], action: "cancel" });
  assert.equal(again.status, 200);
  assert.equal(again.json.results[0].ok, false);
});

test("billable items: invoice now, ride on the next renewal, and recur", async () => {
  // NOW → its own invoice
  const now = await staff.req("POST", "/admin/billable-items", { userId: ids.user, description: "Data recovery", amount: 99900, taxable: false, invoiceAction: "NOW" });
  assert.equal(now.status, 201, JSON.stringify(now.json));
  assert.ok(now.json.invoiceId);
  assert.equal((await inv(now.json.invoiceId)).total, 99900);
  assert.equal((await prisma.billableItem.findUniqueOrThrow({ where: { id: now.json.item.id } })).invoiced, true);

  // NEXT_INVOICE → added to the renewal
  const next = await staff.req("POST", "/admin/billable-items", { userId: ids.user, description: "Extra IP (one-off setup)", amount: 15000, taxable: false, invoiceAction: "NEXT_INVOICE" });
  assert.equal(next.status, 201);
  const svc = await prisma.service.create({ data: { userId: ids.user, productId: ids.product, status: "ACTIVE", billingCycle: "MONTHLY", firstAmount: 40000, recurringAmount: 40000, currency: "INR", nextDueDate: new Date(Date.now() + 2 * 86400_000) } });
  const { generateRenewalInvoices } = await import("../src/jobs/billing");
  await generateRenewalInvoices({ userId: ids.user });
  const renewal = await prisma.invoice.findFirstOrThrow({ where: { userId: ids.user, items: { some: { relId: svc.id, type: "SERVICE" } } }, include: { items: true } });
  assert.ok(renewal.items.some((i) => i.description === "Extra IP (one-off setup)"), "the waiting charge rode on the renewal");
  assert.equal(renewal.total, 55000);
  assert.equal((await prisma.billableItem.findUniqueOrThrow({ where: { id: next.json.item.id } })).invoiceId, renewal.id);

  // RECURRING, 2 times, monthly, due already
  const rec = await staff.req("POST", "/admin/billable-items", { userId: ids.user, description: "Managed support", amount: 20000, taxable: false, invoiceAction: "RECURRING", dueDate: new Date(Date.now() - 86400_000).toISOString(), recurEveryMonths: 1, recurTimes: 2 });
  assert.equal(rec.status, 201, JSON.stringify(rec.json));
  const { runBillableItems } = await import("../src/modules/billing/extras");
  const r1 = await runBillableItems();
  assert.ok(r1.invoices >= 1);
  let item = await prisma.billableItem.findUniqueOrThrow({ where: { id: rec.json.item.id } });
  assert.deepEqual([item.recurDone, item.invoiced], [1, false]);
  assert.ok(item.dueDate! > new Date(), "moved to next month");
  await runBillableItems(new Date(item.dueDate!.getTime() + 1000));
  item = await prisma.billableItem.findUniqueOrThrow({ where: { id: rec.json.item.id } });
  assert.deepEqual([item.recurDone, item.invoiced], [2, true], "finished after 2 times");

  // missing date for a dated item
  assert.equal((await staff.req("POST", "/admin/billable-items", { userId: ids.user, description: "x", amount: 1, invoiceAction: "ON_DATE" })).status, 400);
});

test("quotes: draft is private, sent quote is accepted by the customer and becomes an invoice", async () => {
  const c = await staff.req("POST", "/admin/quotes", { userId: ids.user, subject: "Dedicated server setup", validUntil: new Date(Date.now() + 10 * 86400_000).toISOString(), items: [{ description: "Server build", quantity: 1, unitPrice: 500000, taxable: false }, { description: "Discount", quantity: 1, unitPrice: -50000, taxable: false }] });
  assert.equal(c.status, 201, JSON.stringify(c.json));
  const q = c.json.quote;
  assert.match(q.number, /^Q-\d{6}$/);
  assert.equal(q.total, 450000);
  assert.equal((await client.req("GET", `/client/quotes/${q.id}`)).status, 404, "drafts are hidden");
  assert.equal((await client.req("POST", `/client/quotes/${q.id}/accept`)).status, 404);

  assert.equal((await staff.req("POST", `/admin/quotes/${q.id}/send`)).json.quote.status, "SENT");
  const view = await client.req("GET", `/client/quotes/${q.id}`);
  assert.equal(view.status, 200);
  assert.equal(view.json.quote.adminNotes, undefined, "staff notes never reach the customer");

  const acc = await client.req("POST", `/client/quotes/${q.id}/accept`);
  assert.equal(acc.status, 200, JSON.stringify(acc.json));
  const i = await inv(acc.json.invoiceId);
  assert.deepEqual([i.total, i.userId, i.status], [450000, ids.user, "UNPAID"]);
  assert.equal((await client.req("POST", `/client/quotes/${q.id}/accept`)).json.invoiceId, i.id, "accepting twice gives the same invoice");
  assert.equal((await staff.req("PUT", `/admin/quotes/${q.id}`, { subject: "x y", validUntil: new Date().toISOString(), items: [{ description: "a", unitPrice: 1 }] })).status, 409);

  // decline + expiry
  const d = (await staff.req("POST", "/admin/quotes", { userId: ids.user, subject: "Second option", validUntil: new Date(Date.now() + 86400_000).toISOString(), items: [{ description: "x", unitPrice: 1000, taxable: false }], send: true })).json.quote;
  assert.equal((await client.req("POST", `/client/quotes/${d.id}/decline`, { reason: "too pricey" })).status, 200);
  assert.equal((await client.req("POST", `/client/quotes/${d.id}/accept`)).status, 409);
  const e = (await staff.req("POST", "/admin/quotes", { userId: ids.user, subject: "Old option", validUntil: new Date(Date.now() - 86400_000).toISOString(), items: [{ description: "x", unitPrice: 1000, taxable: false }], send: true })).json.quote;
  const { expireQuotes } = await import("../src/modules/billing/extras");
  assert.ok((await expireQuotes()) >= 1);
  assert.equal((await prisma.quote.findUniqueOrThrow({ where: { id: e.id } })).status, "EXPIRED");
  assert.equal((await client.req("POST", `/client/quotes/${e.id}/accept`)).status, 409);
});

test("terminating or cancelling a service cancels its unpaid invoices (shared ones are trimmed, part-paid ones left)", async () => {
  const { createInvoice } = await import("../src/modules/billing/invoices");
  const { runProvisionAction } = await import("../src/modules/provisioning/provisioner");
  const mkSvc = () => prisma.service.create({ data: { userId: ids.user, productId: ids.product, status: "ACTIVE", billingCycle: "MONTHLY", firstAmount: 40000, recurringAmount: 40000, currency: "INR", nextDueDate: new Date(Date.now() + 86400_000) } });
  const a = await mkSvc();
  const other = await mkSvc();
  const line = (svcId: string, d: string, p = 40000) => ({ type: "SERVICE" as const, relId: svcId, description: d, unitPrice: p, taxable: false });
  const only = await prisma.$transaction((tx) => createInvoice(tx, { userId: ids.user, items: [line(a.id, "VPS renewal"), { type: "LATE_FEE", description: "Late fee", unitPrice: 2000, taxable: false }] }));
  const mixed = await prisma.$transaction((tx) => createInvoice(tx, { userId: ids.user, items: [line(a.id, "VPS A renewal"), line(other.id, "VPS B renewal", 30000), { type: "CUSTOM", description: "Consulting", unitPrice: 5000, taxable: false }] }));
  const part = await prisma.$transaction((tx) => createInvoice(tx, { userId: ids.user, items: [line(a.id, "VPS older renewal")] }));
  await prisma.invoice.update({ where: { id: part.id }, data: { amountPaid: 10000 } });
  const paid = await newInvoice([{ description: "already paid thing", unitPrice: 100 }]);
  await staff.req("POST", `/admin/invoices/${paid}/payment`, { amount: 100, gateway: "bank", reference: `T-${RUN}` });

  await runProvisionAction(a.id, "terminate", { notify: false });
  assert.equal((await prisma.service.findUniqueOrThrow({ where: { id: a.id } })).status, "TERMINATED");
  assert.equal((await inv(only.id)).status, "CANCELLED", "invoice only for the terminated service is cancelled");
  const m = await inv(mixed.id);
  assert.equal(m.status, "UNPAID", "shared invoice stays due");
  assert.equal(m.items.some((i) => i.relId === a.id), false, "the terminated service's line is removed");
  assert.equal(m.total, 35000, "B renewal + consulting");
  assert.equal((await inv(part.id)).status, "UNPAID", "part-paid invoice is left for staff");
  assert.ok(await prisma.activityLog.count({ where: { action: "invoice.termination_needs_review", entityId: part.id } }));
  assert.equal((await inv(paid)).status, "PAID");
  await prisma.invoice.update({ where: { id: part.id }, data: { amountPaid: 0 } });

  // manual: staff set the other service to CANCELLED
  const r = await staff.req("PUT", `/admin/services/${other.id}`, { status: "CANCELLED" });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal((await inv(mixed.id)).status, "UNPAID", "consulting line still due");
  assert.equal((await inv(mixed.id)).total, 5000);
  assert.deepEqual(r.json.invoices.trimmed, [mixed.id]);

  // switched off → nothing happens
  const { updateSettings } = await import("../src/lib/settings");
  const c = await mkSvc();
  const ci = await prisma.$transaction((tx) => createInvoice(tx, { userId: ids.user, items: [line(c.id, "VPS C renewal")] }));
  await updateSettings("automation", { cancelInvoicesOnTerminate: false } as never);
  try {
    await staff.req("PUT", `/admin/services/${c.id}`, { status: "TERMINATED" });
    assert.equal((await inv(ci.id)).status, "UNPAID");
  } finally {
    await updateSettings("automation", { cancelInvoicesOnTerminate: true } as never);
  }
});

test("daily sweep cancels leftover unpaid invoices of services that ended earlier", async () => {
  const { createInvoice } = await import("../src/modules/billing/invoices");
  const { sweepEndedServiceInvoices } = await import("../src/modules/billing/termination");
  const old = await prisma.service.create({ data: { userId: ids.user, productId: ids.product, status: "TERMINATED", billingCycle: "MONTHLY", firstAmount: 1000, recurringAmount: 1000, currency: "INR" } });
  const i = await prisma.$transaction((tx) => createInvoice(tx, { userId: ids.user, items: [{ type: "SERVICE", relId: old.id, description: "old renewal", unitPrice: 1000, taxable: false }] }));
  const r = await sweepEndedServiceInvoices();
  assert.ok(r.cancelled >= 1);
  assert.equal((await inv(i.id)).status, "CANCELLED");
});

test("termination records date + reason; customers see them, never staff notes; staff can edit the reason", async () => {
  const { runProvisionAction } = await import("../src/modules/provisioning/provisioner");
  const s = await prisma.service.create({ data: { userId: ids.user, productId: ids.product, status: "ACTIVE", billingCycle: "MONTHLY", firstAmount: 1000, recurringAmount: 1000, currency: "INR", hostname: `term-${RUN}`, notes: "internal: watch this customer", nextDueDate: new Date(Date.now() - 37 * 86400_000) } });
  await runProvisionAction(s.id, "terminate", { notify: false, reason: "Non-payment — unpaid since 08 Oct 2026" });
  const t = await prisma.service.findUniqueOrThrow({ where: { id: s.id } });
  assert.equal(t.status, "TERMINATED");
  assert.ok(t.terminationDate && Date.now() - t.terminationDate.getTime() < 60_000);
  assert.equal(t.terminationReason, "Non-payment — unpaid since 08 Oct 2026");

  const list = await client.req("GET", "/client/services?status=TERMINATED");
  const mine = list.json.services.find((x: any) => x.id === s.id);
  assert.equal(mine.terminationReason, "Non-payment — unpaid since 08 Oct 2026");
  assert.equal(mine.notes, undefined, "staff notes never reach the customer");
  const one = await client.req("GET", `/client/services/${s.id}`);
  assert.equal(one.json.service.notes, undefined);
  assert.ok(one.json.service.terminationDate);

  const r = await staff.req("PUT", `/admin/services/${s.id}`, { terminationReason: "Cancelled at the customer's request", terminationDate: "2026-11-01" });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const e = await prisma.service.findUniqueOrThrow({ where: { id: s.id } });
  assert.equal(e.terminationReason, "Cancelled at the customer's request");
  assert.equal(e.terminationDate?.toISOString().slice(0, 10), "2026-11-01");

  // staff marking a service Cancelled by hand stamps the date
  const c = await prisma.service.create({ data: { userId: ids.user, productId: ids.product, status: "ACTIVE", billingCycle: "MONTHLY", firstAmount: 1000, recurringAmount: 1000, currency: "INR" } });
  await staff.req("PUT", `/admin/services/${c.id}`, { status: "CANCELLED", terminationReason: "Duplicate order" });
  const cc = await prisma.service.findUniqueOrThrow({ where: { id: c.id } });
  assert.ok(cc.terminationDate);
  assert.equal(cc.terminationReason, "Duplicate order");
});

test("a paid manual-setup service tells the customer it's being set up, not that payment is due", async () => {
  const { createInvoice } = await import("../src/modules/billing/invoices");
  const s = await prisma.service.create({ data: { userId: ids.user, productId: ids.product, status: "PENDING", billingCycle: "MONTHLY", firstAmount: 4900, recurringAmount: 4900, currency: "INR", hostname: `manual-${RUN}.com` } });
  const i = await prisma.$transaction((tx) => createInvoice(tx, { userId: ids.user, items: [{ type: "SERVICE", relId: s.id, description: "Shared Basic", unitPrice: 4900, taxable: false }] }));
  assert.equal((await client.req("GET", `/client/services/${s.id}`)).json.unpaidInvoiceId, i.id, "before payment: points at the invoice");
  assert.ok((await staff.req("POST", `/admin/invoices/${i.id}/payment`, { amount: 4900, gateway: "bank", reference: `MS-${RUN}` })).status < 300);
  const after = await client.req("GET", `/client/services/${s.id}`);
  assert.equal(after.json.service.status, "PENDING", "manual plan waits for staff");
  assert.equal(after.json.unpaidInvoiceId, null, "…but nothing is due any more");
  assert.ok(after.json.service.nextDueDate, "next due date starts from payment");
});
