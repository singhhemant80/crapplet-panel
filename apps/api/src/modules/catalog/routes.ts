import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../db";
import { ah, badRequest, clientIp, notFound, parse } from "../../lib/http";
import { requireAuth, requireClient } from "../../middleware/auth";
import { listAvailableIps, releaseIpReservation, reserveIp } from "../ipam/service";
import { cartSchema, priceCart } from "../orders/pricing";
import { checkout } from "../orders/checkout";
import { checkDomain } from "../domains/service";
import { isHostingProduct, isVpsProduct } from "../../lib/product-kind";
import { BASE_CURRENCY, jsonPrice, listCurrencies, priceResolver } from "../../lib/currency";

type Resolvers = Awaited<ReturnType<typeof priceResolver>>[];
/** one price resolver per currency the shop bills in */
async function resolvers(): Promise<Resolvers> {
  const cur = (await listCurrencies()).filter((c) => c.enabled || c.code === BASE_CURRENCY);
  return Promise.all(cur.map((c) => priceResolver(c.code)));
}
/** { INR: x, USD: y } for every currency that has (or can derive) a price */
function perCurrency(rs: Resolvers, inr: number, map: unknown, field?: string) {
  const out: Record<string, number> = {};
  for (const r of rs) {
    const v = r.price(inr, jsonPrice(map, r.currency.code, field));
    if (v !== null) out[r.currency.code] = v;
  }
  return out;
}

export const catalogRouter = Router();

const productInclude = {
  pricing: { where: { enabled: true }, orderBy: { price: "asc" as const } },
  configOptions: { orderBy: { sortOrder: "asc" as const } },
  osTemplates: { include: { osTemplate: true } },
  addons: { include: { addon: true } },
};

function publicProduct(p: Awaited<ReturnType<typeof findProduct>>, rs: Resolvers) {
  if (!p) return null;
  // prices in every billing currency: explicit rows win, otherwise derived from INR
  const pricing = rs.flatMap((r) => {
    const code = r.currency.code;
    const cycles = new Set(p.pricing.map((x) => x.cycle));
    return [...cycles].flatMap((cycle) => {
      const base = p.pricing.find((x) => x.cycle === cycle && x.currency === BASE_CURRENCY && x.enabled);
      const own = code === BASE_CURRENCY ? undefined : p.pricing.find((x) => x.cycle === cycle && x.currency === code);
      if (own && !own.enabled) return [];
      const price = r.price(base?.price, own?.price);
      if (price === null) return [];
      return [{ cycle, currency: code, price, setupFee: r.price(base?.setupFee ?? 0, own?.setupFee) ?? 0, converted: code !== BASE_CURRENCY && !own }];
    });
  });
  return {
    id: p.id,
    legacyPid: p.legacyPid,
    name: p.name,
    slug: p.slug,
    type: p.type,
    tagline: p.tagline,
    description: p.description,
    features: p.features,
    imageUrl: p.imageUrl,
    group: p.group ? { name: p.group.name, slug: p.group.slug } : undefined,
    specs: { cpuCores: p.cpuCores, ramMb: p.ramMb, diskGb: p.diskGb, bandwidthGb: p.bandwidthGb, ipv4Count: p.ipv4Count, ipv6: p.ipv6Enabled, virtType: p.virtType },
    isVps: isVpsProduct(p),
    // shared / reseller / WordPress plans are ordered with a domain first, whichever way they're set up
    isHosting: isHostingProduct(p),
    freeDomain: p.freeDomain === "once" || p.freeDomain === "recurring" ? { type: p.freeDomain, cycles: p.freeDomainCycles, tlds: p.freeDomainTlds } : null,
    allowIpSelection: p.allowIpSelection && p.provisioner !== "VIRTUALIZOR",
    requireHostname: p.requireHostname,
    featured: p.featured,
    outOfStock: p.outOfStock || (p.stockControl && p.stockQty <= 0),
    pricing,
    configOptions: p.configOptions.map((o) => ({
      key: o.key,
      label: o.label,
      type: o.type,
      minQty: o.minQty,
      maxQty: o.maxQty,
      choices: (o.choices as { value: string; label: string; monthly: number; prices?: unknown }[]).map((c) => ({ value: c.value, label: c.label, monthly: c.monthly, prices: perCurrency(rs, c.monthly, c.prices) })),
      unitMonthly: o.unitMonthly,
      unitPrices: perCurrency(rs, o.unitMonthly, o.unitPrices),
    })),
    osTemplates: p.osTemplates
      .filter((o) => o.osTemplate.enabled)
      .map((o) => ({ id: o.osTemplate.id, name: o.osTemplate.name, family: o.osTemplate.family, distro: o.osTemplate.distro ?? o.osTemplate.name.split(" ")[0].toLowerCase(), logoUrl: o.osTemplate.logoUrl, serverId: o.osTemplate.virtualizorServerId }))
      .sort((a, b) => a.family.localeCompare(b.family) || a.name.localeCompare(b.name, undefined, { numeric: true })),
    addons: p.addons.filter((a) => a.addon.enabled).map((a) => ({ id: a.addon.id, name: a.addon.name, description: a.addon.description, monthly: a.addon.monthly, setupFee: a.addon.setupFee, prices: { monthly: perCurrency(rs, a.addon.monthly, a.addon.prices, "monthly"), setupFee: perCurrency(rs, a.addon.setupFee, a.addon.prices, "setupFee") } })),
  };
}

const findProduct = (key: string) =>
  prisma.product.findFirst({
    where: { enabled: true, OR: [{ id: key }, { slug: key }, ...(/^\d+$/.test(key) ? [{ legacyPid: Number(key) }] : [])] },
    include: { ...productInclude, group: true },
  });

catalogRouter.get(
  "/groups",
  ah(async (_req, res) => {
    const groups = await prisma.productGroup.findMany({
      where: { hidden: false },
      orderBy: { sortOrder: "asc" },
      include: { products: { where: { enabled: true, hidden: false }, orderBy: { sortOrder: "asc" }, include: { ...productInclude, group: true } } },
    });
    const rs = await resolvers();
    res.json({ groups: groups.map((g) => ({ id: g.id, legacyGid: g.legacyGid, name: g.name, slug: g.slug, headline: g.headline, description: g.description, products: g.products.map((p) => publicProduct(p, rs)) })) });
  }),
);

/**
 * Plans for the public website's product pages (shared-hosting.html, forex-vps-hosting.html …).
 * ?types=SHARED,WORDPRESS — every enabled, visible plan of those types, in order-page order, so a plan
 * created / hidden / marked out of stock in the admin panel shows up (or goes) on the website by itself.
 */
const MONTHS: Record<string, number> = { MONTHLY: 1, QUARTERLY: 3, SEMIANNUAL: 6, ANNUAL: 12, BIENNIAL: 24, TRIENNIAL: 36 };
let plansCache = new Map<string, { at: number; body: unknown }>();
/** Staff changed a plan — the website shows it on its next load instead of after the 30 s cache. */
export function clearPlansCache() {
  plansCache.clear();
}
catalogRouter.get(
  "/plans",
  ah(async (req, res) => {
    const types = String(req.query.types ?? "").split(",").map((t) => t.trim().toUpperCase()).filter((t) => /^[A-Z_]{2,30}$/.test(t)).slice(0, 10);
    if (!types.length) throw badRequest("Pass ?types=SHARED (comma-separated plan types)");
    const key = types.sort().join(",");
    const hit = plansCache.get(key);
    res.setHeader("cache-control", "public, max-age=30");
    if (hit && Date.now() - hit.at < 30_000) return res.json(hit.body);
    const rows = await prisma.product.findMany({
      where: { enabled: true, hidden: false, type: { in: types as never }, group: { hidden: false } },
      orderBy: [{ group: { sortOrder: "asc" } }, { sortOrder: "asc" }, { name: "asc" }],
      include: { ...productInclude, group: true },
    });
    // types the panel manages (it has at least one plan of that type, even hidden) — the website keeps its
    // own hand-made section for types that have no plans in the panel yet
    const managed = await prisma.product.groupBy({ by: ["type"], where: { type: { in: types as never } } });
    const rs = await resolvers();
    // the price a card shows: monthly if sold monthly, otherwise the cheapest cycle per month
    const display = (pricing: { cycle: string; currency: string; price: number }[], code: string) => {
      const mine = pricing.filter((x) => x.currency === code);
      const m = mine.find((x) => x.cycle === "MONTHLY");
      if (m) return { amount: m.price / 100, per: "mo", cycle: "MONTHLY" };
      const recurring = mine.filter((x) => MONTHS[x.cycle]).sort((a, b) => a.price / MONTHS[a.cycle] - b.price / MONTHS[b.cycle]);
      if (recurring[0]) return { amount: Math.round(recurring[0].price / MONTHS[recurring[0].cycle]) / 100, per: "mo", cycle: recurring[0].cycle };
      const once = mine.find((x) => x.cycle === "ONETIME");
      return once ? { amount: once.price / 100, per: "one-time", cycle: "ONETIME" } : null;
    };
    const body = {
      managedTypes: managed.map((m) => m.type),
      plans: rows.map((row) => {
        const p = publicProduct(row, rs)!;
        return {
          slug: p.slug,
          name: p.name,
          tagline: p.tagline,
          type: p.type,
          group: p.group,
          featured: p.featured,
          outOfStock: p.outOfStock,
          features: p.features.slice(0, 12),
          specs: p.specs,
          freeDomain: p.freeDomain,
          price: { INR: display(p.pricing, "INR"), USD: p.pricing.some((x) => x.currency === "USD" && !x.converted) ? display(p.pricing, "USD") : null },
          orderUrl: `/order/configure?product=${encodeURIComponent(p.slug)}`,
        };
      }),
    };
    if (plansCache.size > 50) plansCache = new Map();
    plansCache.set(key, { at: Date.now(), body });
    res.json(body);
  }),
);

catalogRouter.get(
  "/products/:key",
  ah(async (req, res) => {
    const p = await findProduct(req.params.key);
    if (!p) throw notFound("Product not found");
    res.json({ product: publicProduct(p, await resolvers()) });
  }),
);

/** Locations offering a product, with the number of free IPv4 addresses at each. */
catalogRouter.get(
  "/products/:key/locations",
  ah(async (req, res) => {
    const p = await prisma.product.findFirst({ where: { enabled: true, OR: [{ id: req.params.key }, { slug: req.params.key }] }, include: { servers: { include: { server: { include: { location: true } } } } } });
    if (!p) throw notFound("Product not found");
    const out = [];
    for (const { server } of p.servers.filter((s) => s.server.enabled)) {
      const free = await prisma.ipAddress.count({ where: { serverId: server.id, version: 4, serviceId: null, OR: [{ status: "AVAILABLE" }, { status: "RESERVED", reservedUntil: { lt: new Date() } }] } });
      out.push({ serverId: server.id, name: server.location?.name ?? server.name, code: server.location?.code ?? null, country: server.location?.country ?? "IN", freeIps: free });
    }
    res.json({ locations: out });
  }),
);

catalogRouter.get(
  "/products/:key/ips",
  ah(async (req, res) => {
    const q = parse(z.object({ serverId: z.string().optional(), search: z.string().max(40).optional() }), req.query);
    const p = await prisma.product.findFirst({ where: { enabled: true, OR: [{ id: req.params.key }, { slug: req.params.key }] }, include: { servers: true } });
    if (!p) throw notFound("Product not found");
    if (!p.allowIpSelection || p.provisioner === "VIRTUALIZOR") throw badRequest("This plan assigns IPs automatically");
    const allowed = p.servers.map((s) => s.serverId);
    const serverIds = q.serverId ? allowed.filter((id) => id === q.serverId) : allowed;
    const ips = await listAvailableIps({ serverIds, search: q.search, limit: 256 });
    res.json({ ips });
  }),
);

catalogRouter.post(
  "/ips/:ipId/reserve",
  requireClient,
  ah(async (req, res) => {
    const { productId } = parse(z.object({ productId: z.string() }), req.body);
    const p = await prisma.product.findFirst({ where: { OR: [{ id: productId }, { slug: productId }], enabled: true }, include: { servers: true } });
    if (!p || !p.allowIpSelection || p.provisioner === "VIRTUALIZOR") throw badRequest("This plan does not support IP selection");
    const ip = await reserveIp({ ipId: req.params.ipId, userId: req.user!.id, serverIds: p.servers.map((s) => s.serverId) });
    res.json({ reservation: { ipId: ip.id, address: ip.address, serverId: ip.serverId, expiresAt: ip.reservedUntil } });
  }),
);

catalogRouter.delete(
  "/ips/:ipId/reserve",
  requireClient,
  ah(async (req, res) => {
    res.json({ released: await releaseIpReservation(req.params.ipId, req.user!.id) });
  }),
);

catalogRouter.get(
  "/domains/check",
  ah(async (req, res) => {
    const { name } = parse(z.object({ name: z.string().trim().toLowerCase().regex(/^[a-z0-9-]{1,63}(\.[a-z0-9-]{2,63})+$/, "Enter a domain like example.in") }), req.query);
    const r = await checkDomain(name);
    if (!r.pricing) return res.json(r);
    // add the price in every billing currency
    const row = await prisma.domainPricing.findUnique({ where: { tld: r.tld } });
    const rs = await resolvers();
    res.json({ ...r, prices: { register: perCurrency(rs, r.pricing.register, row?.prices, "register"), transfer: perCurrency(rs, r.pricing.transfer, row?.prices, "transfer"), renew: perCurrency(rs, r.pricing.renew, row?.prices, "renew") } });
  }),
);

/**
 * Domain search for the hosting order step: the name asked for plus the same name on other TLDs we sell
 * (like WHMCS's "suggestions"). `name` may be a bare word ("mybrand") or a full domain.
 */
catalogRouter.get(
  "/domains/search",
  ah(async (req, res) => {
    const { name } = parse(z.object({ name: z.string().trim().toLowerCase().max(80) }), req.query);
    const clean = name.replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/.*$/, "");
    const sld = clean.split(".")[0];
    if (!/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(sld)) throw badRequest("Use letters, numbers and hyphens only, like mybusiness");
    const tlds = await prisma.domainPricing.findMany({ where: { enabled: true }, orderBy: [{ register: "asc" }] });
    if (!tlds.length) throw badRequest("Domain registration isn't available yet");
    const asked = clean.includes(".") ? clean : `${sld}${tlds[0].tld}`;
    const askedTld = "." + asked.split(".").slice(1).join(".");
    const names = [asked, ...tlds.filter((t) => t.tld !== askedTld).slice(0, 7).map((t) => `${sld}${t.tld}`)];
    const rs = await resolvers();
    const results = await Promise.all(
      names.map(async (n) => {
        const r = await checkDomain(n).catch(() => ({ name: n, tld: "." + n.split(".").slice(1).join("."), available: null as boolean | null, pricing: null }));
        const row = tlds.find((t) => t.tld === r.tld);
        return {
          ...r,
          prices: row ? { register: perCurrency(rs, row.register, row.prices, "register"), transfer: perCurrency(rs, row.transfer, row.prices, "transfer"), renew: perCurrency(rs, row.renew, row.prices, "renew") } : null,
        };
      }),
    );
    res.json({ query: asked, result: results[0], suggestions: results.slice(1).filter((r) => r.pricing && r.available !== false) });
  }),
);

catalogRouter.get(
  "/domains/pricing",
  ah(async (_req, res) => {
    const rs = await resolvers();
    const tlds = await prisma.domainPricing.findMany({ where: { enabled: true }, orderBy: { register: "asc" } });
    res.json({
      tlds: tlds.map((t) => ({ ...t, prices: { register: perCurrency(rs, t.register, t.prices, "register"), transfer: perCurrency(rs, t.transfer, t.prices, "transfer"), renew: perCurrency(rs, t.renew, t.prices, "renew") } })),
    });
  }),
);

catalogRouter.get(
  "/currencies",
  ah(async (_req, res) => {
    res.json({ currencies: (await listCurrencies()).filter((c) => c.enabled || c.code === BASE_CURRENCY).map(({ code, prefix, suffix, isDefault }) => ({ code, prefix, suffix, isDefault })) });
  }),
);

catalogRouter.get(
  "/os-templates",
  ah(async (_req, res) => {
    res.json({ osTemplates: await prisma.osTemplate.findMany({ where: { enabled: true }, orderBy: { sortOrder: "asc" }, select: { id: true, name: true, family: true } }) });
  }),
);

// ── Cart ──
catalogRouter.post(
  "/cart/quote",
  ah(async (req, res) => {
    const cart = parse(cartSchema, req.body);
    const r = await priceCart(cart, { userId: req.user?.type === "CLIENT" ? req.user.id : null });
    res.json({ lines: r.lines, promo: r.promo, totals: r.tax, currency: r.currency });
  }),
);

catalogRouter.post(
  "/cart/checkout",
  requireClient,
  ah(async (req, res) => {
    const body = parse(cartSchema.extend({ notes: z.string().max(1000).optional(), useCredit: z.boolean().default(true), acceptTos: z.literal(true, { errorMap: () => ({ message: "Please accept the terms of service" }) }) }), req.body);
    const u = await prisma.user.findUniqueOrThrow({ where: { id: req.user!.id }, include: { profile: true } });
    const { getSettings } = await import("../../lib/settings");
    const s = await getSettings();
    if (s.orders.requireEmailVerification && !u.emailVerifiedAt) throw badRequest("Please verify your email address before ordering");
    if (!u.profile?.address1) throw badRequest("Please complete your billing address before ordering");
    const r = await checkout({ userId: u.id, cart: body, ip: clientIp(req), notes: body.notes, useCredit: body.useCredit });
    res.status(201).json(r);
  }),
);

export { requireAuth };
