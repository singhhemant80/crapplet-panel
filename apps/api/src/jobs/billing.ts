/**
 * Daily automation — the panel's equivalent of the WHMCS cron.
 *
 * Runs once a day at Settings → Automation → run time (IST). A run missed while the worker was down
 * is caught up as soon as it's back, and "Run now" runs it on demand. Every step is idempotent, so a
 * second run on the same day does nothing twice.
 *
 * Each thing a run does is recorded as an AutomationEvent (invoice generated, reminder sent, service
 * suspended, …) so Admin → Automation can show daily counts and the exact items behind each count.
 */
import { prisma } from "../db";
import { addCycle, addDays, istDayStart, addMonths, CYCLE_LABEL } from "../lib/money";
import { getSettings } from "../lib/settings";
import { expireQuotes, pendingForNextInvoice, runBillableItems } from "../modules/billing/extras";
import { addInvoiceItemsTx, createInvoice, invoiceEmailVars, applyCreditToInvoice, cancelInvoice, type NewInvoiceItem } from "../modules/billing/invoices";
import { queueEmail } from "../modules/email/mailer";
import { enqueueProvision } from "./queues";
import { qualifiesForFreeDomain } from "../lib/product-kind";
import { jsonPrice, priceResolver } from "../lib/currency";

const dayDiff = (a: Date, b: Date) => Math.round((istDayStart(a).getTime() - istDayStart(b).getTime()) / 86400000);
const invNo = (i: { number: string | null; proformaNumber: string }) => i.number ?? i.proformaNumber;

// ───────────────────────── recording ─────────────────────────

export interface AutomationEventInput {
  action: string;
  entity?: string;
  entityId?: string;
  userId?: string;
  label?: string;
  success?: boolean;
  message?: string;
}
export type Recorder = (e: AutomationEventInput) => Promise<void>;

/** Records outside a run (e.g. unsuspend on payment) still count toward the day. */
export const recordEvent: Recorder = async (e) => {
  await prisma.automationEvent.create({ data: { ...e, success: e.success ?? true } }).catch((err) => console.error("[automation] record failed", err));
};
const noop: Recorder = async () => {};

// ───────────────────────── tasks ─────────────────────────

export async function generateRenewalInvoices(opts: { userId?: string; rec?: Recorder } = {}) {
  const rec = opts.rec ?? noop;
  const s = await getSettings();
  const a = s.automation;
  const horizon = addDays(new Date(), a.invoiceDaysBeforeDue);
  const services = await prisma.service.findMany({
    where: { ...(opts.userId ? { userId: opts.userId } : {}), status: { in: ["ACTIVE", "SUSPENDED"] }, billingCycle: { not: "ONETIME" }, nextDueDate: { lte: horizon, not: null }, recurringAmount: { gt: 0 } },
    include: { product: true, user: true, addons: { where: { status: "ACTIVE" }, include: { addon: true } } },
  });
  let created = 0;
  for (const svc of services) {
    try {
      const periodStart = svc.nextDueDate!;
      const exists = await prisma.invoiceItem.count({ where: { relId: svc.id, type: "SERVICE", periodStart, invoice: { status: { notIn: ["CANCELLED"] } } } });
      if (exists) continue;
      const periodEnd = addCycle(periodStart, svc.billingCycle);
      const items: NewInvoiceItem[] = [
        { type: "SERVICE", relId: svc.id, description: `${svc.product.name} (${CYCLE_LABEL[svc.billingCycle]} renewal)${svc.hostname ? ` — ${svc.hostname}` : ""}`, hsnSac: svc.product.hsnSac, unitPrice: svc.recurringAmount, taxable: svc.product.taxable, periodStart, periodEnd },
        ...svc.addons.map((x) => ({ type: "ADDON" as const, relId: x.id, description: `${x.addon.name} (renewal)`, unitPrice: x.recurringAmount, taxable: x.addon.taxable, periodStart, periodEnd })),
      ];
      const inv = await prisma.$transaction(async (tx) => {
        // the customer's waiting "add to next invoice" charges ride along with the renewal
        const extra = await pendingForNextInvoice(tx, svc.userId, svc.currency);
        const inv = await createInvoice(tx, { userId: svc.userId, items: [...items, ...extra.lines], dueDate: periodStart, currency: svc.currency });
        await extra.done(inv.id);
        return inv;
      });
      created++;
      await rec({ action: "invoice_created", entity: "invoice", entityId: inv.id, userId: svc.userId, label: `${invNo(inv)} · ${svc.hostname ?? svc.product.name}`, message: `${CYCLE_LABEL[svc.billingCycle]} renewal due ${periodStart.toDateString()}` });
      let paid = false;
      if (a.applyCreditAutomatically) {
        const prof = await prisma.clientProfile.findUnique({ where: { userId: svc.userId } });
        if (prof && prof.creditBalance > 0) {
          const r = await applyCreditToInvoice(svc.userId, inv.id).catch(() => ({ paid: false, applied: 0 }));
          paid = r.paid;
          if ((r as { applied?: number }).applied) await rec({ action: "credit_applied", entity: "invoice", entityId: inv.id, userId: svc.userId, label: invNo(inv), message: paid ? "Paid in full from account credit" : "Part-paid from account credit" });
        }
      }
      if (!paid && a.invoiceCreatedEmail) await queueEmail("invoice.created", svc.user.email, invoiceEmailVars(inv, svc.user.firstName), svc.userId);
    } catch (e) {
      await rec({ action: "error", entity: "service", entityId: svc.id, userId: svc.userId, label: svc.hostname ?? svc.product.name, success: false, message: `Renewal invoice: ${(e as Error).message}` });
    }
  }

  // domain renewals
  const domains = await prisma.domain.findMany({ where: { ...(opts.userId ? { userId: opts.userId } : {}), status: "ACTIVE", autoRenew: true, nextDueDate: { lte: addDays(new Date(), a.domainInvoiceDaysBeforeDue), not: null } }, include: { user: true } });
  for (const d of domains) {
    try {
      const periodStart = d.nextDueDate!;
      const exists = await prisma.invoiceItem.count({ where: { relId: d.id, type: "DOMAIN", periodStart, invoice: { status: { notIn: ["CANCELLED"] } } } });
      if (exists) continue;
      const price = await domainRenewalPrice(d);
      const inv = await prisma.$transaction((tx) =>
        createInvoice(tx, { userId: d.userId, dueDate: periodStart, currency: d.currency, items: [{ type: "DOMAIN", relId: d.id, description: `Domain renewal — ${d.name} (1 yr)${price.freeWith ? ` — free with ${price.freeWith}` : ""}`, unitPrice: price.amount, periodStart, periodEnd: addMonths(periodStart, 12) }] }),
      );
      created++;
      // a free renewal is "paid" straight away — renew it now
      if (inv.status === "PAID") await (await import("../modules/billing/hooks")).onInvoicePaid(inv.id);
      await rec({ action: "invoice_created", entity: "invoice", entityId: inv.id, userId: d.userId, label: `${invNo(inv)} · ${d.name}`, message: "Domain renewal" });
      if (a.invoiceCreatedEmail) await queueEmail("invoice.created", d.user.email, invoiceEmailVars(inv, d.user.firstName), d.userId);
    } catch (e) {
      await rec({ action: "error", entity: "domain", entityId: d.id, userId: d.userId, label: d.name, success: false, message: `Domain renewal invoice: ${(e as Error).message}` });
    }
  }
  return created;
}

export async function sendReminders(rec: Recorder = noop) {
  const s = await getSettings();
  const a = s.automation;
  const today = istDayStart();
  const invoices = await prisma.invoice.findMany({ where: { status: "UNPAID", isWalletTopup: false }, include: { user: true } });
  const overdueDays = [...a.overdueReminderDaysAfter].sort((x, y) => x - y);
  let sent = 0;
  for (const inv of invoices) {
    if (inv.lastReminderAt && istDayStart(inv.lastReminderAt).getTime() === today.getTime()) continue;
    const d = dayDiff(inv.dueDate, new Date()); // >0 = days until due, <0 = days overdue
    let template: string | null = null;
    let action = "";
    if (d > 0 && a.reminderDaysBefore.includes(d)) {
      template = "invoice.reminder";
      action = "reminder_sent";
    } else if (d < 0 && overdueDays.includes(-d)) {
      template = "invoice.overdue";
      const n = overdueDays.indexOf(-d) + 1;
      action = n === 1 ? "overdue_1" : n === 2 ? "overdue_2" : "overdue_3";
    }
    if (!template) continue;
    try {
      await queueEmail(template, inv.user.email, invoiceEmailVars(inv, inv.user.firstName), inv.userId);
      await prisma.invoice.update({ where: { id: inv.id }, data: { remindersSent: { increment: 1 }, lastReminderAt: new Date() } });
      sent++;
      await rec({ action, entity: "invoice", entityId: inv.id, userId: inv.userId, label: `${invNo(inv)} · ${inv.user.email}`, message: d > 0 ? `Due in ${d} day${d === 1 ? "" : "s"}` : `${-d} day${d === -1 ? "" : "s"} overdue` });
    } catch (e) {
      await rec({ action: "error", entity: "invoice", entityId: inv.id, userId: inv.userId, label: invNo(inv), success: false, message: `Reminder: ${(e as Error).message}` });
    }
  }
  return sent;
}

/** Add one late fee to invoices overdue by N days (never twice to the same invoice). */
export async function applyLateFees(rec: Recorder = noop) {
  const a = (await getSettings()).automation;
  const enabled = a.lateFeeEnabled || a.lateFeePct > 0;
  const type = a.lateFeeEnabled ? a.lateFeeType : "percent";
  const value = a.lateFeeEnabled ? a.lateFeeAmount : a.lateFeePct;
  if (!enabled || !(value > 0)) return 0;
  const cutoff = addDays(istDayStart(), -a.lateFeeDaysAfterDue);
  const invoices = await prisma.invoice.findMany({
    where: { status: "UNPAID", isWalletTopup: false, dueDate: { lt: cutoff }, items: { none: { type: "LATE_FEE" } } },
    select: { id: true, number: true, proformaNumber: true, subtotal: true, currency: true, userId: true },
  });
  let added = 0;
  for (const inv of invoices) {
    try {
      let fee = type === "percent" ? Math.round((inv.subtotal * value) / 100) : Math.round(value * 100);
      fee = Math.max(fee, Math.round((a.lateFeeMinimum || 0) * 100));
      if (fee <= 0) continue;
      await prisma.$transaction((tx) => addInvoiceItemsTx(tx, inv.id, [{ type: "LATE_FEE", description: `Late payment fee${type === "percent" ? ` (${value}%)` : ""}`, unitPrice: fee }]));
      added++;
      await rec({ action: "late_fee", entity: "invoice", entityId: inv.id, userId: inv.userId, label: invNo(inv), message: `${(fee / 100).toFixed(2)} ${inv.currency} added` });
    } catch (e) {
      await rec({ action: "error", entity: "invoice", entityId: inv.id, userId: inv.userId, label: invNo(inv), success: false, message: `Late fee: ${(e as Error).message}` });
    }
  }
  return added;
}

/** The automation already queued this action for the service in the last 20 hours. */
const queuedRecently = async (action: string, serviceId: string) =>
  (await prisma.automationEvent.count({ where: { action, entityId: serviceId, success: true, createdAt: { gt: new Date(Date.now() - 20 * 3600_000) } } })) > 0;

export async function processSuspensions(rec: Recorder = noop) {
  const a = (await getSettings()).automation;
  let suspended = 0,
    terminated = 0;
  if (a.autoSuspend) {
    const cutoff = addDays(new Date(), -a.suspendDaysAfterDue);
    const overdue = await prisma.invoiceItem.findMany({
      where: { type: "SERVICE", relId: { not: null }, invoice: { status: "UNPAID", dueDate: { lt: cutoff } } },
      include: { invoice: true },
    });
    const done = new Set<string>();
    for (const item of overdue) {
      if (done.has(item.relId!)) continue;
      const svc = await prisma.service.findUnique({ where: { id: item.relId! }, include: { product: { select: { name: true } } } });
      if (!svc || svc.status !== "ACTIVE" || svc.overrideAutoSuspend) continue;
      done.add(svc.id);
      if (await queuedRecently("suspended", svc.id)) continue; // already queued; the worker hasn't finished it yet
      const reason = `Overdue invoice ${invNo(item.invoice)}`;
      try {
        await prisma.service.update({ where: { id: svc.id }, data: { suspendReason: reason } });
        await enqueueProvision({ serviceId: svc.id, action: "suspend", params: { reason, notify: a.suspendEmail } });
        suspended++;
        await rec({ action: "suspended", entity: "service", entityId: svc.id, userId: svc.userId, label: svc.hostname ?? svc.product.name, message: reason });
      } catch (e) {
        await rec({ action: "error", entity: "service", entityId: svc.id, userId: svc.userId, label: svc.hostname ?? svc.product.name, success: false, message: `Suspend: ${(e as Error).message}` });
      }
    }
  }
  if (a.autoTerminate) {
    const cutoff = addDays(new Date(), -a.terminateDaysAfterDue);
    const overdue = await prisma.invoiceItem.findMany({
      where: { type: "SERVICE", relId: { not: null }, invoice: { status: "UNPAID", dueDate: { lt: cutoff } } },
      include: { invoice: true },
    });
    const done = new Set<string>();
    for (const item of overdue) {
      if (done.has(item.relId!)) continue;
      const svc = await prisma.service.findUnique({ where: { id: item.relId! }, include: { product: { select: { name: true } } } });
      if (!svc || svc.status !== "SUSPENDED" || svc.overrideAutoSuspend || !(svc.suspendReason ?? "").startsWith("Overdue")) continue;
      done.add(svc.id);
      if (await queuedRecently("terminated", svc.id)) continue;
      try {
        await enqueueProvision({ serviceId: svc.id, action: "terminate", params: { reason: "Non-payment", notify: a.terminateEmail } });
        if (item.invoice.amountPaid === 0) await cancelInvoice(item.invoice.id, "Service terminated for non-payment").catch(() => undefined);
        terminated++;
        await rec({ action: "terminated", entity: "service", entityId: svc.id, userId: svc.userId, label: svc.hostname ?? svc.product.name, message: `Non-payment of ${invNo(item.invoice)}` });
      } catch (e) {
        await rec({ action: "error", entity: "service", entityId: svc.id, userId: svc.userId, label: svc.hostname ?? svc.product.name, success: false, message: `Terminate: ${(e as Error).message}` });
      }
    }
  }
  return { suspended, terminated };
}

/** Cancel orders whose first invoice is still unpaid after N days (releases held IPs). */
export async function cancelUnpaidOrders(rec: Recorder = noop) {
  const days = (await getSettings()).automation.cancelUnpaidOrdersAfterDays;
  if (!(days > 0)) return 0;
  const invoices = await prisma.invoice.findMany({
    where: { status: "UNPAID", amountPaid: 0, createdAt: { lt: addDays(new Date(), -days) }, order: { is: { status: "PENDING", statusLocked: false } } },
    include: { order: { select: { id: true, number: true } } },
  });
  let cancelled = 0;
  for (const inv of invoices) {
    try {
      await cancelInvoice(inv.id, `Order cancelled automatically — unpaid after ${days} days`);
      cancelled++;
      await rec({ action: "order_cancelled", entity: "order", entityId: inv.order!.id, userId: inv.userId, label: inv.order!.number, message: `Invoice ${invNo(inv)} unpaid after ${days} days` });
    } catch (e) {
      await rec({ action: "error", entity: "order", entityId: inv.order!.id, userId: inv.userId, label: inv.order!.number, success: false, message: `Cancel order: ${(e as Error).message}` });
    }
  }
  return cancelled;
}

/**
 * Renewal price for a domain. A domain that came free with a hosting plan ("recurring" free domain) stays
 * free only while that plan is active on a qualifying cycle; otherwise it renews at the normal price.
 */
export async function domainRenewalPrice(d: { name: string; userId: string; currency: string; recurringAmount: number }): Promise<{ amount: number; freeWith?: string }> {
  if (d.recurringAmount > 0) return { amount: d.recurringAmount };
  const host = await prisma.service.findFirst({
    where: { userId: d.userId, hostname: d.name, status: { in: ["ACTIVE", "SUSPENDED"] }, product: { freeDomain: "recurring" } },
    include: { product: true },
  });
  if (host && qualifiesForFreeDomain(host.product, host.billingCycle, d.name)) return { amount: 0, freeWith: host.product.name };
  const tld = "." + d.name.split(".").slice(1).join(".");
  const pr = await prisma.domainPricing.findUnique({ where: { tld } });
  if (!pr) throw new Error(`No price for ${tld} renewals — set it in Domain pricing`);
  const r = await priceResolver(d.currency);
  return { amount: r.must(pr.renew, jsonPrice(pr.prices, r.currency.code, "renew"), `${tld} renewals`) };
}

export async function domainExpiryAlerts(rec: Recorder = noop) {
  const a = (await getSettings()).automation;
  const maxDays = Math.max(0, ...a.domainExpiryNoticeDays);
  const domains = await prisma.domain.findMany({ where: { status: "ACTIVE", expiryDate: { not: null, lte: addDays(new Date(), maxDays + 1) } }, include: { user: true } });
  let sent = 0;
  for (const d of domains) {
    const days = dayDiff(d.expiryDate!, new Date());
    if (!a.domainExpiryNoticeDays.includes(days)) continue;
    await queueEmail("domain.expiry", d.user.email, { name: d.user.firstName, domain: d.name, expiryDate: d.expiryDate!.toDateString() }, d.userId);
    sent++;
    await rec({ action: "domain_notice", entity: "domain", entityId: d.id, userId: d.userId, label: d.name, message: `Expires in ${days} day${days === 1 ? "" : "s"}` });
  }
  const expiring = await prisma.domain.findMany({ where: { status: "ACTIVE", expiryDate: { lt: new Date() } }, select: { id: true, name: true, userId: true } });
  if (expiring.length) await prisma.domain.updateMany({ where: { id: { in: expiring.map((d) => d.id) } }, data: { status: "EXPIRED" } });
  for (const d of expiring) await rec({ action: "domain_expired", entity: "domain", entityId: d.id, userId: d.userId, label: d.name });
  return { sent, expired: expiring.length };
}

export async function autoCloseTickets(rec: Recorder = noop) {
  const s = await getSettings();
  if (!(s.support.autoCloseHours > 0)) return 0;
  const where = { status: "ANSWERED" as const, lastReplyAt: { lt: new Date(Date.now() - s.support.autoCloseHours * 3600_000) } };
  const tickets = await prisma.ticket.findMany({ where, select: { id: true, number: true, subject: true, userId: true } });
  if (!tickets.length) return 0;
  await prisma.ticket.updateMany({ where: { id: { in: tickets.map((t) => t.id) } }, data: { status: "CLOSED", closedAt: new Date() } });
  for (const t of tickets) await rec({ action: "ticket_closed", entity: "ticket", entityId: t.id, userId: t.userId ?? undefined, label: `#${t.number} ${t.subject}`, message: `No reply for ${s.support.autoCloseHours} hours` });
  return tickets.length;
}

async function pruneHistory() {
  const days = (await getSettings()).automation.historyDays;
  if (!(days > 0)) return;
  const before = addDays(new Date(), -days);
  await prisma.automationEvent.deleteMany({ where: { createdAt: { lt: before } } });
  await prisma.automationRun.deleteMany({ where: { startedAt: { lt: before } } });
}

// ───────────────────────── the run ─────────────────────────

/** Display order and labels for the counts (shared with the admin page). */
export const AUTOMATION_ACTIONS: Record<string, string> = {
  invoice_created: "Invoices generated",
  credit_applied: "Paid from credit",
  reminder_sent: "Payment reminders",
  overdue_1: "First overdue notices",
  overdue_2: "Second overdue notices",
  overdue_3: "Third overdue notices",
  late_fee: "Late fees added",
  suspended: "Services suspended",
  unsuspended: "Services unsuspended",
  terminated: "Services terminated",
  order_cancelled: "Unpaid orders cancelled",
  domain_notice: "Domain renewal notices",
  domain_expired: "Domains expired",
  ticket_closed: "Tickets closed",
  error: "Failed actions",
};

export async function runAutomation(opts: { trigger: "schedule" | "manual"; actorId?: string } = { trigger: "manual" }) {
  const running = await prisma.automationRun.findFirst({ where: { status: "RUNNING", startedAt: { gt: new Date(Date.now() - 60 * 60_000) } } });
  if (running) return { skipped: "A run is already in progress", runId: running.id };
  const run = await prisma.automationRun.create({ data: { trigger: opts.trigger, triggeredById: opts.actorId } });
  const counts: Record<string, number> = {};
  const rec: Recorder = async (e) => {
    counts[e.action] = (counts[e.action] ?? 0) + 1;
    await prisma.automationEvent.create({ data: { ...e, success: e.success ?? true, runId: run.id } }).catch((err) => console.error("[automation] record failed", err));
  };
  const step = async <T>(name: string, fn: () => Promise<T>) => {
    try {
      return await fn();
    } catch (e) {
      await rec({ action: "error", label: name, success: false, message: (e as Error).message });
      return undefined;
    }
  };
  const started = Date.now();
  // order matters: bill first, then remind, then charge late fees, then suspend
  await step("Renewal invoices", () => generateRenewalInvoices({ rec }));
  await step("Reminders", () => sendReminders(rec));
  await step("Billable items", async () => {
    const r = await runBillableItems();
    if (r.invoices) await rec({ action: "invoice_created", label: "Billable items", message: `${r.items} billable item(s) invoiced on ${r.invoices} invoice(s)` });
  });
  await step("Quotes", () => expireQuotes());
  await step("Late fees", () => applyLateFees(rec));
  await step("Suspensions", () => processSuspensions(rec));
  await step("Unpaid orders", () => cancelUnpaidOrders(rec));
  await step("Domains", () => domainExpiryAlerts(rec));
  await step("Tickets", () => autoCloseTickets(rec));
  await step("History", () => pruneHistory());
  const durationMs = Date.now() - started;
  await prisma.automationRun.update({ where: { id: run.id }, data: { status: "COMPLETED", finishedAt: new Date(), durationMs, summary: counts } });
  console.log("[automation] run", opts.trigger, counts, `${durationMs}ms`);
  return { runId: run.id, counts, durationMs };
}

/** Kept for the "Run billing now" buttons: same as Automation → Run now. */
export async function runBillingCycle(actorId?: string) {
  const r = await runAutomation({ trigger: "manual", actorId });
  const c: Record<string, number> = ("counts" in r ? r.counts : undefined) ?? {};
  return {
    ...r,
    invoices: c.invoice_created ?? 0,
    reminders: (c.reminder_sent ?? 0) + (c.overdue_1 ?? 0) + (c.overdue_2 ?? 0) + (c.overdue_3 ?? 0),
    suspended: c.suspended ?? 0,
    terminated: c.terminated ?? 0,
  };
}

/** When the scheduled run should happen today (IST), as a Date. */
export function scheduledTimeToday(runAt: string, now = new Date()) {
  const [h, m] = (/^(\d{1,2}):(\d{2})$/.exec(runAt) ?? ["", "9", "0"]).slice(1).map(Number);
  return new Date(istDayStart(now).getTime() + (h * 60 + m) * 60_000);
}

/** Worker tick (every few minutes): run today's automation once its time has passed. */
export async function maybeRunScheduled() {
  const a = (await getSettings()).automation;
  if (!a.enabled) return { skipped: "disabled" };
  const now = new Date();
  if (now < scheduledTimeToday(a.runAt, now)) return { skipped: "not yet" };
  const ranToday = await prisma.automationRun.count({ where: { trigger: "schedule", startedAt: { gte: istDayStart(now) } } });
  if (ranToday) return { skipped: "already ran today" };
  return runAutomation({ trigger: "schedule" });
}
