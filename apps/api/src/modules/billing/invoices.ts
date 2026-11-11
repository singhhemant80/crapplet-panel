import { inrPerUnit, requireCurrency } from "../../lib/currency";
import { prisma, type Db, type Tx, InvoiceItemType, Prisma } from "../../db";
import { HttpError, badRequest, conflict, notFound } from "../../lib/http";
import { getSettings } from "../../lib/settings";
import { nextSequence } from "../../lib/sequence";
import { addDays, financialYear, formatMoney } from "../../lib/money";
import { computeGst } from "./gst";

export interface NewInvoiceItem {
  type: InvoiceItemType;
  relId?: string | null;
  description: string;
  hsnSac?: string | null;
  quantity?: number;
  unitPrice: number;
  taxable?: boolean;
  periodStart?: Date | null;
  periodEnd?: Date | null;
}

export async function createInvoice(
  db: Tx,
  args: { userId: string; items: NewInvoiceItem[]; dueDate?: Date; notes?: string; isWalletTopup?: boolean; currency?: string },
) {
  if (!args.items.length) throw badRequest("Invoice needs at least one item");
  const settings = await getSettings(db);
  const user = await db.user.findUniqueOrThrow({ where: { id: args.userId }, include: { profile: true } });
  const p = user.profile;
  const items = args.items.map((i) => {
    const qty = i.quantity ?? 1;
    return { ...i, quantity: qty, amount: i.unitPrice * qty, taxable: args.isWalletTopup ? false : (i.taxable ?? true), hsnSac: i.hsnSac ?? (i.type === "DOMAIN" ? settings.tax.domainSac : settings.tax.defaultSac) };
  });
  const tax = computeGst(
    items.map((i) => ({ amount: i.amount, taxable: i.taxable })),
    {
      enabled: settings.tax.enabled,
      rate: settings.tax.gstRate,
      inclusive: settings.tax.pricesIncludeTax,
      companyStateCode: settings.company.stateCode,
      applyToForeign: settings.tax.applyToForeign,
      customer: { country: p?.country ?? "IN", stateCode: p?.stateCode, gstin: p?.gstin },
    },
  );
  const discount = -items.filter((i) => i.amount < 0).reduce((s, i) => s + i.amount, 0);
  const cur = await requireCurrency(args.currency ?? p?.currency ?? "INR", db);
  const seq = await nextSequence("proforma", db);
  const invoice = await db.invoice.create({
    data: {
      proformaNumber: `${settings.invoice.proformaPrefix}${String(seq).padStart(6, "0")}`,
      userId: args.userId,
      currency: cur.code,
      exchangeRate: inrPerUnit(cur),
      dueDate: args.dueDate ?? addDays(new Date(), settings.invoice.dueDays),
      subtotal: tax.subtotal + discount,
      discount,
      taxableAmount: tax.taxableAmount,
      cgst: tax.cgst,
      sgst: tax.sgst,
      igst: tax.igst,
      taxTotal: tax.taxTotal,
      total: tax.total,
      taxInclusive: settings.tax.pricesIncludeTax,
      gstRate: tax.rate,
      placeOfSupply: tax.placeOfSupply,
      placeOfSupplyCode: tax.placeOfSupplyCode,
      customerGstin: p?.gstin ?? null,
      isWalletTopup: !!args.isWalletTopup,
      notes: args.notes,
      status: tax.total <= 0 ? "PAID" : "UNPAID",
      paidAt: tax.total <= 0 ? new Date() : null,
      billingSnapshot: {
        name: `${user.firstName} ${user.lastName}`.trim(),
        email: user.email,
        phone: user.phone,
        companyName: p?.companyName,
        address1: p?.address1,
        address2: p?.address2,
        city: p?.city,
        state: p?.state,
        stateCode: p?.stateCode,
        country: p?.country,
        postcode: p?.postcode,
        gstin: p?.gstin,
        pan: p?.pan,
      },
      items: {
        create: items.map((i) => ({
          type: i.type,
          relId: i.relId ?? null,
          description: i.description,
          hsnSac: i.hsnSac,
          quantity: i.quantity,
          unitPrice: i.unitPrice,
          amount: i.amount,
          taxable: i.taxable,
          periodStart: i.periodStart ?? null,
          periodEnd: i.periodEnd ?? null,
        })),
      },
    },
    include: { items: true },
  });
  if (invoice.status === "PAID") await assignTaxNumber(db, invoice.id);
  return invoice;
}

/**
 * Add lines to an unpaid invoice (late fee, adjustments) and recompute GST and totals the same way
 * createInvoice does, using the customer details captured on the invoice.
 */
export async function addInvoiceItemsTx(db: Tx, invoiceId: string, extra: NewInvoiceItem[]) {
  const inv = await db.invoice.findUniqueOrThrow({ where: { id: invoiceId }, include: { items: true } });
  if (inv.status !== "UNPAID") throw conflict("Only unpaid invoices can be changed");
  const settings = await getSettings(db);
  const snap = (inv.billingSnapshot ?? {}) as { country?: string; stateCode?: string | null; gstin?: string | null };
  for (const i of extra) {
    const qty = i.quantity ?? 1;
    await db.invoiceItem.create({
      data: { invoiceId, type: i.type, relId: i.relId ?? null, description: i.description, hsnSac: i.hsnSac ?? settings.tax.defaultSac, quantity: qty, unitPrice: i.unitPrice, amount: i.unitPrice * qty, taxable: i.taxable ?? true, periodStart: i.periodStart ?? null, periodEnd: i.periodEnd ?? null },
    });
  }
  const items = await db.invoiceItem.findMany({ where: { invoiceId } });
  const tax = computeGst(
    items.map((i) => ({ amount: i.amount, taxable: i.taxable })),
    {
      enabled: settings.tax.enabled,
      rate: inv.gstRate ?? settings.tax.gstRate,
      inclusive: inv.taxInclusive,
      companyStateCode: settings.company.stateCode,
      applyToForeign: settings.tax.applyToForeign,
      customer: { country: snap.country ?? "IN", stateCode: snap.stateCode, gstin: inv.customerGstin ?? snap.gstin },
    },
  );
  const discount = -items.filter((i) => i.amount < 0).reduce((s, i) => s + i.amount, 0);
  return db.invoice.update({
    where: { id: invoiceId },
    data: { subtotal: tax.subtotal + discount, discount, taxableAmount: tax.taxableAmount, cgst: tax.cgst, sgst: tax.sgst, igst: tax.igst, taxTotal: tax.taxTotal, total: tax.total },
    include: { items: true },
  });
}

/** Sequential tax-invoice number per Indian financial year, assigned when the invoice is paid. */
async function assignTaxNumber(db: Db, invoiceId: string) {
  const inv = await db.invoice.findUniqueOrThrow({ where: { id: invoiceId } });
  if (inv.number) return inv.number;
  const s = await getSettings(db);
  const fy = financialYear(inv.paidAt ?? new Date());
  const prefix = inv.isWalletTopup ? "RV/{FY}/" : s.invoice.taxPrefix;
  const seqName = inv.isWalletTopup ? `receipt:${fy}` : `invoice:${fy}`;
  const n = await nextSequence(seqName, db);
  const number = prefix.replace("{FY}", fy) + String(n).padStart(s.invoice.taxNumberPad, "0");
  await db.invoice.update({ where: { id: invoiceId }, data: { number } });
  return number;
}

export const invoiceLabel = (i: { number: string | null; proformaNumber: string }) => i.number ?? i.proformaNumber;

// ───── Credit balance ─────

export async function adjustCredit(db: Db, args: { userId: string; amount: number; description: string; refType?: string; refId?: string }) {
  const rows = await db.$queryRaw<{ creditBalance: number }[]>`
    UPDATE "ClientProfile" SET "creditBalance" = "creditBalance" + ${args.amount}
    WHERE "userId" = ${args.userId} AND "creditBalance" + ${args.amount} >= 0
    RETURNING "creditBalance"`;
  if (!rows.length) throw new HttpError(402, "Insufficient credit balance", "INSUFFICIENT_CREDIT");
  await db.creditLedger.create({
    data: { userId: args.userId, amount: args.amount, balanceAfter: Number(rows[0].creditBalance), description: args.description, refType: args.refType, refId: args.refId },
  });
  return Number(rows[0].creditBalance);
}

// ───── Payments ─────

export interface PaymentInput {
  invoiceId: string;
  amount: number;
  gateway: string;
  gatewayTxnId: string;
  fee?: number;
  raw?: unknown;
  description?: string;
}

/**
 * Idempotently records a verified payment against an invoice.
 * The unique (gateway, gatewayTxnId, type) constraint guarantees the same gateway transaction is never applied twice,
 * even if the webhook and the browser callback arrive simultaneously.
 */
export async function applyPayment(input: PaymentInput): Promise<{ duplicate: boolean; paid: boolean; invoiceId: string }> {
  if (input.amount <= 0) throw badRequest("Payment amount must be positive");
  let becamePaid = false;
  try {
    await prisma.$transaction(async (tx) => {
      const locked = await tx.$queryRaw<{ id: string; status: string; total: number; amountPaid: number; userId: string; currency: string }[]>`
        SELECT "id", "status", "total", "amountPaid", "userId", "currency" FROM "Invoice" WHERE "id" = ${input.invoiceId} FOR UPDATE`;
      const inv = locked[0];
      if (!inv) throw notFound("Invoice not found");
      await tx.transaction.create({
        data: {
          userId: inv.userId,
          invoiceId: inv.id,
          gateway: input.gateway,
          gatewayTxnId: input.gatewayTxnId,
          type: "PAYMENT",
          amount: input.amount,
          currency: inv.currency,
          fee: input.fee ?? 0,
          description: input.description ?? `Payment for invoice`,
          raw: (input.raw ?? undefined) as Prisma.InputJsonValue | undefined,
        },
      });
      if (inv.status === "PAID" || inv.status === "CANCELLED" || inv.status === "REFUNDED") {
        // payment for an already settled invoice → keep the money as account credit
        await adjustCredit(tx, { userId: inv.userId, amount: input.amount, description: `Overpayment via ${input.gateway} (${input.gatewayTxnId})`, refType: "invoice", refId: inv.id });
        return;
      }
      const paidNow = Number(inv.amountPaid) + input.amount;
      const total = Number(inv.total);
      const fully = paidNow >= total;
      await tx.invoice.update({
        where: { id: inv.id },
        data: { amountPaid: Math.min(paidNow, total), ...(fully ? { status: "PAID", paidAt: new Date() } : {}) },
      });
      if (paidNow > total) {
        await adjustCredit(tx, { userId: inv.userId, amount: paidNow - total, description: `Overpayment on invoice`, refType: "invoice", refId: inv.id });
      }
      if (fully) {
        await assignTaxNumber(tx, inv.id);
        becamePaid = true;
      }
    });
  } catch (e) {
    if ((e as { code?: string }).code === "P2002") return { duplicate: true, paid: false, invoiceId: input.invoiceId };
    throw e;
  }
  if (becamePaid) {
    const { onInvoicePaid } = await import("./hooks");
    await onInvoicePaid(input.invoiceId);
  }
  return { duplicate: false, paid: becamePaid, invoiceId: input.invoiceId };
}

/** Pay (part of) an invoice from the customer's credit balance. */
export async function applyCreditToInvoice(userId: string, invoiceId: string, maxAmount?: number) {
  let becamePaid = false;
  const applied = await prisma.$transaction(async (tx) => {
    const locked = await tx.$queryRaw<{ id: string; status: string; total: number; amountPaid: number; userId: string; isWalletTopup: boolean; currency: string }[]>`
      SELECT "id", "status", "total", "amountPaid", "userId", "isWalletTopup", "currency" FROM "Invoice" WHERE "id" = ${invoiceId} FOR UPDATE`;
    const inv = locked[0];
    if (!inv || inv.userId !== userId) throw notFound("Invoice not found");
    if (inv.status !== "UNPAID") throw conflict("Invoice is not payable");
    if (inv.isWalletTopup) throw badRequest("Credit cannot be used to pay a wallet top-up");
    const profile = await tx.clientProfile.findUniqueOrThrow({ where: { userId } });
    // the wallet is kept in the account currency — never mix currencies
    if (inv.currency !== profile.currency) throw badRequest(`Your credit balance is in ${profile.currency}; this invoice is in ${inv.currency}`);
    const due = Number(inv.total) - Number(inv.amountPaid);
    const amount = Math.min(due, profile.creditBalance, maxAmount ?? Infinity);
    if (amount <= 0) throw new HttpError(402, "No credit balance available", "INSUFFICIENT_CREDIT");
    const ledgerBalance = await adjustCredit(tx, { userId, amount: -amount, description: `Applied to invoice`, refType: "invoice", refId: invoiceId });
    await tx.transaction.create({
      data: { userId, invoiceId, gateway: "credit", gatewayTxnId: `credit-${invoiceId}-${Date.now()}-${ledgerBalance}`, type: "CREDIT_APPLIED", amount, currency: inv.currency, description: "Credit balance applied" },
    });
    const paidNow = Number(inv.amountPaid) + amount;
    const fully = paidNow >= Number(inv.total);
    await tx.invoice.update({ where: { id: invoiceId }, data: { amountPaid: paidNow, creditApplied: { increment: amount }, ...(fully ? { status: "PAID", paidAt: new Date() } : {}) } });
    if (fully) {
      await assignTaxNumber(tx, invoiceId);
      becamePaid = true;
    }
    return amount;
  });
  if (becamePaid) {
    const { onInvoicePaid } = await import("./hooks");
    await onInvoicePaid(invoiceId);
  }
  return { applied, paid: becamePaid };
}

export async function cancelInvoice(invoiceId: string, reason = "Cancelled") {
  const inv = await prisma.invoice.findUniqueOrThrow({ where: { id: invoiceId }, include: { order: true } });
  if (inv.status !== "UNPAID" && inv.status !== "DRAFT") throw conflict("Only unpaid invoices can be cancelled");
  if (inv.amountPaid > 0) throw conflict("Invoice has partial payments — refund or credit them first");
  await prisma.invoice.update({ where: { id: invoiceId }, data: { status: "CANCELLED", notes: [inv.notes, reason].filter(Boolean).join("\n") } });
  if (inv.order) {
    const { releaseOrderReservations } = await import("../ipam/service");
    await releaseOrderReservations(inv.order.id);
    await prisma.service.updateMany({ where: { orderId: inv.order.id, status: { in: ["PENDING", "FAILED"] } }, data: { status: "CANCELLED" } });
    await prisma.domain.updateMany({ where: { orderId: inv.order.id, status: { in: ["PENDING", "PENDING_TRANSFER"] } }, data: { status: "CANCELLED" } });
    const { syncOrderStatus } = await import("../orders/status");
    await syncOrderStatus(inv.order.id);
  }
}

/** Issue a credit note and optionally refund to the customer's credit balance. */
export async function issueCreditNote(args: { invoiceId: string; amount: number; reason: string; toCredit: boolean; actorId: string }) {
  return prisma.$transaction((tx) => issueCreditNoteTx(tx, args));
}

/** Same as issueCreditNote, inside a caller's transaction (refunds write the refund and its credit note together). */
export async function issueCreditNoteTx(tx: Prisma.TransactionClient, args: { invoiceId: string; amount: number; reason: string; toCredit: boolean; actorId: string }) {
  {
    const inv = await tx.invoice.findUniqueOrThrow({ where: { id: args.invoiceId }, include: { creditNotes: true } });
    if (inv.status !== "PAID") throw conflict("Credit notes can only be issued against paid invoices");
    const already = inv.creditNotes.reduce((s, c) => s + c.amount, 0);
    if (args.amount <= 0 || args.amount + already > inv.total) throw badRequest("Amount exceeds the invoice total");
    const s = await getSettings(tx);
    const fy = financialYear();
    const n = await nextSequence(`creditnote:${fy}`, tx);
    const taxShare = inv.total > 0 ? Math.round((inv.taxTotal * args.amount) / inv.total) : 0;
    const cn = await tx.creditNote.create({
      data: { number: s.invoice.creditNotePrefix.replace("{FY}", fy) + String(n).padStart(5, "0"), invoiceId: inv.id, userId: inv.userId, amount: args.amount, taxAmount: taxShare, reason: args.reason },
    });
    if (args.toCredit) await adjustCredit(tx, { userId: inv.userId, amount: args.amount, description: `Credit note ${cn.number}`, refType: "creditNote", refId: cn.id });
    if (args.amount + already >= inv.total) await tx.invoice.update({ where: { id: inv.id }, data: { status: "REFUNDED" } });
    return cn;
  }
}

export function invoiceEmailVars(inv: { id: string; number: string | null; proformaNumber: string; total: number; currency: string; dueDate: Date }, name: string) {
  return {
    name,
    invoiceId: inv.id,
    invoiceNumber: invoiceLabel(inv),
    total: formatMoney(inv.total, inv.currency),
    dueDate: inv.dueDate.toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata", day: "2-digit", month: "short", year: "numeric" }),
  };
}
