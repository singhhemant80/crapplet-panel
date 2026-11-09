import { INDIAN_STATES } from "../auth/states";

export interface TaxLine {
  amount: number; // minor units, may be negative for discounts
  taxable: boolean;
}

export interface TaxContext {
  enabled: boolean;
  rate: number; // percent e.g. 18
  inclusive: boolean;
  companyStateCode: string;
  applyToForeign: boolean;
  customer: { country: string; stateCode?: string | null; gstin?: string | null };
}

export interface TaxResult {
  subtotal: number; // sum of line amounts (pre-tax when exclusive, gross when inclusive)
  taxableAmount: number;
  cgst: number;
  sgst: number;
  igst: number;
  taxTotal: number;
  total: number;
  rate: number;
  placeOfSupply: string | null;
  placeOfSupplyCode: string | null;
  regime: "INTRA" | "INTER" | "EXPORT" | "NONE";
}

const round = (n: number) => Math.round(n + Number.EPSILON);

/**
 * GST under Indian rules for B2B / B2C supply of services:
 *  - same state as supplier  → CGST + SGST (rate split in half)
 *  - different Indian state  → IGST
 *  - outside India           → export of services, zero-rated (unless configured otherwise)
 */
export function computeGst(lines: TaxLine[], ctx: TaxContext): TaxResult {
  const subtotal = lines.reduce((s, l) => s + l.amount, 0);
  const taxableGross = Math.max(0, lines.filter((l) => l.taxable).reduce((s, l) => s + l.amount, 0));
  const nonTaxable = subtotal - lines.filter((l) => l.taxable).reduce((s, l) => s + l.amount, 0);

  const domestic = (ctx.customer.country || "IN").toUpperCase() === "IN";
  const posCode = domestic ? ctx.customer.gstin?.slice(0, 2) || ctx.customer.stateCode || null : null;
  const placeOfSupply = domestic ? (posCode ? `${INDIAN_STATES[posCode] ?? "Unknown"} (${posCode})` : null) : "Outside India (96)";

  let regime: TaxResult["regime"] = "NONE";
  if (ctx.enabled && ctx.rate > 0) {
    if (!domestic) regime = ctx.applyToForeign ? "INTER" : "EXPORT";
    else regime = posCode && posCode === ctx.companyStateCode ? "INTRA" : "INTER";
  }

  if (regime === "NONE" || regime === "EXPORT") {
    return { subtotal, taxableAmount: taxableGross, cgst: 0, sgst: 0, igst: 0, taxTotal: 0, total: subtotal, rate: 0, placeOfSupply, placeOfSupplyCode: domestic ? posCode : "96", regime };
  }

  let taxableAmount: number;
  let taxTotal: number;
  if (ctx.inclusive) {
    taxableAmount = round((taxableGross * 100) / (100 + ctx.rate));
    taxTotal = taxableGross - taxableAmount;
  } else {
    taxableAmount = taxableGross;
    taxTotal = round((taxableAmount * ctx.rate) / 100);
  }

  let cgst = 0,
    sgst = 0,
    igst = 0;
  if (regime === "INTRA") {
    cgst = Math.floor(taxTotal / 2);
    sgst = taxTotal - cgst;
  } else igst = taxTotal;

  const total = ctx.inclusive ? subtotal : taxableAmount + taxTotal + nonTaxable;
  return { subtotal, taxableAmount, cgst, sgst, igst, taxTotal, total, rate: ctx.rate, placeOfSupply, placeOfSupplyCode: domestic ? posCode : "96", regime };
}
