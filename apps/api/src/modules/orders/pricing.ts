import { coloInvoiceDetails } from "../../lib/product-kind";
import { z } from "zod";
import { prisma, BillingCycle, type Db } from "../../db";
import { badRequest } from "../../lib/http";
import { CYCLE_LABEL, CYCLE_MONTHS } from "../../lib/money";
import { getSettings } from "../../lib/settings";
import { computeGst } from "../billing/gst";
import { BASE_CURRENCY, jsonPrice, priceResolver } from "../../lib/currency";
import { qualifiesForFreeDomain } from "../../lib/product-kind";

type Resolver = Awaited<ReturnType<typeof priceResolver>>;

/**
 * Root password chosen at order time. 10–64 characters with lower case, upper case and a digit; no
 * spaces, quotes or backslashes (they break cloud-init / hypervisor APIs).
 */
const passwordRules = (what: string) =>
  z
    .string()
    .min(10, `${what} must be at least 10 characters`)
    .max(64, `${what} can be at most 64 characters`)
    .regex(/^[\x21-\x7e]+$/, `${what} can't contain spaces or non-ASCII characters`)
    .refine((v) => !/['"`\\]/.test(v), `${what} can't contain quotes or backslashes`)
    .refine((v) => /[a-z]/.test(v) && /[A-Z]/.test(v) && /\d/.test(v), `${what} needs upper case, lower case and a number`);
export const rootPasswordSchema = passwordRules("Root password");
export const hostingPasswordSchema = passwordRules("Password");

export const cartItemSchema = z.object({
  productId: z.string(),
  cycle: z.nativeEnum(BillingCycle),
  osTemplateId: z.string().optional().nullable(),
  hostname: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/, "Invalid hostname")
    .max(120)
    .optional()
    .nullable()
    .or(z.literal("").transform(() => null)),
  serverId: z.string().optional().nullable(),
  ipId: z.string().optional().nullable(),
  config: z.record(z.union([z.string(), z.number(), z.boolean()])).default({}),
  addonIds: z.array(z.string()).default([]),
  quantity: z.number().int().min(1).max(10).default(1),
  /** colocation: the customer's equipment (stored on the service as config.equipment) */
  equipment: z
    .object({
      device: z.string().trim().min(2, "Describe the equipment (make and model)").max(120),
      units: z.number().int().min(1).max(48),
      powerW: z.number().int().min(0).max(20000).nullable().optional(),
      psus: z.number().int().min(1).max(4).nullable().optional(),
      serial: z.string().trim().max(80).nullable().optional(),
      notes: z.string().trim().max(500).nullable().optional(),
    })
    .nullable()
    .optional(),
  /** optional; empty = the panel generates one and emails it */
  rootPassword: rootPasswordSchema.optional().nullable().or(z.literal("").transform(() => null)),
});

export const domainItemSchema = z.object({
  name: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z0-9-]{1,63}(\.[a-z0-9-]{2,63})+$/, "Invalid domain"),
  action: z.enum(["register", "transfer"]),
  years: z.number().int().min(1).max(10).default(1),
  eppCode: z.string().max(100).optional(),
});

export const cartSchema = z.object({
  items: z.array(cartItemSchema).max(20).default([]),
  domains: z.array(domainItemSchema).max(20).default([]),
  promoCode: z.string().trim().toUpperCase().optional().nullable(),
  currency: z.string().default("INR"),
});
export type Cart = z.infer<typeof cartSchema>;

export interface PricedLine {
  kind: "product" | "setup" | "addon" | "domain" | "promo";
  description: string;
  /** domain included free with a hosting plan in the same cart */
  freeWith?: string;
  productId?: string;
  itemIndex?: number;
  domainIndex?: number;
  addonId?: string;
  amount: number; // first payment amount
  recurring: number; // renewal amount per cycle
  taxable: boolean;
  hsnSac?: string;
  cycle?: BillingCycle;
}

export async function loadProductForCart(db: Db, productId: string) {
  const p = await db.product.findFirst({
    where: { OR: [{ id: productId }, { slug: productId }], enabled: true },
    include: { pricing: true, configOptions: true, addons: { include: { addon: true } }, osTemplates: { include: { osTemplate: true } }, servers: true },
  });
  if (!p) throw badRequest(`Product ${productId} is not available`);
  return p;
}

/** Monthly price of selected configurable options. */
function configMonthly(p: Awaited<ReturnType<typeof loadProductForCart>>, cfg: Record<string, unknown>, r: Resolver) {
  const code = r.currency.code;
  let monthly = 0;
  const desc: string[] = [];
  for (const opt of p.configOptions) {
    const v = cfg[opt.key];
    if (v === undefined || v === null || v === "") continue;
    if (opt.type === "SELECT") {
      const choice = (opt.choices as { value: string; label: string; monthly: number; prices?: Record<string, number> }[]).find((c) => c.value === String(v));
      if (!choice) throw badRequest(`Invalid choice for ${opt.label}`);
      const m = r.must(choice.monthly, jsonPrice(choice.prices, code), `${opt.label}: ${choice.label}`);
      monthly += m;
      if (m) desc.push(`${opt.label}: ${choice.label}`);
    } else if (opt.type === "QUANTITY") {
      const q = Number(v);
      if (!Number.isInteger(q) || q < opt.minQty || q > opt.maxQty) throw badRequest(`${opt.label} must be between ${opt.minQty} and ${opt.maxQty}`);
      monthly += q * r.must(opt.unitMonthly, jsonPrice(opt.unitPrices, code), opt.label);
      if (q) desc.push(`${opt.label}: ${q}`);
    } else if (opt.type === "YESNO" && (v === true || v === "1" || v === "true" || v === 1)) {
      monthly += r.must(opt.unitMonthly, jsonPrice(opt.unitPrices, code), opt.label);
      desc.push(opt.label);
    }
  }
  return { monthly, desc };
}

export async function priceCart(cart: Cart, opts: { userId?: string | null; db?: Db; wholesale?: { discountPct: number } | null } = {}) {
  const db = opts.db ?? prisma;
  const settings = await getSettings(db);
  const lines: PricedLine[] = [];
  const products: Awaited<ReturnType<typeof loadProductForCart>>[] = [];

  // A signed-in customer always pays in their account currency; guests choose on the order page.
  let currencyCode = (cart.currency || BASE_CURRENCY).toUpperCase();
  let profile: { country: string; stateCode: string | null; gstin: string | null; currency: string } | null = null;
  if (opts.userId) {
    profile = await db.clientProfile.findUnique({ where: { userId: opts.userId }, select: { country: true, stateCode: true, gstin: true, currency: true } });
    if (profile?.currency) currencyCode = profile.currency;
  }
  const r = await priceResolver(currencyCode, db);
  const code = r.currency.code;
  if (opts.wholesale && code !== BASE_CURRENCY) throw badRequest("Reseller orders are billed in INR");

  for (const [idx, item] of cart.items.entries()) {
    const p = await loadProductForCart(db, item.productId);
    products.push(p);
    const base = p.pricing.find((x) => x.cycle === item.cycle && x.currency === BASE_CURRENCY && x.enabled);
    const own = code === BASE_CURRENCY ? undefined : p.pricing.find((x) => x.cycle === item.cycle && x.currency === code);
    const amount = own && !own.enabled ? null : r.price(base?.price, own?.price);
    if (amount === null) throw badRequest(`${p.name} is not available for ${CYCLE_LABEL[item.cycle]} billing${code !== BASE_CURRENCY ? ` in ${code}` : ""}`);
    let price = { price: amount, setupFee: r.price(base?.setupFee ?? 0, own?.setupFee) ?? 0 };
    if (opts.wholesale) {
      if (!p.resellerEnabled) throw badRequest(`${p.name} is not available to resellers`);
      const ws = await db.wholesalePrice.findUnique({ where: { productId_cycle: { productId: p.id, cycle: item.cycle } } });
      const wsBase = ws?.price ?? price.price;
      price = { ...price, price: Math.round((wsBase * (100 - opts.wholesale.discountPct)) / 100), setupFee: 0 };
    }
    const months = Math.max(1, CYCLE_MONTHS[item.cycle]);
    const cfg = configMonthly(p, item.config, r);
    const recurring = (price.price + cfg.monthly * months) * item.quantity;
    lines.push({
      kind: "product",
      description: `${p.name} (${CYCLE_LABEL[item.cycle]})${item.hostname ? ` — ${item.hostname}` : ""}${cfg.desc.length ? `\n${cfg.desc.join(", ")}` : ""}${(() => {
        const colo = coloInvoiceDetails(p, item.equipment ? { equipment: item.equipment } : undefined);
        return colo ? `\n${colo}` : "";
      })()}`,
      productId: p.id,
      itemIndex: idx,
      amount: recurring,
      recurring: item.cycle === "ONETIME" ? 0 : recurring,
      taxable: p.taxable,
      hsnSac: p.hsnSac,
      cycle: item.cycle,
    });
    if (price.setupFee) lines.push({ kind: "setup", description: `Setup fee — ${p.name}`, productId: p.id, itemIndex: idx, amount: price.setupFee * item.quantity, recurring: 0, taxable: p.taxable, hsnSac: p.hsnSac });
    for (const addonId of item.addonIds) {
      const a = p.addons.find((x) => x.addonId === addonId)?.addon;
      if (!a || !a.enabled) throw badRequest("Invalid add-on selected");
      const amt = r.must(a.monthly, jsonPrice(a.prices, code, "monthly"), a.name) * months * item.quantity;
      const setup = r.price(a.setupFee, jsonPrice(a.prices, code, "setupFee")) ?? 0;
      lines.push({ kind: "addon", description: `${a.name} (add-on for ${p.name})`, addonId: a.id, itemIndex: idx, amount: amt + setup, recurring: amt, taxable: a.taxable, cycle: item.cycle });
    }
    if (item.osTemplateId && !p.osTemplates.some((o) => o.osTemplateId === item.osTemplateId)) throw badRequest(`Selected OS is not available for ${p.name}`);
  }

  // each hosting plan in the cart can include one free domain (WHMCS "free domain" — the plan's own domain)
  const freeUsed = new Set<number>();
  for (const [idx, d] of cart.domains.entries()) {
    const tld = "." + d.name.split(".").slice(1).join(".");
    const pr = await db.domainPricing.findUnique({ where: { tld } });
    if (!pr || !pr.enabled) throw badRequest(`We don't sell ${tld} domains yet`);
    const unit = r.must(d.action === "register" ? pr.register : pr.transfer, jsonPrice(pr.prices, code, d.action), `${tld} domains`);
    const renew = r.must(pr.renew, jsonPrice(pr.prices, code, "renew"), `${tld} renewals`);
    const host = opts.wholesale ? -1 : cart.items.findIndex((it, i) => !freeUsed.has(i) && (it.hostname ?? "").toLowerCase() === d.name && qualifiesForFreeDomain(products[i], it.cycle, d.name));
    const label = `Domain ${d.action === "register" ? "registration" : "transfer"} — ${d.name} (${d.years} yr)`;
    if (host >= 0) {
      freeUsed.add(host);
      const p = products[host];
      // first year free; extra years at the renewal price; "recurring" keeps renewals free while the plan is kept
      lines.push({ kind: "domain", description: `${label} — free with ${p.name}`, domainIndex: idx, amount: renew * (d.years - 1), recurring: p.freeDomain === "recurring" ? 0 : renew, taxable: true, hsnSac: settings.tax.domainSac, freeWith: p.name });
    } else lines.push({ kind: "domain", description: label, domainIndex: idx, amount: unit * d.years, recurring: renew, taxable: true, hsnSac: settings.tax.domainSac });
  }

  // promo code
  let promo: { code: string; discount: number; recurring: boolean } | null = null;
  if (cart.promoCode) {
    const pc = await db.promoCode.findUnique({ where: { code: cart.promoCode } });
    const now = new Date();
    if (!pc || !pc.enabled || (pc.startsAt && pc.startsAt > now) || (pc.expiresAt && pc.expiresAt < now) || (pc.maxUses && pc.uses >= pc.maxUses))
      throw badRequest("This promo code is invalid or has expired");
    if (pc.newOnly && opts.userId) {
      const prior = await db.invoice.count({ where: { userId: opts.userId, status: "PAID", isWalletTopup: false } });
      if (prior) throw badRequest("This promo code is only for new customers");
    }
    let discount = 0;
    const fixed = pc.type === "FIXED" ? r.must(pc.value, jsonPrice(pc.fixedAmounts, code), `Promo code ${pc.code}`) : 0;
    for (const l of lines) {
      if (l.kind !== "product" || !l.productId) continue;
      if (pc.productIds.length && !pc.productIds.includes(l.productId)) continue;
      if (pc.cycles.length && l.cycle && !pc.cycles.includes(l.cycle)) continue;
      discount += pc.type === "PERCENT" ? Math.round((l.amount * pc.value) / 100) : Math.min(fixed, l.amount);
      if (pc.recurring && l.recurring) l.recurring -= pc.type === "PERCENT" ? Math.round((l.recurring * pc.value) / 100) : Math.min(fixed, l.recurring);
    }
    if (!discount) throw badRequest("This promo code doesn't apply to the items in your cart");
    promo = { code: pc.code, discount, recurring: pc.recurring };
    lines.push({ kind: "promo", description: `Promo code ${pc.code}`, amount: -discount, recurring: 0, taxable: true });
  }

  // guests paying in a foreign currency are treated as overseas until they sign in (GST is recomputed at checkout)
  let customer = { country: code === BASE_CURRENCY ? "IN" : "US", stateCode: null as string | null, gstin: null as string | null };
  if (profile) customer = { country: profile.country, stateCode: profile.stateCode, gstin: profile.gstin };
  const tax = computeGst(
    lines.map((l) => ({ amount: l.amount, taxable: l.taxable })),
    { enabled: settings.tax.enabled, rate: settings.tax.gstRate, inclusive: settings.tax.pricesIncludeTax, companyStateCode: settings.company.stateCode, applyToForeign: settings.tax.applyToForeign, customer },
  );
  return { lines, products, promo, tax, currency: code, exchangeRate: r.exchangeRate };
}
