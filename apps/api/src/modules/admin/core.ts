import { getSettings } from "../../lib/settings";
import { inrPerUnit, listCurrencies, requireCurrency } from "../../lib/currency";
import { Router } from "express";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { prisma, Prisma, InvoiceStatus, ServiceStatus, BillingCycle, OrderStatus } from "../../db";
import { ah, badRequest, conflict, notFound, pageParams, parse } from "../../lib/http";
import { audit } from "../../lib/audit";
import { cartSchema, rootPasswordSchema, hostingPasswordSchema } from "../orders/pricing";
import { decrypt, encrypt, randomToken } from "../../lib/crypto";
import { requireStaff } from "../../middleware/auth";
import { enqueueProvision, type ProvisionAction } from "../../jobs/queues";
import { deriveOrderStatus, syncOrderForService, syncOrderStatus } from "../orders/status";
import { adjustCredit, applyPayment, cancelInvoice, createInvoice, invoiceEmailVars, invoiceLabel, issueCreditNote } from "../billing/invoices";
import { renderInvoicePdf } from "../billing/pdf";
import { reviewOfflinePayment, refundTransaction } from "../payments/service";
import { releaseOrderReservations } from "../ipam/service";
import { liveStates, liveStatus, replaceVirtualizorIps, syncVirtualizorService } from "../provisioning/provisioner";
import { provisioningProgress } from "../provisioning/progress";
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
      // money totals are reported in INR: foreign-currency amounts use the invoice's stored exchange rate
      prisma.$queryRaw<{ count: bigint; due: number | null }[]>`SELECT COUNT(*) AS count, SUM(("total" - "amountPaid") * "exchangeRate") AS due FROM "Invoice" WHERE "status" = 'UNPAID'`,
      prisma.invoice.count({ where: { status: "PAID", paidAt: { gte: monthStart } } }),
      prisma.$queryRaw<{ total: number | null }[]>`SELECT SUM(t."amount" * COALESCE(i."exchangeRate", 1)) AS total FROM "Transaction" t LEFT JOIN "Invoice" i ON i."id" = t."invoiceId" WHERE t."type" = 'PAYMENT' AND t."createdAt" >= ${monthStart}`,
      prisma.order.count({ where: { createdAt: { gte: new Date(Date.now() - 86400000 * 7) } } }),
      prisma.order.count({ where: { status: "PENDING" } }),
      prisma.ticket.count({ where: { status: { in: ["OPEN", "CUSTOMER_REPLY", "IN_PROGRESS"] } } }),
      prisma.server.findMany({ include: { nodes: true, location: true, _count: { select: { services: { where: { status: "ACTIVE" } } } } } }),
      prisma.paymentIntent.count({ where: { status: "PENDING_REVIEW" } }),
      prisma.service.count({ where: { status: "FAILED" } }),
      prisma.service.findMany({ where: { status: { in: ["ACTIVE", "SUSPENDED"] }, billingCycle: { not: "ONETIME" } }, select: { recurringAmount: true, billingCycle: true, currency: true } }),
    ]);
    const rates = Object.fromEntries((await listCurrencies()).map((c) => [c.code, inrPerUnit(c)]));
    const months: Record<BillingCycle, number> = { ONETIME: 0, MONTHLY: 1, QUARTERLY: 3, SEMIANNUAL: 6, ANNUAL: 12, BIENNIAL: 24, TRIENNIAL: 36 };
    const mrr = recurring.reduce((s, r) => s + (months[r.billingCycle] ? (r.recurringAmount * (rates[r.currency] ?? 1)) / months[r.billingCycle] : 0), 0);
    const revenue = await prisma.$queryRaw<{ month: string; total: bigint }[]>`
      SELECT to_char(date_trunc('month', t."createdAt" AT TIME ZONE 'Asia/Kolkata'), 'YYYY-MM') AS month, ROUND(SUM(t."amount" * COALESCE(i."exchangeRate", 1)))::bigint AS total
      FROM "Transaction" t LEFT JOIN "Invoice" i ON i."id" = t."invoiceId"
      WHERE t."type" = 'PAYMENT' AND t."createdAt" > now() - interval '12 months'
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
        monthRevenue: Math.round(Number(monthRevenue[0]?.total ?? 0)),
        unpaidInvoices: Number(unpaid[0]?.count ?? 0),
        outstanding: Math.round(Number(unpaid[0]?.due ?? 0)),
        paidThisMonth: paidCount,
        newOrders,
        pendingOrders,
        openTickets,
        pendingPaymentReviews: pendingReview,
        failedProvisioning: failedServices,
      },
      revenue: revenue.map((r) => ({ month: r.month, total: Number(r.total) })),
      servers: servers.map((s) => ({ id: s.id, name: s.name, type: s.type, location: s.location?.name, enabled: s.enabled, lastCheckAt: s.lastCheckAt, status: s.lastStatus, activeServices: s._count.services, nodes: s.nodes })),
      recentOrders: recentOrders.map((o) => ({ id: o.id, number: o.number, client: `${o.user.firstName} ${o.user.lastName}`.trim(), email: o.user.email, total: o.total, currency: o.currency, status: o.status, paid: o.invoice?.status === "PAID", createdAt: o.createdAt })),
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
    const [services, invoices, tickets, domains, transactions, logins, ledger, notesUser, orders] = await Promise.all([
      prisma.service.findMany({ where: { userId: req.params.id }, orderBy: { createdAt: "desc" }, include: { product: { select: { name: true } }, ips: { select: { address: true } } } }),
      prisma.invoice.findMany({ where: { userId: req.params.id }, orderBy: { createdAt: "desc" }, take: 50 }),
      prisma.ticket.findMany({ where: { userId: req.params.id }, orderBy: { lastReplyAt: "desc" }, take: 20, include: { department: true } }),
      prisma.domain.findMany({ where: { userId: req.params.id } }),
      prisma.transaction.findMany({ where: { userId: req.params.id }, orderBy: { createdAt: "desc" }, take: 30 }),
      prisma.loginHistory.findMany({ where: { userId: req.params.id }, orderBy: { createdAt: "desc" }, take: 15 }),
      prisma.creditLedger.findMany({ where: { userId: req.params.id }, orderBy: { createdAt: "desc" }, take: 30 }),
      prisma.user.findUnique({ where: { id: req.params.id }, select: { status: true } }),
      prisma.order.findMany({ where: { userId: req.params.id }, orderBy: { createdAt: "desc" }, take: 50, select: { id: true, number: true, status: true, total: true, currency: true, createdAt: true } }),
    ]);
    res.json({ client: { ...user, status: notesUser?.status }, services, invoices, tickets, domains, transactions, logins, ledger, orders });
  }),
);

adminCore.post(
  "/clients",
  requireStaff("clients.manage"),
  ah(async (req, res) => {
    const b = parse(profileSchema.extend({ email: z.string().email().toLowerCase(), password: z.string().min(8).optional(), sendWelcome: z.boolean().default(true), currency: z.string().length(3).toUpperCase().optional() }), req.body);
    if (b.currency) await requireCurrency(b.currency);
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
        profile: { create: { companyName: b.companyName, gstin: b.gstin, pan: b.pan, address1: b.address1, address2: b.address2, city: b.city, state: b.state, stateCode: resolveStateCode(b.country, b.state, b.gstin, b.stateCode), country: b.country, postcode: b.postcode, currency: b.currency ?? (b.country === "IN" ? "INR" : "USD") } },
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
    const b = parse(profileSchema.partial().extend({ email: z.string().email().toLowerCase().optional(), status: z.enum(["ACTIVE", "INACTIVE", "CLOSED"]).optional(), notes: z.string().max(5000).optional(), currency: z.string().length(3).toUpperCase().optional() }), req.body);
    const { email, status, firstName, lastName, phone, notes, currency, ...profile } = b;
    const current = await prisma.clientProfile.findUnique({ where: { userId: req.params.id } });
    if (currency && currency !== current?.currency) {
      // switching currency mid-life would mix rupees and dollars on one account
      await requireCurrency(currency);
      const [unpaid, live] = await Promise.all([
        prisma.invoice.count({ where: { userId: req.params.id, status: "UNPAID" } }),
        prisma.service.count({ where: { userId: req.params.id, status: { in: ["PENDING", "PROVISIONING", "ACTIVE", "SUSPENDED"] } } }),
      ]);
      if (unpaid || live || (current?.creditBalance ?? 0) !== 0)
        throw badRequest("Currency can only be changed when the client has no unpaid invoices, no active services and a zero credit balance");
      (profile as Record<string, unknown>).currency = currency;
    }
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
    const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
    const where: Prisma.OrderWhereInput = {
      ...(req.query.status ? { status: req.query.status as OrderStatus } : {}),
      ...(q ? { OR: [{ number: { contains: q, mode: "insensitive" } }, { user: { email: { contains: q, mode: "insensitive" } } }, { services: { some: { hostname: { contains: q, mode: "insensitive" } } } }] } : {}),
    };
    const [rows, total] = await Promise.all([
      prisma.order.findMany({ where, orderBy: { createdAt: "desc" }, skip, take, include: { user: { select: { id: true, firstName: true, lastName: true, email: true } }, invoice: { select: { id: true, status: true, total: true } }, services: { select: { id: true, hostname: true, status: true, product: { select: { name: true } } } }, domains: { select: { name: true } } } }),
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
      if (s.product.provisioner === "PROXMOX" || s.product.provisioner === "VIRTUALIZOR" || s.product.provisioner === "CPANEL") {
        await prisma.service.update({ where: { id: s.id }, data: { status: "PROVISIONING" } });
        await enqueueProvision({ serviceId: s.id, action: "create", actorId: req.user!.id });
      } else await prisma.service.update({ where: { id: s.id }, data: { status: "ACTIVE" } });
    }
    // Active once delivered — automated services move it there when their setup finishes
    await syncOrderStatus(o.id);
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
    await prisma.domain.updateMany({ where: { orderId: o.id, status: { in: ["PENDING", "PENDING_TRANSFER"] } }, data: { status: "CANCELLED" } });
    if (fraud) await prisma.order.update({ where: { id: o.id }, data: { status: "FRAUD", statusLocked: true } });
    else await syncOrderStatus(o.id);
    await audit({ actorId: req.user!.id, action: fraud ? "order.fraud" : "order.cancelled", entity: "order", entityId: o.id });
    res.json({ ok: true });
  }),
);

/**
 * Order-level actions — applied to every service in the order, then the order's status follows them:
 *   activate  → set up anything not delivered yet, unsuspend anything suspended
 *   suspend   → suspend every running service
 *   terminate → terminate every delivered service (undelivered ones are cancelled)
 *   cancel    → cancel undelivered services/domains and the unpaid invoice (optionally terminate delivered ones)
 *   set       → pin the status label by hand (automatic updates pause) / "AUTO" to follow the services again
 */
adminCore.post(
  "/orders/:id/status",
  requireStaff("orders.manage"),
  ah(async (req, res) => {
    const b = parse(
      z.object({
        action: z.enum(["activate", "suspend", "terminate", "cancel", "set"]),
        reason: z.string().trim().max(200).optional(),
        terminateDelivered: z.boolean().default(false),
        status: z.enum(["AUTO", "PENDING", "ACTIVE", "SUSPENDED", "TERMINATED", "CANCELLED", "FRAUD"]).optional(),
      }),
      req.body,
    );
    const o = await prisma.order.findUniqueOrThrow({ where: { id: req.params.id }, include: { services: { include: { product: true } }, domains: true, invoice: true } });
    const actorId = req.user!.id;
    const automated = (p: { provisioner: string }) => p.provisioner === "PROXMOX" || p.provisioner === "VIRTUALIZOR" || p.provisioner === "CPANEL";
    let queued = 0;
    const queue = async (serviceId: string, action: ProvisionAction, params: Record<string, unknown> = {}) => {
      await enqueueProvision({ serviceId, action, params, actorId });
      queued++;
    };

    if (b.action === "set") {
      if (!b.status) throw badRequest("Choose the status");
      if (b.status === "AUTO") await prisma.order.update({ where: { id: o.id }, data: { statusLocked: false, status: deriveOrderStatus(o) } });
      else await prisma.order.update({ where: { id: o.id }, data: { status: b.status, statusLocked: true } });
      await audit({ actorId, action: "order.status_set", entity: "order", entityId: o.id, details: { status: b.status } });
      return res.json({ ok: true, status: (await prisma.order.findUniqueOrThrow({ where: { id: o.id } })).status });
    }

    // an action hands control back to the services
    if (o.statusLocked || o.status === "FRAUD") await prisma.order.update({ where: { id: o.id }, data: { statusLocked: false, ...(o.status === "FRAUD" ? { status: "PENDING" } : {}) } });

    for (const s of o.services) {
      if (b.action === "activate") {
        if (s.status === "SUSPENDED") await queue(s.id, "unsuspend");
        else if (s.status === "PENDING" || s.status === "FAILED") {
          if (automated(s.product)) {
            await prisma.service.update({ where: { id: s.id }, data: { status: "PROVISIONING" } });
            const { provisioningQueue } = await import("../../jobs/queues");
            const old = await provisioningQueue().getJob(`create-${s.id}`);
            if (old && ["failed", "completed"].includes(await old.getState())) await old.remove();
            await queue(s.id, "create");
          } else await prisma.service.update({ where: { id: s.id }, data: { status: "ACTIVE" } });
        }
      } else if (b.action === "suspend") {
        if (s.status === "ACTIVE") await queue(s.id, "suspend", { reason: b.reason || "Suspended by administrator" });
      } else if (b.action === "terminate") {
        if (s.status === "ACTIVE" || s.status === "SUSPENDED") await queue(s.id, "terminate");
        else if (["PENDING", "FAILED", "PROVISIONING"].includes(s.status)) await prisma.service.update({ where: { id: s.id }, data: { status: "CANCELLED" } });
      } else if (b.action === "cancel") {
        if (["PENDING", "FAILED"].includes(s.status)) await prisma.service.update({ where: { id: s.id }, data: { status: "CANCELLED" } });
        else if (b.terminateDelivered && (s.status === "ACTIVE" || s.status === "SUSPENDED")) await queue(s.id, "terminate");
      }
    }
    if (b.action === "cancel" || b.action === "terminate") {
      await prisma.domain.updateMany({ where: { orderId: o.id, status: { in: ["PENDING", "PENDING_TRANSFER"] } }, data: { status: "CANCELLED" } });
      if (o.invoice?.status === "UNPAID" && o.invoice.amountPaid === 0) await cancelInvoice(o.invoice.id, b.action === "cancel" ? "Order cancelled" : "Order terminated");
      await releaseOrderReservations(o.id);
    }
    await syncOrderStatus(o.id);
    const status = (await prisma.order.findUniqueOrThrow({ where: { id: o.id } })).status;
    await audit({ actorId, action: `order.${b.action}`, entity: "order", entityId: o.id, details: { queued, reason: b.reason, terminateDelivered: b.terminateDelivered } });
    res.json({ ok: true, status, queued });
  }),
);

/** Changing the OS only makes sense before the VM exists — afterwards it's a reinstall. */
async function checkOsChange(serviceId: string, osTemplateId: string | null) {
  const svc = await prisma.service.findUniqueOrThrow({ where: { id: serviceId }, include: { product: true } });
  if (svc.osTemplateId === osTemplateId) return;
  if (svc.remoteId && ["ACTIVE", "SUSPENDED"].includes(svc.status)) throw badRequest("This server is already built — use Reinstall to change its operating system");
  if (!osTemplateId) return;
  const os = await prisma.osTemplate.findUnique({ where: { id: osTemplateId } });
  if (!os) throw badRequest("Unknown OS template");
  if (svc.product.provisioner === "VIRTUALIZOR" && !os.virtualizorOsId) throw badRequest(`"${os.name}" has no Virtualizor OS id — pick a template synced from Virtualizor`);
  if (svc.product.provisioner === "PROXMOX" && !os.proxmoxKvmVmid && !os.proxmoxLxcVolid) throw badRequest(`"${os.name}" has no Proxmox template configured`);
}

adminCore.get(
  "/orders/:id",
  requireStaff("orders.view"),
  ah(async (req, res) => {
    const o = await prisma.order.findFirst({
      where: { OR: [{ id: req.params.id }, { number: req.params.id }] },
      include: {
        user: { select: { id: true, email: true, firstName: true, lastName: true, phone: true, createdAt: true, profile: { select: { companyName: true, city: true, state: true, country: true, gstin: true, currency: true } }, _count: { select: { orders: true, services: true } } } },
        invoice: { include: { items: true, transactions: { orderBy: { createdAt: "asc" } } } },
        services: {
          include: {
            product: { select: { id: true, name: true, provisioner: true, type: true, cpuCores: true, ramMb: true, diskGb: true, moduleConfig: true, servers: { select: { serverId: true } }, osTemplates: { include: { osTemplate: true } } } },
            osTemplate: true,
            server: { select: { id: true, name: true, type: true } },
            ips: { select: { address: true, isPrimary: true } },
            logs: { orderBy: { createdAt: "desc" }, take: 3 },
          },
        },
        domains: true,
      },
    });
    if (!o) throw notFound("Order not found");
    const reseller = o.resellerId ? await prisma.reseller.findUnique({ where: { id: o.resellerId }, select: { brandName: true } }) : null;
    res.json({
      order: {
        ...o,
        reseller,
        services: o.services.map(({ passwordEnc, product, ...s }) => ({
          ...s,
          hasPassword: !!passwordEnc,
          product: { ...product, osTemplates: product.osTemplates.map((x) => x.osTemplate).filter((t) => t.enabled) },
        })),
      },
    });
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
      include: { user: { select: { id: true, email: true, firstName: true, lastName: true } }, product: { include: { osTemplates: { include: { osTemplate: true } } } }, server: true, osTemplate: true, ips: { include: { subnet: true } }, addons: { include: { addon: true } }, logs: { orderBy: { createdAt: "desc" }, take: 50 }, order: true, reseller: true },
    });
    if (!s) throw notFound();
    const { passwordEnc, server, ...rest } = s;
    const invoices = await prisma.invoice.findMany({ where: { items: { some: { relId: s.id } } }, orderBy: { createdAt: "desc" }, select: { id: true, number: true, proformaNumber: true, status: true, total: true, dueDate: true } });
    // node id → node name (Virtualizor serid / Proxmox node)
    const nodeRow = s.node && server ? await prisma.serverNode.findFirst({ where: { serverId: server.id, OR: [{ externalId: s.node }, { name: s.node }] }, select: { name: true } }) : null;
    res.json({ service: { ...rest, nodeName: nodeRow?.name ?? s.node ?? null, server: server ? { id: server.id, name: server.name, type: server.type, hostname: server.hostname, nameservers: server.nameservers } : null, hasPassword: !!passwordEnc }, invoices });
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

/**
 * Staff places an order for a customer (same checkout as the shop): plan, cycle, OS, hostname and an
 * optional root password; optionally records the payment so setup starts right away.
 */
adminCore.post(
  "/orders",
  requireStaff("orders.manage"),
  ah(async (req, res) => {
    const b = parse(
      cartSchema.extend({
        userId: z.string(),
        notes: z.string().max(1000).optional(),
        markPaid: z.boolean().default(false),
        paymentReference: z.string().trim().max(120).optional(),
      }),
      req.body,
    );
    const u = await prisma.user.findUnique({ where: { id: b.userId } });
    if (!u) throw notFound("Customer not found");
    const { checkout } = await import("../orders/checkout");
    const r = await checkout({ userId: u.id, cart: b, ip: req.ip, notes: b.notes ?? `Placed by staff`, useCredit: false });
    let paid = r.paid;
    if (b.markPaid && !paid && r.total > 0) {
      const inv = await prisma.invoice.findUniqueOrThrow({ where: { id: r.invoiceId } });
      const out = await applyPayment({ invoiceId: inv.id, amount: inv.total - inv.amountPaid, gateway: "manual", gatewayTxnId: b.paymentReference || `staff-${r.orderId}`, description: `Recorded by staff with the order` });
      paid = out.paid;
    }
    await audit({ actorId: req.user!.id, userId: u.id, action: "order.created_by_staff", entity: "order", entityId: r.orderId, details: { items: b.items.map((i) => ({ productId: i.productId, cycle: i.cycle, hostname: i.hostname, osTemplateId: i.osTemplateId, passwordChosen: !!i.rootPassword })), markPaid: b.markPaid } });
    res.status(201).json({ ...r, paid });
  }),
);

/**
 * Build a fresh VPS for a terminated (or cancelled) service — same order, customer, plan and billing
 * record. The old VPS is gone, so its id/node/password are cleared and a normal create is queued.
 */
adminCore.post(
  "/services/:id/recreate",
  requireStaff("services.manage"),
  ah(async (req, res) => {
    const b = parse(
      z.object({
        osTemplateId: z.string().optional(),
        hostname: z.string().trim().toLowerCase().regex(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/, "Invalid hostname").max(253).optional(),
        billing: z.enum(["keep", "restart"]).default("keep"),
        rootPassword: rootPasswordSchema.optional().or(z.literal("").transform(() => undefined)),
      }),
      req.body ?? {},
    );
    const s = await prisma.service.findUniqueOrThrow({ where: { id: req.params.id }, include: { product: true, server: true } });
    if (!["TERMINATED", "CANCELLED"].includes(s.status)) throw conflict(`Only terminated or cancelled services can be created again (this one is ${s.status.toLowerCase()})`);
    if (s.product.provisioner === "MANUAL") throw badRequest("This plan isn't set up automatically");
    // never leave the old VPS running alongside the new one
    if (s.remoteId && s.server?.type === "VIRTUALIZOR") {
      const { virtualizorFor } = await import("../provisioning/provisioner");
      const still = await virtualizorFor(s.server).getVps(s.remoteId).then((r) => Object.keys(r.vs ?? {}).length > 0).catch(() => false);
      if (still) throw conflict(`The old VPS ${s.remoteId} still exists in Virtualizor — delete it there (or terminate again) before creating a new one`);
    }
    if (b.osTemplateId) {
      const os = await prisma.productOs.findFirst({ where: { productId: s.productId, osTemplateId: b.osTemplateId } });
      if (!os) throw badRequest("That OS isn't offered on this plan");
    }
    const cfg = { ...((s.config ?? {}) as Record<string, unknown>) };
    delete cfg.vzExistingVpsIds;
    delete cfg.requestedIpId;
    const { addCycle } = await import("../../lib/money");
    await prisma.service.update({
      where: { id: s.id },
      data: {
        status: "PROVISIONING",
        remoteId: null,
        node: null,
        passwordEnc: b.rootPassword ? encrypt(b.rootPassword) : null,
        terminationDate: null,
        suspendReason: null,
        config: cfg as Prisma.InputJsonValue,
        ...(b.osTemplateId ? { osTemplateId: b.osTemplateId } : {}),
        ...(b.hostname ? { hostname: b.hostname } : {}),
        ...(b.billing === "restart" ? { nextDueDate: addCycle(new Date(), s.billingCycle) } : {}),
      },
    });
    await prisma.provisioningLog.create({
      data: { serviceId: s.id, action: "create", success: true, message: `Creating a new VPS for this order (previous VPS ${s.remoteId ?? "—"} was ${s.status.toLowerCase()}${s.terminationDate ? ` on ${s.terminationDate.toISOString().slice(0, 10)}` : ""})` },
    });
    const { provisioningQueue } = await import("../../jobs/queues");
    const old = await provisioningQueue().getJob(`create-${s.id}`);
    if (old && ["failed", "completed"].includes(await old.getState())) await old.remove();
    await enqueueProvision({ serviceId: s.id, action: "create", actorId: req.user!.id });
    await audit({ actorId: req.user!.id, userId: s.userId, action: "service.recreate", entity: "service", entityId: s.id, details: { previousVpsId: s.remoteId, osTemplateId: b.osTemplateId, hostname: b.hostname, billing: b.billing, passwordChosen: !!b.rootPassword } });
    await syncOrderForService(s.id);
    res.status(202).json({ queued: true });
  }),
);

/** One-time browser console session (noVNC through the panel). */
adminCore.post(
  "/services/:id/console",
  requireStaff("services.manage"),
  ah(async (req, res) => {
    const { openConsole } = await import("../console");
    const r = await openConsole(req.params.id, { userId: req.user!.id, staff: true, ip: req.ip });
    await audit({ actorId: req.user!.id, action: "service.console_opened", entity: "service", entityId: req.params.id });
    res.json(r);
  }),
);

/** Live state (online / offline / suspended / locked) for many services — one call per master. */
adminCore.get(
  "/live-states",
  requireStaff("services.view"),
  ah(async (req, res) => {
    const ids = String(req.query.ids ?? "").split(",").filter(Boolean).slice(0, 200);
    res.json({ states: await liveStates(ids) });
  }),
);

/** Pull IPs, node, hostname and state from Virtualizor into the panel. */
adminCore.post(
  "/services/:id/virtualizor-sync",
  requireStaff("services.manage"),
  ah(async (req, res) => {
    const r = await syncVirtualizorService(req.params.id);
    await audit({ actorId: req.user!.id, action: "service.virtualizor_sync", entity: "service", entityId: req.params.id, details: r });
    res.json(r);
  }),
);

/** Replace the VPS's IPs in Virtualizor with free IPs of its node (or the ones given). */
adminCore.post(
  "/services/:id/replace-ips",
  requireStaff("services.manage"),
  ah(async (req, res) => {
    const b = parse(z.object({ ips: z.array(z.string().ip({ version: "v4" })).max(32).optional() }), req.body ?? {});
    const r = await replaceVirtualizorIps(req.params.id, b.ips);
    await audit({ actorId: req.user!.id, action: "service.ips_replaced", entity: "service", entityId: req.params.id, details: r });
    res.json(r);
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
        hostname: z.string().trim().toLowerCase().max(120).regex(/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/, "Invalid hostname").optional(),
        osTemplateId: z.string().nullable().optional(),
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
    if (b.osTemplateId !== undefined) await checkOsChange(req.params.id, b.osTemplateId);
    await prisma.service.update({ where: { id: req.params.id }, data: { ...data, ...(data.nextDueDate !== undefined ? { nextInvoiceDate: data.nextDueDate } : {}), ...(password ? { passwordEnc: encrypt(password) } : {}) } });
    await audit({ actorId: req.user!.id, action: "service.updated", entity: "service", entityId: req.params.id, details: Object.keys(b) });
    if (b.status) await syncOrderForService(req.params.id);
    res.json({ ok: true });
  }),
);

adminCore.post(
  "/services/:id/action",
  requireStaff("services.manage"),
  ah(async (req, res) => {
    const b = parse(
      z.object({
        action: z.enum(["create", "suspend", "unsuspend", "terminate", "start", "stop", "shutdown", "reboot", "reinstall", "reset_password", "change_package", "sync"]),
        reason: z.string().max(200).optional(),
        package: z.string().max(120).optional(),
        osTemplateId: z.string().optional(),
        notify: z.boolean().optional(),
      }),
      req.body,
    );
    const s = await prisma.service.findUniqueOrThrow({ where: { id: req.params.id } });
    if (b.action === "create" && s.status === "ACTIVE") throw conflict("Service is already active");
    if (b.action === "create") {
      const { provisioningQueue } = await import("../../jobs/queues");
      const old = await provisioningQueue().getJob(`create-${s.id}`);
      const state = old ? await old.getState() : null;
      if (state === "active") {
        const mins = Math.max(1, Math.round((Date.now() - (old!.processedOn ?? Date.now())) / 60_000));
        throw conflict(`Setup is already running for this service (for ${mins} min — Virtualizor can take several minutes to build). It finishes on its own; a run interrupted by a restart is picked up again within a minute.`);
      }
      await prisma.service.update({ where: { id: s.id }, data: { status: "PROVISIONING" } });
      // remove a finished/failed create job so it can be queued again under the same id
      if (old && (state === "failed" || state === "completed")) await old.remove();
    }
    await enqueueProvision({ serviceId: s.id, action: b.action as ProvisionAction, params: { reason: b.reason, osTemplateId: b.osTemplateId, notify: b.notify, package: b.package }, actorId: req.user!.id });
    await audit({ actorId: req.user!.id, userId: s.userId, action: `service.${b.action}`, entity: "service", entityId: s.id, details: b });
    res.status(202).json({ queued: true });
  }),
);

// ───────────── Hosting (cPanel) ─────────────
const loadHostingService = (id: string) => prisma.service.findUniqueOrThrow({ where: { id }, include: { server: true, user: true, product: { include: { servers: { include: { server: true } } } } } });

/** One-click login to the customer's cPanel / webmail / WHM (reseller). */
adminCore.post(
  "/services/:id/cpanel-login",
  requireStaff("services.manage"),
  ah(async (req, res) => {
    const { service } = parse(z.object({ service: z.enum(["cpaneld", "webmaild", "whostmgrd"]).default("cpaneld") }), req.body);
    const s = await loadHostingService(req.params.id);
    if (s.product.provisioner !== "CPANEL") throw badRequest("Not a hosting account");
    const { cpanelLoginUrl } = await import("../provisioning/cpanel-provisioner");
    const url = await cpanelLoginUrl(s, service).catch((e: Error) => {
      throw badRequest(e.message);
    });
    await audit({ actorId: req.user!.id, userId: s.userId, action: "service.cpanel_login", entity: "service", entityId: s.id, details: { service } });
    res.json({ url });
  }),
);

/** Set the cPanel password (applied on the server right away; the new one is stored for the credentials row). */
adminCore.post(
  "/services/:id/hosting-password",
  requireStaff("services.manage"),
  ah(async (req, res) => {
    const { password } = parse(z.object({ password: hostingPasswordSchema }), req.body);
    const s = await loadHostingService(req.params.id);
    if (s.product.provisioner !== "CPANEL") throw badRequest("Not a hosting account");
    const { runProvisionAction } = await import("../provisioning/provisioner");
    await runProvisionAction(s.id, "reset_password", { password }).catch((e: Error) => {
      throw badRequest(`cPanel didn't accept the password: ${e.message.replace(/^WHM passwd: /, "")}`);
    });
    await audit({ actorId: req.user!.id, userId: s.userId, action: "service.password_changed", entity: "service", entityId: s.id });
    res.json({ ok: true });
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
      prisma.invoice.groupBy({ by: ["currency"], where, _sum: { total: true, amountPaid: true, taxTotal: true } }),
    ]);
    // never add rupees to dollars: one total per currency
    const byCurrency = sums.map((g) => ({ currency: g.currency, ...g._sum }));
    res.json({ invoices: rows, total, page, pageSize, sums: byCurrency.find((g) => g.currency === "INR") ?? { total: 0, amountPaid: 0, taxTotal: 0 }, sumsByCurrency: byCurrency });
  }),
);

adminCore.get(
  "/invoices/:id",
  requireStaff("billing.view"),
  ah(async (req, res) => {
    const inv = await prisma.invoice.findUnique({ where: { id: req.params.id }, include: { items: true, transactions: true, creditNotes: true, paymentIntents: true, user: { select: { id: true, email: true, firstName: true, lastName: true } }, order: true } });
    if (!inv) throw notFound();
    const st = await getSettings();
    res.json({ invoice: inv, label: invoiceLabel(inv), company: st.company, bankDetails: st.invoice.bankDetails, footerNote: st.invoice.footerNote, lutArn: st.currency.lutArn });
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
      // everything in INR (foreign invoices at their stored rate); exports = zero-rated supplies for GSTR-1 table 6A
      prisma.$queryRaw<{ month: string; invoices: bigint; taxable: bigint; cgst: bigint; sgst: bigint; igst: bigint; total: bigint; exports: bigint; foreign: bigint }[]>`
        SELECT to_char(date_trunc('month', "paidAt" AT TIME ZONE 'Asia/Kolkata'), 'YYYY-MM') AS month, COUNT(*)::bigint AS invoices,
          ROUND(SUM("taxableAmount" * "exchangeRate"))::bigint AS taxable, ROUND(SUM("cgst" * "exchangeRate"))::bigint AS cgst, ROUND(SUM("sgst" * "exchangeRate"))::bigint AS sgst,
          ROUND(SUM("igst" * "exchangeRate"))::bigint AS igst, ROUND(SUM("total" * "exchangeRate"))::bigint AS total,
          ROUND(SUM(CASE WHEN "taxTotal" = 0 AND "placeOfSupplyCode" = '96' THEN "taxableAmount" * "exchangeRate" ELSE 0 END))::bigint AS exports,
          COUNT(*) FILTER (WHERE "currency" <> 'INR')::bigint AS foreign
        FROM "Invoice" WHERE "status" = 'PAID' AND "isWalletTopup" = false AND "paidAt" BETWEEN ${from} AND ${to}
        GROUP BY 1 ORDER BY 1`,
      prisma.$queryRaw<{ type: string; services: bigint; mrr: bigint }[]>`
        SELECT p."type"::text AS type, COUNT(*)::bigint AS services,
          ROUND(SUM((CASE s."billingCycle" WHEN 'MONTHLY' THEN s."recurringAmount" WHEN 'QUARTERLY' THEN s."recurringAmount"/3.0 WHEN 'SEMIANNUAL' THEN s."recurringAmount"/6.0 WHEN 'ANNUAL' THEN s."recurringAmount"/12.0 WHEN 'BIENNIAL' THEN s."recurringAmount"/24.0 WHEN 'TRIENNIAL' THEN s."recurringAmount"/36.0 ELSE 0 END)
            / CASE WHEN s."currency" = 'INR' OR c."rate" IS NULL OR c."rate" = 0 THEN 1 ELSE c."rate" END))::bigint AS mrr
        FROM "Service" s JOIN "Product" p ON p."id" = s."productId" LEFT JOIN "Currency" c ON c."code" = s."currency" WHERE s."status" IN ('ACTIVE','SUSPENDED') GROUP BY 1 ORDER BY 3 DESC`,
      prisma.$queryRaw<{ month: string; clients: bigint }[]>`
        SELECT to_char(date_trunc('month', "createdAt" AT TIME ZONE 'Asia/Kolkata'), 'YYYY-MM') AS month, COUNT(*)::bigint AS clients
        FROM "User" WHERE "type" = 'CLIENT' AND "createdAt" BETWEEN ${from} AND ${to} GROUP BY 1 ORDER BY 1`,
      prisma.$queryRaw<{ gateway: string; payments: bigint; amount: bigint }[]>`
        SELECT t."gateway", COUNT(*)::bigint AS payments, ROUND(SUM(t."amount" * COALESCE(i."exchangeRate", 1)))::bigint AS amount FROM "Transaction" t LEFT JOIN "Invoice" i ON i."id" = t."invoiceId"
        WHERE t."type" = 'PAYMENT' AND t."createdAt" BETWEEN ${from} AND ${to} GROUP BY 1 ORDER BY 3 DESC`,
    ]);
    const num = <T extends Record<string, unknown>>(rows: T[]) => rows.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, typeof v === "bigint" ? Number(v) : v])));
    res.json({ gst: num(gst), byType: num(byType), newClients: num(newClients), gateways: num(gateways) });
  }),
);

// ───────────── Provisioning status ─────────────
adminCore.get(
  "/services/:id/provisioning",
  requireStaff("services.view"),
  ah(async (req, res) => {
    res.json(await provisioningProgress(req.params.id, "admin"));
  }),
);

/** Everything being set up right now, waiting, failed, or finished in the last 24 hours. */
adminCore.get(
  "/provisioning",
  requireStaff("services.view"),
  ah(async (_req, res) => {
    const since = new Date(Date.now() - 24 * 3600_000);
    const rows = await prisma.service.findMany({
      where: {
        product: { provisioner: { in: ["PROXMOX", "VIRTUALIZOR"] } },
        OR: [{ status: { in: ["PENDING", "PROVISIONING", "FAILED"] } }, { status: "ACTIVE", logs: { some: { action: "create", createdAt: { gte: since } } } }],
      },
      orderBy: { updatedAt: "desc" },
      take: 100,
      select: { id: true, hostname: true, status: true, updatedAt: true, product: { select: { name: true } }, user: { select: { email: true, firstName: true, lastName: true } }, order: { select: { id: true, number: true } } },
    });
    const items = await Promise.all(rows.map(async (r) => ({ ...r, progress: await provisioningProgress(r.id, "admin") })));
    const count = (f: (x: (typeof items)[number]) => boolean) => items.filter(f).length;
    res.json({
      items,
      summary: {
        inProgress: count((x) => x.progress.inProgress),
        failed: count((x) => x.status === "FAILED" || x.progress.stuck),
        waitingPayment: count((x) => x.progress.steps.find((s) => s.key === "payment")?.state === "current"),
        doneToday: count((x) => x.status === "ACTIVE"),
      },
    });
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
