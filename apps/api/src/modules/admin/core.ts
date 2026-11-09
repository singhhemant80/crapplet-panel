import { Router } from "express";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { prisma, Prisma, InvoiceStatus, ServiceStatus, BillingCycle, OrderStatus } from "../../db";
import { ah, badRequest, conflict, notFound, pageParams, parse } from "../../lib/http";
import { audit } from "../../lib/audit";
import { decrypt, encrypt, randomToken } from "../../lib/crypto";
import { requireStaff } from "../../middleware/auth";
import { enqueueProvision, type ProvisionAction } from "../../jobs/queues";
import { adjustCredit, applyPayment, cancelInvoice, createInvoice, invoiceEmailVars, invoiceLabel, issueCreditNote } from "../billing/invoices";
import { renderInvoicePdf } from "../billing/pdf";
import { reviewOfflinePayment, refundTransaction } from "../payments/service";
import { releaseOrderReservations } from "../ipam/service";
import { liveStatus } from "../provisioning/provisioner";
import { queueEmail } from "../email/mailer";
import { profileSchema, resolveStateCode, publicUser } from "../auth/routes";
import { runBillingCycle } from "../../jobs/billing";

export const adminCore = Router();

// ───────────── Dashboard ─────────────
adminCore.get(
  "/dashboard",
  requireStaff(),
  ah(async (_req, res) => {
    const now = new Date();
    const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const vpsWhere = { product: { provisioner: { in: ["PROXMOX", "VIRTUALIZOR"] as ("PROXMOX" | "VIRTUALIZOR")[] } } };
    const [clients, activeClients, vpsTotal, vpsActive, vpsSuspended, unpaid, paidCount, monthRevenue, newOrders, pendingOrders, openTickets, servers, pendingReview, failedServices, recurring] = await Promise.all([
      prisma.user.count({ where: { type: "CLIENT", ownerResellerId: null } }),
      prisma.user.count({ where: { type: "CLIENT", services: { some: { status: "ACTIVE" } } } }),
      prisma.service.count({ where: { ...vpsWhere, status: { notIn: ["CANCELLED", "TERMINATED"] } } }),
      prisma.service.count({ where: { ...vpsWhere, status: "ACTIVE" } }),
      prisma.service.count({ where: { ...vpsWhere, status: "SUSPENDED" } }),
      prisma.invoice.aggregate({ where: { status: "UNPAID" }, _sum: { total: true, amountPaid: true }, _count: true }),
      prisma.invoice.count({ where: { status: "PAID", paidAt: { gte: monthStart } } }),
      prisma.transaction.aggregate({ where: { type: "PAYMENT", createdAt: { gte: monthStart } }, _sum: { amount: true } }),
      prisma.order.count({ where: { createdAt: { gte: new Date(Date.now() - 86400000 * 7) } } }),
      prisma.order.count({ where: { status: "PENDING" } }),
      prisma.ticket.count({ where: { status: { in: ["OPEN", "CUSTOMER_REPLY", "IN_PROGRESS"] } } }),
      prisma.server.findMany({ include: { nodes: true, location: true, _count: { select: { services: { where: { status: "ACTIVE" } } } } } }),
      prisma.paymentIntent.count({ where: { status: "PENDING_REVIEW" } }),
      prisma.service.count({ where: { status: "FAILED" } }),
      prisma.service.findMany({ where: { status: { in: ["ACTIVE", "SUSPENDED"] }, billingCycle: { not: "ONETIME" } }, select: { recurringAmount: true, billingCycle: true } }),
    ]);
    const months: Record<BillingCycle, number> = { ONETIME: 0, MONTHLY: 1, QUARTERLY: 3, SEMIANNUAL: 6, ANNUAL: 12, BIENNIAL: 24, TRIENNIAL: 36 };
    const mrr = recurring.reduce((s, r) => s + (months[r.billingCycle] ? r.recurringAmount / months[r.billingCycle] : 0), 0);
    const revenue = await prisma.$queryRaw<{ month: string; total: bigint }[]>`
      SELECT to_char(date_trunc('month', "createdAt" AT TIME ZONE 'Asia/Kolkata'), 'YYYY-MM') AS month, SUM("amount")::bigint AS total
      FROM "Transaction" WHERE "type" = 'PAYMENT' AND "createdAt" > now() - interval '12 months'
      GROUP BY 1 ORDER BY 1`;
    const recentOrders = await prisma.order.findMany({ orderBy: { createdAt: "desc" }, take: 8, include: { user: { select: { firstName: true, lastName: true, email: true } }, invoice: { select: { status: true } } } });
    res.json({
      stats: {
        clients,
        activeClients,
        vpsTotal,
        vpsActive,
        vpsSuspended,
        mrr: Math.round(mrr),
        arr: Math.round(mrr * 12),
        monthRevenue: monthRevenue._sum.amount ?? 0,
        unpaidInvoices: unpaid._count,
        outstanding: (unpaid._sum.total ?? 0) - (unpaid._sum.amountPaid ?? 0),
        paidThisMonth: paidCount,
        newOrders,
        pendingOrders,
        openTickets,
        pendingPaymentReviews: pendingReview,
        failedProvisioning: failedServices,
      },
      revenue: revenue.map((r) => ({ month: r.month, total: Number(r.total) })),
      servers: servers.map((s) => ({ id: s.id, name: s.name, type: s.type, location: s.location?.name, enabled: s.enabled, lastCheckAt: s.lastCheckAt, status: s.lastStatus, activeServices: s._count.services, nodes: s.nodes })),
      recentOrders: recentOrders.map((o) => ({ id: o.id, number: o.number, client: `${o.user.firstName} ${o.user.lastName}`.trim(), email: o.user.email, total: o.total, status: o.status, paid: o.invoice?.status === "PAID", createdAt: o.createdAt })),
    });
  }),
);

// ───────────── Clients ─────────────
adminCore.get(
  "/clients",
  requireStaff("clients.view"),
  ah(async (req, res) => {
    const { skip, take, page, pageSize } = pageParams(req.query);
    const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
    const where: Prisma.UserWhereInput = {
      type: "CLIENT",
      ...(req.query.status ? { status: req.query.status as "ACTIVE" } : {}),
      ...(q ? { OR: [{ email: { contains: q, mode: "insensitive" } }, { firstName: { contains: q, mode: "insensitive" } }, { lastName: { contains: q, mode: "insensitive" } }, { phone: { contains: q } }, { profile: { companyName: { contains: q, mode: "insensitive" } } }, { profile: { gstin: { contains: q.toUpperCase() } } }] } : {}),
    };
    const [rows, total] = await Promise.all([
      prisma.user.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip,
        take,
        select: { id: true, email: true, firstName: true, lastName: true, phone: true, status: true, createdAt: true, emailVerifiedAt: true, ownerResellerId: true, profile: { select: { companyName: true, gstin: true, city: true, state: true, country: true, creditBalance: true } }, _count: { select: { services: true } } },
      }),
      prisma.user.count({ where }),
    ]);
    res.json({ clients: rows, total, page, pageSize });
  }),
);

adminCore.get(
  "/clients/:id",
  requireStaff("clients.view"),
  ah(async (req, res) => {
    const user = await publicUser(req.params.id).catch(() => null);
    if (!user || user.type !== "CLIENT") throw notFound("Client not found");
    const [services, invoices, tickets, domains, transactions, logins, ledger, notesUser] = await Promise.all([
      prisma.service.findMany({ where: { userId: req.params.id }, orderBy: { createdAt: "desc" }, include: { product: { select: { name: true } }, ips: { select: { address: true } } } }),
      prisma.invoice.findMany({ where: { userId: req.params.id }, orderBy: { createdAt: "desc" }, take: 50 }),
      prisma.ticket.findMany({ where: { userId: req.params.id }, orderBy: { lastReplyAt: "desc" }, take: 20, include: { department: true } }),
      prisma.domain.findMany({ where: { userId: req.params.id } }),
      prisma.transaction.findMany({ where: { userId: req.params.id }, orderBy: { createdAt: "desc" }, take: 30 }),
      prisma.loginHistory.findMany({ where: { userId: req.params.id }, orderBy: { createdAt: "desc" }, take: 15 }),
      prisma.creditLedger.findMany({ where: { userId: req.params.id }, orderBy: { createdAt: "desc" }, take: 30 }),
      prisma.user.findUnique({ where: { id: req.params.id }, select: { status: true } }),
    ]);
    res.json({ client: { ...user, status: notesUser?.status }, services, invoices, tickets, domains, transactions, logins, ledger });
  }),
);

adminCore.post(
  "/clients",
  requireStaff("clients.manage"),
  ah(async (req, res) => {
    const b = parse(profileSchema.extend({ email: z.string().email().toLowerCase(), password: z.string().min(8).optional(), sendWelcome: z.boolean().default(true) }), req.body);
    if (await prisma.user.findUnique({ where: { email: b.email } })) throw conflict("Email already in use");
    const password = b.password ?? randomToken(12);
    const u = await prisma.user.create({
      data: {
        email: b.email,
        passwordHash: await bcrypt.hash(password, 12),
        firstName: b.firstName,
        lastName: b.lastName,
        phone: b.phone,
        emailVerifiedAt: new Date(),
        profile: { create: { companyName: b.companyName, gstin: b.gstin, pan: b.pan, address1: b.address1, address2: b.address2, city: b.city, state: b.state, stateCode: resolveStateCode(b.country, b.state, b.gstin, b.stateCode), country: b.country, postcode: b.postcode, currency: b.country === "IN" ? "INR" : "USD" } },
      },
    });
    if (b.sendWelcome) await queueEmail("auth.welcome", u.email, { name: u.firstName }, u.id);
    await audit({ actorId: req.user!.id, userId: u.id, action: "client.created_by_staff" });
    res.status(201).json({ id: u.id, password: b.password ? undefined : password });
  }),
);

adminCore.put(
  "/clients/:id",
  requireStaff("clients.manage"),
  ah(async (req, res) => {
    const b = parse(profileSchema.partial().extend({ email: z.string().email().toLowerCase().optional(), status: z.enum(["ACTIVE", "INACTIVE", "CLOSED"]).optional(), notes: z.string().max(5000).optional() }), req.body);
    const { email, status, firstName, lastName, phone, notes, ...profile } = b;
    const current = await prisma.clientProfile.findUnique({ where: { userId: req.params.id } });
    const stateCode = profile.country || profile.state || profile.gstin ? resolveStateCode(profile.country ?? current?.country ?? "IN", profile.state ?? current?.state ?? "", profile.gstin ?? current?.gstin, profile.stateCode) : undefined;
    await prisma.user.update({
      where: { id: req.params.id },
      data: { email, status, firstName, lastName, phone, profile: { update: { ...profile, ...(stateCode !== undefined ? { stateCode } : {}), ...(notes !== undefined ? { notes } : {}) } } },
    });
    if (status && status !== "ACTIVE") await prisma.session.updateMany({ where: { userId: req.params.id, revokedAt: null }, data: { revokedAt: new Date() } });
    await audit({ actorId: req.user!.id, userId: req.params.id, action: "client.updated", details: Object.keys(b) });
    res.json({ ok: true });
  }),
);

adminCore.post(
  "/clients/:id/credit",
  requireStaff("billing.manage"),
  ah(async (req, res) => {
    const b = parse(z.object({ amount: z.number().int().refine((v) => v !== 0), description: z.string().min(3).max(200) }), req.body);
    const balance = await adjustCredit(prisma, { userId: req.params.id, amount: b.amount, description: `${b.description} (staff)`, refType: "staff", refId: req.user!.id });
    await audit({ actorId: req.user!.id, userId: req.params.id, action: "client.credit_adjusted", details: b });
    res.json({ balance });
  }),
);

adminCore.post(
  "/clients/:id/reset-2fa",
  requireStaff("clients.manage"),
  ah(async (req, res) => {
    await prisma.user.update({ where: { id: req.params.id }, data: { totpEnabled: false, totpSecretEnc: null } });
    await audit({ actorId: req.user!.id, userId: req.params.id, action: "client.2fa_reset" });
    res.json({ ok: true });
  }),
);

// ───────────── Orders ─────────────
adminCore.get(
  "/orders",
  requireStaff("orders.view"),
  ah(async (req, res) => {
    const { skip, take, page, pageSize } = pageParams(req.query);
    const where: Prisma.OrderWhereInput = req.query.status ? { status: req.query.status as OrderStatus } : {};
    const [rows, total] = await Promise.all([
      prisma.order.findMany({ where, orderBy: { createdAt: "desc" }, skip, take, include: { user: { select: { id: true, firstName: true, lastName: true, email: true } }, invoice: { select: { id: true, status: true, total: true } }, services: { include: { product: { select: { name: true } } } }, domains: { select: { name: true } } } }),
      prisma.order.count({ where }),
    ]);
    res.json({ orders: rows, total, page, pageSize });
  }),
);

adminCore.post(
  "/orders/:id/accept",
  requireStaff("orders.manage"),
  ah(async (req, res) => {
    const o = await prisma.order.findUniqueOrThrow({ where: { id: req.params.id }, include: { services: { include: { product: true } }, invoice: true } });
    for (const s of o.services.filter((x) => x.status === "PENDING" || x.status === "FAILED")) {
      if (s.product.provisioner === "PROXMOX" || s.product.provisioner === "VIRTUALIZOR") {
        await prisma.service.update({ where: { id: s.id }, data: { status: "PROVISIONING" } });
        await enqueueProvision({ serviceId: s.id, action: "create", actorId: req.user!.id });
      } else await prisma.service.update({ where: { id: s.id }, data: { status: "ACTIVE" } });
    }
    await prisma.order.update({ where: { id: o.id }, data: { status: "ACTIVE" } });
    await audit({ actorId: req.user!.id, action: "order.accepted", entity: "order", entityId: o.id, details: { invoicePaid: o.invoice?.status === "PAID" } });
    res.json({ ok: true });
  }),
);

adminCore.post(
  "/orders/:id/cancel",
  requireStaff("orders.manage"),
  ah(async (req, res) => {
    const { fraud } = parse(z.object({ fraud: z.boolean().default(false) }), req.body ?? {});
    const o = await prisma.order.findUniqueOrThrow({ where: { id: req.params.id }, include: { invoice: true } });
    if (o.invoice?.status === "UNPAID") await cancelInvoice(o.invoice.id, fraud ? "Order marked as fraud" : "Order cancelled");
    await releaseOrderReservations(o.id);
    await prisma.service.updateMany({ where: { orderId: o.id, status: { in: ["PENDING", "FAILED"] } }, data: { status: "CANCELLED" } });
    await prisma.order.update({ where: { id: o.id }, data: { status: fraud ? "FRAUD" : "CANCELLED" } });
    await audit({ actorId: req.user!.id, action: fraud ? "order.fraud" : "order.cancelled", entity: "order", entityId: o.id });
    res.json({ ok: true });
  }),
);

// ───────────── Services (incl. VPS management) ─────────────
adminCore.get(
  "/services",
  requireStaff("services.view"),
  ah(async (req, res) => {
    const { skip, take, page, pageSize } = pageParams(req.query);
    const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
    const where: Prisma.ServiceWhereInput = {
      ...(req.query.status ? { status: req.query.status as ServiceStatus } : {}),
      ...(req.query.serverId ? { serverId: String(req.query.serverId) } : {}),
      ...(req.query.vps === "1" ? { product: { provisioner: { in: ["PROXMOX", "VIRTUALIZOR"] } } } : {}),
      ...(req.query.resellerId ? { resellerId: String(req.query.resellerId) } : {}),
      ...(q ? { OR: [{ hostname: { contains: q, mode: "insensitive" } }, { remoteId: q }, { ips: { some: { address: { startsWith: q } } } }, { user: { email: { contains: q, mode: "insensitive" } } }] } : {}),
    };
    const [rows, total] = await Promise.all([
      prisma.service.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip,
        take,
        include: { user: { select: { id: true, email: true, firstName: true, lastName: true } }, product: { select: { name: true, provisioner: true, type: true } }, server: { select: { name: true } }, ips: { select: { address: true, isPrimary: true } } },
      }),
      prisma.service.count({ where }),
    ]);
    res.json({ services: rows.map(({ passwordEnc, ...s }) => ({ ...s, hasPassword: !!passwordEnc })), total, page, pageSize });
  }),
);

adminCore.get(
  "/services/:id",
  requireStaff("services.view"),
  ah(async (req, res) => {
    const s = await prisma.service.findUnique({
      where: { id: req.params.id },
      include: { user: { select: { id: true, email: true, firstName: true, lastName: true } }, product: true, server: true, osTemplate: true, ips: { include: { subnet: true } }, addons: { include: { addon: true } }, logs: { orderBy: { createdAt: "desc" }, take: 50 }, order: true, reseller: true },
    });
    if (!s) throw notFound();
    const { passwordEnc, server, ...rest } = s;
    const invoices = await prisma.invoice.findMany({ where: { items: { some: { relId: s.id } } }, orderBy: { createdAt: "desc" }, select: { id: true, number: true, proformaNumber: true, status: true, total: true, dueDate: true } });
    res.json({ service: { ...rest, server: server ? { id: server.id, name: server.name, type: server.type, hostname: server.hostname } : null, hasPassword: !!passwordEnc }, invoices });
  }),
);

adminCore.get(
  "/services/:id/password",
  requireStaff("services.manage"),
  ah(async (req, res) => {
    const s = await prisma.service.findUniqueOrThrow({ where: { id: req.params.id } });
    await audit({ actorId: req.user!.id, userId: s.userId, action: "service.password_viewed", entity: "service", entityId: s.id });
    res.json({ username: s.username, password: s.passwordEnc ? decrypt(s.passwordEnc) : null });
  }),
);

adminCore.get(
  "/services/:id/live",
  requireStaff("services.view"),
  ah(async (req, res) => {
    res.json({ live: await liveStatus(req.params.id).catch((e) => ({ error: String((e as Error).message) })) });
  }),
);

adminCore.put(
  "/services/:id",
  requireStaff("services.manage"),
  ah(async (req, res) => {
    const b = parse(
      z.object({
        nextDueDate: z.coerce.date().nullable().optional(),
        recurringAmount: z.number().int().min(0).optional(),
        billingCycle: z.nativeEnum(BillingCycle).optional(),
        status: z.nativeEnum(ServiceStatus).optional(),
        hostname: z.string().max(120).optional(),
        serverId: z.string().nullable().optional(),
        node: z.string().nullable().optional(),
        remoteId: z.string().nullable().optional(),
        username: z.string().optional(),
        password: z.string().min(6).optional(),
        overrideAutoSuspend: z.boolean().optional(),
        notes: z.string().max(5000).optional(),
      }),
      req.body,
    );
    const { password, ...data } = b;
    await prisma.service.update({ where: { id: req.params.id }, data: { ...data, ...(data.nextDueDate !== undefined ? { nextInvoiceDate: data.nextDueDate } : {}), ...(password ? { passwordEnc: encrypt(password) } : {}) } });
    await audit({ actorId: req.user!.id, action: "service.updated", entity: "service", entityId: req.params.id, details: Object.keys(b) });
    res.json({ ok: true });
  }),
);

adminCore.post(
  "/services/:id/action",
  requireStaff("services.manage"),
  ah(async (req, res) => {
    const b = parse(
      z.object({
        action: z.enum(["create", "suspend", "unsuspend", "terminate", "start", "stop", "shutdown", "reboot", "reinstall", "reset_password", "sync"]),
        reason: z.string().max(200).optional(),
        osTemplateId: z.string().optional(),
        notify: z.boolean().optional(),
      }),
      req.body,
    );
    const s = await prisma.service.findUniqueOrThrow({ where: { id: req.params.id } });
    if (b.action === "create" && s.status === "ACTIVE") throw conflict("Service is already active");
    if (b.action === "create") {
      await prisma.service.update({ where: { id: s.id }, data: { status: "PROVISIONING" } });
      // remove any stale (failed) create job so it can be re-queued under the same id
      const { provisioningQueue } = await import("../../jobs/queues");
      const old = await provisioningQueue().getJob(`create-${s.id}`);
      if (old && (await old.isFailed() || await old.isCompleted())) await old.remove();
    }
    await enqueueProvision({ serviceId: s.id, action: b.action as ProvisionAction, params: { reason: b.reason, osTemplateId: b.osTemplateId, notify: b.notify }, actorId: req.user!.id });
    await audit({ actorId: req.user!.id, userId: s.userId, action: `service.${b.action}`, entity: "service", entityId: s.id, details: b });
    res.status(202).json({ queued: true });
  }),
);

// ───────────── Invoices ─────────────
adminCore.get(
  "/invoices",
  requireStaff("billing.view"),
  ah(async (req, res) => {
    const { skip, take, page, pageSize } = pageParams(req.query);
    const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
    const where: Prisma.InvoiceWhereInput = {
      ...(req.query.status ? { status: req.query.status as InvoiceStatus } : {}),
      ...(req.query.userId ? { userId: String(req.query.userId) } : {}),
      ...(req.query.overdue === "1" ? { status: "UNPAID", dueDate: { lt: new Date() } } : {}),
      ...(q ? { OR: [{ number: { contains: q } }, { proformaNumber: { contains: q } }, { user: { email: { contains: q, mode: "insensitive" } } }] } : {}),
    };
    const [rows, total, sums] = await Promise.all([
      prisma.invoice.findMany({ where, orderBy: { createdAt: "desc" }, skip, take, include: { user: { select: { id: true, email: true, firstName: true, lastName: true } } } }),
      prisma.invoice.count({ where }),
      prisma.invoice.aggregate({ where, _sum: { total: true, amountPaid: true, taxTotal: true } }),
    ]);
    res.json({ invoices: rows, total, page, pageSize, sums: sums._sum });
  }),
);

adminCore.get(
  "/invoices/:id",
  requireStaff("billing.view"),
  ah(async (req, res) => {
    const inv = await prisma.invoice.findUnique({ where: { id: req.params.id }, include: { items: true, transactions: true, creditNotes: true, paymentIntents: true, user: { select: { id: true, email: true, firstName: true, lastName: true } }, order: true } });
    if (!inv) throw notFound();
    res.json({ invoice: inv, label: invoiceLabel(inv) });
  }),
);

adminCore.get(
  "/invoices/:id/pdf",
  requireStaff("billing.view"),
  ah(async (req, res) => {
    const inv = await prisma.invoice.findUniqueOrThrow({ where: { id: req.params.id } });
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `inline; filename="${invoiceLabel(inv).replace(/\//g, "-")}.pdf"`);
    res.send(await renderInvoicePdf(inv.id));
  }),
);

adminCore.post(
  "/invoices",
  requireStaff("billing.manage"),
  ah(async (req, res) => {
    const b = parse(
      z.object({
        userId: z.string(),
        dueDate: z.coerce.date().optional(),
        notes: z.string().max(2000).optional(),
        items: z.array(z.object({ description: z.string().min(1).max(300), unitPrice: z.number().int(), quantity: z.number().int().min(1).default(1), taxable: z.boolean().default(true), hsnSac: z.string().optional() })).min(1),
        sendEmail: z.boolean().default(true),
      }),
      req.body,
    );
    const inv = await prisma.$transaction((tx) => createInvoice(tx, { userId: b.userId, dueDate: b.dueDate, notes: b.notes, items: b.items.map((i) => ({ ...i, type: "CUSTOM" as const })) }));
    if (b.sendEmail) {
      const u = await prisma.user.findUniqueOrThrow({ where: { id: b.userId } });
      await queueEmail("invoice.created", u.email, invoiceEmailVars(inv, u.firstName), u.id);
    }
    await audit({ actorId: req.user!.id, userId: b.userId, action: "invoice.created_manual", entity: "invoice", entityId: inv.id });
    res.status(201).json({ id: inv.id });
  }),
);

adminCore.post(
  "/invoices/:id/payment",
  requireStaff("billing.manage"),
  ah(async (req, res) => {
    const b = parse(z.object({ amount: z.number().int().positive(), gateway: z.string().default("manual"), reference: z.string().min(3).max(100), fee: z.number().int().min(0).default(0) }), req.body);
    const r = await applyPayment({ invoiceId: req.params.id, amount: b.amount, gateway: b.gateway, gatewayTxnId: b.reference, fee: b.fee, description: `Recorded by staff` });
    if (r.duplicate) throw conflict("A payment with this reference was already recorded");
    await audit({ actorId: req.user!.id, action: "invoice.payment_recorded", entity: "invoice", entityId: req.params.id, details: b });
    res.json(r);
  }),
);

adminCore.post(
  "/invoices/:id/cancel",
  requireStaff("billing.manage"),
  ah(async (req, res) => {
    await cancelInvoice(req.params.id, "Cancelled by staff");
    await audit({ actorId: req.user!.id, action: "invoice.cancelled", entity: "invoice", entityId: req.params.id });
    res.json({ ok: true });
  }),
);

adminCore.post(
  "/invoices/:id/credit-note",
  requireStaff("billing.manage"),
  ah(async (req, res) => {
    const b = parse(z.object({ amount: z.number().int().positive(), reason: z.string().min(3), toCredit: z.boolean().default(true) }), req.body);
    const cn = await issueCreditNote({ invoiceId: req.params.id, ...b, actorId: req.user!.id });
    await audit({ actorId: req.user!.id, action: "invoice.credit_note", entity: "invoice", entityId: req.params.id, details: b });
    res.status(201).json({ creditNote: cn });
  }),
);

adminCore.post(
  "/invoices/:id/remind",
  requireStaff("billing.manage"),
  ah(async (req, res) => {
    const inv = await prisma.invoice.findUniqueOrThrow({ where: { id: req.params.id }, include: { user: true } });
    if (inv.status !== "UNPAID") throw badRequest("Invoice is not unpaid");
    await queueEmail(inv.dueDate < new Date() ? "invoice.overdue" : "invoice.reminder", inv.user.email, invoiceEmailVars(inv, inv.user.firstName), inv.userId);
    await prisma.invoice.update({ where: { id: inv.id }, data: { remindersSent: { increment: 1 }, lastReminderAt: new Date() } });
    res.json({ ok: true });
  }),
);

// ───────────── Transactions & payment reviews ─────────────
adminCore.get(
  "/transactions",
  requireStaff("billing.view"),
  ah(async (req, res) => {
    const { skip, take, page, pageSize } = pageParams(req.query);
    const where: Prisma.TransactionWhereInput = { ...(req.query.gateway ? { gateway: String(req.query.gateway) } : {}), ...(req.query.userId ? { userId: String(req.query.userId) } : {}) };
    const [rows, total] = await Promise.all([
      prisma.transaction.findMany({ where, orderBy: { createdAt: "desc" }, skip, take, include: { user: { select: { id: true, email: true, firstName: true, lastName: true } }, invoice: { select: { id: true, number: true, proformaNumber: true } } } }),
      prisma.transaction.count({ where }),
    ]);
    res.json({ transactions: rows.map(({ raw, ...t }) => t), total, page, pageSize });
  }),
);

adminCore.post(
  "/transactions/:id/refund",
  requireStaff("payments.manage"),
  ah(async (req, res) => {
    const b = parse(z.object({ amount: z.number().int().positive(), toCredit: z.boolean().default(true), reason: z.string().min(3) }), req.body);
    const r = await refundTransaction({ transactionId: req.params.id, ...b, actorId: req.user!.id });
    await audit({ actorId: req.user!.id, action: "transaction.refunded", entity: "transaction", entityId: req.params.id, details: b });
    res.json(r);
  }),
);

adminCore.get(
  "/payment-reviews",
  requireStaff("billing.view"),
  ah(async (_req, res) => {
    res.json({
      intents: await prisma.paymentIntent.findMany({ where: { status: "PENDING_REVIEW" }, orderBy: { updatedAt: "asc" }, include: { user: { select: { email: true, firstName: true, lastName: true } }, invoice: { select: { id: true, number: true, proformaNumber: true, total: true, amountPaid: true } } } }),
    });
  }),
);

adminCore.post(
  "/payment-reviews/:id",
  requireStaff("payments.manage"),
  ah(async (req, res) => {
    const b = parse(z.object({ approve: z.boolean(), amount: z.number().int().positive().optional(), note: z.string().max(300).optional() }), req.body);
    const r = await reviewOfflinePayment({ intentId: req.params.id, ...b, actorId: req.user!.id });
    await audit({ actorId: req.user!.id, action: b.approve ? "payment.approved" : "payment.rejected", entity: "paymentIntent", entityId: req.params.id });
    res.json(r);
  }),
);

// ───────────── Reports ─────────────
adminCore.get(
  "/reports/summary",
  requireStaff("reports.view"),
  ah(async (req, res) => {
    const from = req.query.from ? new Date(String(req.query.from)) : new Date(Date.now() - 365 * 86400000);
    const to = req.query.to ? new Date(String(req.query.to)) : new Date();
    const [gst, byType, newClients, gateways] = await Promise.all([
      prisma.$queryRaw<{ month: string; invoices: bigint; taxable: bigint; cgst: bigint; sgst: bigint; igst: bigint; total: bigint }[]>`
        SELECT to_char(date_trunc('month', "paidAt" AT TIME ZONE 'Asia/Kolkata'), 'YYYY-MM') AS month, COUNT(*)::bigint AS invoices,
          SUM("taxableAmount")::bigint AS taxable, SUM("cgst")::bigint AS cgst, SUM("sgst")::bigint AS sgst, SUM("igst")::bigint AS igst, SUM("total")::bigint AS total
        FROM "Invoice" WHERE "status" = 'PAID' AND "isWalletTopup" = false AND "paidAt" BETWEEN ${from} AND ${to}
        GROUP BY 1 ORDER BY 1`,
      prisma.$queryRaw<{ type: string; services: bigint; mrr: bigint }[]>`
        SELECT p."type"::text AS type, COUNT(*)::bigint AS services,
          SUM(CASE s."billingCycle" WHEN 'MONTHLY' THEN s."recurringAmount" WHEN 'QUARTERLY' THEN s."recurringAmount"/3 WHEN 'SEMIANNUAL' THEN s."recurringAmount"/6 WHEN 'ANNUAL' THEN s."recurringAmount"/12 WHEN 'BIENNIAL' THEN s."recurringAmount"/24 WHEN 'TRIENNIAL' THEN s."recurringAmount"/36 ELSE 0 END)::bigint AS mrr
        FROM "Service" s JOIN "Product" p ON p."id" = s."productId" WHERE s."status" IN ('ACTIVE','SUSPENDED') GROUP BY 1 ORDER BY 3 DESC`,
      prisma.$queryRaw<{ month: string; clients: bigint }[]>`
        SELECT to_char(date_trunc('month', "createdAt" AT TIME ZONE 'Asia/Kolkata'), 'YYYY-MM') AS month, COUNT(*)::bigint AS clients
        FROM "User" WHERE "type" = 'CLIENT' AND "createdAt" BETWEEN ${from} AND ${to} GROUP BY 1 ORDER BY 1`,
      prisma.$queryRaw<{ gateway: string; payments: bigint; amount: bigint }[]>`
        SELECT "gateway", COUNT(*)::bigint AS payments, SUM("amount")::bigint AS amount FROM "Transaction"
        WHERE "type" = 'PAYMENT' AND "createdAt" BETWEEN ${from} AND ${to} GROUP BY 1 ORDER BY 3 DESC`,
    ]);
    const num = <T extends Record<string, unknown>>(rows: T[]) => rows.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, typeof v === "bigint" ? Number(v) : v])));
    res.json({ gst: num(gst), byType: num(byType), newClients: num(newClients), gateways: num(gateways) });
  }),
);

adminCore.post(
  "/billing/run",
  requireStaff("settings.manage"),
  ah(async (req, res) => {
    const r = await runBillingCycle();
    await audit({ actorId: req.user!.id, action: "billing.run_manual", details: r });
    res.json(r);
  }),
);

adminCore.get(
  "/activity",
  requireStaff("reports.view"),
  ah(async (req, res) => {
    const { skip, take, page, pageSize } = pageParams(req.query);
    const [rows, total] = await Promise.all([prisma.activityLog.findMany({ orderBy: { createdAt: "desc" }, skip, take, include: { user: { select: { email: true } } } }), prisma.activityLog.count()]);
    res.json({ items: rows, total, page, pageSize });
  }),
);
