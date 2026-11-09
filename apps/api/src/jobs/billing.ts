/**
 * Daily automation (runs at 09:00 IST via the worker, or manually from Admin → Settings → Run billing now).
 * Every step is idempotent so a re-run on the same day does nothing twice.
 */
import { prisma } from "../db";
import { addCycle, addDays, istDayStart, addMonths } from "../lib/money";
import { getSettings } from "../lib/settings";
import { createInvoice, invoiceEmailVars, applyCreditToInvoice, cancelInvoice, type NewInvoiceItem } from "../modules/billing/invoices";
import { queueEmail } from "../modules/email/mailer";
import { enqueueProvision } from "./queues";
import { CYCLE_LABEL } from "../lib/money";

const dayDiff = (a: Date, b: Date) => Math.round((istDayStart(a).getTime() - istDayStart(b).getTime()) / 86400000);

export async function generateRenewalInvoices() {
  const s = await getSettings();
  const horizon = addDays(new Date(), s.automation.invoiceDaysBeforeDue);
  const services = await prisma.service.findMany({
    where: { status: { in: ["ACTIVE", "SUSPENDED"] }, billingCycle: { not: "ONETIME" }, nextDueDate: { lte: horizon, not: null }, recurringAmount: { gt: 0 } },
    include: { product: true, user: true, addons: { where: { status: "ACTIVE" }, include: { addon: true } } },
  });
  let created = 0;
  for (const svc of services) {
    const periodStart = svc.nextDueDate!;
    const exists = await prisma.invoiceItem.count({ where: { relId: svc.id, type: "SERVICE", periodStart, invoice: { status: { notIn: ["CANCELLED"] } } } });
    if (exists) continue;
    const periodEnd = addCycle(periodStart, svc.billingCycle);
    const items: NewInvoiceItem[] = [
      { type: "SERVICE", relId: svc.id, description: `${svc.product.name} (${CYCLE_LABEL[svc.billingCycle]} renewal)${svc.hostname ? ` — ${svc.hostname}` : ""}`, hsnSac: svc.product.hsnSac, unitPrice: svc.recurringAmount, taxable: svc.product.taxable, periodStart, periodEnd },
      ...svc.addons.map((a) => ({ type: "ADDON" as const, relId: a.id, description: `${a.addon.name} (renewal)`, unitPrice: a.recurringAmount, taxable: a.addon.taxable, periodStart, periodEnd })),
    ];
    const inv = await prisma.$transaction((tx) => createInvoice(tx, { userId: svc.userId, items, dueDate: periodStart, currency: svc.currency }));
    created++;
    let paid = false;
    if (s.automation.applyCreditAutomatically) {
      const prof = await prisma.clientProfile.findUnique({ where: { userId: svc.userId } });
      if (prof && prof.creditBalance > 0) paid = (await applyCreditToInvoice(svc.userId, inv.id).catch(() => ({ paid: false }))).paid;
    }
    if (!paid) await queueEmail("invoice.created", svc.user.email, invoiceEmailVars(inv, svc.user.firstName), svc.userId);
  }

  // domain renewals
  const domains = await prisma.domain.findMany({ where: { status: "ACTIVE", autoRenew: true, nextDueDate: { lte: addDays(new Date(), 30), not: null } }, include: { user: true } });
  for (const d of domains) {
    const periodStart = d.nextDueDate!;
    const exists = await prisma.invoiceItem.count({ where: { relId: d.id, type: "DOMAIN", periodStart, invoice: { status: { notIn: ["CANCELLED"] } } } });
    if (exists) continue;
    const inv = await prisma.$transaction((tx) =>
      createInvoice(tx, { userId: d.userId, dueDate: periodStart, items: [{ type: "DOMAIN", relId: d.id, description: `Domain renewal — ${d.name} (1 yr)`, unitPrice: d.recurringAmount, periodStart, periodEnd: addMonths(periodStart, 12) }] }),
    );
    created++;
    await queueEmail("invoice.created", d.user.email, invoiceEmailVars(inv, d.user.firstName), d.userId);
  }
  return created;
}

export async function sendReminders() {
  const s = await getSettings();
  const today = istDayStart();
  const invoices = await prisma.invoice.findMany({ where: { status: "UNPAID", isWalletTopup: false }, include: { user: true } });
  let sent = 0;
  for (const inv of invoices) {
    if (inv.lastReminderAt && istDayStart(inv.lastReminderAt).getTime() === today.getTime()) continue;
    const d = dayDiff(inv.dueDate, new Date()); // >0 = days until due, <0 = days overdue
    let template: string | null = null;
    if (d > 0 && s.automation.reminderDaysBefore.includes(d)) template = "invoice.reminder";
    else if (d < 0 && s.automation.overdueReminderDaysAfter.includes(-d)) template = "invoice.overdue";
    if (!template) continue;
    await queueEmail(template, inv.user.email, invoiceEmailVars(inv, inv.user.firstName), inv.userId);
    await prisma.invoice.update({ where: { id: inv.id }, data: { remindersSent: { increment: 1 }, lastReminderAt: new Date() } });
    sent++;
  }
  return sent;
}

export async function processSuspensions() {
  const s = await getSettings();
  let suspended = 0,
    terminated = 0;
  if (s.automation.autoSuspend) {
    const cutoff = addDays(new Date(), -s.automation.suspendDaysAfterDue);
    const overdue = await prisma.invoiceItem.findMany({
      where: { type: "SERVICE", relId: { not: null }, invoice: { status: "UNPAID", dueDate: { lt: cutoff } } },
      include: { invoice: true },
    });
    for (const item of overdue) {
      const svc = await prisma.service.findUnique({ where: { id: item.relId! } });
      if (!svc || svc.status !== "ACTIVE" || svc.overrideAutoSuspend) continue;
      await prisma.service.update({ where: { id: svc.id }, data: { suspendReason: `Overdue invoice ${item.invoice.number ?? item.invoice.proformaNumber}` } });
      await enqueueProvision({ serviceId: svc.id, action: "suspend", params: { reason: `Overdue invoice ${item.invoice.number ?? item.invoice.proformaNumber}` } });
      suspended++;
    }
  }
  if (s.automation.autoTerminate) {
    const cutoff = addDays(new Date(), -s.automation.terminateDaysAfterDue);
    const overdue = await prisma.invoiceItem.findMany({
      where: { type: "SERVICE", relId: { not: null }, invoice: { status: "UNPAID", dueDate: { lt: cutoff } } },
      include: { invoice: true },
    });
    for (const item of overdue) {
      const svc = await prisma.service.findUnique({ where: { id: item.relId! } });
      if (!svc || svc.status !== "SUSPENDED" || svc.overrideAutoSuspend || !(svc.suspendReason ?? "").startsWith("Overdue")) continue;
      await enqueueProvision({ serviceId: svc.id, action: "terminate", params: { reason: "Non-payment" } });
      if (item.invoice.amountPaid === 0) await cancelInvoice(item.invoice.id, "Service terminated for non-payment").catch(() => undefined);
      terminated++;
    }
  }
  return { suspended, terminated };
}

export async function domainExpiryAlerts() {
  const domains = await prisma.domain.findMany({ where: { status: "ACTIVE", expiryDate: { not: null, lte: addDays(new Date(), 31) } }, include: { user: true } });
  let sent = 0;
  for (const d of domains) {
    const days = dayDiff(d.expiryDate!, new Date());
    if (![30, 7, 1].includes(days)) continue;
    await queueEmail("domain.expiry", d.user.email, { name: d.user.firstName, domain: d.name, expiryDate: d.expiryDate!.toDateString() }, d.userId);
    sent++;
  }
  const expired = await prisma.domain.updateMany({ where: { status: "ACTIVE", expiryDate: { lt: new Date() } }, data: { status: "EXPIRED" } });
  return { sent, expired: expired.count };
}

export async function autoCloseTickets() {
  const s = await getSettings();
  const r = await prisma.ticket.updateMany({ where: { status: "ANSWERED", lastReplyAt: { lt: new Date(Date.now() - s.support.autoCloseHours * 3600_000) } }, data: { status: "CLOSED", closedAt: new Date() } });
  return r.count;
}

export async function runBillingCycle() {
  const started = Date.now();
  const invoices = await generateRenewalInvoices();
  const reminders = await sendReminders();
  const susp = await processSuspensions();
  const domains = await domainExpiryAlerts();
  const ticketsClosed = await autoCloseTickets();
  const result = { invoices, reminders, ...susp, domainAlerts: domains.sent, domainsExpired: domains.expired, ticketsClosed, ms: Date.now() - started };
  console.log("[billing] daily run", result);
  return result;
}
