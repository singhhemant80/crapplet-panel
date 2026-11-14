/**
 * Invoice management (WHMCS-style): edit lines / dates / notes / GSTIN, draft ↔ issued, apply credit,
 * duplicate, split, merge, delete, bulk actions and emails. GST and totals are always recomputed from
 * the lines (recomputeInvoiceTx). Paid tax invoices are never re-priced — use a credit note or refund.
 */
import { Router } from "express";
import { z } from "zod";
import { prisma, type Tx } from "../../db";
import { ah, badRequest, conflict, notFound, parse } from "../../lib/http";
import { audit } from "../../lib/audit";
import { requireStaff } from "../../middleware/auth";
import { queueEmail } from "../email/mailer";
import { applyCreditToInvoice, applyPayment, assignTaxNumber, cancelInvoice, createInvoice, invoiceEmailVars, invoiceLabel, recomputeInvoiceTx } from "../billing/invoices";

export const adminInvoices = Router();

const lineSchema = z.object({
  id: z.string().optional(),
  description: z.string().trim().min(1).max(500),
  quantity: z.number().int().min(1).max(100_000).default(1),
  /** per unit, paise; negative = discount line */
  unitPrice: z.number().int().min(-1_000_000_000).max(1_000_000_000),
  taxable: z.boolean().default(true),
  hsnSac: z.string().trim().max(20).nullish(),
});
const editSchema = z.object({
  items: z.array(lineSchema).min(1).max(200).optional(),
  issueDate: z.coerce.date().optional(),
  dueDate: z.coerce.date().optional(),
  notes: z.string().max(4000).nullish(),
  customerGstin: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^\d{2}[A-Z]{5}\d{4}[A-Z][A-Z\d]Z[A-Z\d]$/, "Not a valid GSTIN")
    .nullish()
    .or(z.literal("").transform(() => null)),
});

const lock = (tx: Tx, id: string) => tx.$queryRaw<{ id: string }[]>`SELECT "id" FROM "Invoice" WHERE "id" = ${id} FOR UPDATE`;
const EDITABLE = ["UNPAID", "DRAFT"];

/** After lines change: if what's been paid now covers the total, the invoice becomes paid. */
async function settleIfCovered(tx: Tx, invoiceId: string) {
  const inv = await tx.invoice.findUniqueOrThrow({ where: { id: invoiceId } });
  if (inv.status === "UNPAID" && inv.amountPaid >= inv.total) {
    await tx.invoice.update({ where: { id: invoiceId }, data: { status: "PAID", paidAt: new Date(), amountPaid: inv.total } });
    await assignTaxNumber(tx, invoiceId);
    return true;
  }
  return false;
}

// ───── edit ─────
adminInvoices.put(
  "/invoices/:id",
  requireStaff("billing.manage"),
  ah(async (req, res) => {
    const b = parse(editSchema, req.body);
    const before = await prisma.invoice.findUnique({ where: { id: req.params.id }, include: { items: true } });
    if (!before) throw notFound("Invoice not found");
    const linesEditable = EDITABLE.includes(before.status);
    if (!linesEditable && (b.items || b.issueDate || b.dueDate || b.customerGstin !== undefined))
      throw conflict(before.status === "PAID" ? "A paid tax invoice can't be re-priced or re-dated — issue a credit note or refund instead (notes can still be edited)" : "Only notes can be changed on a cancelled or refunded invoice");
    if (b.dueDate && b.issueDate && b.dueDate < b.issueDate) throw badRequest("The due date can't be before the invoice date");

    let paidNow = false;
    await prisma.$transaction(async (tx) => {
      await lock(tx, before.id);
      if (b.items) {
        const keep = new Map(before.items.map((i) => [i.id, i]));
        const seen = new Set<string>();
        for (const l of b.items) {
          const amount = l.unitPrice * l.quantity;
          const old = l.id ? keep.get(l.id) : undefined;
          if (l.id && !old) throw badRequest("A line doesn't belong to this invoice — reload and try again");
          if (old) {
            seen.add(old.id);
            await tx.invoiceItem.update({ where: { id: old.id }, data: { description: l.description, quantity: l.quantity, unitPrice: l.unitPrice, amount, taxable: l.taxable, ...(l.hsnSac !== undefined ? { hsnSac: l.hsnSac } : {}) } });
          } else {
            await tx.invoiceItem.create({ data: { invoiceId: before.id, type: l.unitPrice < 0 ? "PROMO" : "CUSTOM", description: l.description, quantity: l.quantity, unitPrice: l.unitPrice, amount, taxable: l.taxable, hsnSac: l.hsnSac ?? null } });
          }
        }
        const removed = before.items.filter((i) => !seen.has(i.id)).map((i) => i.id);
        if (removed.length) await tx.invoiceItem.deleteMany({ where: { id: { in: removed } } });
      }
      await tx.invoice.update({
        where: { id: before.id },
        data: {
          ...(b.issueDate ? { issueDate: b.issueDate } : {}),
          ...(b.dueDate ? { dueDate: b.dueDate } : {}),
          ...(b.notes !== undefined ? { notes: b.notes || null } : {}),
          ...(b.customerGstin !== undefined ? { customerGstin: b.customerGstin, billingSnapshot: { ...((before.billingSnapshot ?? {}) as object), gstin: b.customerGstin } } : {}),
        },
      });
      if (b.items || b.customerGstin !== undefined) {
        const inv = await recomputeInvoiceTx(tx, before.id);
        if (inv.total < 0) throw badRequest("The invoice total can't be negative");
        if (inv.amountPaid > inv.total) throw conflict(`${(inv.amountPaid / 100).toFixed(2)} has already been paid — the new total can't be lower than that. Refund or credit the difference instead.`);
        paidNow = await settleIfCovered(tx, before.id);
      }
    });
    if (paidNow) {
      const { onInvoicePaid } = await import("../billing/hooks");
      await onInvoicePaid(before.id);
    }
    const after = await prisma.invoice.findUniqueOrThrow({ where: { id: before.id }, include: { items: true } });
    await audit({
      actorId: req.user!.id,
      userId: after.userId,
      action: "invoice.edited",
      entity: "invoice",
      entityId: after.id,
      details: {
        total: { from: before.total, to: after.total },
        ...(b.items ? { lines: { from: before.items.map((i) => `${i.description} × ${i.quantity} @ ${i.unitPrice}`), to: after.items.map((i) => `${i.description} × ${i.quantity} @ ${i.unitPrice}`) } } : {}),
        ...(b.dueDate ? { dueDate: { from: before.dueDate, to: after.dueDate } } : {}),
        ...(b.issueDate ? { issueDate: { from: before.issueDate, to: after.issueDate } } : {}),
        ...(b.notes !== undefined ? { notes: true } : {}),
        ...(b.customerGstin !== undefined ? { customerGstin: { from: before.customerGstin, to: after.customerGstin } } : {}),
      },
    });
    res.json({ invoice: after, paid: paidNow });
  }),
);

// ───── status: draft ↔ unpaid, reopen a cancelled one ─────
adminInvoices.post(
  "/invoices/:id/status",
  requireStaff("billing.manage"),
  ah(async (req, res) => {
    const b = parse(z.object({ status: z.enum(["DRAFT", "UNPAID", "CANCELLED"]), sendEmail: z.boolean().default(false) }), req.body);
    const inv = await prisma.invoice.findUnique({ where: { id: req.params.id }, include: { user: true, transactions: { select: { id: true } } } });
    if (!inv) throw notFound("Invoice not found");
    if (inv.status === b.status) return res.json({ ok: true });
    if (b.status === "CANCELLED") {
      if (!EDITABLE.includes(inv.status)) throw conflict("Only unpaid or draft invoices can be cancelled — refund a paid one");
      await cancelInvoice(inv.id, "Cancelled by staff");
    } else if (b.status === "DRAFT") {
      if (inv.status !== "UNPAID" || inv.amountPaid > 0 || inv.creditApplied > 0) throw conflict("Only an unpaid invoice with nothing paid on it can go back to draft");
      await prisma.invoice.update({ where: { id: inv.id }, data: { status: "DRAFT" } });
    } else {
      // → UNPAID: issue a draft, or reopen a cancelled invoice that was never paid
      if (inv.status === "DRAFT" || (inv.status === "CANCELLED" && !inv.number && !inv.transactions.length)) {
        await prisma.invoice.update({ where: { id: inv.id }, data: { status: "UNPAID" } });
        if (b.sendEmail) await queueEmail("invoice.created", inv.user.email, invoiceEmailVars(inv, inv.user.firstName), inv.userId);
      } else throw conflict("This invoice can't be reopened");
    }
    await audit({ actorId: req.user!.id, userId: inv.userId, action: "invoice.status_changed", entity: "invoice", entityId: inv.id, details: { from: inv.status, to: b.status } });
    res.json({ ok: true });
  }),
);

// ───── apply the customer's account credit ─────
adminInvoices.post(
  "/invoices/:id/apply-credit",
  requireStaff("billing.manage"),
  ah(async (req, res) => {
    const b = parse(z.object({ amount: z.number().int().positive().optional() }), req.body ?? {});
    const inv = await prisma.invoice.findUnique({ where: { id: req.params.id } });
    if (!inv) throw notFound("Invoice not found");
    if (inv.status !== "UNPAID") throw conflict("Credit can only be applied to an unpaid invoice");
    const r = await applyCreditToInvoice(inv.userId, inv.id, b.amount);
    await audit({ actorId: req.user!.id, userId: inv.userId, action: "invoice.credit_applied", entity: "invoice", entityId: inv.id, details: r as object });
    res.json(r);
  }),
);

// ───── duplicate (as a draft to edit) ─────
adminInvoices.post(
  "/invoices/:id/duplicate",
  requireStaff("billing.manage"),
  ah(async (req, res) => {
    const src = await prisma.invoice.findUnique({ where: { id: req.params.id }, include: { items: true } });
    if (!src) throw notFound("Invoice not found");
    if (src.isWalletTopup) throw badRequest("Wallet top-ups can't be duplicated");
    const copy = await prisma.$transaction(async (tx) => {
      // copied lines are plain charges — paying the copy mustn't renew services again
      const inv = await createInvoice(tx, { userId: src.userId, currency: src.currency, notes: src.notes ?? undefined, items: src.items.map((i) => ({ type: i.unitPrice < 0 ? ("PROMO" as const) : ("CUSTOM" as const), description: i.description, quantity: i.quantity, unitPrice: i.unitPrice, taxable: i.taxable, hsnSac: i.hsnSac })) });
      if (inv.status === "UNPAID") await tx.invoice.update({ where: { id: inv.id }, data: { status: "DRAFT" } });
      return inv;
    });
    await audit({ actorId: req.user!.id, userId: src.userId, action: "invoice.duplicated", entity: "invoice", entityId: copy.id, details: { from: invoiceLabel(src) } });
    res.status(201).json({ id: copy.id });
  }),
);

/** Nothing paid, no tax number, not a top-up — lines can move. */
function assertMovable(inv: { status: string; amountPaid: number; creditApplied: number; number: string | null; isWalletTopup: boolean }, what: string) {
  if (!EDITABLE.includes(inv.status) || inv.amountPaid > 0 || inv.creditApplied > 0 || inv.number || inv.isWalletTopup) throw conflict(`Only unpaid invoices with nothing paid on them can be ${what}`);
}

// ───── split: move some lines to a new invoice ─────
adminInvoices.post(
  "/invoices/:id/split",
  requireStaff("billing.manage"),
  ah(async (req, res) => {
    const b = parse(z.object({ itemIds: z.array(z.string()).min(1) }), req.body);
    const src = await prisma.invoice.findUnique({ where: { id: req.params.id }, include: { items: true } });
    if (!src) throw notFound("Invoice not found");
    assertMovable(src, "split");
    const moving = src.items.filter((i) => b.itemIds.includes(i.id));
    if (moving.length !== b.itemIds.length) throw badRequest("Some lines aren't on this invoice");
    if (moving.length === src.items.length) throw badRequest("Leave at least one line on the original invoice");
    const created = await prisma.$transaction(async (tx) => {
      await lock(tx, src.id);
      const inv = await createInvoice(tx, {
        userId: src.userId,
        currency: src.currency,
        dueDate: src.dueDate,
        items: moving.map((i) => ({ type: i.type, relId: i.relId, description: i.description, quantity: i.quantity, unitPrice: i.unitPrice, taxable: i.taxable, hsnSac: i.hsnSac, periodStart: i.periodStart, periodEnd: i.periodEnd })),
      });
      await tx.invoiceItem.deleteMany({ where: { id: { in: moving.map((i) => i.id) } } });
      await recomputeInvoiceTx(tx, src.id);
      if (src.status === "DRAFT") await tx.invoice.update({ where: { id: inv.id }, data: { status: "DRAFT" } });
      return inv;
    });
    await audit({ actorId: req.user!.id, userId: src.userId, action: "invoice.split", entity: "invoice", entityId: src.id, details: { newInvoice: invoiceLabel(created), lines: moving.map((i) => i.description) } });
    res.status(201).json({ id: created.id });
  }),
);

// ───── merge several unpaid invoices of one customer ─────
adminInvoices.post(
  "/invoices/merge",
  requireStaff("billing.manage"),
  ah(async (req, res) => {
    const b = parse(z.object({ ids: z.array(z.string()).min(2).max(50) }), req.body);
    const list = await prisma.invoice.findMany({ where: { id: { in: b.ids } }, include: { order: { select: { id: true } } }, orderBy: [{ dueDate: "asc" }, { createdAt: "asc" }] });
    if (list.length !== new Set(b.ids).size) throw notFound("Some invoices weren't found");
    if (new Set(list.map((i) => i.userId)).size > 1) throw badRequest("Only one customer's invoices can be merged");
    if (new Set(list.map((i) => i.currency)).size > 1) throw badRequest("The invoices are in different currencies");
    for (const i of list) assertMovable(i, "merged");
    if (list.filter((i) => i.order).length > 1) throw conflict("More than one of these invoices belongs to an order — they can't be merged");
    const [target, ...rest] = list;
    await prisma.$transaction(async (tx) => {
      for (const i of list) await lock(tx, i.id);
      const restIds = rest.map((i) => i.id);
      await tx.invoiceItem.updateMany({ where: { invoiceId: { in: restIds } }, data: { invoiceId: target.id } });
      await tx.paymentIntent.updateMany({ where: { invoiceId: { in: restIds } }, data: { invoiceId: target.id } });
      const withOrder = rest.find((i) => i.order);
      if (withOrder && !target.order) await tx.order.update({ where: { id: withOrder.order!.id }, data: { invoiceId: target.id } });
      await tx.invoice.deleteMany({ where: { id: { in: restIds } } });
      await recomputeInvoiceTx(tx, target.id);
    });
    await audit({ actorId: req.user!.id, userId: target.userId, action: "invoice.merged", entity: "invoice", entityId: target.id, details: { merged: rest.map(invoiceLabel) } });
    res.json({ id: target.id });
  }),
);

// ───── delete ─────
async function deleteInvoice(id: string) {
  const inv = await prisma.invoice.findUnique({ where: { id }, include: { transactions: { select: { id: true } }, creditNotes: { select: { id: true } }, order: { select: { id: true, number: true } }, paymentIntents: { select: { status: true, createdAt: true } } } });
  if (!inv) throw notFound("Invoice not found");
  if (inv.number || inv.transactions.length || inv.creditNotes.length || inv.amountPaid > 0 || inv.creditApplied > 0) throw conflict("This invoice has payments or a tax number — it can't be deleted (cancel or refund it instead)");
  if (inv.order) throw conflict(`This invoice belongs to order ${inv.order.number} — cancel it instead`);
  if (inv.paymentIntents.some((p) => (p.status === "CREATED" || p.status === "PENDING_REVIEW") && p.createdAt.getTime() > Date.now() - 2 * 3600_000)) throw conflict("The customer started paying this invoice in the last 2 hours — cancel it instead");
  await prisma.$transaction(async (tx) => {
    await tx.paymentIntent.deleteMany({ where: { invoiceId: id } });
    await tx.billableItem.updateMany({ where: { invoiceId: id }, data: { invoiceId: null, invoiced: false } });
    await tx.invoice.delete({ where: { id } });
  });
  return inv;
}
adminInvoices.delete(
  "/invoices/:id",
  requireStaff("billing.manage"),
  ah(async (req, res) => {
    const inv = await deleteInvoice(req.params.id);
    await audit({ actorId: req.user!.id, userId: inv.userId, action: "invoice.deleted", entity: "invoice", entityId: inv.id, details: { invoice: invoiceLabel(inv), total: inv.total } });
    res.json({ ok: true });
  }),
);

// ───── email ─────
const TEMPLATES = { created: "invoice.created", reminder: "invoice.reminder", overdue: "invoice.overdue", paid: "invoice.paid" } as const;
async function emailInvoice(id: string, kind: keyof typeof TEMPLATES) {
  const inv = await prisma.invoice.findUnique({ where: { id }, include: { user: true } });
  if (!inv) throw notFound("Invoice not found");
  if (inv.status === "DRAFT") throw conflict("Issue the draft before emailing it");
  if (kind === "paid" ? inv.status !== "PAID" : inv.status !== "UNPAID") throw conflict(kind === "paid" ? "The invoice isn't paid" : "The invoice isn't unpaid");
  await queueEmail(TEMPLATES[kind], inv.user.email, invoiceEmailVars(inv, inv.user.firstName), inv.userId);
  if (kind === "reminder" || kind === "overdue") await prisma.invoice.update({ where: { id }, data: { remindersSent: { increment: 1 }, lastReminderAt: new Date() } });
  return inv;
}
adminInvoices.post(
  "/invoices/:id/email",
  requireStaff("billing.manage"),
  ah(async (req, res) => {
    const b = parse(z.object({ template: z.enum(["created", "reminder", "overdue", "paid"]) }), req.body);
    const inv = await emailInvoice(req.params.id, b.template);
    await audit({ actorId: req.user!.id, userId: inv.userId, action: "invoice.emailed", entity: "invoice", entityId: inv.id, details: { template: b.template } });
    res.json({ ok: true });
  }),
);

// ───── bulk ─────
adminInvoices.post(
  "/invoices/bulk",
  requireStaff("billing.manage"),
  ah(async (req, res) => {
    const b = parse(z.object({ ids: z.array(z.string()).min(1).max(200), action: z.enum(["mark_paid", "cancel", "remind", "send", "apply_credit", "delete", "issue"]), reference: z.string().trim().max(80).optional() }), req.body);
    const results: { id: string; ok: boolean; error?: string }[] = [];
    for (const id of b.ids) {
      try {
        const inv = await prisma.invoice.findUnique({ where: { id } });
        if (!inv) throw notFound("Not found");
        if ((b.action === "remind" || b.action === "send") && inv.status === "DRAFT") throw conflict("Draft — issue it first");
        if (b.action === "remind" && inv.status !== "UNPAID") throw conflict("Not unpaid");
        if (b.action === "mark_paid") {
          if (inv.status !== "UNPAID") throw conflict("Not unpaid");
          const due = inv.total - inv.amountPaid;
          const ref = `${b.reference || "bulk"}-${invoiceLabel(inv)}`.slice(0, 100);
          const r = await applyPayment({ invoiceId: id, amount: due, gateway: "manual", gatewayTxnId: ref, description: "Marked paid by staff" });
          if (r.duplicate) throw conflict("Already recorded");
        } else if (b.action === "cancel") {
          if (!EDITABLE.includes(inv.status)) throw conflict("Not unpaid");
          await cancelInvoice(id, "Cancelled by staff");
        } else if (b.action === "remind") await emailInvoice(id, inv.dueDate < new Date() ? "overdue" : "reminder");
        else if (b.action === "send") await emailInvoice(id, inv.status === "PAID" ? "paid" : "created");
        else if (b.action === "apply_credit") {
          if (inv.status !== "UNPAID") throw conflict("Not unpaid");
          await applyCreditToInvoice(inv.userId, id);
        } else if (b.action === "issue") {
          if (inv.status !== "DRAFT") throw conflict("Not a draft");
          await prisma.invoice.update({ where: { id }, data: { status: "UNPAID" } });
        } else if (b.action === "delete") await deleteInvoice(id);
        results.push({ id, ok: true });
      } catch (e) {
        results.push({ id, ok: false, error: (e as Error).message });
      }
    }
    await audit({ actorId: req.user!.id, action: `invoice.bulk_${b.action}`, entity: "invoice", entityId: "*", details: { ids: b.ids, ok: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok) } });
    res.json({ ok: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok), results });
  }),
);

// ───────────── Number series (next invoice / credit note / quote number) ─────────────
adminInvoices.get(
  "/numbering",
  requireStaff("billing.view"),
  ah(async (_req, res) => {
    const { numberingStatus } = await import("../billing/numbering");
    res.json(await numberingStatus());
  }),
);

adminInvoices.put(
  "/numbering",
  requireStaff("settings.manage"),
  ah(async (req, res) => {
    const { SERIES, setNextNumber } = await import("../billing/numbering");
    const b = parse(z.object({ key: z.enum(SERIES), next: z.number().int().min(1).max(99_999_999) }), req.body);
    const r = await setNextNumber(b.key, b.next);
    await audit({ actorId: req.user!.id, action: "settings.numbering", entity: "settings", entityId: b.key, details: { next: r.preview } });
    res.json(r);
  }),
);
