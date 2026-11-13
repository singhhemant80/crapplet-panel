/**
 * UPI AutoPay through Cashfree subscriptions, against a stand-in Cashfree:
 * offer → ON_DEMAND subscription whose approval pays the invoice → back from Cashfree → mandate saved →
 * approval webhook doesn't pay twice → renewal CHARGE scheduled ≥ 24 h ahead → payment webhook pays it →
 * cancelled in the UPI app → never charged again.
 *   npx tsx --test test/autopay-cashfree.test.ts
 */
import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import crypto from "node:crypto";
import type { AddressInfo } from "node:net";
import { prisma } from "../src/db";

const RUN = Date.now().toString(36);
const KEY = { appId: "cf_app_" + RUN, secretKey: "cf_sec_" + RUN };
let base = "";
let app: http.Server;
let fake: http.Server;
let savedCf: { enabled: boolean; testMode: boolean; configEnc: string | null } | null = null;
let savedRz: { enabled: boolean } | null = null;
let savedAuto: unknown = null;
const calls: { method: string; path: string; body: any; headers: http.IncomingHttpHeaders }[] = [];
const SUBS: Record<string, any> = {};
const ids: Record<string, string> = {};

function startFake() {
  return new Promise<void>((resolve) => {
    fake = http.createServer((req, res) => {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        const body = raw ? JSON.parse(raw) : undefined;
        calls.push({ method: req.method!, path: req.url!, body, headers: req.headers });
        const send = (o: unknown) => { res.setHeader("content-type", "application/json"); res.end(JSON.stringify(o)); };
        if (req.method === "POST" && req.url === "/pg/subscriptions") return send({ subscription_id: body.subscription_id, cf_subscription_id: 9001, subscription_session_id: "sess_" + RUN, subscription_status: "INITIALIZED" });
        if (req.method === "POST" && req.url === "/pg/subscriptions/pay") return send({ cf_payment_id: `7001${RUN}`, payment_id: body.payment_id, payment_status: "INITIALIZED", payment_type: "CHARGE" });
        const m = /^\/pg\/subscriptions\/([^/]+)$/.exec(req.url!);
        if (req.method === "GET" && m && SUBS[m[1]]) return send(SUBS[m[1]]);
        if (/\/manage$/.test(req.url!)) return send({ subscription_status: "CANCELLED" });
        res.statusCode = 404;
        send({ message: "not found" });
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
/** Cashfree webhook: x-webhook-signature = base64(HMAC-SHA256(secret, timestamp + body)) */
async function webhook(a: Agent, payload: unknown) {
  const raw = JSON.stringify(payload);
  const ts = String(Math.floor(Date.now() / 1000));
  return a.req("POST", "/webhooks/cashfree", raw, { "x-webhook-timestamp": ts, "x-webhook-signature": crypto.createHmac("sha256", KEY.secretKey).update(ts + raw).digest("base64") });
}
async function invoiceFor(total: number, dueInDays: number) {
  const { createInvoice } = await import("../src/modules/billing/invoices");
  const inv = await prisma.$transaction((tx) => createInvoice(tx, { userId: ids.user, dueDate: new Date(Date.now() + dueInDays * 86400_000), items: [{ type: "SERVICE", relId: ids.service, description: "Linux VPS renewal", unitPrice: total, taxable: false }] } as never));
  return inv.id as string;
}

before(async () => {
  await startFake();
  process.env.CASHFREE_API_BASE = `http://127.0.0.1:${(fake.address() as AddressInfo).port}/pg`;
  const { createApp } = await import("../src/app");
  const { encryptJson } = await import("../src/lib/crypto");
  const { getSettings, updateSettings } = await import("../src/lib/settings");
  app = createApp().listen(0);
  base = `http://127.0.0.1:${(app.address() as AddressInfo).port}/api`;

  savedCf = await prisma.paymentGateway.findUnique({ where: { code: "cashfree" }, select: { enabled: true, testMode: true, configEnc: true } });
  savedRz = await prisma.paymentGateway.findUnique({ where: { code: "razorpay" }, select: { enabled: true } });
  await prisma.paymentGateway.upsert({ where: { code: "cashfree" }, update: { enabled: true, testMode: true, configEnc: encryptJson(KEY) }, create: { code: "cashfree", name: "Cashfree", enabled: true, testMode: true, configEnc: encryptJson(KEY) } });
  const s = await getSettings();
  savedAuto = { upiAutopay: s.automation.upiAutopay, autopayGateway: s.automation.autopayGateway };
  await updateSettings("automation", { upiAutopay: true, autopayGateway: "cashfree" });

  const bcrypt = (await import("bcryptjs")).default;
  ids.user = (await prisma.user.create({ data: { email: `cfap-${RUN}@t.test`, phone: "+91 98000 00001", passwordHash: await bcrypt.hash("Auto@12345", 10), firstName: "Cash", lastName: "Free", type: "CLIENT", status: "ACTIVE", profile: { create: { country: "IN", state: "Uttar Pradesh", stateCode: "09" } } } })).id;
  ids.group = (await prisma.productGroup.create({ data: { name: `QA CF ${RUN}`, slug: `qa-cf-${RUN}` } })).id;
  ids.product = (await prisma.product.create({ data: { groupId: ids.group, name: `QA CF VPS ${RUN}`, slug: `qa-cf-${RUN}`, type: "VPS_LINUX", provisioner: "MANUAL", autoSetup: "MANUAL" } })).id;
  ids.service = (await prisma.service.create({ data: { userId: ids.user, productId: ids.product, status: "ACTIVE", billingCycle: "MONTHLY", firstAmount: 47082, recurringAmount: 39900, currency: "INR" } })).id;
});

after(async () => {
  await prisma.payMethod.deleteMany({ where: { userId: ids.user } });
  await prisma.transaction.deleteMany({ where: { userId: ids.user } });
  await prisma.paymentIntent.deleteMany({ where: { userId: ids.user } });
  await prisma.webhookEvent.deleteMany({ where: { gateway: "cashfree", eventId: { contains: RUN } } });
  await prisma.invoiceItem.deleteMany({ where: { invoice: { userId: ids.user } } });
  await prisma.invoice.deleteMany({ where: { userId: ids.user } });
  await prisma.service.deleteMany({ where: { userId: ids.user } });
  await prisma.product.deleteMany({ where: { id: ids.product } });
  await prisma.productGroup.deleteMany({ where: { id: ids.group } });
  await prisma.activityLog.deleteMany({ where: { userId: ids.user } }).catch(() => undefined);
  await prisma.loginHistory.deleteMany({ where: { userId: ids.user } });
  await prisma.session.deleteMany({ where: { userId: ids.user } });
  await prisma.user.deleteMany({ where: { id: ids.user } });
  if (savedCf) await prisma.paymentGateway.update({ where: { code: "cashfree" }, data: savedCf });
  else await prisma.paymentGateway.delete({ where: { code: "cashfree" } });
  const { updateSettings } = await import("../src/lib/settings");
  await updateSettings("automation", savedAuto as never);
  app.close();
  fake.close();
  const { closeQueues } = await import("../src/jobs/queues");
  await closeQueues().catch(() => undefined);
  await prisma.$disconnect();
});

test("Cashfree AutoPay: approving the mandate pays the invoice, renewals are charged, cancelling stops it", async () => {
  const a = new Agent();
  assert.equal((await a.req("POST", "/auth/login", { email: `cfap-${RUN}@t.test`, password: "Auto@12345" })).status, 200);
  const first = await invoiceFor(47082, 7);

  const m = await a.req("GET", `/payments/methods?currency=INR&invoiceId=${first}`);
  assert.equal(m.json.methods[0].code, "cashfree_autopay");

  const start = await a.req("POST", "/payments/start", { invoiceId: first, gateway: "cashfree_autopay" });
  assert.equal(start.status, 200, JSON.stringify(start.json));
  assert.equal(start.json.type, "cashfree_subscription");
  assert.equal(start.json.subsSessionId, `sess_${RUN}`);
  const create = calls.find((c) => c.path === "/pg/subscriptions" && c.method === "POST")!;
  assert.equal(create.headers["x-api-version"], "2025-01-01");
  assert.equal(create.headers["x-client-id"], KEY.appId);
  assert.equal(create.body.plan_details.plan_type, "ON_DEMAND");
  assert.equal(create.body.plan_details.plan_max_amount, 1000);
  assert.deepEqual(create.body.authorization_details, { authorization_amount: 470.82, authorization_amount_refund: false, payment_methods: ["upi"] });
  assert.equal(create.body.customer_details.customer_phone, "9800000001");
  assert.match(create.body.subscription_meta.return_url, new RegExp(`/client/invoices/${first}\\?autopay=cashfree&intent=${start.json.intentId}$`));
  const subId = create.body.subscription_id as string;

  // back from Cashfree before the bank confirms → pending; once active → paid
  SUBS[subId] = { subscription_id: subId, subscription_status: "BANK_APPROVAL_PENDING", authorisation_details: { authorization_status: "PENDING" } };
  assert.equal((await a.req("POST", `/payments/${start.json.intentId}/verify`, {})).json.paid, false);
  SUBS[subId] = { subscription_id: subId, subscription_status: "ACTIVE", authorisation_details: { authorization_status: "ACTIVE", authorization_amount: 470.82 } };
  const v = await a.req("POST", `/payments/${start.json.intentId}/verify`, {});
  assert.equal(v.json.paid, true, JSON.stringify(v.json));
  assert.equal((await prisma.invoice.findUniqueOrThrow({ where: { id: first } })).status, "PAID");
  const pm = await prisma.payMethod.findUniqueOrThrow({ where: { externalId: subId } });
  assert.deepEqual([pm.gateway, pm.autopay, pm.status, pm.maxAmount], ["cashfree", true, "ACTIVE", 100_000]);

  // the approval webhook arriving afterwards doesn't pay twice
  const w1 = await webhook(a, { type: "SUBSCRIPTION_AUTH_STATUS", event_time: "x", data: { subscription_id: subId, payment_id: "auth_" + RUN, cf_payment_id: `6001${RUN}`, payment_status: "SUCCESS", payment_amount: 470.82, payment_type: "AUTH" } });
  assert.equal(w1.status, 200, JSON.stringify(w1.json));
  const inv1 = await prisma.invoice.findUniqueOrThrow({ where: { id: first } });
  assert.equal(inv1.amountPaid, 47082, "paid once");

  // renewal due in 2 days → a CHARGE scheduled at least 24 h out
  const renewal = await invoiceFor(47082, 2);
  const { runAutopay } = await import("../src/modules/payments/autopay");
  const r = await runAutopay();
  assert.equal(r.charged, 1, JSON.stringify(r));
  const pay = calls.find((c) => c.path === "/pg/subscriptions/pay")!;
  assert.equal(pay.body.subscription_id, subId);
  assert.equal(pay.body.payment_type, "CHARGE");
  assert.equal(pay.body.payment_amount, 470.82);
  assert.ok(new Date(pay.body.payment_schedule_date).getTime() >= Date.now() + 24 * 3600_000, "after the bank's 24 h notice");
  const charge = await prisma.paymentIntent.findFirstOrThrow({ where: { invoiceId: renewal } });
  assert.equal(charge.gatewayOrderId, pay.body.payment_id);

  const w2 = await webhook(a, { type: "SUBSCRIPTION_PAYMENT_SUCCESS", event_time: "y", data: { subscription_id: subId, payment_id: pay.body.payment_id, cf_payment_id: `7001${RUN}`, payment_status: "SUCCESS", payment_amount: 470.82, payment_type: "CHARGE" } });
  assert.equal(w2.status, 200, JSON.stringify(w2.json));
  assert.equal((await prisma.invoice.findUniqueOrThrow({ where: { id: renewal } })).status, "PAID");

  // cancelled from the UPI app
  const w3 = await webhook(a, { type: "SUBSCRIPTION_STATUS_CHANGED", event_time: "z", data: { subscription_details: { subscription_id: subId, subscription_status: "CUSTOMER_CANCELLED" } } });
  assert.equal(w3.status, 200);
  const after1 = await prisma.payMethod.findUniqueOrThrow({ where: { externalId: subId } });
  assert.deepEqual([after1.status, after1.autopay], ["REVOKED", false]);
  await invoiceFor(47082, 1);
  assert.equal((await runAutopay()).charged ?? 0, 0);
});

test("a failed Cashfree renewal is recorded and the customer turning AutoPay off cancels the subscription", async () => {
  const a = new Agent();
  await a.req("POST", "/auth/login", { email: `cfap-${RUN}@t.test`, password: "Auto@12345" });
  const { encrypt } = await import("../src/lib/crypto");
  const pm = await prisma.payMethod.create({ data: { userId: ids.user, type: "UPI", gateway: "cashfree", label: "UPI AutoPay (Cashfree)", externalId: `sub_manual_${RUN}`, tokenEnc: encrypt(JSON.stringify({ subscriptionId: `sub_manual_${RUN}` })), maxAmount: 100_000, autopay: true, status: "ACTIVE" } });
  const inv = await invoiceFor(30000, 1);
  const { runAutopay } = await import("../src/modules/payments/autopay");
  assert.ok((await runAutopay()).charged >= 1, "this invoice (and any other unpaid one) is charged to the new mandate");
  const charge = await prisma.paymentIntent.findFirstOrThrow({ where: { invoiceId: inv } });
  await webhook(a, { type: "SUBSCRIPTION_PAYMENT_FAILED", event_time: "f", data: { subscription_id: `sub_manual_${RUN}`, payment_id: charge.gatewayOrderId, cf_payment_id: `7002${RUN}`, payment_status: "FAILED", payment_amount: 300, payment_type: "CHARGE", failure_details: { failure_reason: "Insufficient balance" } } });
  const failed = await prisma.paymentIntent.findUniqueOrThrow({ where: { id: charge.id } });
  assert.equal(failed.status, "FAILED");
  assert.equal((failed.meta as any).error, "Insufficient balance");
  assert.equal((await prisma.invoice.findUniqueOrThrow({ where: { id: inv } })).status, "UNPAID");

  assert.equal((await a.req("DELETE", `/client/autopay/${pm.id}`)).status, 200);
  const manage = calls.find((c) => c.path === `/pg/subscriptions/sub_manual_${RUN}/manage`)!;
  assert.deepEqual(manage.body, { subscription_id: `sub_manual_${RUN}`, action: "CANCEL" });
  assert.equal((await prisma.payMethod.findUniqueOrThrow({ where: { id: pm.id } })).status, "REVOKED");
});
