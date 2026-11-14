import { readSyncAll, startSyncAll } from "../provisioning/virtualizor-sync-all";
import { getSettings } from "../../lib/settings";
import { inrPerUnit, listCurrencies, requireCurrency } from "../../lib/currency";
import { istDayStart, addDays } from "../../lib/money";
import { Router } from "express";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { prisma, Prisma, InvoiceStatus, ServiceStatus, BillingCycle, OrderStatus } from "../../db";
import { ah, badRequest, conflict, notFound, pageParams, parse } from "../../lib/http";
import { audit } from "../../lib/audit";
import { cartSchema, rootPasswordSchema, hostingPasswordSchema } from "../orders/pricing";
import { decrypt, encrypt, randomToken } from "../../lib/crypto";
import { requireStaff, hasPerm } from "../../middleware/auth";
import { enqueueProvision, type ProvisionAction } from "../../jobs/queues";
import { deriveOrderStatus, syncOrderForService, syncOrderStatus } from "../orders/status";
import { clientWhere, invoiceWhere, orderWhere, phoneDigits, serviceWhere } from "./search";
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
    const segment = typeof req.query.segment === "string" ? req.query.segment : "";
    const monthAgo = addDays(new Date(), -30);
    // segments: the tabs above the customer list
    const SEGMENTS: Record<string, Prisma.UserWhereInput> = {
      active: { status: "ACTIVE", services: { some: { status: { in: ["ACTIVE", "SUSPENDED"] } } } },
      unpaid: { invoices: { some: { status: "UNPAID", isWalletTopup: false } } },
      overdue: { invoices: { some: { status: "UNPAID", isWalletTopup: false, dueDate: { lt: istDayStart() } } } },
      new: { createdAt: { gte: monthAgo } },
      noservices: { services: { none: {} } },
      inactive: { status: { in: ["INACTIVE", "CLOSED"] } },
    };
    const base: Prisma.UserWhereInput = { type: "CLIENT", ...(q ? clientWhere(q) : {}) };
    const where: Prisma.UserWhereInput = {
      ...base,
      ...(req.query.status ? { status: req.query.status as "ACTIVE" } : {}),
      ...(SEGMENTS[segment] ? { AND: [SEGMENTS[segment]] } : {}),
    };
    const [rows, total, ...segCounts] = await Promise.all([
      prisma.user.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip,
        take,
        select: { id: true, email: true, firstName: true, lastName: true, phone: true, status: true, createdAt: true, emailVerifiedAt: true, ownerResellerId: true, profile: { select: { companyName: true, gstin: true, city: true, state: true, country: true, creditBalance: true, currency: true } }, _count: { select: { services: true, tickets: { where: { status: { not: "CLOSED" } } } } } },
      }),
      prisma.user.count({ where }),
      prisma.user.count({ where: base }),
      ...Object.values(SEGMENTS).map((w) => prisma.user.count({ where: { ...base, AND: [w] } })),
    ]);
    const counts = Object.fromEntries([["all", segCounts[0]], ...Object.keys(SEGMENTS).map((k, i) => [k, segCounts[i + 1]])]);
    // per-row money: what each customer owes, has paid, and how many services are live
    const ids = rows.map((r) => r.id);
    const [due, paid, live, lastLogin, cur] = await Promise.all([
      prisma.invoice.groupBy({ by: ["userId", "currency"], where: { userId: { in: ids }, status: "UNPAID", isWalletTopup: false }, _sum: { total: true, amountPaid: true }, _min: { dueDate: true } }),
      prisma.invoice.groupBy({ by: ["userId", "currency"], where: { userId: { in: ids }, status: "PAID", isWalletTopup: false }, _sum: { total: true } }),
      prisma.service.groupBy({ by: ["userId"], where: { userId: { in: ids }, status: { in: ["ACTIVE", "SUSPENDED"] } }, _count: { _all: true } }),
      prisma.loginHistory.findMany({ where: { userId: { in: ids }, success: true }, orderBy: { createdAt: "desc" }, distinct: ["userId"], select: { userId: true, createdAt: true } }),
      listCurrencies(),
    ]);
    const inr = (amount: number, code: string) => Math.round(amount * inrPerUnit(cur.find((c) => c.code === code) ?? { code, rate: 1 }));
    const today = istDayStart();
    const clients = rows.map((r) => {
      const d = due.filter((x) => x.userId === r.id);
      return {
        ...r,
        stats: {
          dueInr: d.reduce((a, x) => a + inr((x._sum.total ?? 0) - (x._sum.amountPaid ?? 0), x.currency), 0),
          overdue: d.some((x) => x._min.dueDate && x._min.dueDate < today),
          paidInr: paid.filter((x) => x.userId === r.id).reduce((a, x) => a + inr(x._sum.total ?? 0, x.currency), 0),
          liveServices: live.find((x) => x.userId === r.id)?._count._all ?? 0,
          lastLoginAt: lastLogin.find((x) => x.userId === r.id)?.createdAt ?? null,
        },
      };
    });
    res.json({ clients, total, page, pageSize, counts });
  }),
);

adminCore.get(
  "/clients/:id",
  requireStaff("clients.view"),
  ah(async (req, res) => {
    const user = await publicUser(req.params.id).catch(() => null);
    if (!user || user.type !== "CLIENT") throw notFound("Client not found");
    const [services, invoices, tickets, domains, transactions, logins, ledger, notesUser, orders] = await Promise.all([
      prisma.service.findMany({ where: { userId: req.params.id }, orderBy: { createdAt: "desc" }, include: { product: { select: { name: true, type: true, provisioner: true } }, ips: { select: { address: true } } } }),
      prisma.invoice.findMany({ where: { userId: req.params.id }, orderBy: { createdAt: "desc" }, take: 50 }),
      prisma.ticket.findMany({ where: { userId: req.params.id }, orderBy: { lastReplyAt: "desc" }, take: 20, include: { department: true } }),
      prisma.domain.findMany({ where: { userId: req.params.id } }),
      prisma.transaction.findMany({ where: { userId: req.params.id }, orderBy: { createdAt: "desc" }, take: 30 }),
      prisma.loginHistory.findMany({ where: { userId: req.params.id }, orderBy: { createdAt: "desc" }, take: 15 }),
      prisma.creditLedger.findMany({ where: { userId: req.params.id }, orderBy: { createdAt: "desc" }, take: 30 }),
      prisma.user.findUnique({ where: { id: req.params.id }, select: { status: true } }),
      prisma.order.findMany({ where: { userId: req.params.id }, orderBy: { createdAt: "desc" }, take: 50, select: { id: true, number: true, status: true, total: true, currency: true, createdAt: true } }),
    ]);
    const { withInvoiceLinks } = await import("../billing/invoice-links");
    res.json({ client: { ...user, status: notesUser?.status }, services, invoices: await withInvoiceLinks(invoices, { includeStatus: true }), tickets, domains, transactions, logins, ledger, orders });
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
    const b = parse(
      z.object({
        amount: z.number().int().refine((v) => v !== 0, "Enter an amount").optional(),
        /** take the whole balance off */
        removeAll: z.boolean().optional(),
        description: z.string().trim().min(3, "Add a short reason (at least 3 characters)").max(200),
      }),
      req.body,
    );
    const prof = await prisma.clientProfile.findUnique({ where: { userId: req.params.id }, select: { creditBalance: true, currency: true } });
    if (!prof) throw notFound("Client not found");
    const amount = b.removeAll ? -prof.creditBalance : b.amount;
    if (!amount) throw badRequest(b.removeAll ? "There's no credit to remove" : "Enter an amount");
    if (amount < 0 && -amount > prof.creditBalance)
      throw badRequest(`Only ${(prof.creditBalance / 100).toFixed(2)} ${prof.currency} of credit is available — you can remove at most that`);
    const balance = await adjustCredit(prisma, { userId: req.params.id, amount, description: `${b.description} (staff)`, refType: "staff", refId: req.user!.id });
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

// ───────────── Search everything ─────────────
adminCore.get(
  "/search",
  requireStaff(),
  ah(async (req, res) => {
    const q = String(req.query.q ?? "").trim().slice(0, 120);
    if (q.length < 2) return res.json({ q, clients: [], services: [], orders: [], invoices: [], domains: [], tickets: [], transactions: [] });
    const take = Math.min(25, Number(req.query.take) || 6);
    const can = (perm: string) => hasPerm(req.user, perm);
    const none = Promise.resolve([] as never[]);
    const ticketNo = /^#?[\w-]{3,20}$/.test(q) ? q.replace(/^#/, "") : null;
    const [clients, services, orders, invoices, domains, tickets, transactions] = await Promise.all([
      can("clients.view") ? prisma.user.findMany({ where: { type: "CLIENT", ...clientWhere(q) }, take, orderBy: { createdAt: "desc" }, select: { id: true, email: true, firstName: true, lastName: true, phone: true, status: true, profile: { select: { companyName: true, gstin: true, city: true } } } }) : none,
      can("services.view") ? prisma.service.findMany({ where: serviceWhere(q), take, orderBy: { createdAt: "desc" }, select: { id: true, hostname: true, status: true, remoteId: true, username: true, product: { select: { name: true, provisioner: true } }, ips: { select: { address: true } }, user: { select: { id: true, email: true, firstName: true, lastName: true } } } }) : none,
      can("orders.view") ? prisma.order.findMany({ where: orderWhere(q), take, orderBy: { createdAt: "desc" }, select: { id: true, number: true, status: true, total: true, currency: true, createdAt: true, user: { select: { email: true, firstName: true, lastName: true } } } }) : none,
      can("billing.view") ? prisma.invoice.findMany({ where: invoiceWhere(q), take, orderBy: { createdAt: "desc" }, select: { id: true, number: true, proformaNumber: true, status: true, total: true, currency: true, user: { select: { email: true, firstName: true, lastName: true } } } }) : none,
      can("clients.view") ? prisma.domain.findMany({ where: { name: { contains: q.toLowerCase(), mode: "insensitive" } }, take, select: { id: true, name: true, status: true, expiryDate: true, user: { select: { id: true, email: true } } } }) : none,
      can("tickets.view") ? prisma.ticket.findMany({ where: { OR: [...(ticketNo !== null ? [{ number: { equals: ticketNo, mode: "insensitive" as const } }] : []), { subject: { contains: q, mode: "insensitive" } }, { user: { email: { contains: q, mode: "insensitive" } } }] }, take, orderBy: { lastReplyAt: "desc" }, select: { id: true, number: true, subject: true, status: true, user: { select: { email: true } } } }) : none,
      can("billing.view") ? prisma.transaction.findMany({ where: { gatewayTxnId: { contains: q } }, take, orderBy: { createdAt: "desc" }, select: { id: true, gateway: true, gatewayTxnId: true, type: true, amount: true, currency: true, invoiceId: true, createdAt: true } }) : none,
    ]);
    res.json({ q, phone: phoneDigits(q), clients, services, orders, invoices, domains, tickets, transactions });
  }),
);

// ───────────── Orders ─────────────
adminCore.get(
  "/orders",
  requireStaff("orders.view"),
  ah(async (req, res) => {
    const { skip, take, page, pageSize } = pageParams(req.query);
    const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
    const period = typeof req.query.period === "string" ? req.query.period : "";
    const payment = typeof req.query.payment === "string" ? req.query.payment : "";
    const since = period === "today" ? istDayStart() : period === "7d" ? addDays(istDayStart(), -6) : period === "30d" ? addDays(istDayStart(), -29) : null;
    // filters other than status (the status tabs show counts within them)
    const base: Prisma.OrderWhereInput = {
      ...(q ? orderWhere(q) : {}),
      ...(since ? { createdAt: { gte: since } } : {}),
      ...(payment === "paid" ? { invoice: { status: "PAID" } } : payment === "unpaid" ? { invoice: { status: "UNPAID" } } : {}),
      ...(typeof req.query.userId === "string" ? { userId: req.query.userId } : {}),
    };
    const where: Prisma.OrderWhereInput = { ...base, ...(req.query.status ? { status: req.query.status as OrderStatus } : {}) };
    const today = istDayStart();
    const monthStart = new Date(today.getTime() - (new Date(today.getTime() + 330 * 60_000).getUTCDate() - 1) * 86400_000);
    const [rows, total, byStatus, cur, todayOrders, monthOrders, awaitingPayment, toAccept] = await Promise.all([
      prisma.order.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip,
        take,
        include: {
          user: { select: { id: true, firstName: true, lastName: true, email: true, phone: true, profile: { select: { companyName: true } } } },
          invoice: { select: { id: true, status: true, total: true, amountPaid: true, dueDate: true, paidAt: true } },
          services: { select: { id: true, hostname: true, status: true, billingCycle: true, product: { select: { name: true, type: true, provisioner: true } }, ips: { select: { address: true }, take: 1 } } },
          domains: { select: { id: true, name: true, action: true, status: true } },
        },
      }),
      prisma.order.count({ where }),
      prisma.order.groupBy({ by: ["status"], where: base, _count: { _all: true } }),
      listCurrencies(),
      prisma.order.findMany({ where: { createdAt: { gte: today }, status: { notIn: ["CANCELLED", "FRAUD"] } }, select: { total: true, currency: true } }),
      prisma.order.findMany({ where: { createdAt: { gte: monthStart }, status: { notIn: ["CANCELLED", "FRAUD"] }, invoice: { status: "PAID" } }, select: { total: true, currency: true } }),
      prisma.order.count({ where: { status: "PENDING", invoice: { status: "UNPAID" } } }),
      prisma.order.count({ where: { status: "PENDING", invoice: { status: "PAID" } } }),
    ]);
    const inr = (amount: number, code: string) => Math.round(amount * inrPerUnit(cur.find((c) => c.code === code) ?? { code, rate: 1 }));
    const resellerIds = [...new Set(rows.map((o) => o.resellerId).filter(Boolean))] as string[];
    const brands = resellerIds.length ? await prisma.reseller.findMany({ where: { id: { in: resellerIds } }, select: { id: true, brandName: true } }) : [];
    const counts: Record<string, number> = { all: byStatus.reduce((a, x) => a + x._count._all, 0) };
    for (const x of byStatus) counts[x.status] = x._count._all;
    res.json({
      orders: rows.map((o) => ({ ...o, resellerBrand: brands.find((b) => b.id === o.resellerId)?.brandName ?? null })),
      total,
      page,
      pageSize,
      counts,
      summary: {
        todayCount: todayOrders.length,
        todayInr: todayOrders.reduce((a, o) => a + inr(o.total, o.currency), 0),
        monthPaidInr: monthOrders.reduce((a, o) => a + inr(o.total, o.currency), 0),
        monthPaidCount: monthOrders.length,
        awaitingPayment,
        toAccept,
      },
    });
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
        if (s.status === "ACTIVE" || s.status === "SUSPENDED") await queue(s.id, "terminate", { reason: b.reason || "Terminated by administrator" });
        else if (["PENDING", "FAILED", "PROVISIONING"].includes(s.status)) await prisma.service.update({ where: { id: s.id }, data: { status: "CANCELLED", terminationDate: new Date(), terminationReason: b.reason || "Order terminated before setup" } });
      } else if (b.action === "cancel") {
        if (["PENDING", "FAILED"].includes(s.status)) await prisma.service.update({ where: { id: s.id }, data: { status: "CANCELLED", terminationDate: new Date(), terminationReason: b.reason || "Order cancelled" } });
        else if (b.terminateDelivered && (s.status === "ACTIVE" || s.status === "SUSPENDED")) await queue(s.id, "terminate", { reason: b.reason || "Order cancelled" });
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
        invoice: { include: { items: true, transactions: { orderBy: [{ createdAt: "desc" }, { id: "desc" }] } } },
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
    // what staff and the system did to this order, its invoice and its services (for the timeline)
    const ids = [o.id, ...(o.invoiceId ? [o.invoiceId] : []), ...o.services.map((x) => x.id)];
    const [acts, provLogs] = await Promise.all([
      prisma.activityLog.findMany({ where: { entityId: { in: ids } }, orderBy: { createdAt: "desc" }, take: 40, select: { id: true, actorId: true, action: true, entity: true, entityId: true, createdAt: true } }),
      prisma.provisioningLog.findMany({ where: { serviceId: { in: o.services.map((x) => x.id) }, action: { in: ["create", "suspend", "unsuspend", "terminate"] } }, orderBy: { createdAt: "desc" }, take: 30, select: { id: true, serviceId: true, action: true, success: true, message: true, createdAt: true } }),
    ]);
    const actorIds = [...new Set(acts.map((a) => a.actorId).filter(Boolean))] as string[];
    const actors = actorIds.length ? await prisma.user.findMany({ where: { id: { in: actorIds } }, select: { id: true, firstName: true, lastName: true, type: true } }) : [];
    const history = [
      ...acts.map((a) => {
        const who = actors.find((x) => x.id === a.actorId);
        return { id: a.id, at: a.createdAt, kind: "activity", action: a.action, entity: a.entity, entityId: a.entityId, by: who ? `${who.firstName ?? ""} ${who.lastName ?? ""}`.trim() || (who.type === "STAFF" ? "Staff" : "Customer") : null };
      }),
      ...provLogs.map((l) => ({ id: l.id, at: l.createdAt, kind: "provision", action: l.action, success: l.success, message: l.message, serviceId: l.serviceId })),
    ];
    res.json({
      history,
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
      ...(q ? serviceWhere(q) : {}),
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
    // failed setups: say why right in the list
    const failedIds = rows.filter((r) => r.status === "FAILED").map((r) => r.id);
    const why = new Map<string, { title: string; cause: string }>();
    if (failedIds.length) {
      const { explainProvisionError } = await import("../provisioning/explain");
      const fails = await prisma.provisioningLog.findMany({ where: { serviceId: { in: failedIds }, success: false }, orderBy: { createdAt: "desc" }, select: { serviceId: true, message: true } });
      for (const r of rows.filter((x) => x.status === "FAILED")) {
        const f = fails.find((l) => l.serviceId === r.id);
        const x = explainProvisionError(f?.message, { provisioner: r.product.provisioner, serverName: r.server?.name });
        why.set(r.id, { title: x.title, cause: x.cause });
      }
    }
    res.json({ services: rows.map(({ passwordEnc, ...s }) => ({ ...s, hasPassword: !!passwordEnc, failure: why.get(s.id) ?? null })), total, page, pageSize });
  }),
);

adminCore.get(
  "/services/:id",
  requireStaff("services.view"),
  ah(async (req, res) => {
    const s = await prisma.service.findUnique({
      where: { id: req.params.id },
      include: { user: { select: { id: true, email: true, firstName: true, lastName: true, phone: true, createdAt: true, status: true, profile: { select: { companyName: true, gstin: true, city: true, state: true, country: true, creditBalance: true, currency: true } } } }, product: { include: { osTemplates: { include: { osTemplate: true } }, group: { select: { name: true } } } }, server: true, osTemplate: true, ips: { include: { subnet: true } }, addons: { include: { addon: true } }, logs: { orderBy: { createdAt: "desc" }, take: 50 }, order: true, reseller: true, tickets: { orderBy: { createdAt: "desc" }, take: 10, select: { id: true, number: true, subject: true, status: true, createdAt: true } } },
    });
    if (!s) throw notFound();
    const { passwordEnc, server, ...rest } = s;
    const invoices = await prisma.invoice.findMany({ where: { items: { some: { relId: s.id } } }, orderBy: { createdAt: "desc" }, select: { id: true, number: true, proformaNumber: true, status: true, total: true, amountPaid: true, currency: true, dueDate: true, paidAt: true, createdAt: true } });
    // node id → node name (Virtualizor serid / Proxmox node)
    const nodeRow = s.node && server ? await prisma.serverNode.findFirst({ where: { serverId: server.id, OR: [{ externalId: s.node }, { name: s.node }] }, select: { name: true } }) : null;
    // every failed step explained in plain words (setup, suspend, reinstall, …)
    const { explainProvisionError } = await import("../provisioning/explain");
    const ctx = { provisioner: s.product.provisioner, productId: s.product.id, productName: s.product.name, serverId: server?.id, serverName: server?.name, serviceId: s.id };
    const logs = rest.logs.map((l) => (l.success ? l : { ...l, explain: explainProvisionError(l.message, ctx) }));
    const lastFail = logs.find((l) => !l.success) as (typeof logs)[number] & { explain?: ReturnType<typeof explainProvisionError> };
    const failure = s.status === "FAILED" ? lastFail?.explain ?? explainProvisionError(null, ctx) : null;
    res.json({ service: { ...rest, logs, failure, nodeName: nodeRow?.name ?? s.node ?? null, server: server ? { id: server.id, name: server.name, type: server.type, hostname: server.hostname, nameservers: server.nameservers } : null, hasPassword: !!passwordEnc }, invoices });
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
    const r = await checkout({ userId: u.id, cart: b, ip: req.ip, notes: b.notes ?? `Placed by staff`, useCredit: false, staff: true });
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
      const still = await virtualizorFor(s.server).findVps(s.remoteId).then((v) => !!v).catch(() => false);
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

/** Sync every Virtualizor service at once (runs in the background; poll GET for progress). */
adminCore.post(
  "/virtualizor/sync-all",
  requireStaff("services.manage"),
  ah(async (req, res) => {
    const st = await startSyncAll(req.user!.id);
    await audit({ actorId: req.user!.id, action: "service.virtualizor_sync_all", entity: "service", entityId: "*", details: { startedAt: st.startedAt } });
    res.status(202).json(st);
  }),
);
adminCore.get(
  "/virtualizor/sync-all",
  requireStaff("services.manage"),
  ah(async (_req, res) => {
    res.json((await readSyncAll()) ?? { status: "never" });
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
        terminationDate: z.coerce.date().nullable().optional(),
        terminationReason: z.string().trim().max(300).nullable().optional(),
        /** colocation: where the customer's equipment sits (staff-maintained, shown to the customer) */
        colo: z
          .object({ datacenter: z.string().trim().max(120), rack: z.string().trim().max(60), position: z.string().trim().max(60), pdu: z.string().trim().max(120), switchPort: z.string().trim().max(120), crossConnect: z.string().trim().max(200), access: z.string().trim().max(500) })
          .partial()
          .optional(),
        equipment: z
          .object({ device: z.string().trim().max(120), units: z.number().int().min(0).max(48).nullable(), powerW: z.number().int().min(0).max(20000).nullable(), psus: z.number().int().min(0).max(4).nullable(), serial: z.string().trim().max(80), notes: z.string().trim().max(500) })
          .partial()
          .optional(),
      }),
      req.body,
    );
    const { password, colo, equipment, ...data } = b;
    if (colo || equipment) {
      const cur = await prisma.service.findUniqueOrThrow({ where: { id: req.params.id }, select: { config: true } });
      const cfg = { ...((cur.config ?? {}) as Record<string, unknown>) };
      const clean = (o: Record<string, unknown>) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== "" && v !== null && v !== undefined));
      if (colo) cfg.colo = clean({ ...((cfg.colo ?? {}) as object), ...colo });
      if (equipment) cfg.equipment = clean({ ...((cfg.equipment ?? {}) as object), ...equipment });
      (data as Record<string, unknown>).config = cfg as Prisma.InputJsonValue;
    }
    if (data.terminationReason === "") data.terminationReason = null;
    if (b.osTemplateId !== undefined) await checkOsChange(req.params.id, b.osTemplateId);
    const before = b.status ? await prisma.service.findUnique({ where: { id: req.params.id }, select: { status: true } }) : null;
    await prisma.service.update({ where: { id: req.params.id }, data: { ...data, ...((b.status === "TERMINATED" || b.status === "CANCELLED") && before?.status !== b.status && b.terminationDate === undefined ? { terminationDate: new Date() } : {}), ...(data.nextDueDate !== undefined ? { nextInvoiceDate: data.nextDueDate } : {}), ...(password ? { passwordEnc: encrypt(password) } : {}) } });
    await audit({ actorId: req.user!.id, action: "service.updated", entity: "service", entityId: req.params.id, details: Object.keys(b) });
    if (b.status) await syncOrderForService(req.params.id);
    // marked terminated / cancelled by hand → its unpaid invoices go too
    let invoices = null;
    if ((b.status === "TERMINATED" || b.status === "CANCELLED") && before && before.status !== b.status) {
      const { cancelServiceInvoices } = await import("../billing/termination");
      invoices = await cancelServiceInvoices(req.params.id, { actorId: req.user!.id });
    }
    res.json({ ok: true, invoices });
  }),
);

/**
 * Make an ended (terminated / cancelled) or stuck service active again by hand — e.g. colocation and
 * other manually delivered services, or a termination done by mistake. Nothing is created on any server.
 */
adminCore.post(
  "/services/:id/reactivate",
  requireStaff("services.manage"),
  ah(async (req, res) => {
    const b = parse(
      z.object({
        nextDueDate: z.coerce.date().nullable().optional(),
        /** bring back the unpaid invoices that were cancelled when it was terminated */
        restoreInvoices: z.boolean().default(true),
        notify: z.boolean().default(false),
        note: z.string().trim().max(300).optional(),
      }),
      req.body ?? {},
    );
    const s = await prisma.service.findUniqueOrThrow({ where: { id: req.params.id }, include: { product: true, user: { select: { email: true, firstName: true, ownerResellerId: true } } } });
    if (!["TERMINATED", "CANCELLED", "FAILED", "PENDING"].includes(s.status)) throw conflict(`This service is ${s.status.toLowerCase()} — ${s.status === "SUSPENDED" ? "use Unsuspend" : "it's already active"}`);
    const restored: string[] = [];
    if (b.restoreInvoices && ["TERMINATED", "CANCELLED"].includes(s.status)) {
      const logs = await prisma.activityLog.findMany({ where: { action: "invoice.cancelled_on_termination", details: { path: ["serviceId"], equals: s.id } }, select: { entityId: true } });
      for (const l of logs) {
        if (!l.entityId) continue;
        const r = await prisma.invoice.updateMany({ where: { id: l.entityId, status: "CANCELLED", amountPaid: 0 }, data: { status: "UNPAID" } });
        if (r.count) restored.push(l.entityId);
      }
    }
    await prisma.service.update({
      where: { id: s.id },
      data: {
        status: "ACTIVE",
        terminationDate: null,
        terminationReason: null,
        suspendReason: null,
        ...(b.nextDueDate !== undefined ? { nextDueDate: b.nextDueDate, nextInvoiceDate: b.nextDueDate } : {}),
      },
    });
    await prisma.provisioningLog.create({ data: { serviceId: s.id, action: "reactivate", success: true, message: `Marked active by staff (was ${s.status.toLowerCase()})${b.note ? ` — ${b.note}` : ""}${restored.length ? ` · ${restored.length} cancelled invoice(s) restored` : ""}` } });
    await audit({ actorId: req.user!.id, userId: s.userId, action: "service.reactivated", entity: "service", entityId: s.id, details: { from: s.status, restoredInvoices: restored, nextDueDate: b.nextDueDate ?? undefined } });
    await syncOrderForService(s.id);
    if (b.notify && !s.user.ownerResellerId) {
      await queueEmail("service.activated", s.user.email, { name: s.user.firstName ?? "", productName: s.product.name, hostname: s.hostname ?? "", serviceId: s.id }, s.userId);
    }
    res.json({ ok: true, restoredInvoices: restored });
  }),
);

adminCore.post(
  "/services/:id/action",
  requireStaff("services.manage"),
  ah(async (req, res) => {
    const b = parse(
      z.object({
        action: z.enum(["create", "suspend", "unsuspend", "terminate", "start", "stop", "shutdown", "reboot", "hard_reset", "reinstall", "reset_password", "change_package", "sync"]),
        reason: z.string().max(200).optional(),
        package: z.string().max(120).optional(),
        osTemplateId: z.string().optional(),
        notify: z.boolean().optional(),
        /** reset_password: staff-chosen password (otherwise one is generated) */
        password: rootPasswordSchema.optional(),
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
    await enqueueProvision({ serviceId: s.id, action: b.action as ProvisionAction, params: { reason: b.reason, osTemplateId: b.osTemplateId, notify: b.notify, package: b.package, ...(b.action === "reset_password" && b.password ? { passwordEnc: encrypt(b.password) } : {}) }, actorId: req.user!.id });
    // never put the password in the audit log
    const { password: chosen, ...logged } = b;
    await audit({ actorId: req.user!.id, userId: s.userId, action: `service.${b.action}`, entity: "service", entityId: s.id, details: { ...logged, ...(chosen ? { passwordChosen: true } : {}) } });
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
      ...(q ? invoiceWhere(q) : {}),
    };
    const [rows, total, sums] = await Promise.all([
      prisma.invoice.findMany({ where, orderBy: { createdAt: "desc" }, skip, take, include: { user: { select: { id: true, email: true, firstName: true, lastName: true } } } }),
      prisma.invoice.count({ where }),
      prisma.invoice.groupBy({ by: ["currency"], where, _sum: { total: true, amountPaid: true, taxTotal: true } }),
    ]);
    // never add rupees to dollars: one total per currency
    const byCurrency = sums.map((g) => ({ currency: g.currency, ...g._sum }));
    const { withInvoiceLinks } = await import("../billing/invoice-links");
    res.json({ invoices: await withInvoiceLinks(rows, { includeStatus: true }), total, page, pageSize, sums: byCurrency.find((g) => g.currency === "INR") ?? { total: 0, amountPaid: 0, taxTotal: 0 }, sumsByCurrency: byCurrency });
  }),
);

adminCore.get(
  "/invoices/:id",
  requireStaff("billing.view"),
  ah(async (req, res) => {
    const inv = await prisma.invoice.findUnique({ where: { id: req.params.id }, include: { items: true, transactions: { orderBy: [{ createdAt: "desc" }, { id: "desc" }] }, creditNotes: { orderBy: { createdAt: "desc" } }, paymentIntents: { orderBy: { createdAt: "desc" } }, user: { select: { id: true, email: true, firstName: true, lastName: true } }, order: true } });
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
        currency: z.string().length(3).toUpperCase().optional(),
        draft: z.boolean().default(false),
      }),
      req.body,
    );
    if (b.currency) await requireCurrency(b.currency);
    const inv = await prisma.$transaction(async (tx) => {
      const inv = await createInvoice(tx, { userId: b.userId, dueDate: b.dueDate, notes: b.notes, currency: b.currency, items: b.items.map((i) => ({ ...i, type: i.unitPrice < 0 ? ("PROMO" as const) : ("CUSTOM" as const) })) });
      return b.draft ? tx.invoice.update({ where: { id: inv.id }, data: { status: "DRAFT" } }) : inv;
    });
    if (b.sendEmail && !b.draft) {
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

/** What can be refunded on an invoice, per payment and per method (wallet / gateway / manual). */
adminCore.get(
  "/invoices/:id/refund-options",
  requireStaff("payments.manage"),
  ah(async (req, res) => {
    const { refundOptions } = await import("../payments/refunds");
    res.json(await refundOptions(req.params.id));
  }),
);

/** Refund an invoice: back through the original gateway, to the customer's wallet, or record a manual refund. */
adminCore.post(
  "/invoices/:id/refund",
  requireStaff("payments.manage"),
  ah(async (req, res) => {
    const b = parse(z.object({ amount: z.number().int().positive(), method: z.enum(["gateway", "wallet", "manual"]), reason: z.string().trim().min(3).max(300) }), req.body);
    const { refundInvoice } = await import("../payments/refunds");
    const r = await refundInvoice({ invoiceId: req.params.id, ...b, actorId: req.user!.id });
    await audit({ actorId: req.user!.id, action: "invoice.refunded", entity: "invoice", entityId: req.params.id, details: { ...b, parts: r.parts.map((p) => ({ gateway: p.gateway, refundId: p.refundId, amount: p.amount })) } });
    res.json(r);
  }),
);

adminCore.post(
  "/transactions/:id/refund",
  requireStaff("payments.manage"),
  ah(async (req, res) => {
    const b = parse(z.object({ amount: z.number().int().positive(), toCredit: z.boolean().optional(), method: z.enum(["gateway", "wallet", "manual"]).optional(), reason: z.string().min(3) }), req.body);
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
    const r = await runBillingCycle(req.user!.id);
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
