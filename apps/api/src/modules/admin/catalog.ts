import { Router } from "express";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { prisma, Prisma, BillingCycle, ProductType, Provisioner, VirtType, AutoSetup, ConfigOptionType, PromoType } from "../../db";
import { ah, badRequest, conflict, notFound, parse } from "../../lib/http";
import { audit } from "../../lib/audit";
import { decryptJson, encryptJson } from "../../lib/crypto";
import { getSettings, updateSettings, DEFAULT_SETTINGS, type SettingKey } from "../../lib/settings";
import { refreshExchangeRates } from "../../lib/currency";
import { PERMISSIONS, requireStaff } from "../../middleware/auth";
import { GATEWAYS, GATEWAY_FIELDS, gatewayCurrencies } from "../payments/gateways";
import { DEFAULT_TEMPLATES } from "../email/templates";
import { render, sendTemplatedEmail } from "../email/mailer";
import { crud } from "./crud";
import { clearPlansCache } from "../catalog/routes";

/** { USD: 499 } style maps; keys are 3-letter currency codes, values minor units */
const curMap = z.record(z.string().length(3), z.number().int().min(0)).default({});
const curMapOf = <T extends z.ZodRawShape>(shape: T) => z.record(z.string().length(3), z.object(shape).partial()).default({});

export const adminCatalog = Router();
const slug = z.string().trim().toLowerCase().regex(/^[a-z0-9-]+$/, "Use lowercase letters, numbers and dashes");

// ───────────── Product groups ─────────────
crud(adminCatalog, "/product-groups", "productGroup", z.object({ name: z.string().min(1), slug, description: z.string().nullable().optional(), headline: z.string().nullable().optional(), sortOrder: z.number().int().default(0), hidden: z.boolean().default(false), legacyGid: z.number().int().positive().nullable().optional() }), "products.manage", {
  orderBy: { sortOrder: "asc" },
  include: { _count: { select: { products: true } } },
});

// ───────────── Products ─────────────
export const VPS_BANDWIDTH_GB = 10_000;

const productSchema = z.object({
  groupId: z.string(),
  legacyPid: z.number().int().nullable().optional(),
  name: z.string().min(1).max(120),
  slug,
  type: z.nativeEnum(ProductType),
  tagline: z.string().max(200).nullable().optional(),
  description: z.string().max(10000).nullable().optional(),
  features: z.array(z.string().max(200)).default([]),
  imageUrl: z.string().max(500).nullable().optional(),
  provisioner: z.nativeEnum(Provisioner).default("MANUAL"),
  virtType: z.nativeEnum(VirtType).default("KVM"),
  cpuCores: z.number().int().min(1).nullable().optional(),
  ramMb: z.number().int().min(128).nullable().optional(),
  diskGb: z.number().int().min(1).nullable().optional(),
  bandwidthGb: z.number().int().min(0).nullable().optional(),
  ipv4Count: z.number().int().min(0).max(64).default(0),
  ipv6Enabled: z.boolean().default(false),
  allowIpSelection: z.boolean().default(false),
  requireHostname: z.boolean().default(false),
  outOfStock: z.boolean().default(false),
  freeDomain: z.enum(["none", "once", "recurring"]).default("none"),
  freeDomainCycles: z.array(z.nativeEnum(BillingCycle)).default([]),
  freeDomainTlds: z.array(z.string().trim().toLowerCase().regex(/^\.?[a-z0-9-]+(\.[a-z0-9-]+)*$/, "TLDs look like .com or .co.in").transform((t) => (t.startsWith(".") ? t : `.${t}`))).default([]),
  hsnSac: z.string().max(10).default("998315"),
  taxable: z.boolean().default(true),
  stockControl: z.boolean().default(false),
  stockQty: z.number().int().min(0).default(0),
  enabled: z.boolean().default(true),
  hidden: z.boolean().default(false),
  featured: z.boolean().default(false),
  autoSetup: z.nativeEnum(AutoSetup).default("ON_PAYMENT"),
  sortOrder: z.number().int().default(0),
  moduleConfig: z.record(z.any()).default({}),
  resellerEnabled: z.boolean().default(false),
  pricing: z.array(z.object({ cycle: z.nativeEnum(BillingCycle), currency: z.string().default("INR"), price: z.number().int().min(0), setupFee: z.number().int().min(0).default(0), enabled: z.boolean().default(true) })).optional(),
  wholesale: z.array(z.object({ cycle: z.nativeEnum(BillingCycle), price: z.number().int().min(0) })).optional(),
  serverIds: z.array(z.string()).optional(),
  osTemplateIds: z.array(z.string()).optional(),
  addonIds: z.array(z.string()).optional(),
  configOptions: z
    .array(
      z.object({
        key: z.string().regex(/^[a-z0-9_]+$/),
        label: z.string(),
        type: z.nativeEnum(ConfigOptionType),
        minQty: z.number().int().default(0),
        maxQty: z.number().int().default(0),
        unitMonthly: z.number().int().default(0),
        unitPrices: curMap,
        choices: z.array(z.object({ value: z.string(), label: z.string(), monthly: z.number().int(), prices: curMap.optional() })).default([]),
        sortOrder: z.number().int().default(0),
      }),
    )
    .optional(),
});

const productInclude = {
  group: true,
  pricing: true,
  wholesalePricing: true,
  servers: { include: { server: { select: { id: true, name: true, type: true } } } },
  osTemplates: { include: { osTemplate: true } },
  configOptions: { orderBy: { sortOrder: "asc" as const } },
  addons: { include: { addon: true } },
  _count: { select: { services: true } },
};

adminCatalog.get(
  "/products",
  requireStaff("products.manage"),
  ah(async (_req, res) => {
    res.json({ products: await prisma.product.findMany({ orderBy: [{ group: { sortOrder: "asc" } }, { sortOrder: "asc" }], include: productInclude }) });
  }),
);

adminCatalog.get(
  "/products/:id",
  requireStaff("products.manage"),
  ah(async (req, res) => {
    const p = await prisma.product.findUnique({ where: { id: req.params.id }, include: productInclude });
    if (!p) throw notFound();
    res.json({ product: p });
  }),
);

async function saveProductRelations(tx: Prisma.TransactionClient, productId: string, b: Partial<z.infer<typeof productSchema>>) {
  if (b.pricing) {
    await tx.productPricing.deleteMany({ where: { productId } });
    if (b.pricing.length) await tx.productPricing.createMany({ data: b.pricing.map((p) => ({ ...p, productId })) });
  }
  if (b.wholesale) {
    await tx.wholesalePrice.deleteMany({ where: { productId } });
    if (b.wholesale.length) await tx.wholesalePrice.createMany({ data: b.wholesale.map((p) => ({ ...p, productId })) });
  }
  if (b.serverIds) {
    await tx.productServer.deleteMany({ where: { productId } });
    if (b.serverIds.length) await tx.productServer.createMany({ data: b.serverIds.map((serverId) => ({ productId, serverId })) });
  }
  if (b.osTemplateIds) {
    await tx.productOs.deleteMany({ where: { productId } });
    if (b.osTemplateIds.length) await tx.productOs.createMany({ data: b.osTemplateIds.map((osTemplateId) => ({ productId, osTemplateId })) });
  }
  if (b.addonIds) {
    await tx.addonProduct.deleteMany({ where: { productId } });
    if (b.addonIds.length) await tx.addonProduct.createMany({ data: b.addonIds.map((addonId) => ({ productId, addonId })) });
  }
  if (b.configOptions) {
    await tx.configOption.deleteMany({ where: { productId } });
    for (const o of b.configOptions) await tx.configOption.create({ data: { ...o, productId, choices: o.choices as Prisma.InputJsonValue } });
  }
}

adminCatalog.post(
  "/products",
  requireStaff("products.manage"),
  ah(async (req, res) => {
    const b = parse(productSchema, req.body);
    const { pricing, wholesale, serverIds, osTemplateIds, addonIds, configOptions, moduleConfig, ...data } = b;
    // VPS plans come with 10 TB of bandwidth unless set otherwise
    if (String(data.type).startsWith("VPS") && data.bandwidthGb == null) data.bandwidthGb = VPS_BANDWIDTH_GB;
    const p = await prisma.$transaction(async (tx) => {
      const p = await tx.product.create({ data: { ...data, moduleConfig: moduleConfig as Prisma.InputJsonValue } });
      await saveProductRelations(tx, p.id, { pricing, wholesale, serverIds, osTemplateIds, addonIds, configOptions });
      return p;
    });
    clearPlansCache();
    await audit({ actorId: req.user!.id, action: "product.created", entity: "product", entityId: p.id });
    res.status(201).json({ id: p.id });
  }),
);

adminCatalog.put(
  "/products/:id",
  requireStaff("products.manage"),
  ah(async (req, res) => {
    const b = parse(productSchema.partial(), req.body);
    const { pricing, wholesale, serverIds, osTemplateIds, addonIds, configOptions, moduleConfig, ...data } = b;
    await prisma.$transaction(async (tx) => {
      await tx.product.update({ where: { id: req.params.id }, data: { ...data, ...(moduleConfig ? { moduleConfig: moduleConfig as Prisma.InputJsonValue } : {}) } });
      await saveProductRelations(tx, req.params.id, { pricing, wholesale, serverIds, osTemplateIds, addonIds, configOptions });
    });
    clearPlansCache();
    await audit({ actorId: req.user!.id, action: "product.updated", entity: "product", entityId: req.params.id });
    res.json({ ok: true });
  }),
);

/**
 * Quick changes to one or many plans from the Products list: show / hide on the website and order page,
 * mark out of stock / back in stock, enable / disable.
 */
const BULK: Record<string, Prisma.ProductUpdateManyMutationInput> = {
  show: { hidden: false, enabled: true },
  hide: { hidden: true },
  out_of_stock: { outOfStock: true },
  in_stock: { outOfStock: false },
  enable: { enabled: true },
  disable: { enabled: false },
};
adminCatalog.post(
  "/products/bulk",
  requireStaff("products.manage"),
  ah(async (req, res) => {
    const b = parse(z.object({ ids: z.array(z.string().max(40)).min(1).max(500), action: z.enum(Object.keys(BULK) as [string, ...string[]]) }), req.body);
    const r = await prisma.product.updateMany({ where: { id: { in: b.ids } }, data: BULK[b.action] });
    clearPlansCache();
    await audit({ actorId: req.user!.id, action: `product.bulk_${b.action}`, entity: "product", entityId: b.ids.length === 1 ? b.ids[0] : "bulk", details: { ids: b.ids, count: r.count } });
    res.json({ updated: r.count });
  }),
);

adminCatalog.delete(
  "/products/:id",
  requireStaff("products.manage"),
  ah(async (req, res) => {
    const used = await prisma.service.count({ where: { productId: req.params.id } });
    if (used) throw conflict(`This product has ${used} services. Disable it instead of deleting.`);
    await prisma.product.delete({ where: { id: req.params.id } });
    clearPlansCache();
    res.json({ ok: true });
  }),
);

// ───────────── Add-ons, promos, OS templates ─────────────
crud(adminCatalog, "/addons", "addon", z.object({ name: z.string().min(1), description: z.string().nullable().optional(), monthly: z.number().int().min(0), setupFee: z.number().int().min(0).default(0), prices: curMapOf({ monthly: z.number().int().min(0), setupFee: z.number().int().min(0) }), taxable: z.boolean().default(true), enabled: z.boolean().default(true) }), "products.manage");

crud(
  adminCatalog,
  "/promo-codes",
  "promoCode",
  z.object({
    code: z.string().trim().toUpperCase().min(3).max(30),
    type: z.nativeEnum(PromoType),
    value: z.number().int().min(1),
    fixedAmounts: curMap,
    recurring: z.boolean().default(false),
    productIds: z.array(z.string()).default([]),
    cycles: z.array(z.nativeEnum(BillingCycle)).default([]),
    maxUses: z.number().int().min(0).default(0),
    newOnly: z.boolean().default(false),
    startsAt: z.coerce.date().nullable().optional(),
    expiresAt: z.coerce.date().nullable().optional(),
    enabled: z.boolean().default(true),
  }),
  "products.manage",
  { orderBy: { createdAt: "desc" } },
);

crud(
  adminCatalog,
  "/os-templates",
  "osTemplate",
  z.object({
    name: z.string().min(1),
    family: z.enum(["linux", "windows"]).default("linux"),
    proxmoxKvmVmid: z.number().int().nullable().optional(),
    proxmoxLxcVolid: z.string().nullable().optional(),
    virtualizorOsId: z.number().int().nullable().optional(),
    defaultUser: z.string().default("root"),
    logoUrl: z.string().max(500).regex(/^(https:\/\/|\/)/, "Use an https:// URL or a /path on this site").nullable().optional(),
    enabled: z.boolean().default(true),
    sortOrder: z.number().int().default(0),
  }),
  "products.manage",
  { orderBy: [{ source: "asc" }, { sortOrder: "asc" }, { name: "asc" }] },
);

crud(adminCatalog, "/domain-pricing", "domainPricing", z.object({ tld: z.string().regex(/^\.[a-z0-9.-]+$/), register: z.number().int().min(0), transfer: z.number().int().min(0), renew: z.number().int().min(0), prices: curMapOf({ register: z.number().int().min(0), transfer: z.number().int().min(0), renew: z.number().int().min(0) }), enabled: z.boolean().default(true), registrar: z.string().default("manual") }), "domains.manage", { idField: "tld", orderBy: { tld: "asc" } });

crud(adminCatalog, "/currencies", "currency", z.object({ code: z.string().length(3).toUpperCase(), prefix: z.string(), suffix: z.string().default(""), rate: z.number().positive(), isDefault: z.boolean().default(false), enabled: z.boolean().default(true) }), "settings.manage", { idField: "code" });

/** Pull today's exchange rates from a public FX API (also runs daily when enabled in settings). */
adminCatalog.post(
  "/currencies/refresh-rates",
  requireStaff("settings.manage"),
  ah(async (req, res) => {
    const updated = await refreshExchangeRates().catch((e) => {
      throw badRequest(`Couldn't fetch exchange rates: ${(e as Error).message}`);
    });
    await audit({ actorId: req.user!.id, action: "currency.rates_refreshed", entity: "currency", entityId: "all", details: updated });
    res.json({ updated });
  }),
);

// ───────────── Content ─────────────
crud(adminCatalog, "/announcements", "announcement", z.object({ title: z.string().min(1).max(200), body: z.string().min(1), published: z.boolean().default(true), publishedAt: z.coerce.date().optional() }), "content.manage", { orderBy: { publishedAt: "desc" } });
crud(adminCatalog, "/kb-categories", "kbCategory", z.object({ name: z.string().min(1), slug }), "content.manage", { include: { _count: { select: { articles: true } } } });
crud(adminCatalog, "/kb-articles", "kbArticle", z.object({ categoryId: z.string(), title: z.string().min(1), slug, body: z.string().min(1), published: z.boolean().default(true) }), "content.manage", { orderBy: { updatedAt: "desc" } });
crud(adminCatalog, "/downloads", "download", z.object({ title: z.string().min(1), description: z.string().nullable().optional(), category: z.string().default("General"), url: z.string().url(), clientsOnly: z.boolean().default(true) }), "content.manage");

// ───────────── Payment gateways ─────────────
adminCatalog.get(
  "/gateways",
  requireStaff("payments.manage"),
  ah(async (_req, res) => {
    const rows = await prisma.paymentGateway.findMany({ orderBy: { sortOrder: "asc" } });
    res.json({
      gateways: Object.keys(GATEWAYS).map((code) => {
        const r = rows.find((x) => x.code === code);
        const secrets = r ? decryptJson<Record<string, string>>(r.configEnc) : {};
        return {
          code,
          name: r?.name ?? GATEWAYS[code].name,
          enabled: r?.enabled ?? false,
          testMode: r?.testMode ?? true,
          sortOrder: r?.sortOrder ?? 0,
          offline: !!GATEWAYS[code].offline,
          defaultCurrencies: GATEWAYS[code].currencies,
          currencies: gatewayCurrencies(code, r?.publicConfig),
          fields: GATEWAY_FIELDS[code],
          configured: Object.fromEntries(GATEWAY_FIELDS[code].secret.map((f) => [f, secrets[f] ? `••••${String(secrets[f]).slice(-4)}` : ""])),
          publicConfig: r?.publicConfig ?? {},
          webhookUrl: `/api/webhooks/${code}`,
        };
      }),
    });
  }),
);

adminCatalog.put(
  "/gateways/:code",
  requireStaff("payments.manage"),
  ah(async (req, res) => {
    const code = req.params.code;
    if (!GATEWAYS[code]) throw notFound();
    const b = parse(z.object({ name: z.string().optional(), enabled: z.boolean().optional(), testMode: z.boolean().optional(), sortOrder: z.number().int().optional(), secrets: z.record(z.string()).optional(), publicConfig: z.record(z.any()).optional() }), req.body);
    const existing = await prisma.paymentGateway.findUnique({ where: { code } });
    const secrets = { ...decryptJson<Record<string, string>>(existing?.configEnc) };
    for (const [k, v] of Object.entries(b.secrets ?? {})) if (v && !v.startsWith("••••")) secrets[k] = v.trim();
    if (b.enabled) {
      const missing = GATEWAY_FIELDS[code].secret.filter((f) => !secrets[f] && f !== "webhookSecret" && f !== "webhookId");
      if (missing.length) throw badRequest(`Missing: ${missing.join(", ")}`);
    }
    const data = {
      name: b.name ?? existing?.name ?? GATEWAYS[code].name,
      enabled: b.enabled ?? existing?.enabled ?? false,
      testMode: b.testMode ?? existing?.testMode ?? true,
      sortOrder: b.sortOrder ?? existing?.sortOrder ?? 0,
      configEnc: encryptJson(secrets),
      publicConfig: (b.publicConfig ?? existing?.publicConfig ?? {}) as Prisma.InputJsonValue,
    };
    await prisma.paymentGateway.upsert({ where: { code }, update: data, create: { code, ...data } });
    await audit({ actorId: req.user!.id, action: "gateway.updated", entity: "gateway", entityId: code, details: { enabled: data.enabled, testMode: data.testMode, fieldsChanged: Object.keys(b.secrets ?? {}) } });
    res.json({ ok: true });
  }),
);

// ───────────── Settings ─────────────
adminCatalog.get(
  "/settings",
  requireStaff("settings.manage"),
  ah(async (_req, res) => {
    res.json({ settings: await getSettings() });
  }),
);

adminCatalog.put(
  "/settings/:section",
  requireStaff("settings.manage"),
  ah(async (req, res) => {
    const section = req.params.section as SettingKey;
    if (!(section in DEFAULT_SETTINGS)) throw notFound("Unknown settings section");
    const allowed = Object.keys(DEFAULT_SETTINGS[section]);
    const value = Object.fromEntries(Object.entries(req.body ?? {}).filter(([k]) => allowed.includes(k)));
    const saved = await updateSettings(section, value as never);
    await audit({ actorId: req.user!.id, action: "settings.updated", entity: "settings", entityId: section, details: Object.keys(value) });
    res.json({ [section]: saved });
  }),
);

// ───────────── Email templates ─────────────
adminCatalog.get(
  "/email-templates",
  requireStaff("settings.manage"),
  ah(async (_req, res) => {
    const rows = await prisma.emailTemplate.findMany();
    res.json({
      templates: Object.entries(DEFAULT_TEMPLATES).map(([key, d]) => {
        const r = rows.find((x) => x.key === key);
        return { key, name: d.name, subject: r?.subject ?? d.subject, body: r?.body ?? d.body, enabled: r?.enabled ?? true, customized: !!r };
      }),
    });
  }),
);

adminCatalog.put(
  "/email-templates/:key",
  requireStaff("settings.manage"),
  ah(async (req, res) => {
    const d = DEFAULT_TEMPLATES[req.params.key];
    if (!d) throw notFound();
    const b = parse(z.object({ subject: z.string().min(1), body: z.string().min(1), enabled: z.boolean().default(true) }), req.body);
    await prisma.emailTemplate.upsert({ where: { key: req.params.key }, update: b, create: { key: req.params.key, name: d.name, ...b } });
    res.json({ ok: true });
  }),
);

adminCatalog.delete(
  "/email-templates/:key",
  requireStaff("settings.manage"),
  ah(async (req, res) => {
    await prisma.emailTemplate.deleteMany({ where: { key: req.params.key } });
    res.json({ ok: true });
  }),
);

adminCatalog.post(
  "/email-templates/:key/preview",
  requireStaff("settings.manage"),
  ah(async (req, res) => {
    const d = DEFAULT_TEMPLATES[req.params.key];
    if (!d) throw notFound();
    const s = await getSettings();
    const vars = { company: s.company, appUrl: "https://crapplet.co.in", name: "Asha", invoiceNumber: "CC/2026-27/00042", total: "₹1,178.82", dueDate: "16 Nov 2026", productName: "Linux VPS G2", hostname: "vps1.example.com", ip: "103.0.0.10", username: "root", password: "S4mple#Pass", os: "Ubuntu 24.04", ticketNumber: "CC-100123", subject: "Sample", message: "Sample reply", ...(req.body?.vars ?? {}) };
    const subject = render(req.body?.subject ?? d.subject, vars);
    const body = render(req.body?.body ?? d.body, vars);
    if (req.body?.sendTo) await sendTemplatedEmail({ template: req.params.key, to: String(req.body.sendTo), vars }, { ignoreSuppression: true });
    res.json({ subject, body });
  }),
);

// ───────────── Staff & roles ─────────────
adminCatalog.get(
  "/permissions",
  requireStaff("staff.manage"),
  ah(async (_req, res) => {
    res.json({ permissions: ["*", ...PERMISSIONS] });
  }),
);

crud(adminCatalog, "/roles", "role", z.object({ name: z.string().min(2), description: z.string().nullable().optional(), permissions: z.array(z.string()).default([]) }), "staff.manage", { include: { _count: { select: { users: true } } } });

adminCatalog.get(
  "/staff",
  requireStaff("staff.manage"),
  ah(async (_req, res) => {
    res.json({ staff: await prisma.user.findMany({ where: { type: "STAFF" }, select: { id: true, email: true, firstName: true, lastName: true, status: true, totpEnabled: true, createdAt: true, role: { select: { id: true, name: true } } } }) });
  }),
);

adminCatalog.post(
  "/staff",
  requireStaff("staff.manage"),
  ah(async (req, res) => {
    const b = parse(z.object({ email: z.string().email().toLowerCase(), firstName: z.string().min(1), lastName: z.string().default(""), password: z.string().min(10), roleId: z.string() }), req.body);
    if (await prisma.user.findUnique({ where: { email: b.email } })) throw conflict("Email already in use");
    const u = await prisma.user.create({ data: { type: "STAFF", email: b.email, firstName: b.firstName, lastName: b.lastName, roleId: b.roleId, passwordHash: await bcrypt.hash(b.password, 12), emailVerifiedAt: new Date() } });
    await audit({ actorId: req.user!.id, action: "staff.created", entity: "user", entityId: u.id });
    res.status(201).json({ id: u.id });
  }),
);

adminCatalog.put(
  "/staff/:id",
  requireStaff("staff.manage"),
  ah(async (req, res) => {
    const b = parse(z.object({ firstName: z.string().optional(), lastName: z.string().optional(), roleId: z.string().optional(), status: z.enum(["ACTIVE", "INACTIVE"]).optional(), password: z.string().min(10).optional() }), req.body);
    if (req.params.id === req.user!.id && b.status === "INACTIVE") throw badRequest("You cannot deactivate yourself");
    const { password, ...data } = b;
    await prisma.user.update({ where: { id: req.params.id, type: "STAFF" }, data: { ...data, ...(password ? { passwordHash: await bcrypt.hash(password, 12) } : {}) } });
    if (b.status === "INACTIVE" || password) await prisma.session.updateMany({ where: { userId: req.params.id, revokedAt: null }, data: { revokedAt: new Date() } });
    await audit({ actorId: req.user!.id, action: "staff.updated", entity: "user", entityId: req.params.id, details: Object.keys(b) });
    res.json({ ok: true });
  }),
);
