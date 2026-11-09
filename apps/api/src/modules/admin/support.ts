import { Router } from "express";
import { z } from "zod";
import { prisma, Prisma, TicketPriority, TicketStatus, DomainStatus } from "../../db";
import { ah, badRequest, notFound, pageParams, parse } from "../../lib/http";
import { audit } from "../../lib/audit";
import { requireStaff } from "../../middleware/auth";
import { attachmentPath, openTicket, replyTicket, ticketUpload } from "../tickets/service";
import { queueEmail } from "../email/mailer";
import { adjustCredit } from "../billing/invoices";
import { crud } from "./crud";

export const adminSupport = Router();

// ───────────── Tickets ─────────────
crud(adminSupport, "/ticket-departments", "ticketDepartment", z.object({ name: z.string().min(2), email: z.string().email().nullable().optional(), hidden: z.boolean().default(false), slaHours: z.number().int().min(1).max(168).default(4), sortOrder: z.number().int().default(0) }), "tickets.manage", { orderBy: { sortOrder: "asc" } });
crud(adminSupport, "/canned-responses", "cannedResponse", z.object({ title: z.string().min(1), body: z.string().min(1) }), "tickets.view");

adminSupport.get(
  "/tickets",
  requireStaff("tickets.view"),
  ah(async (req, res) => {
    const { skip, take, page, pageSize } = pageParams(req.query);
    const q = req.query as Record<string, string | undefined>;
    const where: Prisma.TicketWhereInput = {
      ...(q.status === "active" ? { status: { in: ["OPEN", "CUSTOMER_REPLY", "IN_PROGRESS"] } } : q.status ? { status: q.status as TicketStatus } : {}),
      ...(q.departmentId ? { departmentId: q.departmentId } : {}),
      ...(q.priority ? { priority: q.priority as TicketPriority } : {}),
      ...(q.assigned === "me" ? { assignedToId: req.user!.id } : q.assigned === "none" ? { assignedToId: null } : {}),
      ...(q.userId ? { userId: q.userId } : {}),
      ...(q.q ? { OR: [{ number: { contains: q.q } }, { subject: { contains: q.q, mode: "insensitive" } }, { user: { email: { contains: q.q, mode: "insensitive" } } }] } : {}),
    };
    const [rows, total] = await Promise.all([
      prisma.ticket.findMany({ where, orderBy: [{ lastReplyAt: "desc" }], skip, take, include: { user: { select: { id: true, email: true, firstName: true, lastName: true } }, department: true, assignedTo: { select: { id: true, firstName: true } } } }),
      prisma.ticket.count({ where }),
    ]);
    const now = Date.now();
    res.json({ tickets: rows.map((t) => ({ ...t, slaBreached: !t.firstResponseAt && !!t.slaDueAt && t.slaDueAt.getTime() < now && t.status !== "CLOSED" })), total, page, pageSize });
  }),
);

adminSupport.get(
  "/tickets/:id",
  requireStaff("tickets.view"),
  ah(async (req, res) => {
    const t = await prisma.ticket.findUnique({
      where: { id: req.params.id },
      include: {
        user: { select: { id: true, email: true, firstName: true, lastName: true, phone: true, profile: { select: { companyName: true } } } },
        department: true,
        assignedTo: { select: { id: true, firstName: true, lastName: true } },
        service: { include: { product: { select: { name: true } }, ips: { select: { address: true } } } },
        messages: { orderBy: { createdAt: "asc" }, include: { attachments: true, author: { select: { firstName: true, lastName: true, type: true } } } },
      },
    });
    if (!t) throw notFound();
    const services = await prisma.service.findMany({ where: { userId: t.userId, status: { in: ["ACTIVE", "SUSPENDED"] } }, include: { product: { select: { name: true } } } });
    res.json({ ticket: t, clientServices: services.map((s) => ({ id: s.id, product: s.product.name, hostname: s.hostname, status: s.status })) });
  }),
);

adminSupport.post(
  "/tickets",
  requireStaff("tickets.manage"),
  ticketUpload.array("attachments", 5),
  ah(async (req, res) => {
    const b = parse(z.object({ userId: z.string(), departmentId: z.string(), subject: z.string().min(3), message: z.string().min(1), priority: z.nativeEnum(TicketPriority).default("MEDIUM"), serviceId: z.string().nullable().optional() }), req.body);
    const t = await openTicket({ ...b, authorId: req.user!.id, isStaff: true, files: req.files as Express.Multer.File[] });
    res.status(201).json({ id: t.id });
  }),
);

adminSupport.post(
  "/tickets/:id/reply",
  requireStaff("tickets.manage"),
  ticketUpload.array("attachments", 5),
  ah(async (req, res) => {
    const b = parse(z.object({ message: z.string().min(1), note: z.union([z.boolean(), z.enum(["true", "false"])]).optional(), status: z.nativeEnum(TicketStatus).optional() }), req.body);
    const isNote = b.note === true || b.note === "true";
    await replyTicket({ ticketId: req.params.id, authorId: req.user!.id, isStaff: true, isNote, message: b.message, status: b.status, files: req.files as Express.Multer.File[] });
    res.json({ ok: true });
  }),
);

adminSupport.put(
  "/tickets/:id",
  requireStaff("tickets.manage"),
  ah(async (req, res) => {
    const b = parse(z.object({ status: z.nativeEnum(TicketStatus).optional(), priority: z.nativeEnum(TicketPriority).optional(), departmentId: z.string().optional(), assignedToId: z.string().nullable().optional(), serviceId: z.string().nullable().optional() }), req.body);
    await prisma.ticket.update({ where: { id: req.params.id }, data: { ...b, ...(b.status === "CLOSED" ? { closedAt: new Date() } : {}) } });
    await audit({ actorId: req.user!.id, action: "ticket.updated", entity: "ticket", entityId: req.params.id, details: b });
    res.json({ ok: true });
  }),
);

adminSupport.get(
  "/attachments/:id",
  requireStaff("tickets.view"),
  ah(async (req, res) => {
    const a = await prisma.ticketAttachment.findUniqueOrThrow({ where: { id: req.params.id } });
    res.download(attachmentPath(a.storedAs), a.filename);
  }),
);

// ───────────── Domains ─────────────
adminSupport.get(
  "/domains",
  requireStaff("domains.manage"),
  ah(async (req, res) => {
    const { skip, take, page, pageSize } = pageParams(req.query);
    const q = req.query as Record<string, string | undefined>;
    const where: Prisma.DomainWhereInput = { ...(q.status ? { status: q.status as DomainStatus } : {}), ...(q.q ? { name: { contains: q.q.toLowerCase() } } : {}), ...(q.expiring === "1" ? { expiryDate: { lt: new Date(Date.now() + 30 * 86400000) }, status: "ACTIVE" } : {}) };
    const [rows, total] = await Promise.all([prisma.domain.findMany({ where, orderBy: { createdAt: "desc" }, skip, take, include: { user: { select: { id: true, email: true } } } }), prisma.domain.count({ where })]);
    res.json({ domains: rows.map(({ eppCodeEnc, ...d }) => ({ ...d, hasEpp: !!eppCodeEnc })), total, page, pageSize });
  }),
);

adminSupport.put(
  "/domains/:id",
  requireStaff("domains.manage"),
  ah(async (req, res) => {
    const b = parse(
      z.object({ status: z.nativeEnum(DomainStatus).optional(), registrar: z.string().optional(), registrationDate: z.coerce.date().nullable().optional(), expiryDate: z.coerce.date().nullable().optional(), nextDueDate: z.coerce.date().nullable().optional(), recurringAmount: z.number().int().optional(), nameservers: z.array(z.string()).optional(), locked: z.boolean().optional(), autoRenew: z.boolean().optional() }),
      req.body,
    );
    if (b.status === "ACTIVE" && b.expiryDate && !b.nextDueDate) b.nextDueDate = b.expiryDate;
    await prisma.domain.update({ where: { id: req.params.id }, data: b });
    await audit({ actorId: req.user!.id, action: "domain.updated", entity: "domain", entityId: req.params.id, details: b });
    res.json({ ok: true });
  }),
);

// ───────────── Resellers ─────────────
adminSupport.get(
  "/resellers",
  requireStaff("resellers.manage"),
  ah(async (_req, res) => {
    const rows = await prisma.reseller.findMany({ orderBy: { createdAt: "desc" }, include: { user: { select: { id: true, email: true, firstName: true, lastName: true, profile: { select: { creditBalance: true } } } }, _count: { select: { services: true, customers: true } } } });
    res.json({ resellers: rows });
  }),
);

adminSupport.put(
  "/resellers/:id",
  requireStaff("resellers.manage"),
  ah(async (req, res) => {
    const b = parse(z.object({ status: z.enum(["PENDING", "APPROVED", "REJECTED", "SUSPENDED"]).optional(), discountPct: z.number().int().min(0).max(90).optional(), notes: z.string().optional(), brandName: z.string().optional() }), req.body);
    const prev = await prisma.reseller.findUniqueOrThrow({ where: { id: req.params.id }, include: { user: true } });
    await prisma.reseller.update({ where: { id: req.params.id }, data: { ...b, ...(b.status === "APPROVED" && prev.status !== "APPROVED" ? { approvedAt: new Date() } : {}) } });
    if (b.status === "APPROVED" && prev.status !== "APPROVED") await queueEmail("reseller.approved", prev.user.email, { name: prev.user.firstName, brand: prev.brandName }, prev.userId);
    await audit({ actorId: req.user!.id, userId: prev.userId, action: "reseller.updated", entity: "reseller", entityId: prev.id, details: b });
    res.json({ ok: true });
  }),
);

// ───────────── Affiliates ─────────────
adminSupport.get(
  "/affiliates",
  requireStaff("clients.view"),
  ah(async (_req, res) => {
    res.json({
      affiliates: await prisma.affiliate.findMany({ include: { user: { select: { email: true, firstName: true } }, _count: { select: { referrals: true } } }, orderBy: { createdAt: "desc" } }),
      pending: await prisma.referral.findMany({ where: { status: "PENDING" }, include: { affiliate: { include: { user: { select: { email: true } } } }, referredUser: { select: { email: true } } }, orderBy: { createdAt: "desc" } }),
    });
  }),
);

adminSupport.post(
  "/referrals/:id/approve",
  requireStaff("billing.manage"),
  ah(async (req, res) => {
    const { payout } = parse(z.object({ payout: z.enum(["credit", "balance"]).default("credit") }), req.body ?? {});
    const r = await prisma.referral.findUniqueOrThrow({ where: { id: req.params.id }, include: { affiliate: true } });
    if (r.status !== "PENDING") throw badRequest("Already processed");
    await prisma.$transaction(async (tx) => {
      await tx.referral.update({ where: { id: r.id }, data: { status: payout === "credit" ? "PAID" : "APPROVED" } });
      if (payout === "credit") await adjustCredit(tx, { userId: r.affiliate.userId, amount: r.amount, description: "Affiliate commission", refType: "referral", refId: r.id });
      else await tx.affiliate.update({ where: { id: r.affiliateId }, data: { balance: { increment: r.amount } } });
    });
    res.json({ ok: true });
  }),
);
