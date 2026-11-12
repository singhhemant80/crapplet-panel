/**
 * Hosting orders (WHMCS-style): every shared / reseller / WordPress plan needs a domain whatever its module,
 * a domain registered with a qualifying plan is free, and free renewals stop when the plan goes.
 *   npx tsx --test test/hosting-order.test.ts
 */
import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "../src/db";
import { closeQueues } from "../src/jobs/queues";
import { priceCart, cartSchema } from "../src/modules/orders/pricing";
import { checkout } from "../src/modules/orders/checkout";
import { domainRenewalPrice } from "../src/jobs/billing";
import { isHostingProduct, qualifiesForFreeDomain } from "../src/lib/product-kind";
import { whmcsFreeDomain } from "../src/modules/migration/whmcs";

const RUN = Date.now().toString(36);
let userId = "";
let groupId = "";
const made: string[] = [];

async function plan(slug: string, data: Record<string, unknown> = {}) {
  const p = await prisma.product.create({
    data: { groupId, name: `QA ${slug}`, slug: `qa-${slug}-${RUN}`, type: "SHARED", provisioner: "MANUAL", autoSetup: "MANUAL", pricing: { create: [{ cycle: "MONTHLY", currency: "INR", price: 10000 }, { cycle: "ANNUAL", currency: "INR", price: 100000 }] }, ...data },
  });
  made.push(p.id);
  return p;
}
const cart = (c: unknown) => cartSchema.parse(c);

before(async () => {
  const u = await prisma.user.create({ data: { email: `host-${RUN}@t.test`, passwordHash: "x", firstName: "Host", lastName: "Order", type: "CLIENT", status: "ACTIVE", profile: { create: { country: "IN", state: "Madhya Pradesh", stateCode: "23", currency: "INR", address1: "1 Road" } } } });
  userId = u.id;
  groupId = (await prisma.productGroup.create({ data: { name: `QA Hosting ${RUN}`, slug: `qa-hosting-${RUN}` } })).id;
  for (const [tld, register, renew] of [[".com", 89900, 109900], [".in", 59900, 79900]] as const)
    await prisma.domainPricing.upsert({ where: { tld }, update: { enabled: true }, create: { tld, register, transfer: renew, renew } });
});

after(async () => {
  const svcs = await prisma.service.findMany({ where: { userId }, select: { id: true } });
  await prisma.invoiceItem.deleteMany({ where: { invoice: { userId } } });
  await prisma.invoice.deleteMany({ where: { userId } });
  await prisma.serviceAddon.deleteMany({ where: { serviceId: { in: svcs.map((s) => s.id) } } });
  await prisma.service.deleteMany({ where: { userId } });
  await prisma.domain.deleteMany({ where: { userId } });
  await prisma.order.deleteMany({ where: { userId } });
  await prisma.product.deleteMany({ where: { id: { in: made } } });
  await prisma.productGroup.deleteMany({ where: { id: groupId } });
  await closeQueues().catch(() => undefined);
  await prisma.$disconnect();
});

test("shared / reseller / WordPress plans are hosting whatever module provisions them", () => {
  assert.equal(isHostingProduct({ type: "SHARED", provisioner: "MANUAL" }), true);
  assert.equal(isHostingProduct({ type: "RESELLER_HOSTING", provisioner: "MANUAL" }), true);
  assert.equal(isHostingProduct({ type: "WORDPRESS", provisioner: "NONE" }), true);
  assert.equal(isHostingProduct({ type: "VPS_LINUX", provisioner: "CPANEL" }), true);
  assert.equal(isHostingProduct({ type: "VPS_LINUX", provisioner: "VIRTUALIZOR" }), false);
});

test("free domain rules: cycle and TLD must qualify", () => {
  const p = { freeDomain: "once", freeDomainCycles: ["ANNUAL"], freeDomainTlds: [".com"] };
  assert.equal(qualifiesForFreeDomain(p, "ANNUAL", "shop.com"), true);
  assert.equal(qualifiesForFreeDomain(p, "MONTHLY", "shop.com"), false);
  assert.equal(qualifiesForFreeDomain(p, "ANNUAL", "shop.in"), false);
  assert.equal(qualifiesForFreeDomain({ freeDomain: "none", freeDomainCycles: [], freeDomainTlds: [] }, "ANNUAL", "shop.com"), false);
  assert.equal(qualifiesForFreeDomain({ freeDomain: "recurring", freeDomainCycles: [], freeDomainTlds: [] }, "MONTHLY", "x.co.in"), true);
});

test("WHMCS free-domain settings are imported", () => {
  assert.deepEqual(whmcsFreeDomain({ freedomain: "once", freedomainpaymentterms: "annually,biennially", freedomaintlds: ".com,in" }), { freeDomain: "once", freeDomainCycles: ["ANNUAL", "BIENNIAL"], freeDomainTlds: [".com", ".in"] });
  assert.deepEqual(whmcsFreeDomain({ freedomain: "on", freedomainpaymentterms: "", freedomaintlds: "" }), { freeDomain: "recurring", freeDomainCycles: [], freeDomainTlds: [] });
  assert.deepEqual(whmcsFreeDomain({ freedomain: "" }), { freeDomain: "none" });
});

test("a manual shared plan can't be ordered without a domain", async () => {
  const p = await plan("nodomain");
  await assert.rejects(checkout({ userId, cart: cart({ items: [{ productId: p.slug, cycle: "MONTHLY" }] }) }), /Choose the domain/);
  await assert.rejects(checkout({ userId, cart: cart({ items: [{ productId: p.slug, cycle: "MONTHLY", hostname: "localhost" }] }) }), /Choose the domain/);
});

test("the plan's domain is free on a qualifying cycle and TLD, charged otherwise", async () => {
  const p = await plan("free", { freeDomain: "once", freeDomainCycles: ["ANNUAL"], freeDomainTlds: [".com"] });
  const dom = `qa-${RUN}.com`;
  const q = await priceCart(cart({ items: [{ productId: p.slug, cycle: "ANNUAL", hostname: dom }], domains: [{ name: dom, action: "register", years: 1 }] }), { userId });
  const line = q.lines.find((l) => l.kind === "domain")!;
  assert.equal(line.amount, 0, "first year free");
  assert.equal(line.recurring, 109900, "renews at the normal price");
  assert.match(line.description, /free with/);
  // 2 years: the second year is charged at the renewal price
  const q2 = await priceCart(cart({ items: [{ productId: p.slug, cycle: "ANNUAL", hostname: dom }], domains: [{ name: dom, action: "register", years: 2 }] }), { userId });
  assert.equal(q2.lines.find((l) => l.kind === "domain")!.amount, 109900);
  // monthly billing doesn't qualify
  const q3 = await priceCart(cart({ items: [{ productId: p.slug, cycle: "MONTHLY", hostname: dom }], domains: [{ name: dom, action: "register", years: 1 }] }), { userId });
  assert.equal(q3.lines.find((l) => l.kind === "domain")!.amount, 89900);
  // .in isn't in the list
  const q4 = await priceCart(cart({ items: [{ productId: p.slug, cycle: "ANNUAL", hostname: `qa-${RUN}.in` }], domains: [{ name: `qa-${RUN}.in`, action: "register", years: 1 }] }), { userId });
  assert.equal(q4.lines.find((l) => l.kind === "domain")!.amount, 59900);
  // a domain for something else in the cart isn't free
  const q5 = await priceCart(cart({ items: [{ productId: p.slug, cycle: "ANNUAL", hostname: dom }], domains: [{ name: dom, action: "register", years: 1 }, { name: `other-${RUN}.com`, action: "register", years: 1 }] }), { userId });
  assert.deepEqual(q5.lines.filter((l) => l.kind === "domain").map((l) => l.amount), [0, 89900]);
});

test("checkout: hosting + free domain → service on the domain, domain at ₹0, one hosting per domain", async () => {
  const p = await plan("checkout", { freeDomain: "recurring", freeDomainCycles: [], freeDomainTlds: [] });
  const dom = `shop-${RUN}.in`;
  const r = await checkout({ userId, cart: cart({ items: [{ productId: p.slug, cycle: "ANNUAL", hostname: dom }], domains: [{ name: dom, action: "register", years: 1 }] }) });
  const svc = await prisma.service.findFirstOrThrow({ where: { orderId: r.orderId } });
  assert.equal(svc.hostname, dom);
  const d = await prisma.domain.findUniqueOrThrow({ where: { name: dom } });
  assert.equal(d.recurringAmount, 0, "free renewals while the plan is kept");
  const inv = await prisma.invoice.findUniqueOrThrow({ where: { id: r.invoiceId }, include: { items: true } });
  assert.equal(inv.items.find((i) => i.type === "DOMAIN")!.unitPrice, 0);
  // the same domain can't get a second hosting account
  await assert.rejects(checkout({ userId, cart: cart({ items: [{ productId: p.slug, cycle: "MONTHLY", hostname: dom }] }) }), /already has a hosting account/);
  await assert.rejects(checkout({ userId, cart: cart({ items: [{ productId: p.slug, cycle: "MONTHLY", hostname: `two-${RUN}.com` }, { productId: p.slug, cycle: "MONTHLY", hostname: `two-${RUN}.com` }] }) }), /in your cart twice/);

  // renewal: free while the plan is active, normal price once it's gone
  await prisma.service.update({ where: { id: svc.id }, data: { status: "ACTIVE" } });
  assert.deepEqual(await domainRenewalPrice(d), { amount: 0, freeWith: p.name });
  await prisma.service.update({ where: { id: svc.id }, data: { status: "TERMINATED" } });
  assert.deepEqual(await domainRenewalPrice(d), { amount: 79900 });
});
