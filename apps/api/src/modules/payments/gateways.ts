/**
 * Payment gateway adapters. Each adapter:
 *  - creates a payment session for a PaymentIntent
 *  - verifies browser returns server-side (signature + gateway API lookup)
 *  - verifies and parses webhooks (signature over the raw body)
 * Services are only activated after a verified, idempotent applyPayment().
 */
import crypto from "crypto";
import { request } from "undici";
import QRCode from "qrcode";
import { config } from "../../config";
import { hmacHex, safeEqual } from "../../lib/crypto";
import { HttpError } from "../../lib/http";

export interface IntentLike {
  id: string;
  amount: number;
  currency: string;
  invoiceId: string;
  gatewayOrderId?: string | null;
}
export interface Payer {
  id: string;
  name: string;
  email: string;
  phone?: string | null;
}
export interface Verified {
  intentId?: string;
  gatewayOrderId?: string;
  gatewayTxnId: string;
  amount: number;
  paid: boolean;
  fee?: number;
  raw?: unknown;
}
export interface WebhookResult {
  eventId: string;
  type: string;
  payments: Verified[];
}
export type GatewayConfig = Record<string, string>;
export interface PublicGatewayConfig {
  [k: string]: unknown;
}

export interface Gateway {
  code: string;
  name: string;
  offline?: boolean;
  createPayment(intent: IntentLike, payer: Payer, cfg: GatewayConfig, pub: PublicGatewayConfig, testMode: boolean, label: string): Promise<{ gatewayOrderId?: string; client: Record<string, unknown> }>;
  verifyReturn?(body: Record<string, unknown>, cfg: GatewayConfig, testMode: boolean, intent: IntentLike): Promise<Verified>;
  parseWebhook?(raw: Buffer, headers: Record<string, string | string[] | undefined>, cfg: GatewayConfig, testMode: boolean): Promise<WebhookResult>;
  refund?(gatewayTxnId: string, amount: number, cfg: GatewayConfig, testMode: boolean): Promise<{ refundId: string }>;
}

const h = (headers: Record<string, string | string[] | undefined>, k: string) => {
  const v = headers[k.toLowerCase()];
  return Array.isArray(v) ? v[0] : v ?? "";
};

async function httpJson<T>(url: string, init: { method: string; headers?: Record<string, string>; body?: string }): Promise<T> {
  const res = await request(url, { method: init.method as "GET", headers: init.headers, body: init.body });
  const text = await res.body.text();
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text };
  }
  if (res.statusCode >= 400) throw new HttpError(502, `Gateway error (${res.statusCode}): ${text.slice(0, 300)}`, "GATEWAY_ERROR");
  return json as T;
}

// ───────────────────────── Razorpay ─────────────────────────
const razorpay: Gateway = {
  code: "razorpay",
  name: "Razorpay (UPI, Cards, Netbanking, Wallets)",
  async createPayment(intent, payer, cfg, _pub, _t, label) {
    const auth = "Basic " + Buffer.from(`${cfg.keyId}:${cfg.keySecret}`).toString("base64");
    const order = await httpJson<{ id: string }>("https://api.razorpay.com/v1/orders", {
      method: "POST",
      headers: { Authorization: auth, "Content-Type": "application/json" },
      body: JSON.stringify({ amount: intent.amount, currency: intent.currency, receipt: intent.id, notes: { intentId: intent.id, invoiceId: intent.invoiceId } }),
    });
    return {
      gatewayOrderId: order.id,
      client: { type: "razorpay", keyId: cfg.keyId, orderId: order.id, amount: intent.amount, currency: intent.currency, description: label, prefill: { name: payer.name, email: payer.email, contact: payer.phone ?? "" } },
    };
  },
  async verifyReturn(body, cfg, _t, intent) {
    const orderId = String(body.razorpay_order_id ?? "");
    const paymentId = String(body.razorpay_payment_id ?? "");
    const sig = String(body.razorpay_signature ?? "");
    if (!orderId || !paymentId || !sig || orderId !== intent.gatewayOrderId) throw new HttpError(400, "Invalid Razorpay response");
    if (!safeEqual(hmacHex("sha256", cfg.keySecret, `${orderId}|${paymentId}`), sig)) throw new HttpError(400, "Razorpay signature mismatch");
    // double-check with Razorpay's API that the payment is captured for this order
    const auth = "Basic " + Buffer.from(`${cfg.keyId}:${cfg.keySecret}`).toString("base64");
    const p = await httpJson<{ id: string; order_id: string; amount: number; status: string; fee?: number }>(`https://api.razorpay.com/v1/payments/${paymentId}`, { method: "GET", headers: { Authorization: auth } });
    if (p.order_id !== orderId) throw new HttpError(400, "Payment does not belong to this order");
    return { gatewayOrderId: orderId, gatewayTxnId: p.id, amount: p.amount, paid: p.status === "captured", fee: p.fee ?? 0, raw: p };
  },
  async parseWebhook(raw, headers, cfg) {
    const sig = h(headers, "x-razorpay-signature");
    if (!cfg.webhookSecret || !sig || !safeEqual(hmacHex("sha256", cfg.webhookSecret, raw), sig)) throw new HttpError(400, "Invalid webhook signature");
    const evt = JSON.parse(raw.toString("utf8"));
    const eventId = h(headers, "x-razorpay-event-id") || `${evt.event}:${evt.payload?.payment?.entity?.id ?? evt.created_at}`;
    const payments: Verified[] = [];
    if (evt.event === "payment.captured" || evt.event === "order.paid") {
      const p = evt.payload.payment.entity;
      payments.push({ gatewayOrderId: p.order_id, gatewayTxnId: p.id, amount: p.amount, paid: p.status === "captured", fee: p.fee ?? 0, raw: p });
    }
    return { eventId, type: evt.event, payments };
  },
  async refund(txnId, amount, cfg) {
    const auth = "Basic " + Buffer.from(`${cfg.keyId}:${cfg.keySecret}`).toString("base64");
    const r = await httpJson<{ id: string }>(`https://api.razorpay.com/v1/payments/${txnId}/refund`, { method: "POST", headers: { Authorization: auth, "Content-Type": "application/json" }, body: JSON.stringify({ amount }) });
    return { refundId: r.id };
  },
};

// ───────────────────────── Stripe ─────────────────────────
const stripe: Gateway = {
  code: "stripe",
  name: "Stripe (International cards)",
  async createPayment(intent, payer, cfg, _pub, _t, label) {
    const f = new URLSearchParams({
      mode: "payment",
      client_reference_id: intent.id,
      customer_email: payer.email,
      success_url: `${config.appUrl}/client/invoices/${intent.invoiceId}?gateway=stripe&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${config.appUrl}/client/invoices/${intent.invoiceId}?cancelled=1`,
      "line_items[0][quantity]": "1",
      "line_items[0][price_data][currency]": intent.currency.toLowerCase(),
      "line_items[0][price_data][unit_amount]": String(intent.amount),
      "line_items[0][price_data][product_data][name]": label,
      "metadata[intentId]": intent.id,
      "payment_intent_data[metadata][intentId]": intent.id,
    });
    const s = await httpJson<{ id: string; url: string }>("https://api.stripe.com/v1/checkout/sessions", {
      method: "POST",
      headers: { Authorization: `Bearer ${cfg.secretKey}`, "Content-Type": "application/x-www-form-urlencoded" },
      body: f.toString(),
    });
    return { gatewayOrderId: s.id, client: { type: "redirect", url: s.url } };
  },
  async verifyReturn(body, cfg, _t, intent) {
    const sid = String(body.session_id ?? "");
    if (!sid || sid !== intent.gatewayOrderId) throw new HttpError(400, "Invalid Stripe session");
    const s = await httpJson<{ id: string; payment_status: string; amount_total: number; payment_intent: string; client_reference_id: string }>(`https://api.stripe.com/v1/checkout/sessions/${sid}`, {
      method: "GET",
      headers: { Authorization: `Bearer ${cfg.secretKey}` },
    });
    return { intentId: s.client_reference_id, gatewayOrderId: s.id, gatewayTxnId: s.payment_intent, amount: s.amount_total, paid: s.payment_status === "paid", raw: s };
  },
  async parseWebhook(raw, headers, cfg) {
    const header = h(headers, "stripe-signature");
    const parts = Object.fromEntries(header.split(",").map((kv) => kv.split("=") as [string, string]));
    const t = parts.t;
    const v1s = header.split(",").filter((x) => x.startsWith("v1=")).map((x) => x.slice(3));
    if (!t || !v1s.length || !cfg.webhookSecret) throw new HttpError(400, "Invalid Stripe signature");
    if (Math.abs(Date.now() / 1000 - Number(t)) > 300) throw new HttpError(400, "Stale Stripe webhook");
    const expected = hmacHex("sha256", cfg.webhookSecret, `${t}.${raw.toString("utf8")}`);
    if (!v1s.some((v) => safeEqual(v, expected))) throw new HttpError(400, "Invalid Stripe signature");
    const evt = JSON.parse(raw.toString("utf8"));
    const payments: Verified[] = [];
    if (evt.type === "checkout.session.completed" || evt.type === "checkout.session.async_payment_succeeded") {
      const s = evt.data.object;
      payments.push({ intentId: s.client_reference_id, gatewayOrderId: s.id, gatewayTxnId: s.payment_intent, amount: s.amount_total, paid: s.payment_status === "paid", raw: s });
    }
    return { eventId: evt.id, type: evt.type, payments };
  },
  async refund(txnId, amount, cfg) {
    const r = await httpJson<{ id: string }>("https://api.stripe.com/v1/refunds", {
      method: "POST",
      headers: { Authorization: `Bearer ${cfg.secretKey}`, "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ payment_intent: txnId, amount: String(amount) }).toString(),
    });
    return { refundId: r.id };
  },
};

// ───────────────────────── Cashfree (PG API 2023-08-01) ─────────────────────────
const cfBase = (test: boolean) => (test ? "https://sandbox.cashfree.com/pg" : "https://api.cashfree.com/pg");
const cfHeaders = (cfg: GatewayConfig) => ({ "x-client-id": cfg.appId, "x-client-secret": cfg.secretKey, "x-api-version": "2023-08-01", "Content-Type": "application/json" });
const cashfree: Gateway = {
  code: "cashfree",
  name: "Cashfree (UPI, Cards, Netbanking)",
  async createPayment(intent, payer, cfg, _pub, test) {
    const o = await httpJson<{ order_id: string; payment_session_id: string }>(`${cfBase(test)}/orders`, {
      method: "POST",
      headers: cfHeaders(cfg),
      body: JSON.stringify({
        order_id: intent.id,
        order_amount: intent.amount / 100,
        order_currency: intent.currency,
        customer_details: { customer_id: payer.id, customer_email: payer.email, customer_phone: (payer.phone ?? "9999999999").replace(/\D/g, "").slice(-10), customer_name: payer.name },
        order_meta: {
          return_url: `${config.appUrl}/client/invoices/${intent.invoiceId}?gateway=cashfree&order_id={order_id}`,
          notify_url: `${config.appUrl}/api/webhooks/cashfree`,
        },
      }),
    });
    return { gatewayOrderId: o.order_id, client: { type: "cashfree", sessionId: o.payment_session_id, mode: test ? "sandbox" : "production" } };
  },
  async verifyReturn(_body, cfg, test, intent) {
    const id = intent.gatewayOrderId ?? intent.id;
    const pays = await httpJson<{ cf_payment_id: string | number; payment_status: string; payment_amount: number }[]>(`${cfBase(test)}/orders/${id}/payments`, { method: "GET", headers: cfHeaders(cfg) });
    const ok = pays.find((p) => p.payment_status === "SUCCESS");
    if (!ok) return { gatewayOrderId: id, gatewayTxnId: "pending", amount: 0, paid: false };
    return { gatewayOrderId: id, gatewayTxnId: String(ok.cf_payment_id), amount: Math.round(ok.payment_amount * 100), paid: true, raw: ok };
  },
  async parseWebhook(raw, headers, cfg) {
    const ts = h(headers, "x-webhook-timestamp");
    const sig = h(headers, "x-webhook-signature");
    const expected = crypto.createHmac("sha256", cfg.secretKey).update(ts + raw.toString("utf8")).digest("base64");
    if (!ts || !sig || !safeEqual(expected, sig)) throw new HttpError(400, "Invalid Cashfree signature");
    const evt = JSON.parse(raw.toString("utf8"));
    const p = evt.data?.payment;
    const payments: Verified[] = [];
    if (evt.type === "PAYMENT_SUCCESS_WEBHOOK" && p?.payment_status === "SUCCESS") {
      payments.push({ gatewayOrderId: evt.data.order.order_id, gatewayTxnId: String(p.cf_payment_id), amount: Math.round(Number(p.payment_amount) * 100), paid: true, raw: evt.data });
    }
    return { eventId: `${evt.type}:${p?.cf_payment_id ?? ts}`, type: evt.type, payments };
  },
  async refund(txnId, amount, cfg, test) {
    void txnId;
    void amount;
    void cfg;
    void test;
    throw new HttpError(501, "Cashfree refunds must be initiated from the Cashfree dashboard (order-level refunds need the order id)");
  },
};

// ───────────────────────── PayU (hosted checkout) ─────────────────────────
const payuHash = (s: string) => crypto.createHash("sha512").update(s).digest("hex");
const payu: Gateway = {
  code: "payu",
  name: "PayU",
  async createPayment(intent, payer, cfg, _pub, test, label) {
    const txnid = intent.id;
    const amount = (intent.amount / 100).toFixed(2);
    const productinfo = label.slice(0, 100);
    const firstname = payer.name.split(" ")[0] || "Customer";
    const udf1 = intent.invoiceId;
    const hash = payuHash(`${cfg.key}|${txnid}|${amount}|${productinfo}|${firstname}|${payer.email}|${udf1}||||||||||${cfg.salt}`);
    const cb = `${config.appUrl}/api/payments/callback/payu`;
    return {
      gatewayOrderId: txnid,
      client: {
        type: "form",
        action: test ? "https://test.payu.in/_payment" : "https://secure.payu.in/_payment",
        fields: { key: cfg.key, txnid, amount, productinfo, firstname, email: payer.email, phone: payer.phone ?? "", surl: cb, furl: cb, udf1, hash },
      },
    };
  },
  async verifyReturn(body, cfg) {
    const f = (k: string) => String(body[k] ?? "");
    const reverse = `${cfg.salt}|${f("status")}||||||${f("udf5")}|${f("udf4")}|${f("udf3")}|${f("udf2")}|${f("udf1")}|${f("email")}|${f("firstname")}|${f("productinfo")}|${f("amount")}|${f("txnid")}|${f("key")}`;
    const withCharges = f("additionalCharges") ? `${f("additionalCharges")}|${reverse}` : reverse;
    if (!safeEqual(payuHash(withCharges), f("hash"))) throw new HttpError(400, "PayU hash mismatch");
    return { intentId: f("txnid"), gatewayOrderId: f("txnid"), gatewayTxnId: f("mihpayid"), amount: Math.round(Number(f("amount")) * 100), paid: f("status") === "success", raw: body };
  },
};

// ───────────────────────── Offline: bank transfer, UPI, manual ─────────────────────────
const bank: Gateway = {
  code: "bank",
  name: "Bank Transfer (NEFT / RTGS / IMPS)",
  offline: true,
  async createPayment(intent, _p, _c, pub) {
    return { client: { type: "instructions", title: "Bank transfer", details: pub.instructions ?? "", reference: intent.id.slice(-8).toUpperCase(), needsReference: true } };
  },
};
const upi: Gateway = {
  code: "upi",
  name: "UPI (Scan & Pay)",
  offline: true,
  async createPayment(intent, _p, _c, pub, _t, label) {
    const vpa = String(pub.vpa ?? "");
    if (!vpa) throw new HttpError(503, "UPI is not configured");
    const uri = `upi://pay?${new URLSearchParams({ pa: vpa, pn: String(pub.payeeName ?? "Crapplet Infotech"), am: (intent.amount / 100).toFixed(2), cu: "INR", tn: label.slice(0, 50), tr: intent.id.slice(-12) }).toString()}`;
    return { client: { type: "instructions", title: "Pay with any UPI app", details: `Pay to ${vpa}, then enter the 12-digit UTR / reference number below.`, upiUri: uri, qr: await QRCode.toDataURL(uri, { margin: 1, width: 260 }), needsReference: true } };
  },
};
const manual: Gateway = {
  code: "manual",
  name: "Manual / Cash / Cheque",
  offline: true,
  async createPayment(intent, _p, _c, pub) {
    return { client: { type: "instructions", title: "Manual payment", details: pub.instructions ?? "Contact billing to arrange payment.", reference: intent.id.slice(-8).toUpperCase(), needsReference: true } };
  },
};

// ───────────────────────── Custom gateway API ─────────────────────────
/**
 * Generic HMAC gateway: we redirect to `redirectUrl` with signed params; the provider calls
 * POST /api/webhooks/custom with header X-Signature = hex(HMAC_SHA256(rawBody, secret)) and JSON
 * { "eventId", "intentId", "txnId", "amount" (minor units), "status": "paid" }.
 */
const custom: Gateway = {
  code: "custom",
  name: "Custom payment gateway",
  async createPayment(intent, payer, cfg) {
    const params = new URLSearchParams({ intent: intent.id, amount: String(intent.amount), currency: intent.currency, email: payer.email, return: `${config.appUrl}/client/invoices/${intent.invoiceId}` });
    params.set("sig", hmacHex("sha256", cfg.secret, params.toString()));
    return { gatewayOrderId: intent.id, client: { type: "redirect", url: `${cfg.redirectUrl}?${params.toString()}` } };
  },
  async parseWebhook(raw, headers, cfg) {
    const sig = h(headers, "x-signature");
    if (!cfg.secret || !sig || !safeEqual(hmacHex("sha256", cfg.secret, raw), sig)) throw new HttpError(400, "Invalid signature");
    const b = JSON.parse(raw.toString("utf8"));
    return { eventId: String(b.eventId ?? b.txnId), type: "payment", payments: [{ intentId: b.intentId, gatewayOrderId: b.intentId, gatewayTxnId: String(b.txnId), amount: Number(b.amount), paid: b.status === "paid", raw: b }] };
  },
};

export const GATEWAYS: Record<string, Gateway> = { razorpay, cashfree, payu, stripe, bank, upi, manual, custom };

/** Which secret fields each gateway needs (rendered in Admin → Payment Gateways). */
export const GATEWAY_FIELDS: Record<string, { secret: string[]; public: string[] }> = {
  razorpay: { secret: ["keyId", "keySecret", "webhookSecret"], public: [] },
  cashfree: { secret: ["appId", "secretKey"], public: [] },
  payu: { secret: ["key", "salt"], public: [] },
  stripe: { secret: ["secretKey", "webhookSecret"], public: [] },
  bank: { secret: [], public: ["instructions"] },
  upi: { secret: [], public: ["vpa", "payeeName"] },
  manual: { secret: [], public: ["instructions"] },
  custom: { secret: ["redirectUrl", "secret"], public: [] },
};
