/**
 * Billing health check: finds records that don't add up — invoices, payments, credit, renewals —
 * and fixes the ones that have exactly one right answer. Everything else is listed for staff to review.
 */
import { prisma } from "../../db";
import { addCycle } from "../../lib/money";
import { applyCreditToInvoice, assignTaxNumber, cancelInvoice } from "./invoices";

export type HealthRow = { id: string; label: string; userId?: string | null; customer?: string | null; detail: string; href: string };
export type HealthCheck = {
  key: string;
  title: string;
  /** what's wrong and why it matters, in plain words */
  explain: string;
  severity: "error" | "warn" | "info";
  count: number;
  rows: HealthRow[];
  /** label of the one-click fix, when there's a safe one */
  fix?: string;
};

const SAMPLE = 50;
const rupees = (p: number, c = "INR") => `${c === "INR" ? "₹" : `${c} `}${(p / 100).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const day = (d: Date | null | undefined) => (d ? d.toISOString().slice(0, 10) : "—");
const who = (u: { email: string; firstName: string | null; lastName: string | null } | null | undefined) => (u ? `${u.firstName ?? ""} ${u.lastName ?? ""}`.trim() || u.email : null);
const invNo = (i: { number: string | null; proformaNumber: string }) => i.number ?? i.proformaNumber;
const userSel = { select: { email: true, firstName: true, lastName: true } } as const;

async function importedInvoiceIds(ids: string[]) {
  if (!ids.length) return new Set<string>();
  return new Set((await prisma.legacyMap.findMany({ where: { entity: "invoice", localId: { in: ids } }, select: { localId: true } })).map((r) => r.localId));
}

// ─────────── checks ───────────

/** Unpaid invoices that are already fully covered (or total ₹0) — they should be paid, and their services renewed. */
async function unpaidButCovered() {
  const ids = await prisma.$queryRaw<{ id: string }[]>`SELECT id FROM "Invoice" WHERE status = 'UNPAID' AND "amountPaid" >= total`;
  return ids.map((r) => r.id);
}

/** Paid invoices (made here, not imported) with no tax invoice number. */
async function paidWithoutNumber() {
  const rows = await prisma.invoice.findMany({ where: { status: "PAID", number: null, total: { gt: 0 } }, select: { id: true } });
  const imported = await importedInvoiceIds(rows.map((r) => r.id));
  return rows.map((r) => r.id).filter((id) => !imported.has(id));
}

/** Services whose next due date is earlier than the end of a period they've already paid for. */
async function dueDateBehind() {
  return prisma.$queryRaw<{ id: string; paidUntil: Date; nextDueDate: Date | null }[]>`
    SELECT s.id, MAX(ii."periodEnd") AS "paidUntil", s."nextDueDate"
    FROM "Service" s
    JOIN "InvoiceItem" ii ON ii."relId" = s.id AND ii.type = 'SERVICE' AND ii."periodEnd" IS NOT NULL
    JOIN "Invoice" i ON i.id = ii."invoiceId" AND i.status = 'PAID'
    WHERE s.status IN ('ACTIVE', 'SUSPENDED') AND s."billingCycle" <> 'ONETIME'
    GROUP BY s.id, s."nextDueDate"
    HAVING s."nextDueDate" IS NULL OR MAX(ii."periodEnd") > s."nextDueDate" + interval '1 day'`;
}

/** Two or more open invoices billing the same service for the same or overlapping period. */
async function duplicateRenewals() {
  return prisma.$queryRaw<{ keepId: string; dupId: string; serviceId: string }[]>`
    SELECT a."invoiceId" AS "keepId", b."invoiceId" AS "dupId", a."relId" AS "serviceId"
    FROM "InvoiceItem" a
    JOIN "InvoiceItem" b ON b."relId" = a."relId" AND b.type = 'SERVICE' AND b."invoiceId" <> a."invoiceId"
      AND b."periodStart" IS NOT NULL AND a."periodStart" IS NOT NULL
      AND b."periodStart" < COALESCE(a."periodEnd", a."periodStart" + interval '1 day')
      AND a."periodStart" < COALESCE(b."periodEnd", b."periodStart" + interval '1 day')
    JOIN "Invoice" ia ON ia.id = a."invoiceId" AND ia.status IN ('UNPAID', 'PAID', 'DRAFT')
    JOIN "Invoice" ib ON ib.id = b."invoiceId" AND ib.status IN ('UNPAID', 'DRAFT') AND ib."amountPaid" = 0
    WHERE a.type = 'SERVICE'
      -- keep the paid one, otherwise the older one
      AND (ia.status = 'PAID' OR ia."createdAt" < ib."createdAt" OR (ia."createdAt" = ib."createdAt" AND ia.id < ib.id))`;
}

/** Unpaid invoices still chasing customers for services that have ended. */
async function endedButBilled() {
  return prisma.$queryRaw<{ invoiceId: string; serviceId: string }[]>`
    SELECT DISTINCT i.id AS "invoiceId", s.id AS "serviceId"
    FROM "Invoice" i
    JOIN "InvoiceItem" ii ON ii."invoiceId" = i.id AND ii.type IN ('SERVICE', 'SETUP')
    JOIN "Service" s ON s.id = ii."relId"
    WHERE i.status IN ('UNPAID', 'DRAFT') AND s.status IN ('TERMINATED', 'CANCELLED')`;
}

/** Active services past their due date with no invoice for that period — nobody is being billed. */
async function overdueWithoutInvoice() {
  return prisma.$queryRaw<{ id: string }[]>`
    SELECT s.id FROM "Service" s
    WHERE s.status IN ('ACTIVE', 'SUSPENDED') AND s."billingCycle" <> 'ONETIME' AND s."recurringAmount" > 0
      AND s."nextDueDate" < now() - interval '1 day'
      AND NOT EXISTS (
        SELECT 1 FROM "InvoiceItem" ii JOIN "Invoice" i ON i.id = ii."invoiceId"
        WHERE ii."relId" = s.id AND ii.type = 'SERVICE' AND i.status <> 'CANCELLED'
          AND (ii."periodStart" = s."nextDueDate" OR (ii."periodStart" IS NULL AND i."createdAt" >= s."nextDueDate" - interval '45 days')))`;
}

/** Credit balance that doesn't match the credit history (ledger). */
async function creditLedgerMismatch() {
  return prisma.$queryRaw<{ userId: string; balance: number; ledger: number }[]>`
    SELECT p."userId", p."creditBalance" AS balance, COALESCE(SUM(l.amount), 0)::int AS ledger
    FROM "ClientProfile" p LEFT JOIN "CreditLedger" l ON l."userId" = p."userId"
    GROUP BY p."userId", p."creditBalance"
    HAVING p."creditBalance" <> COALESCE(SUM(l.amount), 0)`;
}

/** Customers with credit sitting unused while they have unpaid invoices in the same currency. */
async function creditNotUsed() {
  return prisma.$queryRaw<{ userId: string; balance: number; unpaid: number; currency: string }[]>`
    SELECT p."userId", p."creditBalance" AS balance, COUNT(i.id)::int AS unpaid, p.currency
    FROM "ClientProfile" p JOIN "Invoice" i ON i."userId" = p."userId" AND i.status = 'UNPAID' AND i."isWalletTopup" = false AND i.currency = p.currency
    WHERE p."creditBalance" > 0
    GROUP BY p."userId", p."creditBalance", p.currency`;
}

/** Money received for invoices that were later cancelled (and not refunded). */
async function cancelledWithPayments() {
  return prisma.$queryRaw<{ id: string; paid: number }[]>`
    SELECT i.id, (COALESCE(SUM(t.amount) FILTER (WHERE t.type = 'PAYMENT'), 0) - COALESCE(SUM(ABS(t.amount)) FILTER (WHERE t.type = 'REFUND'), 0))::int AS paid
    FROM "Invoice" i JOIN "Transaction" t ON t."invoiceId" = i.id
    WHERE i.status = 'CANCELLED'
    GROUP BY i.id
    HAVING COALESCE(SUM(t.amount) FILTER (WHERE t.type = 'PAYMENT'), 0) - COALESCE(SUM(ABS(t.amount)) FILTER (WHERE t.type = 'REFUND'), 0) > 0`;
}

/** Paid invoices (made here) where the recorded payments don't reach the total. */
async function paidShort() {
  const rows = await prisma.$queryRaw<{ id: string; short: number }[]>`SELECT id, (total - "amountPaid")::int AS short FROM "Invoice" WHERE status = 'PAID' AND "amountPaid" < total`;
  const imported = await importedInvoiceIds(rows.map((r) => r.id));
  return rows.filter((r) => !imported.has(r.id));
}

// ─────────── report ───────────

async function invoiceRows(ids: string[], detail: (i: { id: string; total: number; amountPaid: number; currency: string; dueDate: Date; paidAt: Date | null; status: string }) => string): Promise<HealthRow[]> {
  const list = await prisma.invoice.findMany({ where: { id: { in: ids.slice(0, SAMPLE) } }, include: { user: userSel }, orderBy: { createdAt: "desc" } });
  return list.map((i) => ({ id: i.id, label: invNo(i), userId: i.userId, customer: who(i.user), detail: detail(i), href: `/admin/invoices/${i.id}` }));
}
async function serviceRows(ids: string[], detail: (s: { id: string; nextDueDate: Date | null; status: string }) => string): Promise<HealthRow[]> {
  const list = await prisma.service.findMany({ where: { id: { in: ids.slice(0, SAMPLE) } }, include: { user: userSel, product: { select: { name: true } } } });
  return list.map((s) => ({ id: s.id, label: s.hostname || s.product.name, userId: s.userId, customer: who(s.user), detail: detail(s), href: `/admin/services/${s.id}` }));
}
async function userRows(rows: { userId: string; detail: string }[]): Promise<HealthRow[]> {
  const users = await prisma.user.findMany({ where: { id: { in: rows.slice(0, SAMPLE).map((r) => r.userId) } }, select: { id: true, email: true, firstName: true, lastName: true } });
  return rows.slice(0, SAMPLE).map((r) => {
    const u = users.find((x) => x.id === r.userId);
    return { id: r.userId, label: who(u) ?? r.userId, userId: r.userId, customer: u?.email ?? null, detail: r.detail, href: `/admin/clients/${r.userId}` };
  });
}

export async function billingHealth(): Promise<{ checkedAt: string; checks: HealthCheck[] }> {
  const [covered, noNumber, behind, dups, ended, overdue, ledger, idle, cancelledPaid, short] = await Promise.all([
    unpaidButCovered(), paidWithoutNumber(), dueDateBehind(), duplicateRenewals(), endedButBilled(), overdueWithoutInvoice(), creditLedgerMismatch(), creditNotUsed(), cancelledWithPayments(), paidShort(),
  ]);
  const { findSurchargeCredits } = await import("./surcharge-credits");
  const surcharge = await findSurchargeCredits();
  const dupIds = [...new Set(dups.map((d) => d.dupId))];
  const endedInv = [...new Set(ended.map((e) => e.invoiceId))];
  const behindMap = new Map(behind.map((b) => [b.id, b]));
  const shortMap = new Map(short.map((s) => [s.id, s.short]));
  const cpMap = new Map(cancelledPaid.map((c) => [c.id, c.paid]));

  const checks: HealthCheck[] = [
    {
      key: "unpaid_covered", severity: "error", fix: "Mark them paid and renew the services",
      title: "Unpaid invoices that are already fully paid",
      explain: "The payments and credit on these invoices already cover the total (or the total is ₹0), but they still show as unpaid — so the customer's services aren't renewed and reminders keep going out.",
      count: covered.length, rows: await invoiceRows(covered, (i) => `${rupees(i.amountPaid, i.currency)} received of ${rupees(i.total, i.currency)}`),
    },
    {
      key: "due_behind", severity: "error", fix: "Move the due dates to the end of the paid period",
      title: "Paid, but the service still shows payment due",
      explain: "The customer has paid for a period that ends after the service's next due date — the service looks overdue (and may be suspended) even though it's paid. If you moved a due date back on purpose, leave that one alone.",
      count: behind.length, rows: await serviceRows(behind.map((b) => b.id), (s) => `Due ${day(s.nextDueDate)} · paid until ${day(behindMap.get(s.id)?.paidUntil)}`),
    },
    {
      key: "duplicate_renewals", severity: "error", fix: "Cancel the duplicates (unpaid, no payments)",
      title: "The same period billed twice",
      explain: "Two open invoices charge the same service for the same or overlapping period. The extra one (unpaid, nothing received) can be cancelled.",
      count: dupIds.length, rows: await invoiceRows(dupIds, (i) => `Duplicate · due ${day(i.dueDate)} · ${rupees(i.total, i.currency)}`),
    },
    {
      key: "ended_billed", severity: "warn", fix: "Cancel the ended services' unpaid invoices",
      title: "Unpaid invoices for terminated or cancelled services",
      explain: "These invoices still ask customers to pay for services that have ended. Invoices that also bill other things only lose the ended service's lines; part-paid ones are left for you.",
      count: endedInv.length, rows: await invoiceRows(endedInv, (i) => `${rupees(i.total - i.amountPaid, i.currency)} due ${day(i.dueDate)}`),
    },
    {
      key: "overdue_no_invoice", severity: "warn", fix: "Create the missing renewal invoices",
      title: "Overdue services with no invoice",
      explain: "These services passed their due date but no invoice was raised for that period, so nobody is being billed for them.",
      count: overdue.length, rows: await serviceRows(overdue.map((o) => o.id), (s) => `Due ${day(s.nextDueDate)} · ${s.status.toLowerCase()}`),
    },
    {
      key: "paid_no_number", severity: "warn", fix: "Assign tax invoice numbers",
      title: "Paid invoices without a tax invoice number",
      explain: "Every paid invoice needs a GST tax invoice number. Imported WHMCS invoices are not included.",
      count: noNumber.length, rows: await invoiceRows(noNumber, (i) => `Paid ${day(i.paidAt)} · ${rupees(i.total, i.currency)}`),
    },
    {
      key: "surcharge_credit", severity: "warn", fix: "Take back unused fee credit",
      title: "Gateway convenience fees kept as credit",
      explain: "Before the fix, a convenience fee the customer paid to the gateway was added to their account credit.",
      count: surcharge.length,
      rows: surcharge.slice(0, SAMPLE).map((c) => ({ id: c.userId, label: c.name || c.email, userId: c.userId, customer: c.email, detail: `${rupees(c.total, c.currency)} credited · ${rupees(c.removable, c.currency)} unused`, href: `/admin/clients/${c.userId}?tab=credit` })),
    },
    {
      key: "credit_ledger", severity: "warn", fix: "Add a correcting entry to the credit history",
      title: "Credit balance doesn't match the credit history",
      explain: "The balance shown on the account and the sum of its credit log differ (usually from imports or manual database edits). The fix keeps the balance and adds one line to the log so they agree.",
      count: ledger.length, rows: await userRows(ledger.map((l) => ({ userId: l.userId, detail: `Balance ${rupees(l.balance)} · history adds up to ${rupees(l.ledger)}` }))),
    },
    {
      key: "credit_idle", severity: "info", fix: "Apply their credit to unpaid invoices (oldest first)",
      title: "Credit unused while invoices are unpaid",
      explain: "These customers have credit and unpaid invoices in the same currency. Applying it pays the oldest invoices first.",
      count: idle.length, rows: await userRows(idle.map((r) => ({ userId: r.userId, detail: `${rupees(r.balance, r.currency)} credit · ${r.unpaid} unpaid invoice${r.unpaid === 1 ? "" : "s"}` }))),
    },
    {
      key: "cancelled_paid", severity: "warn",
      title: "Cancelled invoices with money received",
      explain: "Payments were recorded on these invoices but they're cancelled and nothing was refunded. Reopen them, refund, or move the money to credit.",
      count: cancelledPaid.length, rows: await invoiceRows(cancelledPaid.map((c) => c.id), (i) => `${rupees(cpMap.get(i.id) ?? 0, i.currency)} received`),
    },
    {
      key: "paid_short", severity: "info",
      title: "Marked paid, but payments don't reach the total",
      explain: "These invoices were marked paid by hand (or written off) — the recorded payments are less than the total. Imported WHMCS invoices are not included.",
      count: short.length, rows: await invoiceRows(short.map((s) => s.id), (i) => `${rupees(shortMap.get(i.id) ?? 0, i.currency)} short of ${rupees(i.total, i.currency)}`),
    },
  ];
  return { checkedAt: new Date().toISOString(), checks };
}

// ─────────── fixes ───────────

export async function fixBillingHealth(key: string): Promise<{ fixed: number; skipped: number; notes: string[] }> {
  const notes: string[] = [];
  let fixed = 0;
  let skipped = 0;
  switch (key) {
    case "unpaid_covered": {
      const { onInvoicePaid } = await import("./hooks");
      for (const id of await unpaidButCovered()) {
        const done = await prisma.$transaction(async (tx) => {
          const r = await tx.invoice.updateMany({ where: { id, status: "UNPAID" }, data: { status: "PAID", paidAt: new Date() } });
          if (r.count) await assignTaxNumber(tx, id);
          return r.count;
        });
        if (done) {
          await onInvoicePaid(id).catch((e) => notes.push(`${id}: ${(e as Error).message}`));
          fixed++;
        } else skipped++;
      }
      break;
    }
    case "due_behind": {
      for (const b of await dueDateBehind()) {
        await prisma.service.update({ where: { id: b.id }, data: { nextDueDate: b.paidUntil, nextInvoiceDate: b.paidUntil } });
        fixed++;
      }
      break;
    }
    case "duplicate_renewals": {
      for (const id of [...new Set((await duplicateRenewals()).map((d) => d.dupId))]) {
        try {
          await cancelInvoice(id, "Cancelled — duplicate of another invoice for the same period");
          fixed++;
        } catch (e) {
          skipped++;
          notes.push(`${id}: ${(e as Error).message}`);
        }
      }
      break;
    }
    case "ended_billed": {
      const { cancelServiceInvoices } = await import("./termination");
      for (const sid of [...new Set((await endedButBilled()).map((e) => e.serviceId))]) {
        const r = await cancelServiceInvoices(sid, { force: true });
        fixed += r.cancelled.length + r.trimmed.length;
        skipped += r.skipped.length;
      }
      if (skipped) notes.push(`${skipped} part-paid invoice(s) left for review — refund or credit the payment first`);
      break;
    }
    case "overdue_no_invoice": {
      const { generateRenewalInvoices } = await import("../../jobs/billing");
      const users = await prisma.service.findMany({ where: { id: { in: (await overdueWithoutInvoice()).map((o) => o.id) } }, select: { userId: true }, distinct: ["userId"] });
      for (const u of users) fixed += await generateRenewalInvoices({ userId: u.userId });
      break;
    }
    case "paid_no_number": {
      for (const id of await paidWithoutNumber()) {
        await assignTaxNumber(prisma, id);
        fixed++;
      }
      break;
    }
    case "surcharge_credit": {
      const { reverseSurchargeCredits } = await import("./surcharge-credits");
      const done = await reverseSurchargeCredits();
      fixed = done.filter((d) => d.removed > 0).length;
      skipped = done.length - fixed;
      break;
    }
    case "credit_ledger": {
      for (const l of await creditLedgerMismatch()) {
        await prisma.creditLedger.create({ data: { userId: l.userId, amount: l.balance - l.ledger, balanceAfter: l.balance, description: "Credit history corrected to match the balance (billing health check)", refType: "healthFix" } });
        fixed++;
      }
      break;
    }
    case "credit_idle": {
      for (const r of await creditNotUsed()) {
        const invs = await prisma.invoice.findMany({ where: { userId: r.userId, status: "UNPAID", isWalletTopup: false, currency: r.currency }, orderBy: [{ dueDate: "asc" }, { createdAt: "asc" }], select: { id: true } });
        for (const i of invs) {
          const left = (await prisma.clientProfile.findUnique({ where: { userId: r.userId }, select: { creditBalance: true } }))?.creditBalance ?? 0;
          if (left <= 0) break;
          await applyCreditToInvoice(r.userId, i.id).then(() => fixed++).catch(() => skipped++);
        }
      }
      break;
    }
    default:
      throw new Error("This check has no automatic fix — open the rows to review them");
  }
  return { fixed, skipped, notes };
}

/** Used by the renewal job: is this period already on an open/paid invoice (even with a different start date)? */
export async function periodAlreadyBilled(serviceId: string, periodStart: Date, cycle: Parameters<typeof addCycle>[1]) {
  const periodEnd = addCycle(periodStart, cycle);
  return (
    (await prisma.invoiceItem.count({
      where: {
        relId: serviceId,
        type: "SERVICE",
        invoice: { status: { notIn: ["CANCELLED", "REFUNDED"] } },
        OR: [
          { periodStart },
          { periodStart: { lt: periodEnd }, periodEnd: { gt: new Date(periodStart.getTime() + 86400_000) } },
          // the first order's line has no start — it runs from the order to periodEnd
          { periodStart: null, invoice: { status: "PAID" }, periodEnd: { gt: new Date(periodStart.getTime() + 86400_000) } },
        ],
      },
    })) > 0
  );
}
