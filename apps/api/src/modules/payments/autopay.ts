/**
 * UPI AutoPay (Razorpay recurring payments).
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
import { RZP_BASE, httpJson, type GatewayConfig } from "./gateways";

const RZP = RZP_BASE;
const auth = (cfg: GatewayConfig) => "Basic " + Buffer.from(`${cfg.keyId}:${cfg.keySecret}`).toString("base64");
const rzp = <T>(cfg: GatewayConfig, method: string, path: string, body?: unknown) =>
  httpJson<T>(`${RZP}${path}`, { method, headers: { Authorization: auth(cfg), "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });

export const AUTOPAY_CODE = "razorpay_autopay";
/** Razorpay's UPI mandate ceiling for ordinary merchants: ₹99,999 */
const MAX_MANDATE = 9_999_900;
const MAX_ATTEMPTS = 3;
type Meta = { autopay?: "register" | "charge"; customerId?: string; maxAmount?: number; payMethodId?: string; error?: string; [k: string]: unknown };

/** Most the mandate allows per debit: comfortably above this invoice (prices change, add-ons), rounded to ₹500. */
export function mandateMax(invoiceTotal: number) {
  const want = Math.max(invoiceTotal * 2, 100_000);
  return Math.min(MAX_MANDATE, Math.ceil(want / 50_000) * 50_000);
}

async function razorpayCfg() {
  const g = await prisma.paymentGateway.findUnique({ where: { code: "razorpay" } });
  if (!g?.enabled) return null;
  const { decryptJson } = await import("../../lib/crypto");
  return { row: g, cfg: decryptJson<Record<string, string>>(g.configEnc) };
}

/** Can this invoice be paid with UPI AutoPay (renewing services / domains, INR, Razorpay on, switched on)? */
export async function autopayEligible(invoiceId: string, userId: string) {
  const s = await getSettings();
  if (!s.automation.upiAutopay) return false;
  const inv = await prisma.invoice.findUnique({ where: { id: invoiceId }, include: { items: true } });
  if (!inv || inv.userId !== userId || inv.status !== "UNPAID" || inv.currency !== "INR" || inv.isWalletTopup) return false;
  if (inv.total - inv.amountPaid > MAX_MANDATE) return false;
  if (!(await razorpayCfg())) return false;
  const serviceIds = inv.items.filter((i) => i.type === "SERVICE" && i.relId).map((i) => i.relId!);
  const renewing = serviceIds.length ? await prisma.service.count({ where: { id: { in: serviceIds }, billingCycle: { not: "ONETIME" } } }) : 0;
  return renewing > 0 || inv.items.some((i) => i.type === "DOMAIN");
}

/** The customer already has a working mandate (renewals will be charged to it). */
export const activeMandate = (userId: string) =>
  prisma.payMethod.findFirst({ where: { userId, gateway: "razorpay", type: "UPI", autopay: true, status: "ACTIVE", externalId: { not: null } }, orderBy: { createdAt: "desc" } });

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
  let tokenId = payment?.token_id ? String(payment.token_id) : "";
  const customerId = String(payment?.customer_id ?? meta.customerId ?? "");
  const rz = await razorpayCfg();
  if (!tokenId && rz && payment?.id) {
    const p = await rzp<{ token_id?: string }>(rz.cfg, "GET", `/payments/${payment.id}`).catch(() => null);
    tokenId = p?.token_id ? String(p.token_id) : "";
  }
  if (!tokenId || !customerId) return null;
  const vpa = payment?.vpa ? String(payment.vpa) : "";
  const label = `UPI AutoPay${vpa ? ` — ${vpa}` : ""}`;
  const pm = await prisma.$transaction(async (tx) => {
    // one mandate does the renewals: older ones stop being used (they stay listed)
    await tx.payMethod.updateMany({ where: { userId: intent.userId, autopay: true, NOT: { externalId: tokenId } }, data: { autopay: false } });
    await tx.payMethod.updateMany({ where: { userId: intent.userId }, data: { isDefault: false } });
    return tx.payMethod.upsert({
      where: { externalId: tokenId },
      update: { autopay: true, isDefault: true, status: "ACTIVE", label },
      create: { userId: intent.userId, type: "UPI", gateway: "razorpay", label, brand: "UPI", tokenEnc: encrypt(JSON.stringify({ customerId, tokenId })), externalId: tokenId, maxAmount: meta.maxAmount ?? null, isDefault: true, autopay: true, status: "ACTIVE" },
    });
  });
  if (pm.createdAt.getTime() > Date.now() - 60_000) {
    await audit({ actorId: intent.userId, userId: intent.userId, action: "client.autopay_enabled", entity: "PayMethod", entityId: pm.id, details: { gateway: "razorpay", vpa: vpa || undefined, maxAmount: meta.maxAmount } });
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
  const intent = await prisma.paymentIntent.findFirst({ where: { gateway: "razorpay", gatewayOrderId } });
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
  const rz = await razorpayCfg();
  if (!rz) return { skipped: "Razorpay isn't enabled" };
  const days = Math.max(2, s.automation.autopayDaysBeforeDue ?? 3);
  const invoices = await prisma.invoice.findMany({
    where: {
      status: "UNPAID",
      currency: "INR",
      isWalletTopup: false,
      dueDate: { lte: new Date(now.getTime() + days * 86400_000), gte: new Date(now.getTime() - 10 * 86400_000) },
      user: { payMethods: { some: { gateway: "razorpay", type: "UPI", autopay: true, status: "ACTIVE", externalId: { not: null } } } },
    },
    include: { user: { include: { payMethods: { where: { gateway: "razorpay", type: "UPI", autopay: true, status: "ACTIVE", externalId: { not: null } }, orderBy: { createdAt: "desc" }, take: 1 } } }, paymentIntents: { where: { gateway: "razorpay" }, orderBy: { createdAt: "desc" } } },
    take: 200,
  });
  const out = { charged: 0, skipped: 0, failed: 0, details: [] as string[] };
  for (const inv of invoices) {
    const pm = inv.user.payMethods[0];
    const due = inv.total - inv.amountPaid;
    const charges = inv.paymentIntents.filter((i) => ((i.meta ?? {}) as Meta).autopay === "charge");
    const inFlight = charges.find((i) => i.status === "CREATED" && i.createdAt.getTime() > now.getTime() - 3 * 86400_000);
    const lastTry = charges[0]?.createdAt.getTime() ?? 0;
    const label = inv.number ?? inv.proformaNumber;
    if (!pm?.tokenEnc || due < 100 || inFlight || charges.length >= MAX_ATTEMPTS || lastTry > now.getTime() - 36 * 3600_000) {
      out.skipped++;
      continue;
    }
    if (pm.maxAmount && due > pm.maxAmount) {
      // above what the customer approved — they pay this one themselves (once)
      if (!charges.length) {
        await prisma.paymentIntent.create({ data: { userId: inv.userId, invoiceId: inv.id, gateway: "razorpay", amount: due, currency: "INR", status: "FAILED", meta: { autopay: "charge", payMethodId: pm.id, error: "Above the AutoPay limit" } satisfies Meta } });
        await notify(inv.user, "Please pay this invoice yourself", `<p>Invoice ${label} for <b>₹${(due / 100).toFixed(2)}</b> is more than your UPI AutoPay limit of ₹${(pm.maxAmount / 100).toFixed(2)}, so it won't be paid automatically. Please pay it from your client area — you can set up a new AutoPay with a higher limit while paying.</p>`);
      }
      out.skipped++;
      continue;
    }
    const { customerId, tokenId } = JSON.parse(decrypt(pm.tokenEnc)) as { customerId: string; tokenId: string };
    const intent = await prisma.paymentIntent.create({ data: { userId: inv.userId, invoiceId: inv.id, gateway: "razorpay", amount: due, currency: "INR", meta: { autopay: "charge", payMethodId: pm.id } satisfies Meta } });
    try {
      const order = await rzp<{ id: string }>(rz.cfg, "POST", "/orders", { amount: due, currency: "INR", payment_capture: true, receipt: intent.id, notes: { intentId: intent.id, invoiceId: inv.id, autopay: "charge" } });
      await prisma.paymentIntent.update({ where: { id: intent.id }, data: { gatewayOrderId: order.id } });
      const phone = inv.user.phone?.replace(/[^\d+]/g, "") || undefined;
      const r = await rzp<{ razorpay_payment_id?: string }>(rz.cfg, "POST", "/payments/create/recurring", {
        email: inv.user.email,
        contact: phone,
        amount: due,
        currency: "INR",
        order_id: order.id,
        customer_id: customerId,
        token: tokenId,
        recurring: "1",
        description: `Invoice ${label}`.slice(0, 48),
        notes: { intentId: intent.id, invoiceId: inv.id },
      });
      await prisma.paymentIntent.update({ where: { id: intent.id }, data: { meta: { autopay: "charge", payMethodId: pm.id, paymentId: r.razorpay_payment_id } satisfies Meta } });
      await prisma.payMethod.update({ where: { id: pm.id }, data: { lastUsedAt: now } });
      await audit({ userId: inv.userId, action: "billing.autopay_charge_started", entity: "Invoice", entityId: inv.id, details: { amount: due, payment: r.razorpay_payment_id } });
      out.charged++;
      out.details.push(`${label}: ₹${(due / 100).toFixed(2)} requested`);
    } catch (e) {
      const msg = (e as Error).message.slice(0, 300);
      await prisma.paymentIntent.update({ where: { id: intent.id }, data: { status: "FAILED", meta: { autopay: "charge", payMethodId: pm.id, error: msg } satisfies Meta } });
      // a mandate Razorpay no longer accepts isn't tried again
      if (/token.*(invalid|cancel|expire|not active|paused)|mandate.*(cancel|revok|expire)/i.test(msg)) await prisma.payMethod.update({ where: { id: pm.id }, data: { status: "REVOKED", autopay: false } });
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
  return { code: AUTOPAY_CODE, active: m ? { label: m.label, maxAmount: m.maxAmount } : null };
}

export function assertAutopayAmount(amount: number) {
  if (amount > MAX_MANDATE) throw badRequest("UPI AutoPay can't be used for amounts above ₹99,999");
}
