/**
 * Reseller dashboard + REST API.
 * Mounted at /api/reseller (session cookie) and /api/v1/reseller (Bearer ck_… API key with scope "reseller").
 * Every query is scoped to the authenticated reseller — resellers can never see another reseller's data.
 */
import { Router } from "express";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { prisma, BillingCycle } from "../../db";
import { ah, badRequest, clientIp, HttpError, notFound, parse } from "../../lib/http";
import { randomToken, decrypt } from "../../lib/crypto";
import { requireReseller, requireScope } from "../../middleware/auth";
import { enqueueProvision } from "../../jobs/queues";
import { checkout } from "../orders/checkout";
import { listAvailableIps, reserveIp } from "../ipam/service";
import { liveStatus } from "../provisioning/provisioner";
import { isHostingProduct, isVpsProduct } from "../../lib/product-kind";
import { encrypt } from "../../lib/crypto";
import { assertPublicHttps, notifyReseller, RESELLER_EVENTS, serviceEventData } from "./webhooks";

export const resellerRouter = Router();
resellerRouter.use(requireReseller, requireScope("reseller"));

const reseller = (resellerId: string) => prisma.reseller.findUniqueOrThrow({ where: { id: resellerId } });

resellerRouter.get(
  "/dashboard",
  ah(async (req, res) => {
    const rid = req.user!.resellerId!;
    const [r, profile, active, suspended, customers, recent] = await Promise.all([
      reseller(rid),
      prisma.clientProfile.findUnique({ where: { userId: req.user!.id } }),
      prisma.service.count({ where: { resellerId: rid, status: "ACTIVE" } }),
      prisma.service.count({ where: { resellerId: rid, status: "SUSPENDED" } }),
      prisma.user.count({ where: { ownerResellerId: rid } }),
      prisma.service.findMany({ where: { resellerId: rid }, orderBy: { createdAt: "desc" }, take: 8, include: { product: true, ips: { where: { isPrimary: true } } } }),
    ]);
    const monthlyCost = await prisma.service.aggregate({ where: { resellerId: rid, status: { in: ["ACTIVE", "SUSPENDED"] }, billingCycle: "MONTHLY" }, _sum: { recurringAmount: true, retailAmount: true } });
    res.json({
      reseller: { brandName: r.brandName, status: r.status, discountPct: r.discountPct },
      wallet: profile?.creditBalance ?? 0,
      stats: { active, suspended, customers, monthlyCost: monthlyCost._sum.recurringAmount ?? 0, monthlyRetail: monthlyCost._sum.retailAmount ?? 0 },
      recent: recent.map((s) => ({ id: s.id, product: s.product.name, hostname: s.hostname, ip: s.ips[0]?.address, status: s.status, createdAt: s.createdAt })),
    });
  }),
);

// ── Plans (wholesale) ──
resellerRouter.get(
  "/plans",
  ah(async (req, res) => {
    const r = await reseller(req.user!.resellerId!);
    const products = await prisma.product.findMany({
      where: { enabled: true, resellerEnabled: true },
      orderBy: { sortOrder: "asc" },
      include: { wholesalePricing: true, pricing: { where: { currency: "INR", enabled: true } }, osTemplates: { include: { osTemplate: true } }, resellerPrices: { where: { resellerId: r.id } }, servers: { include: { server: { include: { location: true } } } } },
    });
    res.json({
      plans: products.map((p) => ({
        id: p.id,
        name: p.name,
        type: p.type,
        category: isVpsProduct(p) ? "vps" : isHostingProduct(p) ? "hosting" : "other",
        requires: isVpsProduct(p) ? (p.osTemplates.length ? ["hostname", "osTemplateId"] : ["hostname"]) : isHostingProduct(p) ? ["domain"] : [],
        specs: { cpuCores: p.cpuCores, ramMb: p.ramMb, diskGb: p.diskGb, bandwidthGb: p.bandwidthGb, ipv4: p.ipv4Count, virtType: p.virtType },
        allowIpSelection: p.allowIpSelection && p.provisioner !== "VIRTUALIZOR",
        locations: p.servers.map((s) => ({ serverId: s.serverId, name: s.server.location?.name ?? s.server.name })),
        os: p.osTemplates.map((o) => ({ id: o.osTemplate.id, name: o.osTemplate.name })),
        prices: p.pricing.map((x) => {
          const ws = p.wholesalePricing.find((w) => w.cycle === x.cycle)?.price ?? x.price;
          return { cycle: x.cycle, retailList: x.price, wholesale: Math.round((ws * (100 - r.discountPct)) / 100), yourRetail: p.resellerPrices.find((rp) => rp.cycle === x.cycle)?.retail ?? null };
        }),
      })),
    });
  }),
);

resellerRouter.put(
  "/prices",
  ah(async (req, res) => {
    const b = parse(z.object({ prices: z.array(z.object({ productId: z.string(), cycle: z.nativeEnum(BillingCycle), retail: z.number().int().min(0), enabled: z.boolean().default(true) })).max(200) }), req.body);
    const rid = req.user!.resellerId!;
    for (const p of b.prices) {
      await prisma.resellerPrice.upsert({
        where: { resellerId_productId_cycle: { resellerId: rid, productId: p.productId, cycle: p.cycle } },
        update: { retail: p.retail, enabled: p.enabled },
        create: { resellerId: rid, productId: p.productId, cycle: p.cycle, retail: p.retail, enabled: p.enabled },
      });
    }
    res.json({ ok: true });
  }),
);

// ── Customers ──
resellerRouter.get(
  "/customers",
  ah(async (req, res) => {
    const customers = await prisma.user.findMany({
      where: { ownerResellerId: req.user!.resellerId! },
      orderBy: { createdAt: "desc" },
      select: { id: true, email: true, firstName: true, lastName: true, phone: true, createdAt: true, profile: { select: { companyName: true, city: true, country: true } } },
    });
    res.json({ customers });
  }),
);

resellerRouter.post(
  "/customers",
  ah(async (req, res) => {
    const b = parse(z.object({ email: z.string().email().toLowerCase(), firstName: z.string().min(1), lastName: z.string().default(""), phone: z.string().optional(), companyName: z.string().optional(), city: z.string().default(""), country: z.string().length(2).default("IN") }), req.body);
    if (await prisma.user.findUnique({ where: { email: b.email } })) throw new HttpError(409, "A user with this email already exists");
    const u = await prisma.user.create({
      data: {
        email: b.email,
        firstName: b.firstName,
        lastName: b.lastName,
        phone: b.phone,
        passwordHash: await bcrypt.hash(randomToken(24), 10), // reseller customers do not log in to Crapplet
        ownerResellerId: req.user!.resellerId!,
        status: "INACTIVE",
        profile: { create: { companyName: b.companyName, city: b.city, country: b.country } },
      },
    });
    res.status(201).json({ customer: { id: u.id, email: u.email } });
  }),
);

// ── IPs ──
resellerRouter.get(
  "/ips",
  ah(async (req, res) => {
    const q = parse(z.object({ productId: z.string(), serverId: z.string().optional(), search: z.string().optional() }), req.query);
    const p = await prisma.product.findFirst({ where: { id: q.productId, resellerEnabled: true, enabled: true }, include: { servers: true } });
    if (!p) throw notFound("Plan not found");
    const ids = p.servers.map((s) => s.serverId).filter((id) => !q.serverId || id === q.serverId);
    res.json({ ips: await listAvailableIps({ serverIds: ids, search: q.search, limit: 256 }) });
  }),
);

resellerRouter.post(
  "/ips/:ipId/reserve",
  ah(async (req, res) => {
    const { productId } = parse(z.object({ productId: z.string() }), req.body);
    const p = await prisma.product.findFirst({ where: { id: productId, resellerEnabled: true }, include: { servers: true } });
    if (!p) throw notFound("Plan not found");
    const ip = await reserveIp({ ipId: req.params.ipId, userId: req.user!.id, serverIds: p.servers.map((s) => s.serverId) });
    res.json({ ipId: ip.id, address: ip.address, expiresAt: ip.reservedUntil });
  }),
);

// ── VPS ──
const vpsShape = (s: { id: string; status: string; hostname: string | null; billingCycle: string; nextDueDate: Date | null; recurringAmount: number; retailAmount: number | null; remoteId: string | null; createdAt: Date; config: unknown; product: { name: string }; ips: { address: string; isPrimary: boolean }[]; osTemplate?: { name: string } | null }) => ({
  id: s.id,
  plan: s.product.name,
  status: s.status,
  hostname: s.hostname,
  ip: s.ips.find((i) => i.isPrimary)?.address ?? s.ips[0]?.address ?? null,
  ips: s.ips.map((i) => i.address),
  os: s.osTemplate?.name ?? null,
  billingCycle: s.billingCycle,
  nextDueDate: s.nextDueDate,
  wholesaleAmount: s.recurringAmount,
  retailAmount: s.retailAmount,
  customerId: ((s.config ?? {}) as { endCustomerId?: string }).endCustomerId ?? null,
  createdAt: s.createdAt,
});

async function ownVps(resellerId: string, id: string) {
  const s = await prisma.service.findFirst({ where: { id, resellerId }, include: { product: true, ips: true, osTemplate: true } });
  if (!s) throw notFound("VPS not found");
  return s;
}

resellerRouter.get(
  "/vps",
  ah(async (req, res) => {
    const rows = await prisma.service.findMany({ where: { resellerId: req.user!.resellerId!, status: { not: "CANCELLED" } }, orderBy: { createdAt: "desc" }, include: { product: true, ips: true, osTemplate: true } });
    res.json({ vps: rows.map(vpsShape) });
  }),
);

resellerRouter.get(
  "/vps/:id",
  ah(async (req, res) => {
    const s = await ownVps(req.user!.resellerId!, req.params.id);
    const live = s.status === "ACTIVE" ? await liveStatus(s.id).catch(() => null) : null;
    res.json({ vps: { ...vpsShape(s), username: s.username, password: s.passwordEnc ? decrypt(s.passwordEnc) : null, live } });
  }),
);

resellerRouter.post(
  "/vps",
  ah(async (req, res) => {
    const b = parse(
      z.object({
        planId: z.string(),
        cycle: z.nativeEnum(BillingCycle).default("MONTHLY"),
        osTemplateId: z.string(),
        hostname: z.string().regex(/^[a-z0-9.-]{3,120}$/i),
        ipId: z.string().optional(),
        serverId: z.string().optional(),
        customerId: z.string().optional(),
        retailAmount: z.number().int().min(0).optional(),
      }),
      req.body,
    );
    const r = await reseller(req.user!.resellerId!);
    if (b.customerId) {
      const c = await prisma.user.count({ where: { id: b.customerId, ownerResellerId: r.id } });
      if (!c) throw badRequest("Unknown customer");
    }
    const result = await checkout({
      userId: req.user!.id,
      resellerId: r.id,
      wholesaleDiscountPct: r.discountPct,
      cart: { items: [{ productId: b.planId, cycle: b.cycle, osTemplateId: b.osTemplateId, hostname: b.hostname.toLowerCase(), ipId: b.ipId, serverId: b.serverId, config: {}, addonIds: [], quantity: 1 }], domains: [], currency: "INR" },
      extraConfig: { endCustomerId: b.customerId ?? null },
      useCredit: true,
      ip: clientIp(req),
    });
    const svc = await prisma.service.findFirst({ where: { orderId: result.orderId } });
    if (svc && b.retailAmount !== undefined) await prisma.service.update({ where: { id: svc.id }, data: { retailAmount: b.retailAmount } });
    if (!result.paid) {
      return res.status(402).json({ error: "Insufficient wallet balance — top up and pay the invoice to deploy", invoiceId: result.invoiceId, vpsId: svc?.id, amount: result.total });
    }
    res.status(201).json({ vpsId: svc?.id, invoiceId: result.invoiceId, status: "PROVISIONING" });
  }),
);

resellerRouter.post(
  "/vps/:id/action",
  ah(async (req, res) => {
    const b = parse(z.object({ action: z.enum(["start", "stop", "shutdown", "reboot", "suspend", "unsuspend", "reinstall", "reset_password"]), osTemplateId: z.string().optional(), reason: z.string().optional() }), req.body);
    const s = await ownVps(req.user!.resellerId!, req.params.id);
    if (b.action === "unsuspend" && s.suspendReason?.startsWith("Overdue")) throw badRequest("Suspended for non-payment — pay the overdue invoice to restore");
    if (["start", "stop", "shutdown", "reboot", "reinstall", "reset_password"].includes(b.action) && s.status !== "ACTIVE") throw badRequest(`VPS is ${s.status}`);
    await enqueueProvision({ serviceId: s.id, action: b.action, params: { osTemplateId: b.osTemplateId, reason: b.reason ? `Reseller: ${b.reason}` : "Suspended by reseller" }, actorId: req.user!.id });
    res.status(202).json({ queued: true });
  }),
);

resellerRouter.delete(
  "/vps/:id",
  ah(async (req, res) => {
    const s = await ownVps(req.user!.resellerId!, req.params.id);
    if (s.status === "TERMINATED") return res.json({ ok: true });
    await enqueueProvision({ serviceId: s.id, action: "terminate", params: { notify: false, reason: "Terminated by the reseller" }, actorId: req.user!.id });
    res.status(202).json({ queued: true });
  }),
);


// ─────────────────────────── API v1 for resellers' own websites ───────────────────────────

/** Account: brand, discount and wallet. */
resellerRouter.get(
  "/me",
  ah(async (req, res) => {
    const r = await reseller(req.user!.resellerId!);
    const p = await prisma.clientProfile.findUnique({ where: { userId: req.user!.id }, select: { creditBalance: true, currency: true } });
    res.json({ reseller: { id: r.id, brandName: r.brandName, status: r.status, discountPct: r.discountPct }, wallet: { balance: p?.creditBalance ?? 0, currency: "INR" } });
  }),
);

/**
 * Place an order for any plan (VPS, hosting, …). Paid from the wallet; nothing is deployed until it's paid.
 * `reference` (or an Idempotency-Key header) makes retries safe: the same reference returns the same order.
 */
resellerRouter.post(
  "/orders",
  ah(async (req, res) => {
    const b = parse(
      z.object({
        planId: z.string(),
        cycle: z.nativeEnum(BillingCycle).default("MONTHLY"),
        hostname: z.string().trim().toLowerCase().regex(/^[a-z0-9.-]{3,120}$/, "hostname: letters, digits, dots and dashes").optional(),
        domain: z.string().trim().toLowerCase().regex(/^[a-z0-9.-]{3,120}$/, "domain: e.g. example.com").optional(),
        osTemplateId: z.string().optional(),
        ipId: z.string().optional(),
        serverId: z.string().optional(),
        customerId: z.string().optional(),
        retailAmount: z.number().int().min(0).optional(),
        reference: z.string().trim().min(1).max(100).optional(),
      }),
      req.body,
    );
    const rid = req.user!.resellerId!;
    const reference = b.reference ?? (typeof req.headers["idempotency-key"] === "string" ? req.headers["idempotency-key"].trim().slice(0, 100) : undefined);
    if (reference) {
      const prev = await prisma.service.findFirst({ where: { resellerId: rid, resellerRef: reference }, select: { id: true, orderId: true, status: true } });
      if (prev) {
        const inv = prev.orderId ? await prisma.order.findUnique({ where: { id: prev.orderId }, select: { invoiceId: true } }) : null;
        return res.status(200).json({ serviceId: prev.id, invoiceId: inv?.invoiceId ?? null, status: prev.status, duplicate: true });
      }
    }
    const plan = await prisma.product.findFirst({ where: { id: b.planId, enabled: true, resellerEnabled: true } });
    if (!plan) throw notFound("Plan not found — list plans with GET /plans");
    const hosting = isHostingProduct(plan);
    const name = hosting ? b.domain ?? b.hostname : b.hostname ?? b.domain;
    if (!name) throw badRequest(hosting ? "domain is required for hosting plans" : "hostname is required");
    const r = await reseller(rid);
    if (r.status !== "APPROVED") throw new HttpError(403, "Your reseller account isn't approved");
    if (b.customerId && !(await prisma.user.count({ where: { id: b.customerId, ownerResellerId: rid } }))) throw badRequest("Unknown customerId — create the customer with POST /customers first");
    const result = await checkout({
      userId: req.user!.id,
      resellerId: rid,
      wholesaleDiscountPct: r.discountPct,
      cart: { items: [{ productId: plan.id, cycle: b.cycle, osTemplateId: b.osTemplateId, hostname: name, ipId: b.ipId, serverId: b.serverId, config: {}, addonIds: [], quantity: 1 }], domains: [], currency: "INR" },
      extraConfig: { endCustomerId: b.customerId ?? null },
      useCredit: true,
      ip: clientIp(req),
    });
    const svc = await prisma.service.findFirst({ where: { orderId: result.orderId } });
    if (svc) await prisma.service.update({ where: { id: svc.id }, data: { ...(b.retailAmount !== undefined ? { retailAmount: b.retailAmount } : {}), ...(reference ? { resellerRef: reference } : {}) } });
    const body = { serviceId: svc?.id ?? null, orderId: result.orderId, invoiceId: result.invoiceId, amount: result.total, paid: result.paid, status: svc ? (await prisma.service.findUnique({ where: { id: svc.id }, select: { status: true } }))?.status : null };
    if (!result.paid) return res.status(402).json({ ...body, error: "Insufficient wallet balance — top up, then POST /invoices/{invoiceId}/pay", code: "INSUFFICIENT_FUNDS" });
    res.status(201).json(body);
  }),
);

// ── services (any kind — /vps above stays for older integrations) ──
resellerRouter.get(
  "/services",
  ah(async (req, res) => {
    const q = parse(z.object({ status: z.enum(["PENDING", "PROVISIONING", "ACTIVE", "SUSPENDED", "TERMINATED", "CANCELLED", "FAILED"]).optional(), reference: z.string().optional(), customerId: z.string().optional(), page: z.coerce.number().int().min(1).default(1), limit: z.coerce.number().int().min(1).max(200).default(50) }), req.query);
    const where = { resellerId: req.user!.resellerId!, ...(q.status ? { status: q.status } : {}), ...(q.reference ? { resellerRef: q.reference } : {}), ...(q.customerId ? { config: { path: ["endCustomerId"], equals: q.customerId } } : {}) };
    const [rows, total] = await Promise.all([
      prisma.service.findMany({ where, orderBy: { createdAt: "desc" }, skip: (q.page - 1) * q.limit, take: q.limit, select: { id: true } }),
      prisma.service.count({ where }),
    ]);
    res.json({ services: (await Promise.all(rows.map((r) => serviceEventData(r.id)))).filter(Boolean), page: q.page, limit: q.limit, total });
  }),
);

resellerRouter.get(
  "/services/:id",
  ah(async (req, res) => {
    const s = await ownVps(req.user!.resellerId!, req.params.id);
    const live = s.status === "ACTIVE" && isVpsProduct(s.product) ? await liveStatus(s.id).catch(() => null) : null;
    res.json({ service: { ...(await serviceEventData(s.id)), billingCycle: s.billingCycle, nextDueDate: s.nextDueDate, wholesaleAmount: s.recurringAmount, retailAmount: s.retailAmount, username: s.username, password: s.passwordEnc ? decrypt(s.passwordEnc) : null, createdAt: s.createdAt, live } });
  }),
);

resellerRouter.post(
  "/services/:id/action",
  ah(async (req, res) => {
    const b = parse(z.object({ action: z.enum(["start", "stop", "shutdown", "reboot", "suspend", "unsuspend", "reinstall", "reset_password"]), osTemplateId: z.string().optional(), reason: z.string().max(200).optional() }), req.body);
    const s = await ownVps(req.user!.resellerId!, req.params.id);
    const vps = isVpsProduct(s.product);
    if (!vps && ["start", "stop", "shutdown", "reboot", "reinstall"].includes(b.action)) throw badRequest(`${b.action} is only for VPS plans`);
    if (b.action === "unsuspend" && s.suspendReason?.startsWith("Overdue")) throw badRequest("Suspended for non-payment — pay the overdue invoice to restore");
    if (["start", "stop", "shutdown", "reboot", "reinstall", "reset_password"].includes(b.action) && s.status !== "ACTIVE") throw badRequest(`The service is ${s.status}`);
    await enqueueProvision({ serviceId: s.id, action: b.action, params: { osTemplateId: b.osTemplateId, reason: b.reason ? `Reseller: ${b.reason}` : "Suspended by reseller" }, actorId: req.user!.id });
    res.status(202).json({ queued: true });
  }),
);

resellerRouter.delete(
  "/services/:id",
  ah(async (req, res) => {
    const s = await ownVps(req.user!.resellerId!, req.params.id);
    if (s.status === "TERMINATED" || s.status === "CANCELLED") return res.json({ ok: true, status: s.status });
    if (["PENDING", "FAILED"].includes(s.status)) {
      await prisma.service.update({ where: { id: s.id }, data: { status: "CANCELLED", terminationDate: new Date(), terminationReason: "Cancelled by the reseller" } });
      return res.json({ ok: true, status: "CANCELLED" });
    }
    await enqueueProvision({ serviceId: s.id, action: "terminate", params: { notify: false, reason: "Terminated by the reseller" }, actorId: req.user!.id });
    res.status(202).json({ queued: true });
  }),
);

/** One-click cPanel / webmail login link for a hosting service (for the reseller's own client area). */
resellerRouter.post(
  "/services/:id/login",
  ah(async (req, res) => {
    const b = parse(z.object({ service: z.enum(["cpaneld", "webmaild"]).default("cpaneld") }), req.body ?? {});
    const s = await ownVps(req.user!.resellerId!, req.params.id);
    if (s.product.provisioner !== "CPANEL") throw badRequest("Login links are for hosting services");
    if (s.status !== "ACTIVE") throw badRequest(`The service is ${s.status}`);
    const { cpanelLoginUrl } = await import("../provisioning/cpanel-provisioner");
    const url = await cpanelLoginUrl(await prisma.service.findUniqueOrThrow({ where: { id: s.id }, include: { server: true, user: true, product: { include: { servers: { include: { server: true } } } } } }), b.service).catch((e: Error) => {
      throw badRequest(e.message);
    });
    res.json({ url, expiresInSeconds: 60 });
  }),
);

// ── wallet & invoices ──
resellerRouter.get(
  "/wallet",
  ah(async (req, res) => {
    const [p, ledger] = await Promise.all([
      prisma.clientProfile.findUnique({ where: { userId: req.user!.id }, select: { creditBalance: true } }),
      prisma.creditLedger.findMany({ where: { userId: req.user!.id }, orderBy: { createdAt: "desc" }, take: 100, select: { amount: true, balanceAfter: true, description: true, createdAt: true } }),
    ]);
    res.json({ balance: p?.creditBalance ?? 0, currency: "INR", transactions: ledger });
  }),
);

const invShape = (i: { id: string; number: string | null; proformaNumber: string; status: string; currency: string; subtotal: number; taxTotal: number; total: number; amountPaid: number; dueDate: Date; paidAt: Date | null; issueDate: Date; items?: { description: string; quantity: number; unitPrice: number; amount: number; relId: string | null; type: string }[] }) => ({
  id: i.id,
  number: i.number ?? i.proformaNumber,
  status: i.status,
  currency: i.currency,
  subtotal: i.subtotal,
  tax: i.taxTotal,
  total: i.total,
  amountDue: Math.max(0, i.total - i.amountPaid),
  issueDate: i.issueDate,
  dueDate: i.dueDate,
  paidAt: i.paidAt,
  ...(i.items ? { items: i.items.map((x) => ({ description: x.description, quantity: x.quantity, unitPrice: x.unitPrice, amount: x.amount, serviceId: x.type === "SERVICE" ? x.relId : null })) } : {}),
});

resellerRouter.get(
  "/invoices",
  ah(async (req, res) => {
    const q = parse(z.object({ status: z.enum(["UNPAID", "PAID", "CANCELLED", "REFUNDED"]).optional(), page: z.coerce.number().int().min(1).default(1), limit: z.coerce.number().int().min(1).max(200).default(50) }), req.query);
    const where = { userId: req.user!.id, status: q.status ?? { not: "DRAFT" as const } };
    const [rows, total] = await Promise.all([prisma.invoice.findMany({ where, orderBy: { createdAt: "desc" }, skip: (q.page - 1) * q.limit, take: q.limit }), prisma.invoice.count({ where })]);
    res.json({ invoices: rows.map((i) => invShape(i)), page: q.page, limit: q.limit, total });
  }),
);

resellerRouter.get(
  "/invoices/:id",
  ah(async (req, res) => {
    const i = await prisma.invoice.findFirst({ where: { id: req.params.id, userId: req.user!.id, status: { not: "DRAFT" } }, include: { items: true } });
    if (!i) throw notFound("Invoice not found");
    res.json({ invoice: invShape(i) });
  }),
);

/** Pay an unpaid invoice from the wallet (renewals, or an order placed while the wallet was short). */
resellerRouter.post(
  "/invoices/:id/pay",
  ah(async (req, res) => {
    const i = await prisma.invoice.findFirst({ where: { id: req.params.id, userId: req.user!.id } });
    if (!i) throw notFound("Invoice not found");
    if (i.status === "PAID") return res.json({ paid: true, already: true });
    if (i.status !== "UNPAID") throw badRequest(`The invoice is ${i.status.toLowerCase()}`);
    const p = await prisma.clientProfile.findUnique({ where: { userId: req.user!.id }, select: { creditBalance: true } });
    const due = i.total - i.amountPaid;
    if ((p?.creditBalance ?? 0) < due) throw new HttpError(402, `Wallet balance ₹${((p?.creditBalance ?? 0) / 100).toFixed(2)} is less than ₹${(due / 100).toFixed(2)} due — top up first`, "INSUFFICIENT_FUNDS");
    const { applyCreditToInvoice } = await import("../billing/invoices");
    const r = await applyCreditToInvoice(req.user!.id, i.id);
    res.json({ paid: !!r.paid, applied: r.applied });
  }),
);

// ── webhooks ──
resellerRouter.get(
  "/webhook",
  ah(async (req, res) => {
    const r = await reseller(req.user!.resellerId!);
    res.json({ url: r.webhookUrl, events: RESELLER_EVENTS, lastDeliveryAt: r.webhookLastAt, lastDelivery: r.webhookLastStatus });
  }),
);

/** Set (or change) the webhook URL — returns a new signing secret, shown once. */
resellerRouter.put(
  "/webhook",
  ah(async (req, res) => {
    if (req.user!.viaApiKey && !(req.user!.scopes ?? []).includes("reseller")) throw new HttpError(403, "Forbidden");
    const b = parse(z.object({ url: z.string().max(500) }), req.body);
    const url = await assertPublicHttps(b.url);
    const secret = `whsec_${randomToken(32)}`;
    await prisma.reseller.update({ where: { id: req.user!.resellerId! }, data: { webhookUrl: url, webhookSecretEnc: encrypt(secret), webhookLastStatus: null } });
    res.json({ url, secret, note: "Store this secret now — it's used to verify X-Crapplet-Signature and won't be shown again." });
  }),
);

resellerRouter.delete(
  "/webhook",
  ah(async (req, res) => {
    await prisma.reseller.update({ where: { id: req.user!.resellerId! }, data: { webhookUrl: null, webhookSecretEnc: null } });
    res.json({ ok: true });
  }),
);

resellerRouter.post(
  "/webhook/test",
  ah(async (req, res) => {
    const r = await reseller(req.user!.resellerId!);
    if (!r.webhookUrl) throw badRequest("Set a webhook URL first (PUT /webhook)");
    await notifyReseller(r.id, "service.active", { test: true, id: "svc_test", reference: "test", plan: "Test plan", status: "ACTIVE", hostname: "test.example.com", ip: "192.0.2.10", ips: ["192.0.2.10"] }, { wait: true });
    const after = await reseller(r.id);
    res.json({ lastDelivery: after.webhookLastStatus, at: after.webhookLastAt });
  }),
);
