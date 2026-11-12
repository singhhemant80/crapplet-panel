/**
 * Website plans + one-click stock: plans created / hidden / out of stock in the panel are what the
 * website shows; out-of-stock plans can't be bought (staff can still place them).
 *   npx tsx --test test/plans-website.test.ts
 */
import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { prisma } from "../src/db";
import { closeQueues } from "../src/jobs/queues";
import { createApp } from "../src/app";
import { cartSchema } from "../src/modules/orders/pricing";
import { checkout } from "../src/modules/orders/checkout";

const RUN = Date.now().toString(36);
let base = "";
let server: import("node:http").Server;
let groupId = "";
let userId = "";
const ids: string[] = [];

before(async () => {
  server = createApp().listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
  groupId = (await prisma.productGroup.create({ data: { name: `QA Web ${RUN}`, slug: `qa-web-${RUN}` } })).id;
  userId = (await prisma.user.create({ data: { email: `web-${RUN}@t.test`, passwordHash: "x", firstName: "W", lastName: "T", type: "CLIENT", status: "ACTIVE", profile: { create: { country: "IN", state: "Madhya Pradesh", stateCode: "23" } } } })).id;
  for (const [i, n] of ["Alpha", "Beta", "Gamma"].entries()) {
    const p = await prisma.product.create({
      data: { groupId, name: `QA ${n} ${RUN}`, slug: `qa-${n.toLowerCase()}-${RUN}`, type: "TALLY", provisioner: "MANUAL", autoSetup: "MANUAL", sortOrder: i, featured: i === 1, features: [`${n} feature`], pricing: { create: i === 2 ? [{ cycle: "ANNUAL", currency: "INR", price: 120000 }] : [{ cycle: "MONTHLY", currency: "INR", price: 49900 }] } },
    });
    ids.push(p.id);
  }
});

after(async () => {
  await prisma.invoiceItem.deleteMany({ where: { invoice: { userId } } });
  await prisma.invoice.deleteMany({ where: { userId } });
  await prisma.service.deleteMany({ where: { userId } });
  await prisma.order.deleteMany({ where: { userId } });
  await prisma.product.deleteMany({ where: { id: { in: ids } } });
  await prisma.productGroup.deleteMany({ where: { id: groupId } });
  await prisma.user.deleteMany({ where: { id: userId } });
  server.close();
  await closeQueues().catch(() => undefined);
  await prisma.$disconnect();
});

const plans = async () => {
  const { clearPlansCache } = await import("../src/modules/catalog/routes");
  clearPlansCache();
  const r = await fetch(`${base}/catalog/plans?types=TALLY`);
  assert.equal(r.status, 200);
  const d = (await r.json()) as { managedTypes: string[]; plans: { slug: string; outOfStock: boolean; featured: boolean; price: { INR: { amount: number; per: string; cycle: string } | null }; orderUrl: string }[] };
  return { ...d, mine: d.plans.filter((p) => p.slug.endsWith(RUN)) };
};

test("website lists visible plans of a type, in order, with display prices and order links", async () => {
  const d = await plans();
  assert.ok(d.managedTypes.includes("TALLY"));
  assert.deepEqual(d.mine.map((p) => p.slug), [`qa-alpha-${RUN}`, `qa-beta-${RUN}`, `qa-gamma-${RUN}`]);
  assert.deepEqual(d.mine[0].price.INR, { amount: 499, per: "mo", cycle: "MONTHLY" });
  assert.deepEqual(d.mine[2].price.INR, { amount: 100, per: "mo", cycle: "ANNUAL" }, "yearly-only plans show their monthly equivalent");
  assert.equal(d.mine[1].featured, true);
  assert.equal(d.mine[0].orderUrl, `/order/configure?product=qa-alpha-${RUN}`);
});

test("hidden and disabled plans leave the website; out of stock stays listed but marked", async () => {
  await prisma.product.update({ where: { id: ids[0] }, data: { hidden: true } });
  await prisma.product.update({ where: { id: ids[1] }, data: { outOfStock: true } });
  await prisma.product.update({ where: { id: ids[2] }, data: { enabled: false } });
  const d = await plans();
  assert.deepEqual(d.mine.map((p) => [p.slug.split("-")[1], p.outOfStock]), [["beta", true]]);
});

test("an out-of-stock plan can't be ordered by customers, but staff can still place it", async () => {
  const cart = cartSchema.parse({ items: [{ productId: `qa-beta-${RUN}`, cycle: "MONTHLY" }] });
  await assert.rejects(checkout({ userId, cart }), /out of stock/);
  const r = await checkout({ userId, cart, staff: true });
  assert.ok(r.orderId);
});

test("types with no plans in the panel are left to the page's own section", async () => {
  const r = await fetch(`${base}/catalog/plans?types=COLOCATION,GPU`);
  const d = (await r.json()) as { managedTypes: string[] };
  const have = await prisma.product.groupBy({ by: ["type"], where: { type: { in: ["COLOCATION", "GPU"] } } });
  assert.deepEqual(d.managedTypes.sort(), have.map((h) => h.type).sort());
  assert.equal((await fetch(`${base}/catalog/plans`)).status, 400);
});
