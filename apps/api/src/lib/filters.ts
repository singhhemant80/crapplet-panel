/**
 * List filters shared by the admin pages.
 * Dates come as YYYY-MM-DD in IST; "to" is inclusive (the whole day).
 */
const IST = 330 * 60_000;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

function istDay(s: unknown): Date | null {
  if (typeof s !== "string" || !DAY.test(s)) return null;
  const t = Date.parse(`${s}T00:00:00Z`);
  return Number.isFinite(t) ? new Date(t - IST) : null;
}

/** `?from=2026-11-01&to=2026-11-15` → `{ gte: 1 Nov 00:00 IST, lt: 16 Nov 00:00 IST }`, or undefined. */
export function dateRange(q: Record<string, unknown>, fromKey = "from", toKey = "to"): { gte?: Date; lt?: Date } | undefined {
  const from = istDay(q[fromKey]);
  const toStart = istDay(q[toKey]);
  if (!from && !toStart) return undefined;
  return { ...(from ? { gte: from } : {}), ...(toStart ? { lt: new Date(toStart.getTime() + 86400_000) } : {}) };
}

export const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
