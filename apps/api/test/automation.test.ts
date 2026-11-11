/**
 * Daily automation: what one run does, that a second run does nothing twice, that every action is
 * recorded for Admin → Automation, and that the scheduler runs once a day after the set time.
 *   npx tsx --test test/automation.test.ts
 */
import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "../src/db";
import { closeQueues } from "../src/jobs/queues";
import { maybeRunScheduled, runAutomation, scheduledTimeToday } from "../src/jobs/billing";
import { createInvoice } from "../src/modules/billing/invoices";
import { getSettings, updateSettings, clearSettingsCache } from "../src/lib/settings";
import { addDays, istDayStart } from "../src/lib/money";

const RUN = Date.now().toString(36);
let saved: unknown;
let userId = "";
let renewSvc = "";
let overdueSvc = "";
let overdueInv = "";
let orderId = "";

before(async () => {
  saved = (await getSettings()).automation;
  await updateSettings("automation", {
    enabled: true, runAt: "00:00", invoiceDaysBeforeDue: 10, invoiceCreatedEmail: false, applyCreditAutomatically: false,
    reminderDaysBefore: [], overdueReminderDaysAfter: [6],
    lateFeeEnabled: true, lateFeeType: "percent", lateFeeAmount: 10, lateFeeMinimum: 0, lateFeeDaysAfterDue: 3, lateFeePct: 0,
    autoSuspend: true, suspendDaysAfterDue: 3, suspendEmail: false, autoTerminate: true, terminateDaysAfterDue: 30, terminateEmail: false,
    cancelUnpaidOrdersAfterDays: 5,
  } as never);
  const product = await prisma.product.findFirstOrThrow({ where: { pricing: { some: {} } } });
  const user = await prisma.user.create({ data: { email: `auto-${RUN}@t.test`, passwordHash: "x", firstName: "Auto", lastName: "Mation", type: "CLIENT", status: "ACTIVE", profile: { create: { country: "IN", state: "Madhya Pradesh", stateCode: "23", currency: "INR" } } } });
  userId = user.id;
  // due in 5 days → a renewal invoice
  renewSvc = (await prisma.service.create({ data: { userId, productId: product.id, status: "ACTIVE", billingCycle: "MONTHLY", recurringAmount: 50000, firstAmount: 50000, currency: "INR", registrationDate: new Date(), nextDueDate: addDays(new Date(), 5), hostname: `renew-${RUN}.test` } })).id;
  // overdue by 6 days → overdue notice, late fee, suspension
  overdueSvc = (await prisma.service.create({ data: { userId, productId: product.id, status: "ACTIVE", billingCycle: "MONTHLY", recurringAmount: 100000, firstAmount: 100000, currency: "INR", registrationDate: new Date(), nextDueDate: addDays(istDayStart(), -6), hostname: `overdue-${RUN}.test` } })).id;
  const due = addDays(istDayStart(), -6);
  overdueInv = (await prisma.$transaction((tx) => createInvoice(tx, { userId, dueDate: due, items: [{ type: "SERVICE", relId: overdueSvc, description: "VPS renewal", unitPrice: 100000, periodStart: due, periodEnd: addDays(due, 30) }] }))).id;
  // an order whose invoice has been unpaid for 8 days → cancelled
  const oinv = await prisma.$transaction((tx) => createInvoice(tx, { userId, items: [{ type: "SERVICE", description: "New VPS", unitPrice: 30000 }] }));
  await prisma.invoice.update({ where: { id: oinv.id }, data: { createdAt: addDays(new Date(), -8), dueDate: addDays(new Date(), 30) } });
  orderId = (await prisma.order.create({ data: { number: `ORD-AUTO-${RUN}`, userId, total: oinv.total, currency: "INR", status: "PENDING", invoiceId: oinv.id } })).id;
});

after(async () => {
  await updateSettings("automation", saved as never);
  clearSettingsCache();
  await closeQueues().catch(() => undefined);
  await prisma.$disconnect();
});

const eventsFor = (runId: string) => prisma.automationEvent.findMany({ where: { runId, userId } });

test("one run bills, reminds, adds a late fee, suspends, cancels the unpaid order — and records it all", async () => {
  const r = await runAutomation({ trigger: "manual" });
  assert.ok("runId" in r && r.runId);
  const ev = await eventsFor(r.runId!);
  const by = (a: string) => ev.filter((e) => e.action === a);

  // renewal invoice for the service due in 5 days
  const renew = by("invoice_created").find((e) => e.label?.includes(`renew-${RUN}`));
  assert.ok(renew, "renewal invoice recorded");
  assert.equal(await prisma.invoiceItem.count({ where: { relId: renewSvc, type: "SERVICE", invoice: { status: "UNPAID" } } }), 1);

  // first overdue notice on day 6
  assert.equal(by("overdue_1").filter((e) => e.entityId === overdueInv).length, 1);

  // 10 % late fee with GST recomputed: ₹1,000 + ₹100 fee = ₹1,100 taxable, 18 % GST → ₹1,298
  assert.equal(by("late_fee").filter((e) => e.entityId === overdueInv).length, 1);
  const inv = await prisma.invoice.findUniqueOrThrow({ where: { id: overdueInv }, include: { items: true } });
  const fee = inv.items.find((i) => i.type === "LATE_FEE");
  assert.equal(fee?.amount, 10000);
  assert.equal(inv.subtotal, 110000);
  assert.equal(inv.taxTotal, 19800);
  assert.equal(inv.total, 129800);
  assert.equal(inv.cgst + inv.sgst, 19800, "intra-state: CGST + SGST");

  // suspension queued with a reason
  assert.equal(by("suspended").filter((e) => e.entityId === overdueSvc).length, 1);
  assert.match((await prisma.service.findUniqueOrThrow({ where: { id: overdueSvc } })).suspendReason ?? "", /^Overdue invoice/);

  // unpaid order cancelled
  assert.equal(by("order_cancelled").filter((e) => e.entityId === orderId).length, 1);
  assert.equal((await prisma.order.findUniqueOrThrow({ where: { id: orderId }, include: { invoice: true } })).invoice?.status, "CANCELLED");

  // run summary counts what happened
  const run = await prisma.automationRun.findUniqueOrThrow({ where: { id: r.runId! } });
  assert.equal(run.status, "COMPLETED");
  assert.ok(((run.summary as Record<string, number>).late_fee ?? 0) >= 1);
});

test("a second run the same day does nothing twice", async () => {
  const r = await runAutomation({ trigger: "manual" });
  const ev = await eventsFor((r as { runId: string }).runId);
  assert.equal(ev.filter((e) => e.action !== "error").length, 0, `nothing repeated for this customer, got: ${ev.map((e) => e.action).join(", ")}`);
  const inv = await prisma.invoice.findUniqueOrThrow({ where: { id: overdueInv }, include: { items: true } });
  assert.equal(inv.items.filter((i) => i.type === "LATE_FEE").length, 1, "late fee added once");
  assert.equal(await prisma.invoiceItem.count({ where: { relId: renewSvc, type: "SERVICE", invoice: { status: "UNPAID" } } }), 1, "no second renewal invoice");
});

test("scheduler runs once a day, after the set time", async () => {
  assert.equal(scheduledTimeToday("09:30", new Date("2026-11-11T10:00:00Z")).toISOString(), "2026-11-11T04:00:00.000Z", "09:30 IST = 04:00 UTC");
  await prisma.automationRun.deleteMany({ where: { trigger: "schedule", startedAt: { gte: istDayStart() } } });
  const first = await maybeRunScheduled();
  assert.ok("runId" in first, "first tick of the day runs");
  const second = await maybeRunScheduled();
  assert.deepEqual(second, { skipped: "already ran today" });
  await updateSettings("automation", { enabled: false } as never);
  assert.deepEqual(await maybeRunScheduled(), { skipped: "disabled" });
});
