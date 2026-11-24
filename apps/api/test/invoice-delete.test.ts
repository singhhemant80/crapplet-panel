/**
 * Deleting invoices: unpaid ones (also an order's), paid / numbered ones with a confirmed reason
 * (credit used goes back to the wallet), never ones with credit notes. Plus IP block service details.
 *   npx tsx --test test/invoice-delete.test.ts
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
  ids.role = (await prisma.role.create({ data: { name: `QA idel ${RUN}`, permissions: ["*"] } })).id;
  ids.staff = (await prisma.user.create({ data: { email: `idel-staff-${RUN}@t.test`, passwordHash: await bcrypt.hash(PW, 10), firstName: "S", type: "STAFF", status: "ACTIVE", roleId: ids.role } })).id;
  ids.user = (await prisma.user.create({ data: { email: `idel-${RUN}@t.test`, passwordHash: "x", firstName: "C", type: "CLIENT", status: "ACTIVE", profile: { create: { currency: "INR" } } } })).id;
  assert.equal((await staff.req("POST", "/auth/login", { email: `idel-staff-${RUN}@t.test`, password: PW })).status, 200);
  assert.equal((await staff.req("POST", "/auth/reauth", { password: PW })).status, 200);
});

after(async () => {
  app.close();
  const invs = (await prisma.invoice.findMany({ where: { userId: ids.user }, select: { id: true } })).map((i) => i.id);
  await prisma.service.deleteMany({ where: { userId: ids.user } });
  await prisma.product.deleteMany({ where: { slug: `ip-pool-${RUN}` } });
  await prisma.order.deleteMany({ where: { userId: ids.user } });
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


async function unpaid(amount: number) {
  const { createInvoice } = await import("../src/modules/billing/invoices");
  return prisma.$transaction((tx) => createInvoice(tx, { userId: ids.user, items: [{ type: "CUSTOM", description: "Service", unitPrice: amount, taxable: false }] }));
}
const gone = async (id: string) => !(await prisma.invoice.findUnique({ where: { id } }));

test("unpaid invoices delete — also one that belongs to an order (the order is unlinked)", async () => {
  const a = await unpaid(10000);
  assert.equal((await staff.req("DELETE", `/admin/invoices/${a.id}`)).status, 200);
  assert.ok(await gone(a.id));
  const b = await unpaid(20000);
  const order = await prisma.order.create({ data: { number: `ORD-${RUN}`, userId: ids.user, total: 20000, invoiceId: b.id } });
  const r = await staff.req("DELETE", `/admin/invoices/${b.id}`);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.ok(await gone(b.id));
  assert.equal((await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).invoiceId, null);
});

test("a paid invoice needs force + reason; its payments go and credit used returns to the wallet", async () => {
  await prisma.clientProfile.update({ where: { userId: ids.user }, data: { creditBalance: 15000 } });
  const inv = await unpaid(40000);
  assert.equal((await staff.req("POST", `/admin/invoices/${inv.id}/apply-credit`, {})).status, 200);
  assert.equal(await wallet(), 0);
  assert.equal((await staff.req("POST", `/admin/invoices/${inv.id}/payment`, { amount: 40000 - 15000, gateway: "manual", reference: `del-${RUN}` })).status, 200);
  assert.equal((await prisma.invoice.findUniqueOrThrow({ where: { id: inv.id } })).status, "PAID");
  assert.equal((await staff.req("DELETE", `/admin/invoices/${inv.id}`)).status, 409);
  assert.equal((await staff.req("DELETE", `/admin/invoices/${inv.id}`, { force: true })).status, 409, "reason required");
  const r = await staff.req("DELETE", `/admin/invoices/${inv.id}`, { force: true, reason: "Duplicate invoice" });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.creditReturned, 15000);
  assert.ok(await gone(inv.id));
  assert.equal(await prisma.transaction.count({ where: { invoiceId: inv.id } }), 0);
  assert.equal(await wallet(), 15000);
  const log = await prisma.activityLog.findFirst({ where: { action: "invoice.deleted", entityId: inv.id } });
  assert.equal((log?.details as any)?.reason, "Duplicate invoice");
});

test("an invoice with a credit note can't be deleted", async () => {
  const inv = await unpaid(5000);
  await prisma.creditNote.create({ data: { number: `CN-${RUN}`, invoiceId: inv.id, userId: ids.user, amount: 100, reason: "test" } });
  const r = await staff.req("DELETE", `/admin/invoices/${inv.id}`, { force: true, reason: "x" });
  assert.equal(r.status, 409);
  assert.match(r.json.error?.message ?? JSON.stringify(r.json), /credit note/);
});

test("IP pool plans are recognised and their block details are saved", async () => {
  const { isIpBlockProduct } = await import("../src/lib/product-kind");
  assert.equal(isIpBlockProduct({ type: "CUSTOM", provisioner: "MANUAL", name: "IP Pool", groupName: "IP POOL" }), true);
  assert.equal(isIpBlockProduct({ type: "CUSTOM", provisioner: "MANUAL", name: "/24 Subnet" }), true);
  assert.equal(isIpBlockProduct({ type: "VPS_LINUX", provisioner: "VIRTUALIZOR", name: "IP Pool" }), false);
  assert.equal(isIpBlockProduct({ type: "CUSTOM", provisioner: "MANUAL", name: "Linux VPS G1", groupName: "VPS" }), false);
  const g = await prisma.productGroup.findFirstOrThrow();
  const p = await prisma.product.create({ data: { name: "IP Pool", slug: `ip-pool-${RUN}`, type: "CUSTOM", provisioner: "MANUAL", groupId: g.id } as never });
  const s = await prisma.service.create({ data: { userId: ids.user, productId: p.id, status: "ACTIVE", billingCycle: "MONTHLY", recurringAmount: 600000, firstAmount: 600000, hostname: "162-4-12-0-25" } as never });
  assert.equal((await staff.req("PUT", `/admin/services/${s.id}`, { ipBlock: { cidr: "not a block" } })).status, 400);
  const r = await staff.req("PUT", `/admin/services/${s.id}`, { ipBlock: { cidr: "162.4.12.0/25", gateway: "162.4.12.1", routedTo: "103.1.2.3", vlan: "", notes: "" } });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const cfg = (await prisma.service.findUniqueOrThrow({ where: { id: s.id } })).config as any;
  assert.deepEqual(cfg.ipBlock, { cidr: "162.4.12.0/25", gateway: "162.4.12.1", routedTo: "103.1.2.3" });
});
