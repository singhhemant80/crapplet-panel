/**
 * Promo codes on the admin New order page: which codes fit, and the order gets the discount.
 *   npx tsx --test test/admin-order-promo.test.ts
 */
import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { prisma } from "../src/db";
import { closeQueues } from "../src/jobs/queues";

const RUN = Date.now().toString(36).toUpperCase();
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

before(async () => {
  const { createApp } = await import("../src/app");
  app = createApp().listen(0);
  base = `http://127.0.0.1:${(app.address() as AddressInfo).port}/api`;
  const bcrypt = (await import("bcryptjs")).default;
  ids.role = (await prisma.role.create({ data: { name: `QA op ${RUN}`, permissions: ["*"] } })).id;
  ids.staff = (await prisma.user.create({ data: { email: `op-staff-${RUN.toLowerCase()}@t.test`, passwordHash: await bcrypt.hash(PW, 10), firstName: "S", type: "STAFF", status: "ACTIVE", roleId: ids.role } })).id;
  ids.user = (await prisma.user.create({ data: { email: `op-${RUN.toLowerCase()}@t.test`, passwordHash: "x", firstName: "C", type: "CLIENT", status: "ACTIVE", profile: { create: { currency: "INR", country: "IN", state: "Madhya Pradesh" } } } })).id;
  ids.group = (await prisma.productGroup.create({ data: { name: `QA OP ${RUN}`, slug: `qa-op-${RUN.toLowerCase()}` } })).id;
  ids.product = (await prisma.product.create({ data: { groupId: ids.group, name: `OP Plan ${RUN}`, slug: `qa-op-${RUN.toLowerCase()}`, type: "CUSTOM", provisioner: "MANUAL", autoSetup: "MANUAL", taxable: false, pricing: { create: [{ currency: "INR", cycle: "MONTHLY", price: 100000 }, { currency: "INR", cycle: "ANNUAL", price: 1000000 }] } } })).id;
  ids.other = (await prisma.product.create({ data: { groupId: ids.group, name: `OP Other ${RUN}`, slug: `qa-op2-${RUN.toLowerCase()}`, type: "CUSTOM", provisioner: "MANUAL", autoSetup: "MANUAL", taxable: false, pricing: { create: [{ currency: "INR", cycle: "MONTHLY", price: 30000 }] } } })).id;
  await prisma.promoCode.createMany({
    data: [
      { code: `P20${RUN}`, type: "PERCENT", value: 20 },
      { code: `ANN${RUN}`, type: "PERCENT", value: 50, cycles: ["ANNUAL"] },
      { code: `OTH${RUN}`, type: "FIXED", value: 5000, productIds: [ids.other] },
      { code: `OLD${RUN}`, type: "PERCENT", value: 90, expiresAt: new Date(Date.now() - 86400_000) },
      { code: `USED${RUN}`, type: "PERCENT", value: 90, maxUses: 1, uses: 1 },
    ],
  });
  assert.equal((await staff.req("POST", "/auth/login", { email: `op-staff-${RUN.toLowerCase()}@t.test`, password: PW })).status, 200);
  assert.equal((await staff.req("POST", "/auth/reauth", { password: PW })).status, 200);
});

after(async () => {
  app.close();
  const orders = await prisma.order.findMany({ where: { userId: ids.user }, select: { id: true } });
  await prisma.service.deleteMany({ where: { userId: ids.user } });
  await prisma.invoiceItem.deleteMany({ where: { invoice: { userId: ids.user } } });
  await prisma.order.deleteMany({ where: { id: { in: orders.map((o) => o.id) } } });
  await prisma.invoice.deleteMany({ where: { userId: ids.user } });
  await prisma.promoCode.deleteMany({ where: { code: { endsWith: RUN } } });
  await prisma.productPricing.deleteMany({ where: { productId: { in: [ids.product, ids.other].filter(Boolean) } } }).catch(() => undefined);
  await prisma.product.deleteMany({ where: { id: { in: [ids.product, ids.other].filter(Boolean) } } });
  await prisma.productGroup.deleteMany({ where: { id: ids.group } });
  await prisma.activityLog.deleteMany({ where: { actorId: ids.staff } }).catch(() => undefined);
  await prisma.loginHistory.deleteMany({ where: { userId: ids.staff } }).catch(() => undefined);
  await prisma.session.deleteMany({ where: { userId: ids.staff } });
  await prisma.clientProfile.deleteMany({ where: { userId: ids.user } });
  await prisma.user.deleteMany({ where: { id: { in: [ids.user, ids.staff] } } });
  await prisma.role.deleteMany({ where: { id: ids.role } });
  await closeQueues().catch(() => undefined);
  await prisma.$disconnect();
});

test("lists active codes; marks the ones that don't fit; hides expired / used up", async () => {
  const r = await staff.req("GET", `/admin/order-promo-codes?productId=${ids.product}&cycle=MONTHLY&userId=${ids.user}`);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const mine = Object.fromEntries(r.json.codes.filter((c: any) => c.code.endsWith(RUN)).map((c: any) => [c.code, c]));
  assert.equal(mine[`P20${RUN}`].eligible, true);
  assert.equal(mine[`ANN${RUN}`].reason, "Not for this billing cycle");
  assert.equal(mine[`OTH${RUN}`].reason, "Not for this plan");
  assert.equal(mine[`OLD${RUN}`], undefined);
  assert.equal(mine[`USED${RUN}`], undefined);
});

test("several plans in one order: a code fits when it applies to any of them; each item becomes a service", async () => {
  const r = await staff.req("GET", `/admin/order-promo-codes?items=${ids.product}:MONTHLY,${ids.other}:MONTHLY&userId=${ids.user}`);
  const oth = r.json.codes.find((c: any) => c.code === `OTH${RUN}`);
  assert.equal(oth.eligible, true, "fits the second plan");
  const o = await staff.req("POST", "/admin/orders", { userId: ids.user, items: [{ productId: ids.product, cycle: "MONTHLY", quantity: 2, config: {}, addonIds: [] }, { productId: ids.other, cycle: "MONTHLY", quantity: 1, config: {}, addonIds: [] }], domains: [] });
  assert.equal(o.status, 201, JSON.stringify(o.json));
  assert.equal(await prisma.service.count({ where: { orderId: o.json.orderId } }), 3);
});

test("a staff order with a promo code gets the discount", async () => {
  const r = await staff.req("POST", "/admin/orders", { userId: ids.user, items: [{ productId: ids.product, cycle: "MONTHLY", quantity: 1, config: {}, addonIds: [] }], domains: [], promoCode: `P20${RUN}`, markPaid: false });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  const inv = await prisma.invoice.findUniqueOrThrow({ where: { id: r.json.invoiceId }, include: { items: true } });
  const promoLine = inv.items.find((i) => i.type === "PROMO");
  assert.ok(promoLine, "promo line on the invoice");
  assert.equal(promoLine!.amount, -20000);
  assert.equal((await prisma.promoCode.findUniqueOrThrow({ where: { code: `P20${RUN}` } })).uses, 1);
  const bad = await staff.req("POST", "/admin/orders", { userId: ids.user, items: [{ productId: ids.product, cycle: "MONTHLY", quantity: 1, config: {}, addonIds: [] }], domains: [], promoCode: `OTH${RUN}` });
  assert.equal(bad.status, 400);
});
