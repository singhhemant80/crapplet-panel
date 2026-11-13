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
  /** ISO currency the gateway actually charged in (checked against the invoice) */
  currency?: string;
  paid: boolean;
  fee?: number;
  raw?: unknown;
}
export interface WebhookResult {
  eventId: string;
  type: string;
  payments: Verified[];
  /** UPI AutoPay mandates whose state changed (Razorpay token.* events) */
  tokens?: { id: string; status: string }[];
  /** failed charges (payment.failed) — used for AutoPay renewal attempts */
  failures?: { gatewayOrderId: string; reason: string }[];
}
export type GatewayConfig = Record<string, string>;
export interface PublicGatewayConfig {
  [k: string]: unknown;
}

export interface Gateway {
  code: string;
  name: string;
  offline?: boolean;
  /** currencies this gateway can charge by default (admins can narrow/extend per gateway) */
  currencies: string[];
  createPayment(intent: IntentLike, payer: Payer, cfg: GatewayConfig, pub: PublicGatewayConfig, testMode: boolean, label: string): Promise<{ gatewayOrderId?: string; client: Record<string, unknown> }>;
  verifyReturn?(body: Record<string, unknown>, cfg: GatewayConfig, testMode: boolean, intent: IntentLike): Promise<Verified>;
  parseWebhook?(raw: Buffer, headers: Record<string, string | string[] | undefined>, cfg: GatewayConfig, testMode: boolean): Promise<WebhookResult>;
  /** Refund (part of) a captured payment through the gateway's API. ctx.ref is our idempotency / refund id. */
  refund?(gatewayTxnId: string, amount: number, cfg: GatewayConfig, testMode: boolean, ctx?: RefundCtx): Promise<{ refundId: string; status?: string }>;
}

const h = (headers: Record<string, string | string[] | undefined>, k: string) => {
  const v = headers[k.toLowerCase()];
  return Array.isArray(v) ? v[0] : v ?? "";
};

export async function httpJson<T>(url: string, init: { method: string; headers?: Record<string, string>; body?: string }): Promise<T> {
  const host = new URL(url).host;
  let res: Awaited<ReturnType<typeof request>>;
  try {
    res = await request(url, { method: init.method as "GET", headers: init.headers, body: init.body, headersTimeout: 30_000, bodyTimeout: 30_000 });
  } catch (e) {
    const code = (e as { code?: string }).code ?? (e as Error).name;
    throw new HttpError(502, `Couldn't connect to ${host} (${code}) — check the server's internet/DNS`, "GATEWAY_UNREACHABLE");
  }
  const text = await res.body.text();
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text };
  }
  if (res.statusCode >= 400) {
    const j = json as { error?: { description?: string; message?: string } | string; message?: string; error_description?: string };
    const said = (typeof j.error === "object" ? j.error?.description ?? j.error?.message : j.error) ?? j.message ?? j.error_description ?? text.slice(0, 200);
    const keys = res.statusCode === 401 || res.statusCode === 403 ? " — check the API keys in Admin → Payment Gateways" : "";
    throw new HttpError(502, `${host} returned ${res.statusCode}: ${String(said).slice(0, 300)}${keys}`, "GATEWAY_ERROR");
  }
  return json as T;
}

// ───────────────────────── Razorpay ─────────────────────────
/** overridable only so tests can point at a stand-in Razorpay */
export const RZP_BASE = process.env.NODE_ENV !== "production" && process.env.RAZORPAY_API_BASE ? process.env.RAZORPAY_API_BASE : "https://api.razorpay.com/v1";
const razorpay: Gateway = {
  code: "razorpay",
  currencies: ["INR"],
  name: "Razorpay (UPI, Cards, Netbanking, Wallets)",
  async createPayment(intent, payer, cfg, _pub, _t, label) {
    const auth = "Basic " + Buffer.from(`${cfg.keyId}:${cfg.keySecret}`).toString("base64");
    const order = await httpJson<{ id: string }>(`${RZP_BASE}/orders`, {
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
    const p = await httpJson<{ id: string; order_id: string; amount: number; status: string; fee?: number }>(`${RZP_BASE}/payments/${paymentId}`, { method: "GET", headers: { Authorization: auth } });
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
      payments.push({ gatewayOrderId: p.order_id, gatewayTxnId: p.id, amount: p.amount, currency: p.currency, paid: p.status === "captured", fee: p.fee ?? 0, raw: p });
    }
    // UPI AutoPay mandate state (cancelled / paused from the customer's UPI app, rejected by the bank …)
    const tokens = /^token\./.test(String(evt.event)) && evt.payload?.token?.entity?.id ? [{ id: String(evt.payload.token.entity.id), status: String(evt.event).slice(6) }] : undefined;
    const failures =
      evt.event === "payment.failed" && evt.payload?.payment?.entity?.order_id
        ? [{ gatewayOrderId: String(evt.payload.payment.entity.order_id), reason: String(evt.payload.payment.entity.error_description ?? evt.payload.payment.entity.error_reason ?? "Payment failed").slice(0, 300) }]
        : undefined;
    return { eventId, type: evt.event, payments, tokens, failures };
  },
  async refund(txnId, amount, cfg, _test, ctx) {
    const auth = "Basic " + Buffer.from(`${cfg.keyId}:${cfg.keySecret}`).toString("base64");
    const r = await httpJson<{ id: string; status?: string }>(`${RZP_BASE}/payments/${txnId}/refund`, {
      method: "POST",
      headers: { Authorization: auth, "Content-Type": "application/json" },
      body: JSON.stringify({ amount, speed: "normal", receipt: ctx?.ref?.slice(0, 40), notes: ctx?.reason ? { reason: ctx.reason.slice(0, 250) } : undefined }),
    });
    return { refundId: r.id, status: r.status };
  },
};

export type RefundCtx = { ref: string; orderId?: string | null; reason?: string };

// ───────────────────────── Stripe ─────────────────────────
const stripe: Gateway = {
  code: "stripe",
  currencies: ["INR", "USD"],
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
    const s = await httpJson<{ id: string; payment_status: string; amount_total: number; currency: string; payment_intent: string; client_reference_id: string }>(`https://api.stripe.com/v1/checkout/sessions/${sid}`, {
      method: "GET",
      headers: { Authorization: `Bearer ${cfg.secretKey}` },
    });
    return { intentId: s.client_reference_id, gatewayOrderId: s.id, gatewayTxnId: s.payment_intent, amount: s.amount_total, currency: s.currency?.toUpperCase(), paid: s.payment_status === "paid", raw: s };
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
      payments.push({ intentId: s.client_reference_id, gatewayOrderId: s.id, gatewayTxnId: s.payment_intent, amount: s.amount_total, currency: s.currency?.toUpperCase(), paid: s.payment_status === "paid", raw: s });
    }
    return { eventId: evt.id, type: evt.type, payments };
  },
  async refund(txnId, amount, cfg, _test, ctx) {
    const r = await httpJson<{ id: string; status?: string }>("https://api.stripe.com/v1/refunds", {
      method: "POST",
      headers: { Authorization: `Bearer ${cfg.secretKey}`, "Content-Type": "application/x-www-form-urlencoded", ...(ctx?.ref ? { "Idempotency-Key": ctx.ref } : {}) },
      body: new URLSearchParams({ payment_intent: txnId, amount: String(amount), reason: "requested_by_customer" }).toString(),
    });
    return { refundId: r.id, status: r.status };
  },
};

// ───────────────────────── Cashfree (PG API 2023-08-01) ─────────────────────────
const cfBase = (test: boolean) => (test ? "https://sandbox.cashfree.com/pg" : "https://api.cashfree.com/pg");
const cfHeaders = (cfg: GatewayConfig) => ({ "x-client-id": cfg.appId, "x-client-secret": cfg.secretKey, "x-api-version": "2023-08-01", "Content-Type": "application/json" });
const cashfree: Gateway = {
  code: "cashfree",
  currencies: ["INR"],
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
  /** Cashfree refunds are made against the order: POST /orders/{order_id}/refunds */
  async refund(txnId, amount, cfg, test, ctx) {
    if (!ctx?.orderId) throw new HttpError(400, `Couldn't find the Cashfree order for payment ${txnId} — refund it from the Cashfree dashboard`);
    const r = await httpJson<{ cf_refund_id?: string | number; refund_id?: string; refund_status?: string }>(`${cfBase(test)}/orders/${encodeURIComponent(ctx.orderId)}/refunds`, {
      method: "POST",
      headers: cfHeaders(cfg),
      body: JSON.stringify({ refund_amount: Number((amount / 100).toFixed(2)), refund_id: ctx.ref.slice(0, 40), refund_note: (ctx.reason ?? "Refund").slice(0, 100), refund_speed: "STANDARD" }),
    });
    return { refundId: String(r.cf_refund_id ?? r.refund_id ?? ctx.ref), status: r.refund_status };
  },
};

// ───────────────────────── PayU (hosted checkout) ─────────────────────────
const payuHash = (s: string) => crypto.createHash("sha512").update(s).digest("hex");
const payu: Gateway = {
  code: "payu",
  currencies: ["INR"],
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
  /** PayU "cancel_refund_transaction": var1 = mihpayid, var2 = our unique refund token, var3 = amount. */
  async refund(txnId, amount, cfg, test, ctx) {
    const command = "cancel_refund_transaction";
    const form = new URLSearchParams({ key: cfg.key, command, var1: txnId, var2: (ctx?.ref ?? `rf${Date.now()}`).slice(0, 23), var3: (amount / 100).toFixed(2), hash: payuHash(`${cfg.key}|${command}|${txnId}|${cfg.salt}`) });
    const r = await httpJson<{ status: number | string; msg?: string; request_id?: string; error_code?: string }>(`${test ? "https://test.payu.in" : "https://info.payu.in"}/merchant/postservice.php?form=2`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form.toString(),
    });
    if (String(r.status) !== "1") throw new HttpError(502, `PayU refused the refund: ${r.msg ?? r.error_code ?? "unknown error"}`);
    return { refundId: String(r.request_id ?? ctx?.ref), status: r.msg };
  },
};

// ───────────────────────── Offline: bank transfer, UPI, manual ─────────────────────────
const bank: Gateway = {
  code: "bank",
  currencies: ["INR"],
  name: "Bank Transfer (NEFT / RTGS / IMPS)",
  offline: true,
  async createPayment(intent, _p, _c, pub) {
    return { client: { type: "instructions", title: "Bank transfer", details: pub.instructions ?? "", reference: intent.id.slice(-8).toUpperCase(), needsReference: true } };
  },
};
const upi: Gateway = {
  code: "upi",
  currencies: ["INR"],
  name: "UPI (Scan & Pay)",
  offline: true,
  async createPayment(intent, _p, _c, pub, _t, label) {
    if (intent.currency !== "INR") throw new HttpError(400, "UPI only accepts INR");
    const vpa = String(pub.vpa ?? "");
    if (!vpa) throw new HttpError(503, "UPI is not configured");
    const uri = `upi://pay?${new URLSearchParams({ pa: vpa, pn: String(pub.payeeName ?? "Crapplet Infotech"), am: (intent.amount / 100).toFixed(2), cu: "INR", tn: label.slice(0, 50), tr: intent.id.slice(-12) }).toString()}`;
    return { client: { type: "instructions", title: "Pay with any UPI app", details: `Pay to ${vpa}, then enter the 12-digit UTR / reference number below.`, upiUri: uri, qr: await QRCode.toDataURL(uri, { margin: 1, width: 260 }), needsReference: true } };
  },
};
const manual: Gateway = {
  code: "manual",
  currencies: ["INR", "USD"],
  name: "Manual / Cash / Cheque",
  offline: true,
  async createPayment(intent, _p, _c, pub) {
    return { client: { type: "instructions", title: "Manual payment", details: pub.instructions ?? "Contact billing to arrange payment.", reference: intent.id.slice(-8).toUpperCase(), needsReference: true } };
  },
};

const wire: Gateway = {
  code: "wire",
  name: "International wire transfer (SWIFT)",
  currencies: ["USD"],
  offline: true,
  async createPayment(intent, _p, _c, pub) {
    return {
      client: {
        type: "instructions",
        title: "International wire transfer",
        details: `${pub.instructions ?? "Contact billing for our SWIFT details."}\n\nAmount: ${intent.currency} ${(intent.amount / 100).toFixed(2)} — please choose "OUR" charges so the full amount arrives, and quote the reference below.`,
        reference: intent.id.slice(-8).toUpperCase(),
        needsReference: true,
      },
    };
  },
};

// ───────────────────────── PayPal (Checkout Orders v2) ─────────────────────────
const ppBase = (test: boolean) => (test ? "https://api-m.sandbox.paypal.com" : "https://api-m.paypal.com");
const ppTokens = new Map<string, { token: string; exp: number }>();
async function ppToken(cfg: GatewayConfig, test: boolean) {
  const k = `${test}:${cfg.clientId}`;
  const c = ppTokens.get(k);
  if (c && c.exp > Date.now() + 60_000) return c.token;
  const r = await httpJson<{ access_token: string; expires_in: number }>(`${ppBase(test)}/v1/oauth2/token`, {
    method: "POST",
    headers: { Authorization: "Basic " + Buffer.from(`${cfg.clientId}:${cfg.clientSecret}`).toString("base64"), "Content-Type": "application/x-www-form-urlencoded" },
    body: "grant_type=client_credentials",
  });
  ppTokens.set(k, { token: r.access_token, exp: Date.now() + r.expires_in * 1000 });
  return r.access_token;
}
type PpCapture = { id: string; status: string; custom_id?: string; amount: { currency_code: string; value: string }; seller_receivable_breakdown?: { paypal_fee?: { value: string } }; supplementary_data?: { related_ids?: { order_id?: string } } };
type PpOrder = { id: string; status: string; purchase_units: { custom_id?: string; payments?: { captures?: PpCapture[] } }[] };
const ppMinor = (v: string) => Math.round(Number(v) * 100);
function ppVerified(order: PpOrder): Verified {
  const cap = order.purchase_units?.[0]?.payments?.captures?.[0];
  return {
    intentId: order.purchase_units?.[0]?.custom_id,
    gatewayOrderId: order.id,
    gatewayTxnId: cap?.id ?? order.id,
    amount: cap ? ppMinor(cap.amount.value) : 0,
    currency: cap?.amount.currency_code,
    fee: cap?.seller_receivable_breakdown?.paypal_fee ? ppMinor(cap.seller_receivable_breakdown.paypal_fee.value) : undefined,
    paid: cap?.status === "COMPLETED",
    raw: order,
  };
}
const paypal: Gateway = {
  code: "paypal",
  name: "PayPal (International)",
  currencies: ["USD"],
  async createPayment(intent, _payer, cfg, _pub, test, label) {
    const token = await ppToken(cfg, test);
    const order = await httpJson<{ id: string; links: { rel: string; href: string }[] }>(`${ppBase(test)}/v2/checkout/orders`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", "PayPal-Request-Id": `create-${intent.id}` },
      body: JSON.stringify({
        intent: "CAPTURE",
        purchase_units: [{ reference_id: intent.id, custom_id: intent.id, invoice_id: intent.id, description: label.slice(0, 127), amount: { currency_code: intent.currency, value: (intent.amount / 100).toFixed(2) } }],
        payment_source: {
          paypal: {
            experience_context: {
              brand_name: "Crapplet Cloud",
              shipping_preference: "NO_SHIPPING",
              user_action: "PAY_NOW",
              return_url: `${config.appUrl}/client/invoices/${intent.invoiceId}?gateway=paypal`,
              cancel_url: `${config.appUrl}/client/invoices/${intent.invoiceId}?cancelled=1`,
            },
          },
        },
      }),
    });
    const approve = order.links.find((l) => l.rel === "payer-action" || l.rel === "approve");
    if (!approve) throw new HttpError(502, "PayPal did not return an approval link", "GATEWAY_ERROR");
    return { gatewayOrderId: order.id, client: { type: "redirect", url: approve.href } };
  },
  /** The buyer returns with ?token=<orderId>; we capture server-side (idempotent via PayPal-Request-Id). */
  async verifyReturn(body, cfg, test, intent) {
    const orderId = String(body.token ?? body.session_id ?? "");
    if (!orderId || orderId !== intent.gatewayOrderId) throw new HttpError(400, "Invalid PayPal order");
    const token = await ppToken(cfg, test);
    let order: PpOrder;
    try {
      order = await httpJson<PpOrder>(`${ppBase(test)}/v2/checkout/orders/${orderId}/capture`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", "PayPal-Request-Id": `capture-${intent.id}` },
        body: "{}",
      });
    } catch {
      // already captured (e.g. webhook won the race) or not approved yet → read the order instead
      order = await httpJson<PpOrder>(`${ppBase(test)}/v2/checkout/orders/${orderId}`, { method: "GET", headers: { Authorization: `Bearer ${token}` } });
    }
    return ppVerified(order);
  },
  async parseWebhook(raw, headers, cfg, test) {
    if (!cfg.webhookId) throw new HttpError(400, "PayPal webhook id not configured");
    const evt = JSON.parse(raw.toString("utf8"));
    const token = await ppToken(cfg, test);
    const check = await httpJson<{ verification_status: string }>(`${ppBase(test)}/v1/notifications/verify-webhook-signature`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        auth_algo: h(headers, "paypal-auth-algo"),
        cert_url: h(headers, "paypal-cert-url"),
        transmission_id: h(headers, "paypal-transmission-id"),
        transmission_sig: h(headers, "paypal-transmission-sig"),
        transmission_time: h(headers, "paypal-transmission-time"),
        webhook_id: cfg.webhookId,
        webhook_event: evt,
      }),
    });
    if (check.verification_status !== "SUCCESS") throw new HttpError(400, "Invalid PayPal webhook signature");
    const payments: Verified[] = [];
    if (evt.event_type === "PAYMENT.CAPTURE.COMPLETED") {
      const c = evt.resource as PpCapture;
      payments.push({
        intentId: c.custom_id,
        gatewayOrderId: c.supplementary_data?.related_ids?.order_id,
        gatewayTxnId: c.id,
        amount: ppMinor(c.amount.value),
        currency: c.amount.currency_code,
        fee: c.seller_receivable_breakdown?.paypal_fee ? ppMinor(c.seller_receivable_breakdown.paypal_fee.value) : undefined,
        paid: c.status === "COMPLETED",
        raw: c,
      });
    } else if (evt.event_type === "CHECKOUT.ORDER.APPROVED") {
      // buyer approved but closed the tab before returning → capture now
      const orderId = evt.resource?.id as string;
      const order = await httpJson<PpOrder>(`${ppBase(test)}/v2/checkout/orders/${orderId}/capture`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", "PayPal-Request-Id": `capture-${evt.resource?.purchase_units?.[0]?.custom_id ?? orderId}` },
        body: "{}",
      }).catch(() => null);
      if (order) payments.push(ppVerified(order));
    }
    return { eventId: String(evt.id), type: String(evt.event_type), payments };
  },
  async refund(txnId, amount, cfg, test, ctx) {
    const token = await ppToken(cfg, test);
    const cap = await httpJson<PpCapture>(`${ppBase(test)}/v2/payments/captures/${txnId}`, { method: "GET", headers: { Authorization: `Bearer ${token}` } });
    const r = await httpJson<{ id: string }>(`${ppBase(test)}/v2/payments/captures/${txnId}/refund`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", "PayPal-Request-Id": ctx?.ref ?? `refund-${txnId}-${amount}-${Date.now()}` },
      body: JSON.stringify({ amount: { value: (amount / 100).toFixed(2), currency_code: cap.amount.currency_code } }),
    });
    return { refundId: r.id };
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
  currencies: ["INR", "USD"],
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

export const GATEWAYS: Record<string, Gateway> = { razorpay, cashfree, payu, stripe, paypal, bank, upi, wire, manual, custom };

/** Currencies a configured gateway accepts: admin override (publicConfig.currencies) or the adapter default. */
export function gatewayCurrencies(code: string, pub: unknown): string[] {
  const o = (pub as { currencies?: unknown } | null)?.currencies;
  if (Array.isArray(o) && o.length) return o.map((c) => String(c).toUpperCase());
  return GATEWAYS[code]?.currencies ?? ["INR"];
}

/** Which secret fields each gateway needs (rendered in Admin → Payment Gateways). */
export const GATEWAY_FIELDS: Record<string, { secret: string[]; public: string[] }> = {
  razorpay: { secret: ["keyId", "keySecret", "webhookSecret"], public: [] },
  cashfree: { secret: ["appId", "secretKey"], public: [] },
  payu: { secret: ["key", "salt"], public: [] },
  stripe: { secret: ["secretKey", "webhookSecret"], public: [] },
  paypal: { secret: ["clientId", "clientSecret", "webhookId"], public: [] },
  wire: { secret: [], public: ["instructions"] },
  bank: { secret: [], public: ["instructions"] },
  upi: { secret: [], public: ["vpa", "payeeName"] },
  manual: { secret: [], public: ["instructions"] },
  custom: { secret: ["redirectUrl", "secret"], public: [] },
};
