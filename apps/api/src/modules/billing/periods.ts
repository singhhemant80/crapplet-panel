/**
 * The service period an invoice line pays for ("16 Nov 2026 – 15 Dec 2026"), shown on invoices and PDFs.
 * Worked out when the invoice is shown, so every existing invoice gets it without changing billing data:
 *  - renewal / imported lines: their stored start and end;
 *  - a first order's line (no stored start, by design — that's how renewals are told apart): from the invoice date;
 *  - older lines with no dates at all: from the invoice date, by the service's billing cycle.
 * The end shown is the last day covered (the day before the next due date).
 */
import type { BillingCycle } from "../../generated/prisma/enums";
import { prisma } from "../../db";
import { addCycle } from "../../lib/money";

type Line = { type: string; relId: string | null; periodStart: Date | null; periodEnd: Date | null };
export type Period = { from: Date; to: Date };

const DAY = 86400_000;
const PERIOD_TYPES = ["SERVICE", "ADDON", "DOMAIN"];

export async function linePeriods<T extends Line>(items: T[], inv: { issueDate: Date | null; createdAt: Date }): Promise<(T & { period: Period | null })[]> {
  const start0 = inv.issueDate ?? inv.createdAt;
  // services whose lines carry no dates: use their billing cycle
  const need = items.filter((i) => i.type === "SERVICE" && i.relId && !i.periodEnd).map((i) => i.relId!);
  const cycles = new Map<string, BillingCycle>(
    need.length ? (await prisma.service.findMany({ where: { id: { in: need } }, select: { id: true, billingCycle: true } })).map((s) => [s.id, s.billingCycle]) : [],
  );
  return items.map((i) => {
    if (!PERIOD_TYPES.includes(i.type)) return { ...i, period: null };
    let from: Date | null = i.periodStart;
    let end: Date | null = i.periodEnd;
    if (end && !from) from = start0;
    if (!end && i.type === "SERVICE" && i.relId) {
      const c = cycles.get(i.relId);
      if (c && c !== "ONETIME") {
        from = from ?? start0;
        end = addCycle(from, c);
      }
    }
    if (!from || !end || end.getTime() - from.getTime() < DAY) return { ...i, period: null };
    return { ...i, period: { from, to: new Date(end.getTime() - DAY) } };
  });
}
