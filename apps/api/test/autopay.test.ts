/**
 * UPI AutoPay (Razorpay) end to end against a stand-in Razorpay:
 * offer → payment that registers the mandate → mandate saved → renewal charged before it's due →
 * webhook pays the invoice → limit respected → token.cancelled stops it.
 *   npx tsx --test test/autopay.test.ts
 */
import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import crypto from "node:crypto";
import type { AddressInfo } from "node:net";
import { prisma } from "../src/db";

const RUN = Date.now().toString(36);
const KEY = { keyId: "rzp_test_x", keySecret: "sek_" + RUN, webhookSecret: "whk_" + RUN };
let base = "";
let app: http.Server;
let fake: http.Server;
let saved: { enabled: boolean; testMode: boolean; configEnc: string | null } | null = null;
const calls: { method: string; path: string; body: any }[] = [];
const ids: Record<string, string> = {};
let n = 0;

// ── stand-in Razorpay ──
const PAYMENTS: Record<string, any> = {};
function startFake() {
  return new Promise<void>((resolve) => {
    fake = http.createServer((req, res) => {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        const body = raw ? JSON.parse(raw) : undefined;
        calls.push({ method: req.method!, path: req.url!, body });
        const send = (o: unknown) => { res.setHeader("content-type", "application/json"); res.end(JSON.stringify(o)); };
        if (req.url === "/v1/customers") return send({ id: "cust_" + RUN });
        if (req.url === "/v1/orders") return send({ id: `order_${RUN}_${++n}` });
        if (req.url === "/v1/payments/create/recurring") return send({ razorpay_payment_id: `pay_rec_${RUN}_${n}`, razorpay_order_id: body.order_id });
        const m = /^\/v1\/payments\/([^/]+)$/.exec(req.url!);
        if (m && PAYMENTS[m[1]]) return send(PAYMENTS[m[1]]);
        if (/\/tokens\/.+\/cancel$/.test(req.url!)) return send({ deleted: true });
        res.statusCode = 404;
        send({ error: { description: "not found" } });
      });
    });
    fake.listen(0, () => resolve());
  });
}

class Agent {
  cookies: Record<string, string> = {};
  async req(method: string, path: string, body?: unknown, extra: Record<string, string> = {}) {
    const res = await fetch(base + path, { method, headers: { "Content-Type": "application/json", "X-Requested-With": "crapplet", ...extra, Cookie: Object.entries(this.cookies).map(([k, v]) => `${k}=${v}`).join("; ") }, body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body) });
    for (const c of res.headers.getSetCookie()) { const [k, v] = c.split(";")[0].split("="); if (v) this.cookies[k] = v; }
    const t = await res.text();
    let json: any = null;
    try { json = JSON.parse(t); } catch { json = t; }
    return { status: res.status, json };
  }
}
const hmac = (secret: string, s: string) => crypto.createHmac("sha256", secret).update(s).digest("hex");

async function invoiceFor(total: number, dueInDays: number) {
  const { createInvoice } = await import("../src/modules/billing/invoices");
  const inv = await prisma.$transaction((tx) => createInvoice(tx, { userId: ids.user, dueDate: new Date(Date.now() + dueInDays * 86400_000), items: [{ type: "SERVICE", relId: ids.service, description: "Linux VPS G1 renewal", unitPrice: total, taxable: false }] } as never));
  return inv.id as string;
}

before(async () => {
  await startFake();
  process.env.RAZORPAY_API_BASE = `http://127.0.0.1:${(fake.address() as AddressInfo).port}/v1`;
  const { createApp } = await import("../src/app");
  const { encryptJson } = await import("../src/lib/crypto");
  app = createApp().listen(0);
  base = `http://127.0.0.1:${(app.address() as AddressInfo).port}/api`;

  saved = await prisma.paymentGateway.findUnique({ where: { code: "razorpay" }, select: { enabled: true, testMode: true, configEnc: true } });
  await prisma.paymentGateway.upsert({ where: { code: "razorpay" }, update: { enabled: true, configEnc: encryptJson(KEY) }, create: { code: "razorpay", name: "Razorpay", enabled: true, configEnc: encryptJson(KEY) } });

  const bcrypt = (await import("bcryptjs")).default;
  ids.user = (await prisma.user.create({ data: { email: `ap-${RUN}@t.test`, phone: "+919800000000", passwordHash: await bcrypt.hash("Auto@12345", 10), firstName: "Auto", lastName: "Pay", type: "CLIENT", status: "ACTIVE", profile: { create: { country: "IN", state: "Uttar Pradesh", stateCode: "09" } } } })).id;
  ids.group = (await prisma.productGroup.create({ data: { name: `QA AP ${RUN}`, slug: `qa-ap-${RUN}` } })).id;
  ids.product = (await prisma.product.create({ data: { groupId: ids.group, name: `QA AP VPS ${RUN}`, slug: `qa-ap-${RUN}`, type: "VPS_LINUX", provisioner: "MANUAL", autoSetup: "MANUAL" } })).id;
  ids.service = (await prisma.service.create({ data: { userId: ids.user, productId: ids.product, status: "ACTIVE", billingCycle: "MONTHLY", firstAmount: 47082, recurringAmount: 39900, currency: "INR" } })).id;
});

after(async () => {
  await prisma.payMethod.deleteMany({ where: { userId: ids.user } });
  await prisma.transaction.deleteMany({ where: { userId: ids.user } });
  await prisma.paymentIntent.deleteMany({ where: { userId: ids.user } });
  await prisma.webhookEvent.deleteMany({ where: { gateway: "razorpay", eventId: { contains: RUN } } });
  await prisma.invoiceItem.deleteMany({ where: { invoice: { userId: ids.user } } });
  await prisma.invoice.deleteMany({ where: { userId: ids.user } });
  await prisma.service.deleteMany({ where: { userId: ids.user } });
  await prisma.product.deleteMany({ where: { id: ids.product } });
  await prisma.productGroup.deleteMany({ where: { id: ids.group } });
  await prisma.activityLog.deleteMany({ where: { userId: ids.user } }).catch(() => undefined);
  await prisma.loginHistory.deleteMany({ where: { userId: ids.user } });
  await prisma.session.deleteMany({ where: { userId: ids.user } });
  await prisma.creditLedger.deleteMany({ where: { userId: ids.user } });
  await prisma.user.deleteMany({ where: { id: ids.user } });
  if (saved) await prisma.paymentGateway.update({ where: { code: "razorpay" }, data: saved });
  else await prisma.paymentGateway.delete({ where: { code: "razorpay" } });
  app.close();
  fake.close();
  const { closeQueues } = await import("../src/jobs/queues");
  await closeQueues().catch(() => undefined);
  await prisma.$disconnect();
});

test("paying a renewing service with UPI AutoPay sets up the mandate, and renewals are charged to it", async () => {
  const a = new Agent();
  assert.equal((await a.req("POST", "/auth/login", { email: `ap-${RUN}@t.test`, password: "Auto@12345" })).status, 200);
  const first = await invoiceFor(47082, 7);

  // offered first, recommended
  const m = await a.req("GET", `/payments/methods?currency=INR&invoiceId=${first}`);
  assert.equal(m.json.methods[0].code, "razorpay_autopay");
  assert.equal(m.json.methods[0].recommended, true);

  // the payment that registers the mandate
  const start = await a.req("POST", "/payments/start", { invoiceId: first, gateway: "razorpay_autopay" });
  assert.equal(start.status, 200, JSON.stringify(start.json));
  assert.equal(start.json.recurring, 1);
  assert.equal(start.json.customerId, `cust_${RUN}`);
  const order = calls.find((c) => c.path === "/v1/orders" && c.body?.method === "upi")!.body;
  assert.equal(order.amount, 47082);
  assert.equal(order.customer_id, `cust_${RUN}`);
  assert.equal(order.token.frequency, "as_presented");
  assert.equal(order.token.max_amount, 100_000, "₹1,000 limit for a ₹470.82 invoice");

  // Razorpay Checkout → handler → verify
  const pay = `pay_${RUN}`;
  PAYMENTS[pay] = { id: pay, order_id: start.json.orderId, amount: 47082, currency: "INR", status: "captured", token_id: `token_${RUN}`, customer_id: `cust_${RUN}`, vpa: "auto@okhdfc" };
  const v = await a.req("POST", `/payments/${start.json.intentId}/verify`, { razorpay_order_id: start.json.orderId, razorpay_payment_id: pay, razorpay_signature: hmac(KEY.keySecret, `${start.json.orderId}|${pay}`) });
  assert.equal(v.json.paid, true, JSON.stringify(v.json));
  assert.equal((await prisma.invoice.findUniqueOrThrow({ where: { id: first } })).status, "PAID");
  const pm = await prisma.payMethod.findUniqueOrThrow({ where: { externalId: `token_${RUN}` } });
  assert.deepEqual([pm.autopay, pm.status, pm.type, pm.maxAmount, pm.label], [true, "ACTIVE", "UPI", 100_000, "UPI AutoPay — auto@okhdfc"]);

  // the customer sees it; the next invoice isn't offered AutoPay again
  const list = await a.req("GET", "/client/autopay");
  assert.equal(list.json.methods.length, 1);
  assert.equal(list.json.methods[0].tokenEnc, undefined, "token never sent to the browser");

  // renewal: due in 2 days → charged now; due in 9 days → not yet
  const renewal = await invoiceFor(47082, 2);
  const later = await invoiceFor(47082, 9);
  const m2 = await a.req("GET", `/payments/methods?currency=INR&invoiceId=${renewal}`);
  assert.notEqual(m2.json.methods[0].code, "razorpay_autopay");
  assert.equal(m2.json.autopay.label, "UPI AutoPay — auto@okhdfc");
  const { runAutopay } = await import("../src/modules/payments/autopay");
  const r1 = await runAutopay();
  assert.equal(r1.charged, 1, JSON.stringify(r1));
  const rec = calls.find((c) => c.path === "/v1/payments/create/recurring")!.body;
  assert.deepEqual([rec.token, rec.customer_id, rec.amount, rec.recurring, rec.email], [`token_${RUN}`, `cust_${RUN}`, 47082, "1", `ap-${RUN}@t.test`]);
  const charge = await prisma.paymentIntent.findFirstOrThrow({ where: { invoiceId: renewal } });
  assert.equal((await runAutopay()).charged, 0, "one charge in flight per invoice");
  assert.equal(await prisma.paymentIntent.count({ where: { invoiceId: later } }), 0);

  // Razorpay debits ~25 h later → webhook pays the invoice
  const evt = JSON.stringify({ event: "payment.captured", payload: { payment: { entity: { id: `pay_r_${RUN}`, order_id: charge.gatewayOrderId, amount: 47082, currency: "INR", status: "captured", token_id: `token_${RUN}` } } }, created_at: 1 });
  const wh = await a.req("POST", "/webhooks/razorpay", evt, { "x-razorpay-signature": hmac(KEY.webhookSecret, evt), "x-razorpay-event-id": `evt_cap_${RUN}` });
  assert.equal(wh.status, 200, JSON.stringify(wh.json));
  assert.equal((await prisma.invoice.findUniqueOrThrow({ where: { id: renewal } })).status, "PAID");
});

test("above the approved limit the customer pays themselves; a cancelled mandate is never charged", async () => {
  const big = await invoiceFor(150_000, 1);
  const { runAutopay } = await import("../src/modules/payments/autopay");
  const before = calls.filter((c) => c.path === "/v1/payments/create/recurring").length;
  await runAutopay();
  assert.equal(calls.filter((c) => c.path === "/v1/payments/create/recurring").length, before, "₹1,500 > ₹1,000 limit — not charged");
  assert.equal((await prisma.paymentIntent.findFirstOrThrow({ where: { invoiceId: big } })).status, "FAILED");

  // cancelled from the UPI app
  const evt = JSON.stringify({ event: "token.cancelled", payload: { token: { entity: { id: `token_${RUN}` } } }, created_at: 2 });
  const a = new Agent();
  assert.equal((await a.req("POST", "/webhooks/razorpay", evt, { "x-razorpay-signature": hmac(KEY.webhookSecret, evt), "x-razorpay-event-id": `evt_tok_${RUN}` })).status, 200);
  const pm = await prisma.payMethod.findUniqueOrThrow({ where: { externalId: `token_${RUN}` } });
  assert.deepEqual([pm.status, pm.autopay], ["REVOKED", false]);
  await invoiceFor(47082, 1);
  const r = await runAutopay();
  assert.equal(r.charged ?? 0, 0);
});

test("an invoice without renewals isn't offered AutoPay; a bad webhook signature is refused", async () => {
  const a = new Agent();
  await a.req("POST", "/auth/login", { email: `ap-${RUN}@t.test`, password: "Auto@12345" });
  const { createInvoice } = await import("../src/modules/billing/invoices");
  const topup = await prisma.$transaction((tx) => createInvoice(tx, { userId: ids.user, isWalletTopup: true, items: [{ type: "WALLET", description: "top-up", unitPrice: 10000, taxable: false }] } as never));
  const m = await a.req("GET", `/payments/methods?currency=INR&invoiceId=${topup.id}`);
  assert.ok(!m.json.methods.some((x: any) => x.code === "razorpay_autopay"));
  assert.equal((await a.req("POST", "/payments/start", { invoiceId: topup.id, gateway: "razorpay_autopay" })).status, 400);
  const evt = JSON.stringify({ event: "token.confirmed", payload: { token: { entity: { id: "token_forged" } } } });
  assert.equal((await a.req("POST", "/webhooks/razorpay", evt, { "x-razorpay-signature": "deadbeef" })).status, 400);
});
