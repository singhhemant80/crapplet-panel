import { prisma, Prisma } from "../../db";
import { decryptJson } from "../../lib/crypto";
import { badRequest, conflict, HttpError, notFound } from "../../lib/http";
import { applyPayment, invoiceLabel } from "../billing/invoices";
import { GATEWAYS, gatewayCurrencies, type Verified } from "./gateways";

export async function gatewayConfig(code: string) {
  const g = await prisma.paymentGateway.findUnique({ where: { code } });
  const impl = GATEWAYS[code];
  if (!g || !g.enabled || !impl) throw badRequest("This payment method is not available");
  return { row: g, impl, secrets: decryptJson<Record<string, string>>(g.configEnc), pub: (g.publicConfig ?? {}) as Record<string, unknown> };
}

export async function startPayment(args: { userId: string; invoiceId: string; gateway: string; amount?: number }) {
  const inv = await prisma.invoice.findUnique({ where: { id: args.invoiceId }, include: { user: true } });
  if (!inv || inv.userId !== args.userId) throw notFound("Invoice not found");
  if (inv.status !== "UNPAID") throw conflict("This invoice is not awaiting payment");
  const due = inv.total - inv.amountPaid;
  const amount = args.amount ? Math.min(args.amount, due) : due;
  if (amount < 100) throw badRequest(`Minimum payment is ${inv.currency === "INR" ? "₹1" : `1 ${inv.currency}`}`);
  const { impl, secrets, pub, row } = await gatewayConfig(args.gateway);
  if (!gatewayCurrencies(args.gateway, pub).includes(inv.currency)) throw badRequest(`${row.name} can't take ${inv.currency} payments — please choose another method`);
  if (impl.offline && (await prisma.paymentIntent.count({ where: { invoiceId: inv.id, status: "PENDING_REVIEW" } })))
    throw conflict("A payment for this invoice is already awaiting verification by our billing team");

  const intent = await prisma.paymentIntent.create({ data: { userId: args.userId, invoiceId: inv.id, gateway: args.gateway, amount, currency: inv.currency } });
  const payer = { id: inv.userId, name: `${inv.user.firstName} ${inv.user.lastName}`.trim(), email: inv.user.email, phone: inv.user.phone };
  try {
    const r = await impl.createPayment({ ...intent }, payer, secrets, pub, row.testMode, `Invoice ${invoiceLabel(inv)}`);
    if (r.gatewayOrderId) await prisma.paymentIntent.update({ where: { id: intent.id }, data: { gatewayOrderId: r.gatewayOrderId } });
    return { intentId: intent.id, ...r.client };
  } catch (e) {
    await prisma.paymentIntent.update({ where: { id: intent.id }, data: { status: "FAILED", meta: { error: String(e) } } });
    throw e;
  }
}

/** Apply a gateway-verified payment to its intent's invoice (idempotent). */
export async function settleVerified(gateway: string, v: Verified) {
  if (!v.paid) return { applied: false, reason: "not paid" };
  const intent = await prisma.paymentIntent.findFirst({
    where: { gateway, OR: [...(v.gatewayOrderId ? [{ gatewayOrderId: v.gatewayOrderId }] : []), ...(v.intentId ? [{ id: v.intentId }] : [])] },
  });
  if (!intent) throw notFound("Payment intent not found");
  if (v.currency && v.currency.toUpperCase() !== intent.currency) {
    // never credit a USD invoice with an INR charge (or vice versa)
    console.error(`[payments] ${gateway} ${v.gatewayTxnId} charged ${v.currency}, intent is ${intent.currency} — not applied`);
    throw badRequest(`Payment currency ${v.currency} doesn't match the invoice (${intent.currency}). Our billing team has been notified.`);
  }
  if (v.amount < intent.amount) {
    // underpaid — record what was received as a partial payment, keep the invoice open
    console.warn(`[payments] ${gateway} ${v.gatewayTxnId} amount ${v.amount} < intent ${intent.amount}`);
  }
  await prisma.paymentIntent.updateMany({ where: { id: intent.id, status: { in: ["CREATED", "FAILED", "EXPIRED"] } }, data: { status: "PAID" } });
  const r = await applyPayment({
    invoiceId: intent.invoiceId,
    amount: v.amount,
    gateway,
    gatewayTxnId: v.gatewayTxnId,
    fee: v.fee,
    raw: v.raw,
    description: `${gateway} payment`,
  });
  return { applied: !r.duplicate, invoicePaid: r.paid, invoiceId: intent.invoiceId };
}

export async function verifyReturn(args: { userId?: string; intentId: string; body: Record<string, unknown> }) {
  const intent = await prisma.paymentIntent.findUnique({ where: { id: args.intentId } });
  if (!intent || (args.userId && intent.userId !== args.userId)) throw notFound("Payment not found");
  const { impl, secrets, row } = await gatewayConfig(intent.gateway);
  if (!impl.verifyReturn) throw badRequest("This gateway confirms payments via webhook only");
  const v = await impl.verifyReturn(args.body, secrets, row.testMode, intent);
  if (!v.paid) return { paid: false, status: "pending" };
  const r = await settleVerified(intent.gateway, { ...v, gatewayOrderId: intent.gatewayOrderId ?? v.gatewayOrderId, intentId: intent.id });
  return { paid: true, ...r };
}

export async function handleWebhook(code: string, raw: Buffer, headers: Record<string, string | string[] | undefined>) {
  const { impl, secrets, row } = await gatewayConfig(code);
  if (!impl.parseWebhook) throw badRequest("Webhooks not supported for this gateway");
  const evt = await impl.parseWebhook(raw, headers, secrets, row.testMode); // throws on bad signature
  try {
    await prisma.webhookEvent.create({ data: { gateway: code, eventId: evt.eventId, type: evt.type, payload: JSON.parse(raw.toString("utf8")) as Prisma.InputJsonValue } });
  } catch (e) {
    if ((e as { code?: string }).code === "P2002") {
      const prev = await prisma.webhookEvent.findUnique({ where: { gateway_eventId: { gateway: code, eventId: evt.eventId } } });
      if (prev?.processedAt) return { duplicate: true };
    } else throw e;
  }
  const results = [];
  try {
    for (const p of evt.payments) results.push(await settleVerified(code, p));
    await prisma.webhookEvent.update({ where: { gateway_eventId: { gateway: code, eventId: evt.eventId } }, data: { processedAt: new Date(), error: null } });
  } catch (e) {
    await prisma.webhookEvent.update({ where: { gateway_eventId: { gateway: code, eventId: evt.eventId } }, data: { error: String(e) } });
    throw e;
  }
  return { ok: true, results };
}

/** Offline methods: customer submits a UTR / reference, staff verify against the bank statement. */
export async function submitOfflineReference(args: { userId: string; intentId: string; reference: string }) {
  const intent = await prisma.paymentIntent.findUnique({ where: { id: args.intentId } });
  if (!intent || intent.userId !== args.userId) throw notFound("Payment not found");
  if (!GATEWAYS[intent.gateway]?.offline) throw badRequest("Not an offline payment method");
  if (intent.status !== "CREATED") throw conflict("Reference already submitted");
  const dupe = await prisma.paymentIntent.findFirst({ where: { gateway: intent.gateway, reference: args.reference, NOT: { id: intent.id } } });
  if (dupe) throw conflict("This reference number has already been submitted");
  await prisma.paymentIntent.update({ where: { id: intent.id }, data: { reference: args.reference, status: "PENDING_REVIEW" } });
  return { ok: true };
}

export async function reviewOfflinePayment(args: { intentId: string; approve: boolean; amount?: number; actorId: string; note?: string }) {
  const intent = await prisma.paymentIntent.findUniqueOrThrow({ where: { id: args.intentId } });
  if (intent.status !== "PENDING_REVIEW") throw conflict("Payment is not awaiting review");
  if (!args.approve) {
    await prisma.paymentIntent.update({ where: { id: intent.id }, data: { status: "REJECTED", meta: { note: args.note, by: args.actorId } } });
    return { ok: true, rejected: true };
  }
  const updated = await prisma.paymentIntent.updateMany({ where: { id: intent.id, status: "PENDING_REVIEW" }, data: { status: "PAID", meta: { approvedBy: args.actorId, note: args.note } } });
  if (!updated.count) throw conflict("Already processed");
  const r = await applyPayment({ invoiceId: intent.invoiceId, amount: args.amount ?? intent.amount, gateway: intent.gateway, gatewayTxnId: intent.reference ?? intent.id, description: `${intent.gateway} payment approved by staff` });
  return { ok: true, ...r };
}

export async function refundTransaction(args: { transactionId: string; amount: number; toCredit: boolean; actorId: string; reason: string }) {
  const t = await prisma.transaction.findUniqueOrThrow({ where: { id: args.transactionId } });
  if (t.type !== "PAYMENT") throw badRequest("Only payments can be refunded");
  const refunded = await prisma.transaction.aggregate({ where: { gateway: t.gateway, type: "REFUND", description: { contains: t.gatewayTxnId } }, _sum: { amount: true } });
  if (args.amount <= 0 || args.amount + (refunded._sum.amount ?? 0) > t.amount) throw badRequest("Refund exceeds the original payment");
  let refundId = `credit-${Date.now()}`;
  if (!args.toCredit) {
    const impl = GATEWAYS[t.gateway];
    if (!impl?.refund) throw new HttpError(400, `Automatic refunds are not supported for ${t.gateway}. Refund to credit or refund manually.`);
    const { secrets, row } = await gatewayConfig(t.gateway);
    refundId = (await impl.refund(t.gatewayTxnId, args.amount, secrets, row.testMode)).refundId;
  }
  await prisma.transaction.create({
    data: { userId: t.userId, invoiceId: t.invoiceId, gateway: args.toCredit ? "credit" : t.gateway, gatewayTxnId: refundId, type: "REFUND", amount: args.amount, currency: t.currency, description: `Refund of ${t.gatewayTxnId}: ${args.reason}` },
  });
  if (t.invoiceId) {
    const { issueCreditNote } = await import("../billing/invoices");
    await issueCreditNote({ invoiceId: t.invoiceId, amount: args.amount, reason: args.reason, toCredit: args.toCredit, actorId: args.actorId }).catch((e) => console.warn("[refund] credit note", e));
  }
  return { ok: true, refundId };
}
