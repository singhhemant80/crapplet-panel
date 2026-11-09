import { BillingCycle } from "../generated/prisma/enums";

export const CYCLE_MONTHS: Record<BillingCycle, number> = {
  ONETIME: 0,
  MONTHLY: 1,
  QUARTERLY: 3,
  SEMIANNUAL: 6,
  ANNUAL: 12,
  BIENNIAL: 24,
  TRIENNIAL: 36,
};

export const CYCLE_LABEL: Record<BillingCycle, string> = {
  ONETIME: "One Time",
  MONTHLY: "Monthly",
  QUARTERLY: "Quarterly",
  SEMIANNUAL: "Semi-Annually",
  ANNUAL: "Annually",
  BIENNIAL: "Biennially",
  TRIENNIAL: "Triennially",
};

/** Add n months, clamping to month end (31 Jan + 1 month = 28/29 Feb). */
export function addMonths(d: Date, n: number): Date {
  const r = new Date(d.getTime());
  const day = r.getUTCDate();
  r.setUTCDate(1);
  r.setUTCMonth(r.getUTCMonth() + n);
  const last = new Date(Date.UTC(r.getUTCFullYear(), r.getUTCMonth() + 1, 0)).getUTCDate();
  r.setUTCDate(Math.min(day, last));
  return r;
}

export function addCycle(d: Date, cycle: BillingCycle): Date {
  return addMonths(d, CYCLE_MONTHS[cycle]);
}

export const addDays = (d: Date, n: number) => new Date(d.getTime() + n * 86400000);

export function formatMoney(minor: number, currency = "INR"): string {
  const v = minor / 100;
  if (currency === "INR") return "₹" + v.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(v);
}

/** Start of day in Asia/Kolkata expressed as a UTC Date. */
export function istDayStart(d = new Date()): Date {
  const ist = new Date(d.getTime() + 330 * 60000);
  return new Date(Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate()) - 330 * 60000);
}

/** Indian financial year label e.g. "2026-27" */
export function financialYear(d = new Date()): string {
  const ist = new Date(d.getTime() + 330 * 60000);
  const y = ist.getUTCFullYear();
  const start = ist.getUTCMonth() >= 3 ? y : y - 1;
  return `${start}-${String((start + 1) % 100).padStart(2, "0")}`;
}
