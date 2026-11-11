import { provisioningProgress } from "../provisioning/progress";
import { requireCurrency } from "../../lib/currency";
import { Router } from "express";
import { z } from "zod";
import { hostingPasswordSchema, rootPasswordSchema } from "../orders/pricing";
import { prisma, TicketPriority } from "../../db";
import { ah, badRequest, conflict, forbidden, notFound, pageParams, parse } from "../../lib/http";
import { decrypt, encrypt, randomToken } from "../../lib/crypto";
import { requireClient } from "../../middleware/auth";
import { enqueueProvision } from "../../jobs/queues";
import { profileSchema, resolveStateCode } from "../auth/routes";
import { applyCreditToInvoice, createInvoice, invoiceLabel } from "../billing/invoices";
import { renderInvoicePdf } from "../billing/pdf";
import { assertClientCan, liveStates, liveStatus, usageHistory } from "../provisioning/provisioner";
import { attachmentPath, openTicket, replyTicket, ticketUpload } from "../tickets/service";
import { getSettings } from "../../lib/settings";

export const clientRouter = Router();
clientRouter.use(requireClient);

// ───── Dashboard ─────
clientRouter.get(
  "/dashboard",
  ah(async (req, res) => {
    const userId = req.user!.id;
    const now = new Date();
    const sixMonthsAgo = new Date(now.getFullYear(), now.getMonth() - 5, 1);
    const [user, services, unpaid, txns, tickets, openTickets, awaitingReply, announcements, domains, expiringDomains, payments, logins, affiliate, invoiceCount] = await Promise.all([
      prisma.user.findUniqueOrThrow({ where: { id: userId }, include: { profile: true } }),
      prisma.service.findMany({
        where: { userId, status: { notIn: ["CANCELLED", "TERMINATED"] } },
        orderBy: [{ status: "asc" }, { createdAt: "desc" }],
        take: 30,
        include: { product: { select: { name: true, type: true, provisioner: true, cpuCores: true, ramMb: true, diskGb: true } }, ips: { where: { isPrimary: true }, select: { address: true } }, osTemplate: { select: { id: true, name: true, family: true, distro: true, logoUrl: true } } },
      }),
      prisma.invoice.findMany({ where: { userId, status: "UNPAID" }, orderBy: { dueDate: "asc" }, select: { id: true, number: true, proformaNumber: true, total: true, amountPaid: true, dueDate: true, currency: true, issueDate: true } }),
      prisma.transaction.findMany({ where: { userId }, orderBy: { createdAt: "desc" }, take: 6 }),
      prisma.ticket.findMany({ where: { userId }, orderBy: { lastReplyAt: "desc" }, take: 5, include: { department: true } }),
      prisma.ticket.count({ where: { userId, status: { not: "CLOSED" } } }),
      prisma.ticket.count({ where: { userId, status: "ANSWERED" } }),
      prisma.announcement.findMany({ where: { published: true }, orderBy: { publishedAt: "desc" }, take: 3 }),
      prisma.domain.count({ where: { userId, status: "ACTIVE" } }),
      prisma.domain.findMany({ where: { userId, status: "ACTIVE", expiryDate: { lte: new Date(Date.now() + 60 * 86400_000) } }, orderBy: { expiryDate: "asc" }, take: 5, select: { id: true, name: true, expiryDate: true, autoRenew: true } }),
      prisma.transaction.findMany({ where: { userId, type: { in: ["PAYMENT", "WALLET_TOPUP"] }, createdAt: { gte: sixMonthsAgo } }, select: { amount: true, createdAt: true } }),
      prisma.loginHistory.findMany({ where: { userId, success: true }, orderBy: { createdAt: "desc" }, take: 3, select: { createdAt: true, ip: true, userAgent: true } }),
      prisma.affiliate.findUnique({ where: { userId }, select: { code: true, balance: true, _count: { select: { referrals: true } } } }),
      prisma.invoice.count({ where: { userId } }),
    ]);
    const p = user.profile;
    const months = Array.from({ length: 6 }, (_, i) => {
      const d = new Date(now.getFullYear(), now.getMonth() - 5 + i, 1);
      return { key: `${d.getFullYear()}-${d.getMonth()}`, label: d.toLocaleString("en-IN", { month: "short" }), total: 0 };
    });
    for (const t of payments) {
      const m = months.find((x) => x.key === `${t.createdAt.getFullYear()}-${t.createdAt.getMonth()}`);
      if (m) m.total += t.amount;
    }
    const profileChecks = [
      ["Phone number", !!user.phone],
      ["Billing address", !!(p?.address1 && p?.city && p?.postcode)],
      ["Email verified", !!user.emailVerifiedAt],
      ["Two-factor sign-in", user.totpEnabled],
    ] as const;
    const live = services.filter((s) => s.status === "ACTIVE" || s.status === "SUSPENDED");
    const nextRenewal = live.filter((s) => s.nextDueDate).sort((a, b) => a.nextDueDate!.getTime() - b.nextDueDate!.getTime())[0];
    const outstanding = unpaid.reduce((s, i) => s + i.total - i.amountPaid, 0);
    res.json({
      stats: {
        activeServices: services.filter((s) => s.status === "ACTIVE").length,
        pendingServices: services.filter((s) => s.status === "PENDING" || s.status === "PROVISIONING").length,
        suspendedServices: services.filter((s) => s.status === "SUSPENDED").length,
        failedServices: services.filter((s) => s.status === "FAILED").length,
        unpaidInvoices: unpaid.length,
        overdueInvoices: unpaid.filter((i) => i.dueDate < now).length,
        outstanding,
        creditBalance: p?.creditBalance ?? 0,
        activeDomains: domains,
        openTickets,
        awaitingReply,
        invoiceCount,
        monthlySpend: live.reduce((sum, s) => sum + Math.round(s.recurringAmount / ({ MONTHLY: 1, QUARTERLY: 3, SEMIANNUAL: 6, ANNUAL: 12, BIENNIAL: 24, TRIENNIAL: 36 } as Record<string, number>)[s.billingCycle] || 0), 0),
      },
      account: {
        id: user.id,
        clientNo: user.id.slice(-6).toUpperCase(),
        since: user.createdAt,
        currency: p?.currency ?? "INR",
        company: p?.companyName ?? null,
        gstin: p?.gstin ?? null,
        emailVerified: !!user.emailVerifiedAt,
        twoFactor: user.totpEnabled,
        logins,
        completeness: { done: profileChecks.filter(([, ok]) => ok).length, total: profileChecks.length, missing: profileChecks.filter(([, ok]) => !ok).map(([k]) => k) },
        affiliate: affiliate ? { code: affiliate.code, balance: affiliate.balance, referrals: affiliate._count.referrals } : null,
      },
      services: services.map((s) => ({
        id: s.id,
        product: s.product.name,
        type: s.product.type,
        kind: s.product.provisioner === "CPANEL" ? "hosting" : s.product.provisioner === "PROXMOX" || s.product.provisioner === "VIRTUALIZOR" ? "vps" : "other",
        hostname: s.hostname,
        ip: s.ips[0]?.address ?? null,
        os: s.osTemplate,
        specs: s.product.cpuCores ? { cpu: s.product.cpuCores, ramMb: s.product.ramMb, diskGb: s.product.diskGb } : null,
        status: s.status,
        nextDueDate: s.nextDueDate,
        amount: s.recurringAmount,
        cycle: s.billingCycle,
        currency: s.currency,
      })),
      unpaid: unpaid.map((i) => ({ ...i, overdue: i.dueDate < now, balance: i.total - i.amountPaid })),
      nextRenewal: nextRenewal ? { id: nextRenewal.id, product: nextRenewal.product.name, date: nextRenewal.nextDueDate, amount: nextRenewal.recurringAmount, currency: nextRenewal.currency } : null,
      spend: months.map(({ label, total }) => ({ label, total })),
      expiringDomains,
      transactions: txns,
      tickets: tickets.map((t) => ({ id: t.id, number: t.number, subject: t.subject, status: t.status, department: t.department.name, lastReplyAt: t.lastReplyAt })),
      announcements,
    });
  }),
);

/** Small counts for the client area's sidebar and top bar (every page). */
clientRouter.get(
  "/shell",
  ah(async (req, res) => {
    const userId = req.user!.id;
    const [unpaid, answered, active, profile] = await Promise.all([
      prisma.invoice.findMany({ where: { userId, status: "UNPAID" }, select: { total: true, amountPaid: true, dueDate: true } }),
      prisma.ticket.count({ where: { userId, status: "ANSWERED" } }),
      prisma.service.count({ where: { userId, status: { in: ["ACTIVE", "SUSPENDED", "PROVISIONING", "PENDING"] } } }),
      prisma.clientProfile.findUnique({ where: { userId }, select: { creditBalance: true, currency: true } }),
    ]);
    const now = Date.now();
    res.json({
      unpaidInvoices: unpaid.length,
      overdueInvoices: unpaid.filter((i) => i.dueDate.getTime() < now).length,
      outstanding: unpaid.reduce((s, i) => s + i.total - i.amountPaid, 0),
      ticketsAwaitingReply: answered,
      services: active,
      creditBalance: profile?.creditBalance ?? 0,
      currency: profile?.currency ?? "INR",
    });
  }),
);

// ───── Profile ─────
clientRouter.put(
  "/profile",
  ah(async (req, res) => {
    const b = parse(profileSchema.extend({ currency: z.string().length(3).toUpperCase().optional() }), req.body);
    const stateCode = resolveStateCode(b.country, b.state, b.gstin, b.stateCode);
    // Billing currency follows the country until the first invoice: Indian accounts bill in INR (with GST),
    // overseas accounts in USD (or another enabled currency they pick). After that only support can change it.
    const cur = await prisma.clientProfile.findUnique({ where: { userId: req.user!.id }, select: { currency: true, creditBalance: true } });
    const fresh = !(await prisma.invoice.count({ where: { userId: req.user!.id } })) && !(cur?.creditBalance ?? 0);
    let currency: string | undefined;
    if (fresh) {
      currency = b.country === "IN" ? "INR" : (b.currency && b.currency !== "INR" ? b.currency : cur?.currency && cur.currency !== "INR" ? cur.currency : "USD");
      await requireCurrency(currency);
    } else if (b.currency && b.currency !== cur?.currency) {
      throw badRequest("Your billing currency is fixed once you've been invoiced — please contact support to change it");
    }
    await prisma.user.update({
      where: { id: req.user!.id },
      data: {
        firstName: b.firstName,
        lastName: b.lastName,
        phone: b.phone,
        profile: {
          upsert: {
            create: { companyName: b.companyName, gstin: b.gstin, pan: b.pan, address1: b.address1, address2: b.address2, city: b.city, state: b.state, stateCode, country: b.country, postcode: b.postcode, ...(currency ? { currency } : {}) },
            update: { companyName: b.companyName, gstin: b.gstin, pan: b.pan, address1: b.address1, address2: b.address2, city: b.city, state: b.state, stateCode, country: b.country, postcode: b.postcode, ...(currency ? { currency } : {}) },
          },
        },
      },
    });
    res.json({ ok: true });
  }),
);

// ───── Services ─────
const svcInclude = { product: { select: { name: true, type: true, provisioner: true, virtType: true, cpuCores: true, ramMb: true, diskGb: true, bandwidthGb: true, osTemplates: { include: { osTemplate: true } } } }, ips: { select: { address: true, isPrimary: true, rdns: true, version: true } }, osTemplate: { select: { id: true, name: true, family: true, distro: true, logoUrl: true } } };

clientRouter.get(
  "/services",
  ah(async (req, res) => {
    const status = typeof req.query.status === "string" ? req.query.status : undefined;
    const services = await prisma.service.findMany({
      where: { userId: req.user!.id, ...(status ? { status: status as "ACTIVE" } : { status: { notIn: ["CANCELLED"] } }) },
      orderBy: { createdAt: "desc" },
      include: svcInclude,
    });
    res.json({ services: services.map(({ passwordEnc, config, ...s }) => ({ ...s, hasPassword: !!passwordEnc })) });
  }),
);

async function ownService(userId: string, id: string) {
  const s = await prisma.service.findFirst({ where: { id, userId }, include: { ...svcInclude, addons: { include: { addon: true } } } });
  if (!s) throw notFound("Service not found");
  return s;
}

clientRouter.get(
  "/services/:id",
  ah(async (req, res) => {
    const { passwordEnc, config, ...s } = await ownService(req.user!.id, req.params.id);
    const invoices = await prisma.invoice.findMany({ where: { items: { some: { relId: s.id } } }, orderBy: { createdAt: "desc" }, take: 10, select: { id: true, number: true, proformaNumber: true, total: true, status: true, dueDate: true } });
    // a build writes several "create" steps (started, node chosen, created…) — customers only see the outcome
    const logs = (
      await prisma.provisioningLog.findMany({ where: { serviceId: s.id, action: { in: ["create", "reinstall", "reboot", "start", "stop", "shutdown", "reset_password"] } }, orderBy: { createdAt: "desc" }, take: 60, select: { action: true, success: true, createdAt: true, message: true } })
    )
      .filter((l) => l.action !== "create" || (l.success ? /^(Virtualizor VPS \S+ created|VPS \S+ running on|cPanel account \S+ created)/.test(l.message ?? "") : !/— trying /.test(l.message ?? "")))
      .slice(0, 10)
      .map(({ message: _m, ...l }) => l);
    const busy = await prisma.provisioningLog.count({ where: { serviceId: s.id, createdAt: { gt: new Date(Date.now() - 20000) } } });
    res.json({ service: { ...s, hasPassword: !!passwordEnc, config: { requestedIp: (config as Record<string, unknown>)?.requestedIpId ? true : false } }, invoices, logs, busy: !!busy });
  }),
);

/** One-click login to cPanel / webmail / WHM (reseller) for the customer's hosting account. */
clientRouter.post(
  "/services/:id/cpanel-login",
  ah(async (req, res) => {
    const s = await ownService(req.user!.id, req.params.id);
    if (s.product.provisioner !== "CPANEL") throw badRequest("Not a hosting account");
    if (s.status !== "ACTIVE") throw badRequest(`Login isn't available while the account is ${s.status.toLowerCase()}`);
    const { service } = parse(z.object({ service: z.enum(["cpaneld", "webmaild", "whostmgrd"]).default("cpaneld") }), req.body);
    const { cpanelLoginUrl } = await import("../provisioning/cpanel-provisioner");
    const url = await cpanelLoginUrl(await prisma.service.findUniqueOrThrow({ where: { id: s.id }, include: { server: true, user: true, product: { include: { servers: { include: { server: true } } } } } }), service).catch((e: Error) => {
      throw badRequest(e.message);
    });
    await prisma.provisioningLog.create({ data: { serviceId: s.id, action: "login", success: true, message: `Customer opened ${service === "whostmgrd" ? "WHM" : service === "webmaild" ? "webmail" : "cPanel"}` } });
    res.json({ url });
  }),
);

/** Customer sets their own cPanel password (applied on the server right away). */
clientRouter.post(
  "/services/:id/hosting-password",
  ah(async (req, res) => {
    const s = await ownService(req.user!.id, req.params.id);
    if (s.product.provisioner !== "CPANEL") throw badRequest("Not a hosting account");
    if (s.status !== "ACTIVE") throw badRequest(`Can't change the password while the account is ${s.status.toLowerCase()}`);
    const { password } = parse(z.object({ password: hostingPasswordSchema }), req.body);
    const { runProvisionAction } = await import("../provisioning/provisioner");
    await runProvisionAction(s.id, "reset_password", { password }).catch((e: Error) => {
      throw badRequest(`cPanel didn't accept the password: ${e.message.replace(/^WHM passwd: /, "")}`);
    });
    res.json({ ok: true });
  }),
);

/** One-time browser console session for the customer's own VPS. */
clientRouter.post(
  "/services/:id/console",
  ah(async (req, res) => {
    const s = await ownService(req.user!.id, req.params.id);
    const { openConsole } = await import("../console");
    res.json(await openConsole(s.id, { userId: req.user!.id, staff: false, ip: req.ip }));
  }),
);

/** Live state of all the customer's VPSes (Online / Offline / Suspended / Locked). */
clientRouter.get(
  "/services-live",
  ah(async (req, res) => {
    const mine = await prisma.service.findMany({ where: { userId: req.user!.id, status: { in: ["ACTIVE", "SUSPENDED"] }, remoteId: { not: null } }, select: { id: true } });
    res.json({ states: await liveStates(mine.map((m) => m.id)) });
  }),
);

clientRouter.get(
  "/services/:id/provisioning",
  ah(async (req, res) => {
    const s = await ownService(req.user!.id, req.params.id);
    res.json(await provisioningProgress(s.id, "client"));
  }),
);

clientRouter.post(
  "/services/:id/reveal-password",
  ah(async (req, res) => {
    const s = await prisma.service.findFirst({ where: { id: req.params.id, userId: req.user!.id } });
    if (!s?.passwordEnc) throw notFound("No password stored");
    res.json({ username: s.username, password: decrypt(s.passwordEnc) });
  }),
);

clientRouter.get(
  "/services/:id/status",
  ah(async (req, res) => {
    const s = await ownService(req.user!.id, req.params.id);
    if (s.status !== "ACTIVE") return res.json({ live: null });
    res.json({ live: await liveStatus(s.id).catch((e) => ({ error: String(e.message ?? e) })) });
  }),
);

clientRouter.get(
  "/services/:id/usage",
  ah(async (req, res) => {
    const s = await ownService(req.user!.id, req.params.id);
    const tf = (["hour", "day", "week", "month"] as const).find((x) => x === req.query.timeframe) ?? "day";
    res.json({ points: s.status === "ACTIVE" ? await usageHistory(s.id, tf).catch(() => []) : [] });
  }),
);

const actionSchema = z.object({
  action: z.enum(["start", "stop", "shutdown", "reboot", "hard_reset", "reinstall", "reset_password"]),
  osTemplateId: z.string().optional(),
  confirm: z.string().optional(),
  /** reset_password: the customer's own password (otherwise one is generated) */
  password: rootPasswordSchema.optional(),
});

clientRouter.post(
  "/services/:id/action",
  ah(async (req, res) => {
    const b = parse(actionSchema, req.body);
    const s = await ownService(req.user!.id, req.params.id);
    assertClientCan(s);
    if (s.product.provisioner !== "PROXMOX" && s.product.provisioner !== "VIRTUALIZOR") throw badRequest(s.product.provisioner === "CPANEL" ? "Use the buttons for hosting accounts (cPanel login, change password)" : "This service is managed manually — open a support ticket");
    if (b.action === "reinstall") {
      if (b.confirm !== s.hostname && b.confirm !== "REINSTALL") throw badRequest("Type REINSTALL to confirm — all data will be erased");
      if (b.osTemplateId && !s.product.osTemplates.some((o) => o.osTemplateId === b.osTemplateId)) throw badRequest("OS not available for this plan");
    }
    // anti double-click: one request per 10 s (finished jobs' own log lines don't count)
    const recent = await prisma.provisioningLog.count({ where: { serviceId: s.id, action: { endsWith: "_requested" }, createdAt: { gt: new Date(Date.now() - 10_000) } } });
    if (recent) throw conflict("You just sent a request for this server — please wait a few seconds");
    await enqueueProvision({ serviceId: s.id, action: b.action, params: { osTemplateId: b.osTemplateId, ...(b.action === "reset_password" && b.password ? { passwordEnc: encrypt(b.password) } : {}) }, actorId: req.user!.id });
    await prisma.provisioningLog.create({ data: { serviceId: s.id, action: `${b.action}_requested`, success: true, message: "Queued by customer" } });
    res.status(202).json({ queued: true });
  }),
);

clientRouter.post(
  "/services/:id/rdns",
  ah(async (req, res) => {
    const b = parse(z.object({ address: z.string().ip(), rdns: z.string().trim().toLowerCase().regex(/^[a-z0-9.-]{3,253}$/).or(z.literal("")) }), req.body);
    const s = await ownService(req.user!.id, req.params.id);
    const r = await prisma.ipAddress.updateMany({ where: { serviceId: s.id, address: b.address }, data: { rdns: b.rdns || null } });
    if (!r.count) throw notFound("IP not assigned to this service");
    res.json({ ok: true, note: "Reverse DNS will be updated by our network team within 24 hours." });
  }),
);

clientRouter.post(
  "/services/:id/cancel",
  ah(async (req, res) => {
    const b = parse(z.object({ reason: z.string().min(3).max(1000), when: z.enum(["immediate", "end_of_period"]) }), req.body);
    const s = await ownService(req.user!.id, req.params.id);
    const dept = await prisma.ticketDepartment.findFirst({ where: { name: "Billing Support" } });
    if (dept)
      await openTicket({ userId: req.user!.id, authorId: req.user!.id, isStaff: false, departmentId: dept.id, priority: "MEDIUM", serviceId: s.id, subject: `Cancellation request: ${s.product.name} ${s.hostname ?? ""}`.trim(), message: `Cancellation type: ${b.when}\nReason: ${b.reason}` });
    res.json({ ok: true });
  }),
);

// ───── Invoices & billing ─────
clientRouter.get(
  "/invoices",
  ah(async (req, res) => {
    const { skip, take, page, pageSize } = pageParams(req.query);
    const where = { userId: req.user!.id, ...(typeof req.query.status === "string" ? { status: req.query.status as "PAID" } : {}) };
    const [rows, total] = await Promise.all([prisma.invoice.findMany({ where, orderBy: { createdAt: "desc" }, skip, take }), prisma.invoice.count({ where })]);
    res.json({ invoices: rows, total, page, pageSize });
  }),
);

clientRouter.get(
  "/invoices/:id",
  ah(async (req, res) => {
    const inv = await prisma.invoice.findFirst({
      where: { id: req.params.id, userId: req.user!.id },
      include: { items: true, transactions: { orderBy: { createdAt: "asc" } }, paymentIntents: { where: { status: "PENDING_REVIEW" } } },
    });
    if (!inv) throw notFound("Invoice not found");
    const s = await getSettings();
    res.json({ invoice: inv, label: invoiceLabel(inv), company: s.company, bankDetails: s.invoice.bankDetails, footerNote: s.invoice.footerNote, lutArn: s.currency.lutArn });
  }),
);

clientRouter.get(
  "/invoices/:id/pdf",
  ah(async (req, res) => {
    const inv = await prisma.invoice.findFirst({ where: { id: req.params.id, userId: req.user!.id } });
    if (!inv) throw notFound("Invoice not found");
    const pdf = await renderInvoicePdf(inv.id);
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `inline; filename="${invoiceLabel(inv).replace(/\//g, "-")}.pdf"`);
    res.send(pdf);
  }),
);

clientRouter.post(
  "/invoices/:id/apply-credit",
  ah(async (req, res) => {
    res.json(await applyCreditToInvoice(req.user!.id, req.params.id));
  }),
);

clientRouter.get(
  "/transactions",
  ah(async (req, res) => {
    const { skip, take, page, pageSize } = pageParams(req.query);
    const where = { userId: req.user!.id };
    const [rows, total] = await Promise.all([
      prisma.transaction.findMany({ where, orderBy: { createdAt: "desc" }, skip, take, select: { id: true, gateway: true, gatewayTxnId: true, type: true, amount: true, currency: true, description: true, createdAt: true, invoiceId: true } }),
      prisma.transaction.count({ where }),
    ]);
    res.json({ transactions: rows, total, page, pageSize });
  }),
);

clientRouter.get(
  "/credit",
  ah(async (req, res) => {
    const [profile, ledger] = await Promise.all([
      prisma.clientProfile.findUnique({ where: { userId: req.user!.id } }),
      prisma.creditLedger.findMany({ where: { userId: req.user!.id }, orderBy: { createdAt: "desc" }, take: 50 }),
    ]);
    res.json({ balance: profile?.creditBalance ?? 0, ledger });
  }),
);

clientRouter.post(
  "/credit/topup",
  ah(async (req, res) => {
    const prof = await prisma.clientProfile.findUnique({ where: { userId: req.user!.id }, select: { currency: true } });
    const inr = (prof?.currency ?? "INR") === "INR";
    // minimum top-up: ₹100 / 5.00 in other currencies
    const { amount } = parse(z.object({ amount: z.number().int().min(inr ? 10000 : 500, inr ? "Minimum top-up is ₹100" : `Minimum top-up is 5 ${prof?.currency}`).max(inr ? 50000000 : 600000) }), req.body);
    const inv = await prisma.$transaction((tx) => createInvoice(tx, { userId: req.user!.id, isWalletTopup: true, items: [{ type: "WALLET", description: "Account credit / wallet top-up", unitPrice: amount, taxable: false }] }));
    res.status(201).json({ invoiceId: inv.id });
  }),
);

// ───── Domains ─────
clientRouter.get(
  "/domains",
  ah(async (req, res) => {
    const domains = await prisma.domain.findMany({ where: { userId: req.user!.id }, orderBy: { createdAt: "desc" } });
    res.json({ domains: domains.map(({ eppCodeEnc, ...d }) => ({ ...d, hasEpp: !!eppCodeEnc })) });
  }),
);

async function ownDomain(userId: string, id: string) {
  const d = await prisma.domain.findFirst({ where: { id, userId }, include: { dnsRecords: true } });
  if (!d) throw notFound("Domain not found");
  return d;
}

clientRouter.get(
  "/domains/:id",
  ah(async (req, res) => {
    const { eppCodeEnc, ...d } = await ownDomain(req.user!.id, req.params.id);
    res.json({ domain: { ...d, hasEpp: !!eppCodeEnc } });
  }),
);

clientRouter.put(
  "/domains/:id/nameservers",
  ah(async (req, res) => {
    const { nameservers } = parse(z.object({ nameservers: z.array(z.string().trim().toLowerCase().regex(/^[a-z0-9.-]+\.[a-z]{2,}$/)).min(2).max(5) }), req.body);
    const d = await ownDomain(req.user!.id, req.params.id);
    if (d.status !== "ACTIVE") throw conflict("Domain is not active");
    const { REGISTRARS } = await import("../domains/service");
    await REGISTRARS[d.registrar]?.setNameservers?.(d.name, nameservers);
    await prisma.domain.update({ where: { id: d.id }, data: { nameservers } });
    res.json({ ok: true });
  }),
);

clientRouter.put(
  "/domains/:id/lock",
  ah(async (req, res) => {
    const { locked } = parse(z.object({ locked: z.boolean() }), req.body);
    const d = await ownDomain(req.user!.id, req.params.id);
    const { REGISTRARS } = await import("../domains/service");
    await REGISTRARS[d.registrar]?.setLock?.(d.name, locked);
    await prisma.domain.update({ where: { id: d.id }, data: { locked } });
    res.json({ ok: true });
  }),
);

clientRouter.put(
  "/domains/:id/autorenew",
  ah(async (req, res) => {
    const { autoRenew } = parse(z.object({ autoRenew: z.boolean() }), req.body);
    const d = await ownDomain(req.user!.id, req.params.id);
    await prisma.domain.update({ where: { id: d.id }, data: { autoRenew } });
    res.json({ ok: true });
  }),
);

const dnsSchema = z.object({
  type: z.enum(["A", "AAAA", "CNAME", "MX", "TXT", "NS", "SRV", "CAA"]),
  name: z.string().trim().max(253),
  content: z.string().trim().min(1).max(2048),
  ttl: z.number().int().min(60).max(86400).default(3600),
  priority: z.number().int().min(0).max(65535).optional().nullable(),
});

clientRouter.post(
  "/domains/:id/dns",
  ah(async (req, res) => {
    const b = parse(dnsSchema, req.body);
    const d = await ownDomain(req.user!.id, req.params.id);
    if (d.dnsRecords.length >= 200) throw badRequest("Record limit reached");
    res.status(201).json({ record: await prisma.dnsRecord.create({ data: { domainId: d.id, ...b } }) });
  }),
);

clientRouter.delete(
  "/domains/:id/dns/:recordId",
  ah(async (req, res) => {
    const d = await ownDomain(req.user!.id, req.params.id);
    const r = await prisma.dnsRecord.deleteMany({ where: { id: req.params.recordId, domainId: d.id } });
    if (!r.count) throw notFound();
    res.json({ ok: true });
  }),
);

// ───── Support ─────
clientRouter.get(
  "/tickets",
  ah(async (req, res) => {
    const tickets = await prisma.ticket.findMany({ where: { userId: req.user!.id }, orderBy: { lastReplyAt: "desc" }, include: { department: true } });
    res.json({ tickets: tickets.map((t) => ({ id: t.id, number: t.number, subject: t.subject, status: t.status, priority: t.priority, department: t.department.name, lastReplyAt: t.lastReplyAt, createdAt: t.createdAt })) });
  }),
);

clientRouter.get(
  "/ticket-departments",
  ah(async (_req, res) => {
    res.json({ departments: await prisma.ticketDepartment.findMany({ where: { hidden: false }, orderBy: { sortOrder: "asc" }, select: { id: true, name: true } }) });
  }),
);

clientRouter.post(
  "/tickets",
  ticketUpload.array("attachments", 5),
  ah(async (req, res) => {
    const b = parse(
      z.object({ departmentId: z.string(), subject: z.string().trim().min(3).max(200), message: z.string().trim().min(5).max(20000), priority: z.nativeEnum(TicketPriority).default("MEDIUM"), serviceId: z.string().optional().nullable() }),
      req.body,
    );
    const t = await openTicket({ ...b, userId: req.user!.id, authorId: req.user!.id, isStaff: false, files: req.files as Express.Multer.File[] });
    res.status(201).json({ id: t.id, number: t.number });
  }),
);

clientRouter.get(
  "/tickets/:id",
  ah(async (req, res) => {
    const t = await prisma.ticket.findFirst({
      where: { id: req.params.id, userId: req.user!.id },
      include: { department: true, service: { include: { product: true } }, messages: { where: { isNote: false }, orderBy: { createdAt: "asc" }, include: { attachments: true, author: { select: { firstName: true, lastName: true, type: true } } } } },
    });
    if (!t) throw notFound("Ticket not found");
    res.json({ ticket: t });
  }),
);

clientRouter.post(
  "/tickets/:id/reply",
  ticketUpload.array("attachments", 5),
  ah(async (req, res) => {
    const { message } = parse(z.object({ message: z.string().trim().min(1).max(20000) }), req.body);
    const t = await prisma.ticket.findFirst({ where: { id: req.params.id, userId: req.user!.id } });
    if (!t) throw notFound("Ticket not found");
    await replyTicket({ ticketId: t.id, authorId: req.user!.id, isStaff: false, message, files: req.files as Express.Multer.File[] });
    res.json({ ok: true });
  }),
);

clientRouter.post(
  "/tickets/:id/close",
  ah(async (req, res) => {
    const r = await prisma.ticket.updateMany({ where: { id: req.params.id, userId: req.user!.id }, data: { status: "CLOSED", closedAt: new Date() } });
    if (!r.count) throw notFound("Ticket not found");
    res.json({ ok: true });
  }),
);

clientRouter.get(
  "/attachments/:id",
  ah(async (req, res) => {
    const a = await prisma.ticketAttachment.findUnique({ where: { id: req.params.id }, include: { message: { include: { ticket: true } } } });
    if (!a || a.message.ticket.userId !== req.user!.id || a.message.isNote) throw forbidden();
    res.download(attachmentPath(a.storedAs), a.filename);
  }),
);

// ───── Affiliates ─────
clientRouter.get(
  "/affiliate",
  ah(async (req, res) => {
    const a = await prisma.affiliate.findUnique({ where: { userId: req.user!.id }, include: { referrals: { orderBy: { createdAt: "desc" }, take: 50, include: { referredUser: { select: { firstName: true, createdAt: true } } } } } });
    res.json({ affiliate: a });
  }),
);

clientRouter.post(
  "/affiliate/activate",
  ah(async (req, res) => {
    const s = await getSettings();
    if (!s.affiliates.enabled) throw badRequest("The affiliate programme is currently closed");
    const existing = await prisma.affiliate.findUnique({ where: { userId: req.user!.id } });
    if (existing) return res.json({ affiliate: existing });
    const a = await prisma.affiliate.create({ data: { userId: req.user!.id, code: randomToken(5).replace(/[-_]/g, "x").toUpperCase(), commissionPct: s.affiliates.defaultCommissionPct } });
    res.status(201).json({ affiliate: a });
  }),
);

// ───── Reseller application ─────
clientRouter.post(
  "/reseller/apply",
  ah(async (req, res) => {
    const b = parse(z.object({ brandName: z.string().trim().min(2).max(80), website: z.string().url().optional().or(z.literal("")), notes: z.string().max(2000).optional() }), req.body);
    const existing = await prisma.reseller.findUnique({ where: { userId: req.user!.id } });
    if (existing) throw conflict(`You already have a reseller application (${existing.status.toLowerCase()})`);
    const r = await prisma.reseller.create({ data: { userId: req.user!.id, brandName: b.brandName, website: b.website || null, notes: b.notes } });
    res.status(201).json({ reseller: r });
  }),
);

// ───── Content ─────
clientRouter.get(
  "/downloads",
  ah(async (_req, res) => {
    res.json({ downloads: await prisma.download.findMany({ orderBy: { createdAt: "desc" } }) });
  }),
);
