/**
 * Reseller API v1 (what a reseller's own website uses): API key auth, plans, orders paid from the wallet,
 * idempotent references, services, invoices, signed webhooks, and white-label rules.
 *   npx tsx --test test/reseller-api.test.ts
 */
process.env.WEBHOOKS_ALLOW_LOCAL = "1";
import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import crypto from "node:crypto";
import type { AddressInfo } from "node:net";
import { prisma } from "../src/db";

const RUN = Date.now().toString(36);
let base = "";
let app: http.Server;
let hook: http.Server;
let hookUrl = "";
const received: { headers: http.IncomingHttpHeaders; body: string }[] = [];
const ids: Record<string, string> = {};
let KEY = "";

const call = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
  const r = await fetch(base + "/v1/reseller" + path, { method, headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json", ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  const t = await r.text();
  let json: any = null;
  try { json = JSON.parse(t); } catch { json = t; }
  return { status: r.status, json };
};
const waitFor = async (pred: () => boolean, ms = 4000) => { const end = Date.now() + ms; while (Date.now() < end) { if (pred()) return true; await new Promise((r) => setTimeout(r, 50)); } return false; };

before(async () => {
  const { createApp } = await import("../src/app");
  app = createApp().listen(0);
  base = `http://127.0.0.1:${(app.address() as AddressInfo).port}/api`;
  hook = http.createServer((req, res) => { let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => { received.push({ headers: req.headers, body: b }); res.writeHead(200).end("ok"); }); }).listen(0);
  hookUrl = `http://127.0.0.1:${(hook.address() as AddressInfo).port}/hook`;

  const bcrypt = (await import("bcryptjs")).default;
  ids.user = (await prisma.user.create({ data: { email: `rs-${RUN}@t.test`, passwordHash: await bcrypt.hash("Reseller@12345", 10), firstName: "Res", lastName: "Eller", type: "CLIENT", status: "ACTIVE", profile: { create: { country: "IN", state: "Uttar Pradesh", stateCode: "09" } } } })).id;
  ids.reseller = (await prisma.reseller.create({ data: { userId: ids.user, brandName: `HostBiz ${RUN}`, status: "APPROVED", discountPct: 10 } })).id;
  ids.group = (await prisma.productGroup.create({ data: { name: `QA RS ${RUN}`, slug: `qa-rs-${RUN}` } })).id;
  ids.plan = (await prisma.product.create({ data: { groupId: ids.group, name: `RS Plan ${RUN}`, slug: `qa-rs-${RUN}`, type: "CUSTOM", provisioner: "MANUAL", autoSetup: "MANUAL", taxable: false, resellerEnabled: true, pricing: { create: [{ currency: "INR", cycle: "MONTHLY", price: 50000 }] } } as never })).id;
  ids.hidden = (await prisma.product.create({ data: { groupId: ids.group, name: `Not for resale ${RUN}`, slug: `qa-rs-no-${RUN}`, type: "CUSTOM", provisioner: "MANUAL", autoSetup: "MANUAL", taxable: false, resellerEnabled: false, pricing: { create: [{ currency: "INR", cycle: "MONTHLY", price: 100 }] } } as never })).id;

  // the reseller creates a key in their dashboard (session) — scope "reseller"
  const login = await fetch(`${base}/auth/login`, { method: "POST", headers: { "Content-Type": "application/json", "X-Requested-With": "crapplet" }, body: JSON.stringify({ email: `rs-${RUN}@t.test`, password: "Reseller@12345" }) });
  const cookie = login.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
  const k = await fetch(`${base}/auth/api-keys`, { method: "POST", headers: { "Content-Type": "application/json", "X-Requested-With": "crapplet", Cookie: cookie }, body: JSON.stringify({ name: "website", scopes: ["reseller"] }) });
  KEY = (await k.json()).key;
  assert.match(KEY, /^ck_/);
});

after(async () => {
  const u = ids.user;
  await prisma.serviceUpgrade.deleteMany({ where: { userId: u } }).catch(() => undefined);
  await prisma.transaction.deleteMany({ where: { userId: u } });
  await prisma.paymentIntent.deleteMany({ where: { userId: u } });
  await prisma.invoiceItem.deleteMany({ where: { invoice: { userId: u } } });
  await prisma.invoice.deleteMany({ where: { userId: u } });
  await prisma.provisioningLog.deleteMany({ where: { service: { userId: u } } });
  await prisma.service.deleteMany({ where: { userId: u } });
  await prisma.order.deleteMany({ where: { userId: u } });
  await prisma.user.deleteMany({ where: { ownerResellerId: ids.reseller } });
  await prisma.apiKey.deleteMany({ where: { userId: u } });
  await prisma.reseller.deleteMany({ where: { id: ids.reseller } });
  await prisma.product.deleteMany({ where: { id: { in: [ids.plan, ids.hidden] } } });
  await prisma.productGroup.deleteMany({ where: { id: ids.group } });
  await prisma.activityLog.deleteMany({ where: { OR: [{ userId: u }, { actorId: u }] } }).catch(() => undefined);
  await prisma.loginHistory.deleteMany({ where: { userId: u } });
  await prisma.session.deleteMany({ where: { userId: u } });
  await prisma.creditLedger.deleteMany({ where: { userId: u } });
  await prisma.user.deleteMany({ where: { id: u } });
  app.close();
  hook.close();
  const { closeQueues } = await import("../src/jobs/queues");
  await closeQueues().catch(() => undefined);
  await prisma.$disconnect();
});

test("API key: account, plans (only resale ones), no key → 401", async () => {
  const me = await call("GET", "/me");
  assert.equal(me.status, 200, JSON.stringify(me.json));
  assert.equal(me.json.reseller.discountPct, 10);
  assert.equal(me.json.wallet.balance, 0);
  const plans = await call("GET", "/plans");
  const p = plans.json.plans.find((x: any) => x.id === ids.plan);
  assert.ok(p, "resale plan listed");
  assert.equal(p.category, "other");
  assert.equal(p.prices[0].wholesale, 45000, "10% reseller discount");
  assert.ok(!plans.json.plans.some((x: any) => x.id === ids.hidden), "plans not for resale are hidden");
  const anon = await fetch(base + "/v1/reseller/me");
  assert.equal(anon.status, 401);
  const bad = await fetch(base + "/v1/reseller/me", { headers: { Authorization: "Bearer ck_nope_nope" } });
  assert.equal(bad.status, 401);
});

test("order: short wallet → 402 with invoice; top up + pay → paid; same reference never orders twice", async () => {
  const ref = `web-${RUN}-1`;
  const o = await call("POST", "/orders", { planId: ids.plan, hostname: `cust1-${RUN}.example.com`, reference: ref, retailAmount: 79900 });
  assert.equal(o.status, 402, JSON.stringify(o.json));
  assert.equal(o.json.code, "INSUFFICIENT_FUNDS");
  assert.ok(o.json.invoiceId && o.json.serviceId);
  assert.equal(o.json.amount, 45000);

  // retry with the same reference (e.g. their website timed out) → same order back
  const again = await call("POST", "/orders", { planId: ids.plan, hostname: `cust1-${RUN}.example.com`, reference: ref });
  assert.equal(again.status, 200);
  assert.equal(again.json.duplicate, true);
  assert.equal(again.json.serviceId, o.json.serviceId);
  assert.equal(await prisma.service.count({ where: { userId: ids.user } }), 1);

  const short = await call("POST", `/invoices/${o.json.invoiceId}/pay`);
  assert.equal(short.status, 402);

  const { adjustCredit } = await import("../src/modules/billing/invoices");
  await adjustCredit(prisma, { userId: ids.user, amount: 200000, description: "Top-up", refType: "test", refId: RUN });
  const pay = await call("POST", `/invoices/${o.json.invoiceId}/pay`);
  assert.equal(pay.status, 200, JSON.stringify(pay.json));
  assert.equal(pay.json.paid, true);
  const inv = await call("GET", `/invoices/${o.json.invoiceId}`);
  assert.equal(inv.json.invoice.status, "PAID");
  assert.equal(inv.json.invoice.items[0].serviceId, o.json.serviceId);
  assert.equal((await call("GET", "/wallet")).json.balance, 155000);

  // with money in the wallet an order is paid at once (Idempotency-Key header works too)
  const o2 = await call("POST", "/orders", { planId: ids.plan, hostname: `cust2-${RUN}.example.com` }, { "Idempotency-Key": `web-${RUN}-2` });
  assert.equal(o2.status, 201, JSON.stringify(o2.json));
  assert.equal(o2.json.paid, true);
  const list = await call("GET", `/services?reference=web-${RUN}-2`);
  assert.equal(list.json.services.length, 1);
  assert.equal(list.json.services[0].id, o2.json.serviceId);

  assert.equal((await call("POST", "/orders", { planId: ids.hidden, hostname: "x.example.com" })).status, 404, "can't order plans that aren't for resale");
});

test("customers belong to the reseller: never mailed by us, can't sign in to our panel", async () => {
  const c = await call("POST", "/customers", { email: `endcust-${RUN}@t.test`, firstName: "End", lastName: "Customer" });
  assert.equal(c.status, 201, JSON.stringify(c.json));
  const bcrypt = (await import("bcryptjs")).default;
  await prisma.user.update({ where: { id: c.json.customer.id }, data: { passwordHash: await bcrypt.hash("Known@12345", 10) } });
  const login = await fetch(`${base}/auth/login`, { method: "POST", headers: { "Content-Type": "application/json", "X-Requested-With": "crapplet" }, body: JSON.stringify({ email: `endcust-${RUN}@t.test`, password: "Known@12345" }) });
  assert.equal(login.status, 401, "white-label: their customers never log in here");
  const { audienceSchema, audienceWhere } = await import("../src/modules/campaigns/service");
  assert.equal(await prisma.user.count({ where: { AND: [audienceWhere(audienceSchema.parse({ includeInactive: true, includeClosed: true }), "INFO"), { id: c.json.customer.id }] } }), 0, "not in our email campaigns");
});

test("webhooks: https only, signed events when a service changes, test delivery", async () => {
  assert.equal((await call("PUT", "/webhook", { url: "not a url" })).status, 400);
  const set = await call("PUT", "/webhook", { url: hookUrl });
  assert.equal(set.status, 200, JSON.stringify(set.json));
  const secret = set.json.secret as string;
  assert.match(secret, /^whsec_/);

  const t = await call("POST", "/webhook/test");
  assert.match(t.json.lastDelivery, /delivered \(200\)/);
  const ev = received.at(-1)!;
  const ts = String(ev.headers["x-crapplet-timestamp"]);
  const expected = `sha256=${crypto.createHmac("sha256", secret).update(`${ts}.${ev.body}`).digest("hex")}`;
  assert.equal(ev.headers["x-crapplet-signature"], expected, "signature verifies with the secret");
  assert.equal(JSON.parse(ev.body).event, "service.active");

  // a real change: the reseller's service is suspended then restored
  const svc = await prisma.service.findFirstOrThrow({ where: { userId: ids.user, resellerRef: `web-${RUN}-1` } });
  await prisma.service.update({ where: { id: svc.id }, data: { status: "ACTIVE" } });
  const n = received.length;
  const { runProvisionAction } = await import("../src/modules/provisioning/provisioner");
  await runProvisionAction(svc.id, "suspend", { reason: "Reseller: unpaid" });
  assert.ok(await waitFor(() => received.slice(n).some((r) => JSON.parse(r.body).event === "service.suspended")), "service.suspended delivered");
  const body = JSON.parse(received.slice(n).find((r) => JSON.parse(r.body).event === "service.suspended")!.body);
  assert.equal(body.data.id, svc.id);
  assert.equal(body.data.reference, `web-${RUN}-1`);
  await runProvisionAction(svc.id, "unsuspend", {});
  assert.ok(await waitFor(() => received.slice(n).some((r) => JSON.parse(r.body).event === "service.unsuspended")));

  // paying an invoice is announced too
  const o3 = await call("POST", "/orders", { planId: ids.plan, hostname: `cust3-${RUN}.example.com`, reference: `web-${RUN}-3` });
  assert.equal(o3.status, 201);
  assert.ok(await waitFor(() => received.some((r) => JSON.parse(r.body).event === "invoice.paid" && JSON.parse(r.body).data.id === o3.json.invoiceId)), "invoice.paid delivered");

  const off = await call("DELETE", "/webhook");
  assert.equal(off.status, 200);
  assert.equal((await call("GET", "/webhook")).json.url, null);
});

test("services: details, cancel a pending one", async () => {
  const s = (await call("GET", `/services?reference=web-${RUN}-2`)).json.services[0];
  const one = await call("GET", `/services/${s.id}`);
  assert.equal(one.status, 200);
  assert.equal(one.json.service.reference, `web-${RUN}-2`);
  assert.equal(one.json.service.wholesaleAmount, 45000);
  const del = await call("DELETE", `/services/${s.id}`);
  assert.equal(del.status, 200, JSON.stringify(del.json));
  assert.equal(del.json.status, "CANCELLED");
  assert.equal((await call("GET", `/services/does-not-exist`)).status, 404);
});

test("webhook URLs can't point at our own network (SSRF) or use plain http", async () => {
  const { assertPublicHttps } = await import("../src/modules/reseller/webhooks");
  const saved = process.env.WEBHOOKS_ALLOW_LOCAL;
  delete process.env.WEBHOOKS_ALLOW_LOCAL;
  try {
    for (const u of ["http://example.com/hook", "https://127.0.0.1/hook", "https://10.0.0.5/hook", "https://192.168.1.1/x", "https://169.254.169.254/latest/meta-data", "https://[::1]/x", "https://user:pw@example.com/x"]) {
      await assert.rejects(assertPublicHttps(u), (e: any) => e.status === 400, u);
    }
    assert.equal(await assertPublicHttps("https://93.184.215.14/hook"), "https://93.184.215.14/hook", "a public address is fine");
  } finally {
    process.env.WEBHOOKS_ALLOW_LOCAL = saved;
  }
});
