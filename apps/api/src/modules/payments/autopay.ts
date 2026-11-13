/**
 * UPI AutoPay — Razorpay recurring payments, or Cashfree subscriptions (setting automation.autopayGateway).
 *
 * Cashfree: an ON_DEMAND subscription whose approval payment (authorization_amount, not refunded) is the
 * invoice itself; renewals are POST /subscriptions/pay CHARGE scheduled 26 h ahead (the bank's 24 h notice);
 * SUBSCRIPTION_* webhooks pay invoices and pause/cancel the mandate. The Razorpay flow:
 *
 *  1. Paying an invoice that has renewals, the customer picks "UPI AutoPay": the same payment approves a
 *     UPI mandate (Razorpay order with method=upi + token{max_amount, frequency: as_presented}, checkout
 *     with recurring=1). The token is saved as a PayMethod (autopay on).
 *  2. Renewal invoices are charged to it a few days before they're due: an order, then
 *     POST /payments/create/recurring. The customer's UPI app shows the bank's pre-debit notice 24 h
 *     before; the debit happens ~25 h after. The payment.captured / order.paid webhook pays the invoice
 *     like any other payment.
 *  3. Cancelled / paused / rejected in the UPI app → token.* webhook → the PayMethod stops being used.
 *     The customer (or staff) can also turn it off in the panel, which cancels the token at Razorpay.
 */
import { prisma } from "../../db";
import { audit } from "../../lib/audit";
import { decrypt, encrypt } from "../../lib/crypto";
import { badRequest, notFound } from "../../lib/http";
import { getSettings } from "../../lib/settings";
import { queueEmail } from "../email/mailer";
import { RZP_BASE, cfBase, cfHeaders, httpJson, type GatewayConfig } from "./gateways";
import { config } from "../../config";

const RZP = RZP_BASE;
const auth = (cfg: GatewayConfig) => "Basic " + Buffer.from(`${cfg.keyId}:${cfg.keySecret}`).toString("base64");
const rzp = <T>(cfg: GatewayConfig, method: string, path: string, body?: unknown) =>
  httpJson<T>(`${RZP}${path}`, { method, headers: { Authorization: auth(cfg), "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });

export const AUTOPAY_CODE = "razorpay_autopay";
export const CF_AUTOPAY_CODE = "cashfree_autopay";
export const AUTOPAY_CODES = [AUTOPAY_CODE, CF_AUTOPAY_CODE];
const MANDATE_GATEWAYS = ["razorpay", "cashfree"];
/** Cashfree subscriptions API version (the PG orders API stays on its own version) */
const CF_SUBS_VERSION = "2025-01-01";
const cf = <T>(g: { cfg: GatewayConfig; testMode: boolean }, method: string, path: string, body?: unknown) =>
  httpJson<T>(`${cfBase(g.testMode)}${path}`, { method, headers: { ...cfHeaders(g.cfg), "x-api-version": CF_SUBS_VERSION }, body: body === undefined ? undefined : JSON.stringify(body) });
const rupees = (paise: number) => Math.round(paise) / 100;
/** Razorpay's UPI mandate ceiling for ordinary merchants: ₹99,999 */
const MAX_MANDATE = 9_999_900;
const MAX_ATTEMPTS = 3;
type Meta = { autopay?: "register" | "charge"; customerId?: string; maxAmount?: number; payMethodId?: string; error?: string; [k: string]: unknown };

/** Most the mandate allows per debit: comfortably above this invoice (prices change, add-ons), rounded to ₹500. */
export function mandateMax(invoiceTotal: number) {
  const want = Math.max(invoiceTotal * 2, 100_000);
  return Math.min(MAX_MANDATE, Math.ceil(want / 50_000) * 50_000);
}

async function gatewayCfg(code: string) {
  const g = await prisma.paymentGateway.findUnique({ where: { code } });
  if (!g?.enabled) return null;
  const { decryptJson } = await import("../../lib/crypto");
  return { code, row: g, testMode: g.testMode, cfg: decryptJson<Record<string, string>>(g.configEnc) };
}
const razorpayCfg = () => gatewayCfg("razorpay");

/** Which gateway sets up new mandates: the setting, or Razorpay when it's on, else Cashfree. */
export async function autopayProvider() {
  const pref = (await getSettings()).automation.autopayGateway ?? "auto";
  for (const code of pref === "cashfree" ? ["cashfree"] : pref === "razorpay" ? ["razorpay"] : ["razorpay", "cashfree"]) {
    const g = await gatewayCfg(code);
    if (g) return g;
  }
  return null;
}

/** Can this invoice be paid with UPI AutoPay (renewing services / domains, INR, Razorpay on, switched on)? */
export async function autopayEligible(invoiceId: string, userId: string) {
  const s = await getSettings();
  if (!s.automation.upiAutopay) return false;
  const inv = await prisma.invoice.findUnique({ where: { id: invoiceId }, include: { items: true } });
  if (!inv || inv.userId !== userId || inv.status !== "UNPAID" || inv.currency !== "INR" || inv.isWalletTopup) return false;
  if (inv.total - inv.amountPaid > MAX_MANDATE) return false;
  if (!(await autopayProvider())) return false;
  const serviceIds = inv.items.filter((i) => i.type === "SERVICE" && i.relId).map((i) => i.relId!);
  const renewing = serviceIds.length ? await prisma.service.count({ where: { id: { in: serviceIds }, billingCycle: { not: "ONETIME" } } }) : 0;
  return renewing > 0 || inv.items.some((i) => i.type === "DOMAIN");
}

/** The customer already has a working mandate (renewals will be charged to it). */
export const activeMandate = (userId: string) =>
  prisma.payMethod.findFirst({ where: { userId, gateway: { in: MANDATE_GATEWAYS }, type: "UPI", autopay: true, status: "ACTIVE", externalId: { not: null } }, orderBy: { createdAt: "desc" } });

/** Cashfree, step 1: an ON_DEMAND UPI subscription whose approval payment is this invoice. */
export async function createCashfreeMandate(intent: { id: string; amount: number; invoiceId: string; userId: string }, payer: { name: string; email: string; phone?: string | null }, g: { cfg: GatewayConfig; testMode: boolean }) {
  const maxAmount = mandateMax(intent.amount);
  const subscriptionId = `sub_${intent.id}`;
  const phone = (payer.phone ?? "").replace(/\D/g, "").slice(-10);
  if (phone.length !== 10) throw badRequest("Add a 10-digit mobile number to your profile to set up UPI AutoPay");
  const r = await cf<{ subscription_session_id: string; cf_subscription_id?: string | number }>(g, "POST", "/subscriptions", {
    subscription_id: subscriptionId,
    customer_details: { customer_name: payer.name.slice(0, 100) || payer.email, customer_email: payer.email, customer_phone: phone },
    plan_details: { plan_name: "Crapplet renewals", plan_type: "ON_DEMAND", plan_currency: "INR", plan_max_amount: rupees(maxAmount), plan_note: "Renewals of your Crapplet Cloud services" },
    authorization_details: { authorization_amount: rupees(intent.amount), authorization_amount_refund: false, payment_methods: ["upi"] },
    subscription_meta: { return_url: `${config.appUrl}/client/invoices/${intent.invoiceId}?autopay=cashfree&intent=${intent.id}` },
    subscription_expiry_time: new Date(Date.now() + 10 * 365 * 86400_000).toISOString(),
    subscription_tags: { intentId: intent.id, invoiceId: intent.invoiceId },
  });
  await prisma.paymentIntent.update({ where: { id: intent.id }, data: { gatewayOrderId: subscriptionId, meta: { autopay: "register", subscriptionId, maxAmount } satisfies Meta } });
  return { gatewayOrderId: subscriptionId, client: { type: "cashfree_subscription", subsSessionId: r.subscription_session_id, mode: g.testMode ? "sandbox" : "production", autopay: { maxAmount } } };
}

/** Cashfree, back from the approval page: ask Cashfree (the webhook may not have arrived yet). */
export async function checkCashfreeMandate(intent: { id: string; amount: number; meta: unknown }) {
  const meta = (intent.meta ?? {}) as Meta;
  const g = await gatewayCfg("cashfree");
  if (!g || !meta.subscriptionId) return { paid: false as const };
  const s = await cf<{ subscription_status?: string; authorisation_details?: { authorization_status?: string; authorization_amount?: number } }>(g, "GET", `/subscriptions/${encodeURIComponent(String(meta.subscriptionId))}`);
  const auth = String(s.authorisation_details?.authorization_status ?? "").toUpperCase();
  const ok = s.subscription_status === "ACTIVE" && (!auth || ["ACTIVE", "SUCCESS", "AUTHORIZED", "APPROVED"].includes(auth));
  if (!ok) return { paid: false as const, status: s.subscription_status };
  const amount = s.authorisation_details?.authorization_amount != null ? Math.round(Number(s.authorisation_details.authorization_amount) * 100) : intent.amount;
  return { paid: true as const, verified: { gatewayOrderId: String(meta.subscriptionId), gatewayTxnId: `cfsub-auth-${meta.subscriptionId}`, amount, currency: "INR", paid: true, raw: { subscription_id: meta.subscriptionId } } };
}

/** Step 1: the order that pays this invoice AND registers the mandate. Returns what Razorpay Checkout needs. */
export async function createAutopayRegistration(intent: { id: string; amount: number; invoiceId: string }, payer: { name: string; email: string; phone?: string | null }, cfg: GatewayConfig, label: string) {
  const customer = await rzp<{ id: string }>(cfg, "POST", "/customers", { name: payer.name.slice(0, 50) || payer.email, email: payer.email, contact: payer.phone ?? undefined, fail_existing: "0" });
  const maxAmount = mandateMax(intent.amount);
  const order = await rzp<{ id: string }>(cfg, "POST", "/orders", {
    amount: intent.amount,
    currency: "INR",
    customer_id: customer.id,
    method: "upi",
    receipt: intent.id,
    notes: { intentId: intent.id, invoiceId: intent.invoiceId, autopay: "register" },
    token: { max_amount: maxAmount, expire_at: Math.floor(Date.now() / 1000) + 10 * 365 * 86400, frequency: "as_presented" },
  });
  await prisma.paymentIntent.update({ where: { id: intent.id }, data: { gatewayOrderId: order.id, meta: { autopay: "register", customerId: customer.id, maxAmount } satisfies Meta } });
  return {
    gatewayOrderId: order.id,
    client: { type: "razorpay", keyId: cfg.keyId, orderId: order.id, amount: intent.amount, currency: "INR", description: label, prefill: { name: payer.name, email: payer.email, contact: payer.phone ?? "" }, recurring: 1, customerId: customer.id, autopay: { maxAmount } },
  };
}

/** Step 2: after the first payment is captured, keep its mandate. Safe to call more than once. */
export async function saveMandateFromPayment(intentId: string, payment: Record<string, unknown> | undefined) {
  const intent = await prisma.paymentIntent.findUnique({ where: { id: intentId } });
  const meta = (intent?.meta ?? {}) as Meta;
  if (!intent || meta.autopay !== "register") return null;
  if (intent.gateway === "cashfree") {
    const subscriptionId = String(meta.subscriptionId ?? payment?.subscription_id ?? "");
    if (!subscriptionId) return null;
    return keepMandate(intent, { gateway: "cashfree", externalId: subscriptionId, secret: { subscriptionId }, label: "UPI AutoPay (Cashfree)", maxAmount: meta.maxAmount });
  }
  let tokenId = payment?.token_id ? String(payment.token_id) : "";
  const customerId = String(payment?.customer_id ?? meta.customerId ?? "");
  const rz = await razorpayCfg();
  if (!tokenId && rz && payment?.id) {
    const p = await rzp<{ token_id?: string }>(rz.cfg, "GET", `/payments/${payment.id}`).catch(() => null);
    tokenId = p?.token_id ? String(p.token_id) : "";
  }
  if (!tokenId || !customerId) return null;
  const vpa = payment?.vpa ? String(payment.vpa) : "";
  return keepMandate(intent, { gateway: "razorpay", externalId: tokenId, secret: { customerId, tokenId }, label: `UPI AutoPay${vpa ? ` — ${vpa}` : ""}`, maxAmount: meta.maxAmount });
}

async function keepMandate(intent: { userId: string }, m: { gateway: string; externalId: string; secret: Record<string, string>; label: string; maxAmount?: number }) {
  const pm = await prisma.$transaction(async (tx) => {
    // one mandate does the renewals: older ones stop being used (they stay listed)
    await tx.payMethod.updateMany({ where: { userId: intent.userId, autopay: true, NOT: { externalId: m.externalId } }, data: { autopay: false } });
    await tx.payMethod.updateMany({ where: { userId: intent.userId }, data: { isDefault: false } });
    return tx.payMethod.upsert({
      where: { externalId: m.externalId },
      update: { autopay: true, isDefault: true, status: "ACTIVE", label: m.label },
      create: { userId: intent.userId, type: "UPI", gateway: m.gateway, label: m.label, brand: "UPI", tokenEnc: encrypt(JSON.stringify(m.secret)), externalId: m.externalId, maxAmount: m.maxAmount ?? null, isDefault: true, autopay: true, status: "ACTIVE" },
    });
  });
  if (pm.createdAt.getTime() > Date.now() - 60_000) {
    await audit({ actorId: intent.userId, userId: intent.userId, action: "client.autopay_enabled", entity: "PayMethod", entityId: pm.id, details: { gateway: m.gateway, label: m.label, maxAmount: m.maxAmount } });
  }
  return pm;
}

/** token.* webhook */
export async function onTokenEvent(tokenId: string, event: string) {
  const status = event === "confirmed" ? "ACTIVE" : event === "paused" ? "PAUSED" : event === "cancelled" || event === "rejected" ? "REVOKED" : null;
  if (!status) return;
  const pm = await prisma.payMethod.findUnique({ where: { externalId: tokenId } });
  if (!pm || pm.status === status) return;
  await prisma.payMethod.update({ where: { id: pm.id }, data: { status, ...(status === "REVOKED" ? { autopay: false } : {}) } });
  await audit({ userId: pm.userId, action: `client.autopay_${event}`, entity: "PayMethod", entityId: pm.id });
}

/** payment.failed webhook for an AutoPay renewal charge */
export async function onChargeFailed(gatewayOrderId: string, reason: string) {
  const intent = await prisma.paymentIntent.findFirst({ where: { gateway: { in: MANDATE_GATEWAYS }, gatewayOrderId } });
  const meta = (intent?.meta ?? {}) as Meta;
  if (!intent || meta.autopay !== "charge" || intent.status === "PAID") return;
  await prisma.paymentIntent.update({ where: { id: intent.id }, data: { status: "FAILED", meta: { ...meta, error: reason } } });
  const inv = await prisma.invoice.findUnique({ where: { id: intent.invoiceId }, include: { user: true } });
  if (inv && inv.status === "UNPAID") await notify(inv.user, "AutoPay couldn't pay your invoice", `<p>Your UPI AutoPay payment of <b>₹${(intent.amount / 100).toFixed(2)}</b> for invoice ${inv.number ?? inv.proformaNumber} didn't go through (${escapeHtml(reason)}).</p><p>We'll try again in a day or two. To avoid any interruption you can also pay it now from your client area.</p>`);
}

/** The customer / staff turns AutoPay off — also cancels the mandate at Razorpay. */
export async function cancelMandate(payMethodId: string, userId: string, actorId: string) {
  const pm = await prisma.payMethod.findFirst({ where: { id: payMethodId, userId } });
  if (!pm) throw notFound("Payment method not found");
  if (pm.gateway === "cashfree" && pm.externalId && pm.status !== "REVOKED") {
    const g = await gatewayCfg("cashfree");
    if (g) await cf(g, "POST", `/subscriptions/${encodeURIComponent(pm.externalId)}/manage`, { subscription_id: pm.externalId, action: "CANCEL" }).catch((e) => console.warn(`[autopay] cancel ${pm.externalId}:`, (e as Error).message));
  }
  if (pm.gateway === "razorpay" && pm.tokenEnc && pm.status !== "REVOKED") {
    const rz = await razorpayCfg();
    const { customerId, tokenId } = JSON.parse(decrypt(pm.tokenEnc)) as { customerId: string; tokenId: string };
    if (rz) await rzp(rz.cfg, "PUT", `/customers/${customerId}/tokens/${tokenId}/cancel`).catch((e) => console.warn(`[autopay] cancel ${tokenId}:`, (e as Error).message));
  }
  await prisma.payMethod.update({ where: { id: pm.id }, data: { autopay: false, status: "REVOKED" } });
  await audit({ actorId, userId, action: "client.autopay_disabled", entity: "PayMethod", entityId: pm.id });
}

// ───────────────────────── renewals ─────────────────────────

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
async function notify(user: { id: string; email: string; firstName: string }, subject: string, messageHtml: string) {
  await queueEmail("staff.message", user.email, { name: user.firstName, subject, messageHtml }, user.id).catch(() => undefined);
}

/**
 * Charge unpaid renewal invoices to the customer's mandate, a few days before they're due.
 * At most one charge in flight per invoice, at most 3 attempts, never above the mandate's limit.
 */
export async function runAutopay(now = new Date()) {
  const s = await getSettings();
  if (!s.automation.upiAutopay) return { skipped: "UPI AutoPay is switched off" };
  const gws: Record<string, Awaited<ReturnType<typeof gatewayCfg>>> = { razorpay: await razorpayCfg(), cashfree: await gatewayCfg("cashfree") };
  const live = MANDATE_GATEWAYS.filter((g) => gws[g]);
  if (!live.length) return { skipped: "No AutoPay gateway is enabled" };
  const days = Math.max(2, s.automation.autopayDaysBeforeDue ?? 3);
  const pmWhere = { gateway: { in: live }, type: "UPI", autopay: true, status: "ACTIVE", externalId: { not: null } };
  const invoices = await prisma.invoice.findMany({
    where: {
      status: "UNPAID",
      currency: "INR",
      isWalletTopup: false,
      dueDate: { lte: new Date(now.getTime() + days * 86400_000), gte: new Date(now.getTime() - 10 * 86400_000) },
      user: { payMethods: { some: pmWhere } },
    },
    include: { user: { include: { payMethods: { where: pmWhere, orderBy: { createdAt: "desc" }, take: 1 } } }, paymentIntents: { where: { gateway: { in: MANDATE_GATEWAYS } }, orderBy: { createdAt: "desc" } } },
    take: 200,
  });
  const out = { charged: 0, skipped: 0, failed: 0, details: [] as string[] };
  for (const inv of invoices) {
    const pm = inv.user.payMethods[0];
    const g = pm ? gws[pm.gateway] : null;
    const due = inv.total - inv.amountPaid;
    const charges = inv.paymentIntents.filter((i) => ((i.meta ?? {}) as Meta).autopay === "charge");
    const inFlight = charges.find((i) => i.status === "CREATED" && i.createdAt.getTime() > now.getTime() - 3 * 86400_000);
    const lastTry = charges[0]?.createdAt.getTime() ?? 0;
    const label = inv.number ?? inv.proformaNumber;
    if (!pm?.tokenEnc || !g || due < 100 || inFlight || charges.length >= MAX_ATTEMPTS || lastTry > now.getTime() - 36 * 3600_000) {
      out.skipped++;
      continue;
    }
    if (pm.maxAmount && due > pm.maxAmount) {
      // above what the customer approved — they pay this one themselves (once)
      if (!charges.length) {
        await prisma.paymentIntent.create({ data: { userId: inv.userId, invoiceId: inv.id, gateway: pm.gateway, amount: due, currency: "INR", status: "FAILED", meta: { autopay: "charge", payMethodId: pm.id, error: "Above the AutoPay limit" } satisfies Meta } });
        await notify(inv.user, "Please pay this invoice yourself", `<p>Invoice ${label} for <b>₹${(due / 100).toFixed(2)}</b> is more than your UPI AutoPay limit of ₹${(pm.maxAmount / 100).toFixed(2)}, so it won't be paid automatically. Please pay it from your client area — you can set up a new AutoPay with a higher limit while paying.</p>`);
      }
      out.skipped++;
      continue;
    }
    const secret = JSON.parse(decrypt(pm.tokenEnc)) as { customerId?: string; tokenId?: string; subscriptionId?: string };
    const intent = await prisma.paymentIntent.create({ data: { userId: inv.userId, invoiceId: inv.id, gateway: pm.gateway, amount: due, currency: "INR", meta: { autopay: "charge", payMethodId: pm.id } satisfies Meta } });
    try {
      let paymentRef: string | undefined;
      if (pm.gateway === "cashfree") {
        // the bank notifies 24 h before a UPI debit — schedule it just after that
        await prisma.paymentIntent.update({ where: { id: intent.id }, data: { gatewayOrderId: intent.id } });
        const r = await cf<{ cf_payment_id?: string | number; payment_status?: string; failure_details?: { failure_reason?: string } }>(g, "POST", "/subscriptions/pay", {
          subscription_id: secret.subscriptionId ?? pm.externalId,
          payment_id: intent.id,
          payment_type: "CHARGE",
          payment_amount: rupees(due),
          payment_schedule_date: new Date(now.getTime() + 26 * 3600_000).toISOString().replace(/\.\d{3}Z$/, "Z"),
          payment_remarks: `Invoice ${label}`.slice(0, 60),
        });
        if (r.payment_status === "FAILED") throw new Error(r.failure_details?.failure_reason ?? "Cashfree refused the charge");
        paymentRef = r.cf_payment_id != null ? String(r.cf_payment_id) : undefined;
      } else {
        const order = await rzp<{ id: string }>(g.cfg, "POST", "/orders", { amount: due, currency: "INR", payment_capture: true, receipt: intent.id, notes: { intentId: intent.id, invoiceId: inv.id, autopay: "charge" } });
        await prisma.paymentIntent.update({ where: { id: intent.id }, data: { gatewayOrderId: order.id } });
        const phone = inv.user.phone?.replace(/[^\d+]/g, "") || undefined;
        const r = await rzp<{ razorpay_payment_id?: string }>(g.cfg, "POST", "/payments/create/recurring", {
          email: inv.user.email,
          contact: phone,
          amount: due,
          currency: "INR",
          order_id: order.id,
          customer_id: secret.customerId,
          token: secret.tokenId,
          recurring: "1",
          description: `Invoice ${label}`.slice(0, 48),
          notes: { intentId: intent.id, invoiceId: inv.id },
        });
        paymentRef = r.razorpay_payment_id;
      }
      await prisma.paymentIntent.update({ where: { id: intent.id }, data: { meta: { autopay: "charge", payMethodId: pm.id, paymentId: paymentRef } satisfies Meta } });
      await prisma.payMethod.update({ where: { id: pm.id }, data: { lastUsedAt: now } });
      await audit({ userId: inv.userId, action: "billing.autopay_charge_started", entity: "Invoice", entityId: inv.id, details: { amount: due, gateway: pm.gateway, payment: paymentRef } });
      out.charged++;
      out.details.push(`${label}: ₹${(due / 100).toFixed(2)} requested via ${pm.gateway}`);
    } catch (e) {
      const msg = (e as Error).message.slice(0, 300);
      await prisma.paymentIntent.update({ where: { id: intent.id }, data: { status: "FAILED", meta: { autopay: "charge", payMethodId: pm.id, error: msg } satisfies Meta } });
      // a mandate the gateway no longer accepts isn't tried again
      if (/token.*(invalid|cancel|expire|not active|paused)|mandate.*(cancel|revok|expire)|subscription.*(cancel|expire|not active|paused|on.hold)/i.test(msg)) await prisma.payMethod.update({ where: { id: pm.id }, data: { status: "REVOKED", autopay: false } });
      out.failed++;
      out.details.push(`${label}: ${msg}`);
    }
  }
  return out;
}

/** For the payment page: is AutoPay offered, and does the customer already have one? */
export async function autopayOffer(invoiceId: string, userId: string) {
  if (!(await autopayEligible(invoiceId, userId))) return null;
  const m = await activeMandate(userId);
  const g = await autopayProvider();
  return { code: g?.code === "cashfree" ? CF_AUTOPAY_CODE : AUTOPAY_CODE, active: m ? { label: m.label, maxAmount: m.maxAmount } : null };
}

export function assertAutopayAmount(amount: number) {
  if (amount > MAX_MANDATE) throw badRequest("UPI AutoPay can't be used for amounts above ₹99,999");
}
