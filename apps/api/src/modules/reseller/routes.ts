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
        specs: { cpuCores: p.cpuCores, ramMb: p.ramMb, diskGb: p.diskGb, bandwidthGb: p.bandwidthGb, ipv4: p.ipv4Count, virtType: p.virtType },
        allowIpSelection: p.allowIpSelection,
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
    await enqueueProvision({ serviceId: s.id, action: "terminate", params: { notify: false }, actorId: req.user!.id });
    res.status(202).json({ queued: true });
  }),
);
