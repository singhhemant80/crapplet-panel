/** Admin: billable items and quotes. */
import { Router } from "express";
import { z } from "zod";
import { prisma, type Prisma } from "../../db";
import { ah, badRequest, conflict, notFound, pageParams, parse } from "../../lib/http";
import { audit } from "../../lib/audit";
import { requireStaff } from "../../middleware/auth";
import { requireCurrency } from "../../lib/currency";
import { acceptQuote, invoiceBillableItems, nextQuoteNumber, quoteTotals, sendQuote, type QuoteLine } from "../billing/extras";

export const adminBillingExtras = Router();

const userBrief = { select: { id: true, email: true, firstName: true, lastName: true } } as const;

// ───────────── billable items ─────────────
const billableSchema = z
  .object({
    userId: z.string(),
    description: z.string().trim().min(1).max(300),
    amount: z.number().int().min(-100_000_000).max(1_000_000_000),
    quantity: z.number().int().min(1).max(100_000).default(1),
    currency: z.string().length(3).toUpperCase().default("INR"),
    taxable: z.boolean().default(true),
    invoiceAction: z.enum(["NOW", "NEXT_INVOICE", "ON_DATE", "RECURRING"]).default("NEXT_INVOICE"),
    dueDate: z.coerce.date().nullish(),
    recurEveryMonths: z.number().int().min(1).max(60).nullish(),
    recurTimes: z.number().int().min(1).max(600).nullish(),
    serviceId: z.string().nullish(),
    notes: z.string().max(2000).nullish(),
  })
  .superRefine((v, ctx) => {
    if ((v.invoiceAction === "ON_DATE" || v.invoiceAction === "RECURRING") && !v.dueDate) ctx.addIssue({ code: "custom", path: ["dueDate"], message: "Pick the date to invoice on" });
    if (v.invoiceAction === "RECURRING" && !v.recurEveryMonths) ctx.addIssue({ code: "custom", path: ["recurEveryMonths"], message: "How often should it repeat?" });
  });

adminBillingExtras.get(
  "/billable-items",
  requireStaff("billing.view"),
  ah(async (req, res) => {
    const { skip, take, page, pageSize } = pageParams(req.query);
    const st = String(req.query.status ?? "open");
    const where: Prisma.BillableItemWhereInput = {
      ...(req.query.userId ? { userId: String(req.query.userId) } : {}),
      ...(st === "open" ? { invoiced: false } : st === "billed" ? { invoiced: true } : {}),
      ...(req.query.q ? { OR: [{ description: { contains: String(req.query.q), mode: "insensitive" } }, { user: { email: { contains: String(req.query.q), mode: "insensitive" } } }] } : {}),
    };
    const [rows, total, open] = await Promise.all([
      prisma.billableItem.findMany({ where, orderBy: { createdAt: "desc" }, skip, take, include: { user: userBrief } }),
      prisma.billableItem.count({ where }),
      prisma.billableItem.groupBy({ by: ["currency"], where: { invoiced: false, invoiceAction: { not: "RECURRING" } }, _sum: { amount: true }, _count: true }),
    ]);
    const invIds = [...new Set(rows.map((r) => r.invoiceId).filter(Boolean))] as string[];
    const invs = invIds.length ? await prisma.invoice.findMany({ where: { id: { in: invIds } }, select: { id: true, number: true, proformaNumber: true, status: true } }) : [];
    res.json({ items: rows.map((r) => ({ ...r, invoice: invs.find((i) => i.id === r.invoiceId) ?? null })), total, page, pageSize, open });
  }),
);

adminBillingExtras.post(
  "/billable-items",
  requireStaff("billing.manage"),
  ah(async (req, res) => {
    const b = parse(billableSchema, req.body);
    const u = await prisma.user.findUnique({ where: { id: b.userId }, select: { type: true } });
    if (!u || u.type !== "CLIENT") throw notFound("Customer not found");
    await requireCurrency(b.currency);
    if (b.serviceId && !(await prisma.service.count({ where: { id: b.serviceId, userId: b.userId } }))) throw badRequest("That service isn't this customer's");
    const item = await prisma.billableItem.create({ data: { ...b, dueDate: b.dueDate ?? null, createdById: req.user!.id } });
    let invoiceId: string | null = null;
    if (b.invoiceAction === "NOW") invoiceId = (await invoiceBillableItems([item.id])).id;
    await audit({ actorId: req.user!.id, userId: b.userId, action: "billable.created", entity: "billableItem", entityId: item.id, details: { description: b.description, amount: b.amount, quantity: b.quantity, action: b.invoiceAction } });
    res.status(201).json({ item, invoiceId });
  }),
);

adminBillingExtras.put(
  "/billable-items/:id",
  requireStaff("billing.manage"),
  ah(async (req, res) => {
    const cur = await prisma.billableItem.findUnique({ where: { id: req.params.id } });
    if (!cur) throw notFound();
    if (cur.invoiced) throw conflict("This item was already invoiced — edit the invoice instead");
    const b = parse(billableSchema, { ...cur, ...req.body, userId: cur.userId });
    const item = await prisma.billableItem.update({ where: { id: cur.id }, data: { description: b.description, amount: b.amount, quantity: b.quantity, taxable: b.taxable, invoiceAction: b.invoiceAction === "NOW" ? "NEXT_INVOICE" : b.invoiceAction, dueDate: b.dueDate ?? null, recurEveryMonths: b.recurEveryMonths ?? null, recurTimes: b.recurTimes ?? null, notes: b.notes ?? null } });
    let invoiceId: string | null = null;
    if (b.invoiceAction === "NOW") invoiceId = (await invoiceBillableItems([item.id])).id;
    await audit({ actorId: req.user!.id, userId: cur.userId, action: "billable.updated", entity: "billableItem", entityId: cur.id });
    res.json({ item, invoiceId });
  }),
);

/** Stop a recurring item / remove an item that hasn't been invoiced. */
adminBillingExtras.delete(
  "/billable-items/:id",
  requireStaff("billing.manage"),
  ah(async (req, res) => {
    const cur = await prisma.billableItem.findUnique({ where: { id: req.params.id } });
    if (!cur) throw notFound();
    if (cur.recurDone > 0 || cur.invoiceId) await prisma.billableItem.update({ where: { id: cur.id }, data: { invoiced: true } });
    else await prisma.billableItem.delete({ where: { id: cur.id } });
    await audit({ actorId: req.user!.id, userId: cur.userId, action: cur.recurDone > 0 ? "billable.stopped" : "billable.deleted", entity: "billableItem", entityId: cur.id, details: { description: cur.description } });
    res.json({ ok: true });
  }),
);

/** Invoice selected items now (one customer). */
adminBillingExtras.post(
  "/billable-items/invoice",
  requireStaff("billing.manage"),
  ah(async (req, res) => {
    const b = parse(z.object({ ids: z.array(z.string()).min(1).max(100), sendEmail: z.boolean().default(true), dueDate: z.coerce.date().optional() }), req.body);
    const inv = await invoiceBillableItems(b.ids, { sendEmail: b.sendEmail, dueDate: b.dueDate });
    await audit({ actorId: req.user!.id, userId: inv.userId, action: "billable.invoiced", entity: "invoice", entityId: inv.id, details: { items: b.ids.length } });
    res.status(201).json({ invoiceId: inv.id });
  }),
);

// ───────────── quotes ─────────────
const quoteLine = z.object({ description: z.string().trim().min(1).max(500), quantity: z.number().int().min(1).max(100_000).default(1), unitPrice: z.number().int().min(-1_000_000_000).max(1_000_000_000), taxable: z.boolean().default(true) });
const quoteSchema = z.object({
  userId: z.string(),
  subject: z.string().trim().min(2).max(200),
  currency: z.string().length(3).toUpperCase().default("INR"),
  validUntil: z.coerce.date(),
  items: z.array(quoteLine).min(1).max(200),
  customerNotes: z.string().max(4000).nullish(),
  adminNotes: z.string().max(4000).nullish(),
  send: z.boolean().default(false),
});

adminBillingExtras.get(
  "/quotes",
  requireStaff("billing.view"),
  ah(async (req, res) => {
    const { skip, take, page, pageSize } = pageParams(req.query);
    const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
    const where: Prisma.QuoteWhereInput = {
      ...(req.query.status ? { status: String(req.query.status) } : {}),
      ...(req.query.userId ? { userId: String(req.query.userId) } : {}),
      ...(q ? { OR: [{ number: { contains: q, mode: "insensitive" } }, { subject: { contains: q, mode: "insensitive" } }, { user: { email: { contains: q, mode: "insensitive" } } }] } : {}),
    };
    const [rows, total, counts] = await Promise.all([
      prisma.quote.findMany({ where, orderBy: { createdAt: "desc" }, skip, take, include: { user: userBrief } }),
      prisma.quote.count({ where }),
      prisma.quote.groupBy({ by: ["status"], _count: true, _sum: { total: true } }),
    ]);
    res.json({ quotes: rows, total, page, pageSize, counts: Object.fromEntries(counts.map((c) => [c.status, { count: c._count, total: c._sum.total ?? 0 }])) });
  }),
);

adminBillingExtras.get(
  "/quotes/:id",
  requireStaff("billing.view"),
  ah(async (req, res) => {
    const q = await prisma.quote.findUnique({ where: { id: req.params.id }, include: { user: { select: { id: true, email: true, firstName: true, lastName: true, phone: true } } } });
    if (!q) throw notFound("Quote not found");
    const invoice = q.invoiceId ? await prisma.invoice.findUnique({ where: { id: q.invoiceId }, select: { id: true, number: true, proformaNumber: true, status: true } }) : null;
    res.json({ quote: q, invoice, breakdown: await quoteTotals(q.userId, q.items as QuoteLine[]) });
  }),
);

async function saveQuote(b: z.infer<typeof quoteSchema>, id: string | null, actorId: string) {
  const u = await prisma.user.findUnique({ where: { id: b.userId }, select: { type: true } });
  if (!u || u.type !== "CLIENT") throw notFound("Customer not found");
  await requireCurrency(b.currency);
  const t = await quoteTotals(b.userId, b.items);
  const data = { userId: b.userId, subject: b.subject, currency: b.currency, validUntil: b.validUntil, items: b.items, subtotal: t.subtotal, taxTotal: t.taxTotal, total: t.total, customerNotes: b.customerNotes ?? null, adminNotes: b.adminNotes ?? null };
  return id ? prisma.quote.update({ where: { id }, data }) : prisma.quote.create({ data: { ...data, number: await nextQuoteNumber(), createdById: actorId } });
}

adminBillingExtras.post(
  "/quotes",
  requireStaff("billing.manage"),
  ah(async (req, res) => {
    const b = parse(quoteSchema, req.body);
    let q = await saveQuote(b, null, req.user!.id);
    if (b.send) q = await sendQuote(q.id);
    await audit({ actorId: req.user!.id, userId: b.userId, action: "quote.created", entity: "quote", entityId: q.id, details: { number: q.number, total: q.total, sent: b.send } });
    res.status(201).json({ quote: q });
  }),
);

adminBillingExtras.put(
  "/quotes/:id",
  requireStaff("billing.manage"),
  ah(async (req, res) => {
    const cur = await prisma.quote.findUnique({ where: { id: req.params.id } });
    if (!cur) throw notFound("Quote not found");
    if (["ACCEPTED", "INVOICED"].includes(cur.status)) throw conflict("An accepted quote can't be changed — edit its invoice instead");
    const b = parse(quoteSchema, { ...req.body, userId: cur.userId });
    let q = await saveQuote(b, cur.id, req.user!.id);
    if (b.send) q = await sendQuote(q.id);
    await audit({ actorId: req.user!.id, userId: cur.userId, action: "quote.updated", entity: "quote", entityId: cur.id, details: { total: { from: cur.total, to: q.total }, sent: b.send } });
    res.json({ quote: q });
  }),
);

adminBillingExtras.post(
  "/quotes/:id/send",
  requireStaff("billing.manage"),
  ah(async (req, res) => {
    const q = await sendQuote(req.params.id);
    await audit({ actorId: req.user!.id, userId: q.userId, action: "quote.sent", entity: "quote", entityId: q.id });
    res.json({ quote: q });
  }),
);

/** Mark accepted on the customer's behalf (phone / email approval) — creates the invoice. */
adminBillingExtras.post(
  "/quotes/:id/accept",
  requireStaff("billing.manage"),
  ah(async (req, res) => {
    const r = await acceptQuote(req.params.id);
    const q = await prisma.quote.findUniqueOrThrow({ where: { id: req.params.id } });
    await audit({ actorId: req.user!.id, userId: q.userId, action: "quote.accepted_by_staff", entity: "quote", entityId: q.id, details: { invoiceId: r.invoiceId } });
    res.json(r);
  }),
);

adminBillingExtras.post(
  "/quotes/:id/status",
  requireStaff("billing.manage"),
  ah(async (req, res) => {
    const b = parse(z.object({ status: z.enum(["DRAFT", "SENT", "DECLINED"]) }), req.body);
    const cur = await prisma.quote.findUnique({ where: { id: req.params.id } });
    if (!cur) throw notFound("Quote not found");
    if (["ACCEPTED", "INVOICED"].includes(cur.status)) throw conflict("This quote was already accepted");
    const q = await prisma.quote.update({ where: { id: cur.id }, data: { status: b.status, ...(b.status === "DECLINED" ? { declinedAt: new Date() } : {}) } });
    await audit({ actorId: req.user!.id, userId: cur.userId, action: "quote.status_changed", entity: "quote", entityId: cur.id, details: { from: cur.status, to: b.status } });
    res.json({ quote: q });
  }),
);

adminBillingExtras.post(
  "/quotes/:id/duplicate",
  requireStaff("billing.manage"),
  ah(async (req, res) => {
    const src = await prisma.quote.findUnique({ where: { id: req.params.id } });
    if (!src) throw notFound("Quote not found");
    const q = await prisma.quote.create({ data: { number: await nextQuoteNumber(), userId: src.userId, subject: src.subject, currency: src.currency, validUntil: new Date(Date.now() + 15 * 86400_000), items: src.items as Prisma.InputJsonValue, subtotal: src.subtotal, taxTotal: src.taxTotal, total: src.total, customerNotes: src.customerNotes, adminNotes: src.adminNotes, createdById: req.user!.id } });
    await audit({ actorId: req.user!.id, userId: src.userId, action: "quote.duplicated", entity: "quote", entityId: q.id, details: { from: src.number } });
    res.status(201).json({ quote: q });
  }),
);

adminBillingExtras.delete(
  "/quotes/:id",
  requireStaff("billing.manage"),
  ah(async (req, res) => {
    const cur = await prisma.quote.findUnique({ where: { id: req.params.id } });
    if (!cur) throw notFound("Quote not found");
    if (cur.status === "INVOICED") throw conflict("This quote became an invoice — it's kept for the record");
    await prisma.quote.delete({ where: { id: cur.id } });
    await audit({ actorId: req.user!.id, userId: cur.userId, action: "quote.deleted", entity: "quote", entityId: cur.id, details: { number: cur.number } });
    res.json({ ok: true });
  }),
);
