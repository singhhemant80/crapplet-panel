/**
 * Refunds — staff choose where the money goes:
 *   gateway → back to the customer's card / UPI / bank through the original gateway's API
 *             (Razorpay, Stripe, PayPal, Cashfree, PayU); no separate trip to the gateway dashboard
 *   wallet  → added to the customer's account credit
 *   manual  → already paid back outside the panel (bank transfer, cash) — recorded only
 *
 * Every refund row points at the payment it reverses (refundOfId), so the total refunded across all
 * methods can never exceed what was paid. The refund row and its GST credit note are written in one
 * database transaction; for gateway refunds the gateway is called first with a unique refund id.
 */
import { randomBytes } from "node:crypto";
import { prisma, type Transaction } from "../../db";
import { decryptJson } from "../../lib/crypto";
import { badRequest, conflict, HttpError } from "../../lib/http";
import { adjustCredit, issueCreditNoteTx } from "../billing/invoices";
import { GATEWAYS } from "./gateways";

export type RefundMethod = "gateway" | "wallet" | "manual";
const OFFLINE = new Set(["bank", "upi", "manual", "wire", "credit"]);

/** Gateway credentials for refunds — works even if the gateway is switched off for new payments. */
async function refundConfig(code: string) {
  const g = await prisma.paymentGateway.findUnique({ where: { code } });
  const impl = GATEWAYS[code];
  if (!g || !impl?.refund) return null;
  return { impl, testMode: g.testMode, secrets: decryptJson<Record<string, string>>(g.configEnc) };
}

/** How much of each payment on an invoice is still refundable, and by which methods. */
export async function refundablePayments(invoiceId: string) {
  const txns = await prisma.transaction.findMany({ where: { invoiceId }, orderBy: { createdAt: "asc" } });
  const pays = txns.filter((t) => t.type === "PAYMENT" || t.type === "CREDIT_APPLIED");
  const refunds = txns.filter((t) => t.type === "REFUND");
  const out = [];
  for (const p of pays) {
    // linked refunds, plus refunds made before refunds were linked (matched by the payment reference)
    const done = refunds.filter((r) => r.refundOfId === p.id || (!r.refundOfId && r.description?.includes(p.gatewayTxnId))).reduce((s, r) => s + Math.abs(r.amount), 0);
    const left = Math.max(0, p.amount - done);
    const cfg = p.type === "PAYMENT" && !OFFLINE.has(p.gateway) ? await refundConfig(p.gateway) : null;
    out.push({
      id: p.id,
      gateway: p.type === "CREDIT_APPLIED" ? "credit" : p.gateway,
      reference: p.gatewayTxnId,
      paidAt: p.createdAt,
      amount: p.amount,
      refunded: done,
      refundable: left,
      currency: p.currency,
      viaGateway: !!cfg,
      gatewayNote: p.type === "CREDIT_APPLIED" ? "Paid from account credit — refunds go back to the wallet" : OFFLINE.has(p.gateway) ? `${p.gateway.toUpperCase()} payment — refund it outside the panel (Manual) or to the wallet` : cfg ? null : `${p.gateway} isn't configured for API refunds`,
    });
  }
  return out;
}

export async function refundOptions(invoiceId: string) {
  const inv = await prisma.invoice.findUniqueOrThrow({ where: { id: invoiceId }, select: { id: true, status: true, total: true, currency: true, userId: true } });
  const payments = await refundablePayments(invoiceId);
  const sum = (f: (p: (typeof payments)[number]) => boolean) => payments.filter(f).reduce((s, p) => s + p.refundable, 0);
  return {
    currency: inv.currency,
    status: inv.status,
    payments,
    max: { gateway: sum((p) => p.viaGateway), wallet: sum(() => true), manual: sum((p) => p.gateway !== "credit") },
  };
}

/**
 * Refund `amount` of an invoice by `method`, spread over its payments (newest first).
 * Gateway: only payments the gateway can refund by API. Wallet: any payment. Manual: non-wallet payments.
 */
export async function refundInvoice(args: { invoiceId: string; amount: number; method: RefundMethod; reason: string; actorId: string }) {
  const inv = await prisma.invoice.findUniqueOrThrow({ where: { id: args.invoiceId }, include: { user: { include: { profile: true } } } });
  if (inv.status !== "PAID" && inv.status !== "REFUNDED") throw conflict("Only paid invoices can be refunded");
  if (args.amount <= 0) throw badRequest("Enter the amount to refund");
  const payments = (await refundablePayments(inv.id)).filter((p) => p.refundable > 0 && (args.method === "gateway" ? p.viaGateway : args.method === "manual" ? p.gateway !== "credit" : true)).reverse();
  const available = payments.reduce((s, p) => s + p.refundable, 0);
  if (args.amount > available)
    throw badRequest(
      args.method === "gateway"
        ? `Only ${(available / 100).toFixed(2)} ${inv.currency} can go back through a payment gateway on this invoice — refund the rest to the wallet or mark it as refunded manually`
        : `Only ${(available / 100).toFixed(2)} ${inv.currency} is left to refund on this invoice`,
    );
  if (args.method === "wallet" && (inv.user.profile?.currency ?? "INR") !== inv.currency) throw badRequest(`The customer's wallet is in ${inv.user.profile?.currency} but this invoice is in ${inv.currency} — refund through the gateway or manually`);

  let left = args.amount;
  const done: { paymentId: string; amount: number; refundId: string; gateway: string; status?: string }[] = [];
  for (const p of payments) {
    if (left <= 0) break;
    const amount = Math.min(left, p.refundable);
    done.push(await refundOne({ paymentId: p.id, amount, method: args.method, reason: args.reason, actorId: args.actorId }));
    left -= amount;
  }
  return { refunded: args.amount, parts: done };
}

/** Refund one payment. Used by refundInvoice and the per-transaction Refund button. */
export async function refundOne(args: { paymentId: string; amount: number; method: RefundMethod; reason: string; actorId: string }) {
  const p = await prisma.transaction.findUniqueOrThrow({ where: { id: args.paymentId } });
  if (p.type !== "PAYMENT" && p.type !== "CREDIT_APPLIED") throw badRequest("Only payments can be refunded");
  if (p.type === "CREDIT_APPLIED" && args.method === "gateway") throw badRequest("This was paid from account credit — refund it to the wallet");
  const row = (await refundablePayments(p.invoiceId ?? "")).find((x) => x.id === p.id);
  const refundable = row?.refundable ?? p.amount - (await alreadyRefunded(p));
  if (args.amount <= 0 || args.amount > refundable) throw badRequest(`At most ${(refundable / 100).toFixed(2)} ${p.currency} of this payment can still be refunded`);

  // a wallet top-up refunded to the card takes the credit back out — it must still be there
  const topup = p.invoiceId ? (await prisma.invoice.findUnique({ where: { id: p.invoiceId }, select: { isWalletTopup: true } }))?.isWalletTopup : false;
  if (topup) {
    if (args.method === "wallet") throw badRequest("This is a wallet top-up — the money is already in the wallet. Refund it through the gateway or manually.");
    const bal = (await prisma.clientProfile.findUnique({ where: { userId: p.userId }, select: { creditBalance: true } }))?.creditBalance ?? 0;
    if (bal < args.amount) throw badRequest(`The customer has only ${(bal / 100).toFixed(2)} ${p.currency} of this top-up left in their wallet — refund at most that`);
  }

  const ref = `rf_${p.id.slice(-8)}_${randomBytes(5).toString("hex")}`;
  let refundId = ref;
  let gateway = args.method === "wallet" ? "credit" : args.method === "manual" ? "manual" : p.gateway;
  let status: string | undefined;
  if (args.method === "gateway") {
    const cfg = await refundConfig(p.gateway);
    if (!cfg) throw new HttpError(400, `${p.gateway} can't refund automatically — choose Wallet or Manual`);
    // Cashfree refunds are per order — find the order this payment belonged to
    const orderId = p.gateway === "cashfree" ? await cashfreeOrderId(p) : null;
    try {
      const r = await cfg.impl.refund!(p.gatewayTxnId, args.amount, cfg.secrets, cfg.testMode, { ref, orderId, reason: args.reason });
      refundId = r.refundId || ref;
      status = r.status;
    } catch (e) {
      throw new HttpError(502, `${p.gateway} didn't accept the refund: ${(e as Error).message}`);
    }
    gateway = p.gateway;
  }

  try {
    await prisma.$transaction(async (tx) => {
      await tx.transaction.create({
        data: {
          userId: p.userId,
          invoiceId: p.invoiceId,
          gateway,
          gatewayTxnId: refundId,
          type: "REFUND",
          amount: args.amount,
          currency: p.currency,
          refundOfId: p.id,
          description: `Refund of ${p.gatewayTxnId} (${args.method === "gateway" ? `via ${p.gateway}` : args.method === "wallet" ? "to wallet" : "paid back manually"}): ${args.reason}`,
          raw: status ? { status } : undefined,
        },
      });
      if (p.invoiceId) {
        const inv = await tx.invoice.findUniqueOrThrow({ where: { id: p.invoiceId }, select: { status: true, isWalletTopup: true } });
        if (inv.status === "PAID" && !inv.isWalletTopup) await issueCreditNoteTx(tx, { invoiceId: p.invoiceId, amount: args.amount, reason: args.reason, toCredit: args.method === "wallet", actorId: args.actorId });
        else if (args.method === "wallet") await adjustCredit(tx, { userId: p.userId, amount: args.amount, description: `Refund of ${p.gatewayTxnId}`, refType: "refund", refId: p.id });
        // a refunded wallet top-up takes the credit back out
        if (inv.isWalletTopup) await adjustCredit(tx, { userId: p.userId, amount: -args.amount, description: `Top-up ${p.gatewayTxnId} refunded`, refType: "refund", refId: p.id });
        if (inv.isWalletTopup) {
          const total = await tx.transaction.aggregate({ where: { invoiceId: p.invoiceId, type: "REFUND" }, _sum: { amount: true } });
          const paid = await tx.invoice.findUniqueOrThrow({ where: { id: p.invoiceId }, select: { total: true } });
          if ((total._sum.amount ?? 0) >= paid.total) await tx.invoice.update({ where: { id: p.invoiceId }, data: { status: "REFUNDED" } });
        }
      } else if (args.method === "wallet") {
        await adjustCredit(tx, { userId: p.userId, amount: args.amount, description: `Refund of ${p.gatewayTxnId}`, refType: "refund", refId: p.id });
      }
    });
  } catch (e) {
    if (args.method === "gateway") {
      // money already went back — make sure staff see the gateway refund id even though our records failed
      console.error(`[refund] ${p.gateway} refund ${refundId} succeeded but recording it failed`, e);
      throw new HttpError(500, `${p.gateway} refunded it (refund id ${refundId}) but the panel couldn't record it: ${(e as Error).message}. Don't refund again — record it manually.`);
    }
    throw e;
  }
  return { paymentId: p.id, amount: args.amount, refundId, gateway, status };
}

async function alreadyRefunded(p: Transaction) {
  const r = await prisma.transaction.aggregate({ where: { type: "REFUND", OR: [{ refundOfId: p.id }, { refundOfId: null, description: { contains: p.gatewayTxnId } }] }, _sum: { amount: true } });
  return Math.abs(r._sum.amount ?? 0);
}

async function cashfreeOrderId(p: Transaction): Promise<string | null> {
  const raw = (p.raw ?? {}) as Record<string, any>;
  const fromRaw = raw.order_id ?? raw.order?.order_id;
  if (fromRaw) return String(fromRaw);
  const intent = await prisma.paymentIntent.findFirst({ where: { gateway: "cashfree", invoiceId: p.invoiceId ?? undefined, userId: p.userId, status: "PAID" }, orderBy: { updatedAt: "desc" } });
  return intent?.gatewayOrderId ?? intent?.id ?? null;
}
