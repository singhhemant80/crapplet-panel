/**
 * Billable items (charges that aren't products) and quotes.
 *
 * Billable item actions:
 *   NOW           — invoiced straight away (its own invoice)
 *   NEXT_INVOICE  — added to the customer's next renewal invoice (or the daily run invoices it after 30 days)
 *   ON_DATE       — invoiced on dueDate
 *   RECURRING     — invoiced on dueDate, then every recurEveryMonths months, recurTimes times (or until stopped)
 *
 * Quotes: DRAFT → SENT → ACCEPTED (creates an invoice → INVOICED) | DECLINED | EXPIRED (past validUntil).
 */
import { prisma, type Tx } from "../../db";
import { badRequest, conflict, notFound } from "../../lib/http";
import { getSettings } from "../../lib/settings";
import { nextSequence } from "../../lib/sequence";
import { addMonths, formatMoney } from "../../lib/money";
import { config } from "../../config";
import { queueEmail } from "../email/mailer";
import { computeGst } from "./gst";
import { createInvoice, invoiceEmailVars, type NewInvoiceItem } from "./invoices";

type Item = { id: string; userId: string; description: string; amount: number; quantity: number; taxable: boolean; currency: string; invoiceAction: string; dueDate: Date | null; recurEveryMonths: number | null; recurTimes: number | null; recurDone: number };

const lineOf = (b: Item, when?: Date): NewInvoiceItem => ({
  type: b.amount < 0 ? "PROMO" : "CUSTOM",
  description: b.invoiceAction === "RECURRING" && when ? `${b.description} (${when.toLocaleDateString("en-IN", { month: "short", year: "numeric" })})` : b.description,
  quantity: b.quantity,
  unitPrice: b.amount,
  taxable: b.taxable,
});

/** After an item is put on an invoice: one-offs are done; recurring ones move to their next date (or finish). */
async function markBilled(tx: Tx, b: Item, invoiceId: string) {
  if (b.invoiceAction === "RECURRING") {
    const done = b.recurDone + 1;
    const finished = b.recurTimes != null && done >= b.recurTimes;
    await tx.billableItem.update({ where: { id: b.id }, data: { recurDone: done, invoiceId, lastInvoicedAt: new Date(), invoiced: finished, dueDate: finished ? b.dueDate : addMonths(b.dueDate ?? new Date(), b.recurEveryMonths ?? 1) } });
  } else {
    await tx.billableItem.update({ where: { id: b.id }, data: { invoiced: true, invoiceId, lastInvoicedAt: new Date() } });
  }
}

/** Invoice some of a customer's billable items now, on one invoice. */
export async function invoiceBillableItems(itemIds: string[], opts: { sendEmail?: boolean; dueDate?: Date } = {}) {
  const items = (await prisma.billableItem.findMany({ where: { id: { in: itemIds }, invoiced: false } })) as Item[];
  if (!items.length) throw badRequest("Nothing to invoice — these items were already billed");
  if (new Set(items.map((i) => i.userId)).size > 1) throw badRequest("Pick one customer's items");
  if (new Set(items.map((i) => i.currency)).size > 1) throw badRequest("The items are in different currencies");
  const inv = await prisma.$transaction(async (tx) => {
    const inv = await createInvoice(tx, { userId: items[0].userId, currency: items[0].currency, dueDate: opts.dueDate, items: items.map((b) => lineOf(b, b.dueDate ?? new Date())) });
    for (const b of items) await markBilled(tx, b, inv.id);
    return inv;
  });
  if (opts.sendEmail !== false) {
    const u = await prisma.user.findUniqueOrThrow({ where: { id: inv.userId } });
    await queueEmail("invoice.created", u.email, invoiceEmailVars(inv, u.firstName), u.id);
  }
  return inv;
}

/** Called by the renewal run: a customer's waiting NEXT_INVOICE items go on their renewal invoice. */
export async function pendingForNextInvoice(tx: Tx, userId: string, currency: string) {
  const items = (await tx.billableItem.findMany({ where: { userId, currency, invoiced: false, invoiceAction: "NEXT_INVOICE" }, orderBy: { createdAt: "asc" } })) as Item[];
  return { lines: items.map((b) => lineOf(b)), done: (invoiceId: string) => Promise.all(items.map((b) => markBilled(tx, b, invoiceId))) };
}

/** Daily: dated and recurring items that are due, plus NEXT_INVOICE items waiting more than 30 days. */
export async function runBillableItems(now = new Date()) {
  const stale = new Date(now.getTime() - 30 * 86400_000);
  const due = (await prisma.billableItem.findMany({
    where: {
      invoiced: false,
      OR: [
        { invoiceAction: { in: ["ON_DATE", "RECURRING"] }, dueDate: { lte: now } },
        { invoiceAction: "NEXT_INVOICE", createdAt: { lte: stale } },
      ],
    },
    orderBy: { createdAt: "asc" },
  })) as Item[];
  // one invoice per customer and currency
  const groups = new Map<string, Item[]>();
  for (const b of due) groups.set(`${b.userId}|${b.currency}`, [...(groups.get(`${b.userId}|${b.currency}`) ?? []), b]);
  let invoices = 0;
  for (const list of groups.values()) {
    try {
      await invoiceBillableItems(list.map((b) => b.id));
      invoices++;
    } catch (e) {
      console.error("[billable] couldn't invoice", list.map((b) => b.id), (e as Error).message);
    }
  }
  return { items: due.length, invoices };
}

// ───────────────────────── quotes ─────────────────────────

export type QuoteLine = { description: string; quantity: number; unitPrice: number; taxable: boolean };

/** Estimated totals with GST, using the customer's current details (the invoice recomputes on acceptance). */
export async function quoteTotals(userId: string, items: QuoteLine[]) {
  const s = await getSettings();
  const p = await prisma.clientProfile.findUnique({ where: { userId } });
  const tax = computeGst(items.map((i) => ({ amount: i.unitPrice * i.quantity, taxable: i.taxable })), {
    enabled: s.tax.enabled,
    rate: s.tax.gstRate,
    inclusive: s.tax.pricesIncludeTax,
    companyStateCode: s.company.stateCode,
    applyToForeign: s.tax.applyToForeign,
    customer: { country: p?.country ?? "IN", stateCode: p?.stateCode, gstin: p?.gstin },
  });
  const discount = -items.filter((i) => i.unitPrice < 0).reduce((a, i) => a + i.unitPrice * i.quantity, 0);
  return { subtotal: tax.subtotal + discount, taxTotal: tax.taxTotal, total: tax.total, cgst: tax.cgst, sgst: tax.sgst, igst: tax.igst, discount };
}

export async function nextQuoteNumber() {
  return `Q-${String(await nextSequence("quote")).padStart(6, "0")}`;
}

const quoteUrl = (id: string) => `${config.appUrl}/client/quotes/${id}`;

export async function sendQuote(id: string) {
  const q = await prisma.quote.findUnique({ where: { id }, include: { user: true } });
  if (!q) throw notFound("Quote not found");
  if (["ACCEPTED", "INVOICED"].includes(q.status)) throw conflict("This quote was already accepted");
  await queueEmail(
    "staff.message",
    q.user.email,
    {
      name: q.user.firstName,
      subject: `Quote ${q.number}: ${q.subject}`,
      messageHtml: `<p>We've prepared a quote for you: <b>${escapeHtml(q.subject)}</b> — ${formatMoney(q.total, q.currency)} (incl. GST), valid until ${q.validUntil.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" })}.</p><p><a href="${quoteUrl(q.id)}">View and accept the quote</a></p>${q.customerNotes ? `<p>${escapeHtml(q.customerNotes).replace(/\n/g, "<br>")}</p>` : ""}`,
    },
    q.userId,
  );
  return prisma.quote.update({ where: { id }, data: { status: q.status === "DRAFT" || q.status === "EXPIRED" ? "SENT" : q.status, sentAt: new Date() } });
}

/** The customer (or staff on their behalf) accepts: an invoice is created from the quote. */
export async function acceptQuote(id: string, userId?: string) {
  const q = await prisma.quote.findUnique({ where: { id } });
  if (!q || (userId && q.userId !== userId)) throw notFound("Quote not found");
  if (q.status === "INVOICED" && q.invoiceId) return { invoiceId: q.invoiceId, already: true };
  if (q.status === "DECLINED") throw conflict("This quote was declined");
  if (userId && q.status === "DRAFT") throw notFound("Quote not found");
  if (q.validUntil < new Date() && userId) throw conflict("This quote has expired — please ask us for a new one");
  const lines = q.items as QuoteLine[];
  const inv = await prisma.$transaction(async (tx) => {
    const fresh = await tx.quote.findUniqueOrThrow({ where: { id } });
    if (fresh.status === "INVOICED" && fresh.invoiceId) return { id: fresh.invoiceId, existing: true };
    const inv = await createInvoice(tx, { userId: q.userId, currency: q.currency, notes: `Quote ${q.number}: ${q.subject}`, items: lines.map((l) => ({ type: l.unitPrice < 0 ? ("PROMO" as const) : ("CUSTOM" as const), description: l.description, quantity: l.quantity, unitPrice: l.unitPrice, taxable: l.taxable })) });
    await tx.quote.update({ where: { id }, data: { status: "INVOICED", acceptedAt: new Date(), invoiceId: inv.id } });
    return { id: inv.id, existing: false, inv };
  });
  if (!inv.existing && "inv" in inv && inv.inv) {
    const u = await prisma.user.findUniqueOrThrow({ where: { id: q.userId } });
    await queueEmail("invoice.created", u.email, invoiceEmailVars(inv.inv, u.firstName), u.id);
  }
  return { invoiceId: inv.id, already: inv.existing };
}

/** Daily: sent quotes past their date become EXPIRED. */
export async function expireQuotes(now = new Date()) {
  const r = await prisma.quote.updateMany({ where: { status: "SENT", validUntil: { lt: now } }, data: { status: "EXPIRED" } });
  return r.count;
}

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
