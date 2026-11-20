/**
 * Editing paid / refunded tax invoices (with a reason), and marking a refunded invoice paid or unpaid again.
 *   npx tsx --test test/invoice-override.test.ts
 */
import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { prisma } from "../src/db";
import { closeQueues } from "../src/jobs/queues";

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
const wallet = async () => (await prisma.clientProfile.findUniqueOrThrow({ where: { userId: ids.user } })).creditBalance;

async function paidInvoice(amount: number) {
  const { createInvoice } = await import("../src/modules/billing/invoices");
  const inv = await prisma.$transaction((tx) => createInvoice(tx, { userId: ids.user, items: [{ type: "CUSTOM", description: "Service", unitPrice: amount, taxable: false }] }));
  const r = await staff.req("POST", `/admin/invoices/${inv.id}/payment`, { amount: inv.total, gateway: "manual", reference: `ref-${RUN}-${inv.id.slice(-4)}` });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  return prisma.invoice.findUniqueOrThrow({ where: { id: inv.id }, include: { items: true } });
}

before(async () => {
  const { createApp } = await import("../src/app");
  app = createApp().listen(0);
  base = `http://127.0.0.1:${(app.address() as AddressInfo).port}/api`;
  const bcrypt = (await import("bcryptjs")).default;
  ids.role = (await prisma.role.create({ data: { name: `QA io ${RUN}`, permissions: ["*"] } })).id;
  ids.staff = (await prisma.user.create({ data: { email: `io-staff-${RUN}@t.test`, passwordHash: await bcrypt.hash(PW, 10), firstName: "S", type: "STAFF", status: "ACTIVE", roleId: ids.role } })).id;
  ids.user = (await prisma.user.create({ data: { email: `io-${RUN}@t.test`, passwordHash: "x", firstName: "C", type: "CLIENT", status: "ACTIVE", profile: { create: { currency: "INR" } } } })).id;
  assert.equal((await staff.req("POST", "/auth/login", { email: `io-staff-${RUN}@t.test`, password: PW })).status, 200);
  assert.equal((await staff.req("POST", "/auth/reauth", { password: PW })).status, 200);
});

after(async () => {
  app.close();
  const invs = (await prisma.invoice.findMany({ where: { userId: ids.user }, select: { id: true } })).map((i) => i.id);
  await prisma.creditNote.deleteMany({ where: { invoiceId: { in: invs } } });
  await prisma.transaction.deleteMany({ where: { userId: ids.user } });
  await prisma.creditLedger.deleteMany({ where: { userId: ids.user } });
  await prisma.invoiceItem.deleteMany({ where: { invoiceId: { in: invs } } });
  await prisma.invoice.deleteMany({ where: { id: { in: invs } } });
  await prisma.activityLog.deleteMany({ where: { actorId: ids.staff } }).catch(() => undefined);
  await prisma.loginHistory.deleteMany({ where: { userId: ids.staff } }).catch(() => undefined);
  await prisma.session.deleteMany({ where: { userId: ids.staff } });
  await prisma.clientProfile.deleteMany({ where: { userId: ids.user } });
  await prisma.user.deleteMany({ where: { id: { in: [ids.user, ids.staff] } } });
  await prisma.role.deleteMany({ where: { id: ids.role } });
  await closeQueues().catch(() => undefined);
  await prisma.$disconnect();
});

test("a paid invoice needs a confirmed reason to change; a higher total makes it unpaid for the balance", async () => {
  const inv = await paidInvoice(50000);
  assert.equal(inv.status, "PAID");
  const line = (p: number) => [{ id: inv.items[0].id, description: "Service", quantity: 1, unitPrice: p, taxable: false }];
  assert.equal((await staff.req("PUT", `/admin/invoices/${inv.id}`, { items: line(60000) })).status, 409);
  assert.equal((await staff.req("PUT", `/admin/invoices/${inv.id}`, { items: line(60000), override: true })).status, 400, "reason required");
  assert.equal((await staff.req("PUT", `/admin/invoices/${inv.id}`, { items: line(40000), override: true, reason: "typo" })).status, 409, "can't go below what's paid");
  const r = await staff.req("PUT", `/admin/invoices/${inv.id}`, { items: line(60000), override: true, reason: "Wrong price at order time" });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.reopened, true);
  const after = await prisma.invoice.findUniqueOrThrow({ where: { id: inv.id } });
  assert.equal(after.status, "UNPAID");
  assert.equal(after.total, 60000);
  assert.equal(after.amountPaid, 50000);
  const log = await prisma.activityLog.findFirst({ where: { entityId: inv.id, action: "invoice.edited" }, orderBy: { createdAt: "desc" } });
  assert.equal((log?.details as any)?.reason, "Wrong price at order time");
});

test("refunded to the wallet → marked paid again takes the credit back", async () => {
  const inv = await paidInvoice(30000);
  const w0 = await wallet();
  assert.equal((await staff.req("POST", `/admin/invoices/${inv.id}/refund`, { amount: inv.total, method: "wallet", reason: "test refund" })).status, 200);
  assert.equal((await prisma.invoice.findUniqueOrThrow({ where: { id: inv.id } })).status, "REFUNDED");
  assert.equal(await wallet(), w0 + inv.total);

  assert.equal((await staff.req("POST", `/admin/invoices/${inv.id}/status`, { status: "PAID" })).status, 400, "reason required");
  const r = await staff.req("POST", `/admin/invoices/${inv.id}/status`, { status: "PAID", reason: "Refunded by mistake" });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.creditTaken, inv.total);
  const after = await prisma.invoice.findUniqueOrThrow({ where: { id: inv.id } });
  assert.equal(after.status, "PAID");
  assert.equal(after.amountPaid, after.total);
  assert.equal(await wallet(), w0);
});

test("refunded → unpaid: the customer owes the full amount again", async () => {
  const inv = await paidInvoice(20000);
  assert.equal((await staff.req("POST", `/admin/invoices/${inv.id}/refund`, { amount: inv.total, method: "manual", reason: "test refund" })).status, 200);
  const due = new Date(Date.now() + 3 * 86400_000).toISOString().slice(0, 10);
  const r = await staff.req("POST", `/admin/invoices/${inv.id}/status`, { status: "UNPAID", reason: "Customer wants it back", dueDate: due });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const after = await prisma.invoice.findUniqueOrThrow({ where: { id: inv.id } });
  assert.equal(after.status, "UNPAID");
  assert.equal(after.amountPaid, 0);
  assert.equal(after.dueDate.toISOString().slice(0, 10), due);

  // a refunded invoice can be edited with a reason too
  const ref2 = await paidInvoice(10000);
  await staff.req("POST", `/admin/invoices/${ref2.id}/refund`, { amount: ref2.total, method: "manual", reason: "x refund" });
  const e = await staff.req("PUT", `/admin/invoices/${ref2.id}`, { notes: "n", items: [{ id: ref2.items[0].id, description: "Service (fixed)", quantity: 1, unitPrice: 10000, taxable: false }], override: true, reason: "Fix description" });
  assert.equal(e.status, 200, JSON.stringify(e.json));
  assert.equal((await prisma.invoice.findUniqueOrThrow({ where: { id: ref2.id } })).status, "REFUNDED");
});
