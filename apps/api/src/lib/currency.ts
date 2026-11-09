/**
 * Multi-currency helpers.
 *
 * INR is the base currency: every catalogue price exists in INR. Other currencies (USD…) can have
 * explicit prices; when one is missing and `currency.autoConvert` is on, it's derived from the INR
 * price with the Currency.rate (units per 1 INR), the configured markup and rounding.
 */
import { prisma, type Db } from "../db";
import { badRequest } from "./http";
import { getSettings } from "./settings";

export const BASE_CURRENCY = "INR";

export type CurrencyRow = { code: string; prefix: string; suffix: string; rate: number; isDefault: boolean; enabled: boolean };

let cache: { at: number; rows: CurrencyRow[] } | null = null;

export async function listCurrencies(db: Db = prisma): Promise<CurrencyRow[]> {
  if (cache && Date.now() - cache.at < 15_000) return cache.rows;
  const rows = (await db.currency.findMany({ orderBy: [{ isDefault: "desc" }, { code: "asc" }] })) as CurrencyRow[];
  cache = { at: Date.now(), rows };
  return rows;
}
export const clearCurrencyCache = () => {
  cache = null;
};

/** Validates a currency code the customer may use. */
export async function requireCurrency(code: string | null | undefined, db: Db = prisma): Promise<CurrencyRow> {
  const c = (code ?? BASE_CURRENCY).toUpperCase();
  const row = (await listCurrencies(db)).find((r) => r.code === c);
  if (!row || (!row.enabled && c !== BASE_CURRENCY)) throw badRequest(`We don't bill in ${c}`);
  return row;
}

/** Rounds a converted minor amount the way the shop wants prices to look. */
export function roundMinor(minor: number, mode: string): number {
  if (minor <= 0) return 0;
  switch (mode) {
    case "whole":
      return Math.ceil(minor / 100) * 100; // 4.12 → 5.00
    case "nice99":
      return Math.max(99, Math.ceil(minor / 100) * 100 - 1); // 4.12 → 4.99
    default:
      return Math.round(minor); // nearest cent
  }
}

/** INR minor units → `cur` minor units using the rate, markup and rounding settings. */
export function convertFromInr(inrMinor: number, cur: Pick<CurrencyRow, "code" | "rate">, opts: { markupPct: number; rounding: string }): number {
  if (cur.code === BASE_CURRENCY) return inrMinor;
  if (!inrMinor) return 0;
  const raw = inrMinor * cur.rate * (1 + (opts.markupPct || 0) / 100);
  return Math.sign(inrMinor) * roundMinor(Math.abs(raw), opts.rounding);
}

/** INR per 1 unit of `cur` — stored on invoices for GST/FEMA reporting. */
export const inrPerUnit = (cur: Pick<CurrencyRow, "code" | "rate">) => (cur.code === BASE_CURRENCY || !cur.rate ? 1 : 1 / cur.rate);

/** Converts any amount back to INR minor units with a stored rate (INR per unit). */
export const toInr = (minor: number, exchangeRate: number | null | undefined) => Math.round(minor * (exchangeRate ?? 1));

/**
 * A price resolver bound to one currency: `price(inr, explicit)` returns the explicit price for
 * that currency when set, else the auto-converted INR price, else null (not sold in that currency).
 */
export async function priceResolver(code: string, db: Db = prisma) {
  const cur = await requireCurrency(code, db);
  const s = await getSettings(db);
  const opts = { markupPct: s.currency.markupPct, rounding: s.currency.rounding };
  const isBase = cur.code === BASE_CURRENCY;
  return {
    currency: cur,
    exchangeRate: inrPerUnit(cur),
    /** explicit price in this currency wins; otherwise convert from INR (if allowed). */
    price(inr: number | null | undefined, explicit?: number | null): number | null {
      if (isBase) return inr ?? null;
      if (explicit !== undefined && explicit !== null && explicit >= 0) return explicit;
      if (inr === null || inr === undefined) return null;
      return s.currency.autoConvert ? convertFromInr(inr, cur, opts) : null;
    },
    /** like price() but throws a friendly error when the item isn't sold in this currency. */
    must(inr: number | null | undefined, explicit: number | null | undefined, what: string): number {
      const v = this.price(inr, explicit);
      if (v === null) throw badRequest(`${what} isn't available in ${cur.code}`);
      return v;
    },
  };
}

/** Reads `{ USD: 499 }`-style per-currency JSON safely. */
export function jsonPrice(map: unknown, code: string, field?: string): number | null {
  if (!map || typeof map !== "object") return null;
  const v = (map as Record<string, unknown>)[code];
  const n = field ? (v && typeof v === "object" ? (v as Record<string, unknown>)[field] : undefined) : v;
  return typeof n === "number" && Number.isFinite(n) ? n : null;
}

/** Refreshes non-base rates from a public FX API (used by the daily job when enabled). */
export async function refreshExchangeRates(db: Db = prisma) {
  const res = await fetch("https://open.er-api.com/v6/latest/INR", { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`FX API HTTP ${res.status}`);
  const j = (await res.json()) as { result?: string; rates?: Record<string, number> };
  if (j.result !== "success" || !j.rates) throw new Error("FX API returned no rates");
  const rows = await db.currency.findMany({ where: { code: { not: BASE_CURRENCY } } });
  const updated: Record<string, number> = {};
  for (const r of rows) {
    const rate = j.rates[r.code];
    if (rate && rate > 0) {
      await db.currency.update({ where: { code: r.code }, data: { rate } });
      updated[r.code] = rate;
    }
  }
  clearCurrencyCache();
  return updated;
}
