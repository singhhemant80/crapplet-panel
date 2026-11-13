/**
 * Admin → Automation: daily-run status (WHMCS "Automation Status") and settings.
 */
import { Router } from "express";
import { z } from "zod";
import { prisma, Prisma } from "../../db";
import { ah, parse } from "../../lib/http";
import { audit } from "../../lib/audit";
import { getSettings, updateSettings } from "../../lib/settings";
import { istDayStart, addDays } from "../../lib/money";
import { requireStaff } from "../../middleware/auth";
import { AUTOMATION_ACTIONS, runAutomation, scheduledTimeToday } from "../../jobs/billing";

export const adminAutomation = Router();

/** YYYY-MM-DD of an instant, in IST */
const istDate = (d: Date) => new Date(d.getTime() + 330 * 60_000).toISOString().slice(0, 10);
/** start of an IST calendar day given as YYYY-MM-DD */
const dayStart = (ymd: string) => new Date(new Date(`${ymd}T00:00:00Z`).getTime() - 330 * 60_000);

adminAutomation.get(
  "/automation/status",
  requireStaff("reports.view"),
  ah(async (req, res) => {
    const days = Math.min(90, Math.max(1, Number(req.query.days) || 30));
    const s = await getSettings();
    const from = addDays(istDayStart(), -(days - 1));
    // counts per IST day and action
    const rows = await prisma.$queryRaw<{ day: string; action: string; n: bigint }[]>(Prisma.sql`
      SELECT to_char(("createdAt" AT TIME ZONE 'UTC') AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM-DD') AS day, action, count(*) AS n
      FROM "AutomationEvent" WHERE "createdAt" >= ${from} GROUP BY 1, 2`);
    const byDay: Record<string, Record<string, number>> = {};
    for (const r of rows) (byDay[r.day] ??= {})[r.action] = Number(r.n);
    const list = Array.from({ length: days }, (_, i) => istDate(addDays(istDayStart(), -i))).map((day) => ({ day, counts: byDay[day] ?? {} }));

    const runs = await prisma.automationRun.findMany({ orderBy: { startedAt: "desc" }, take: 30 });
    const lastScheduled = runs.find((r) => r.trigger === "schedule");
    const now = new Date();
    const todayAt = scheduledTimeToday(s.automation.runAt, now);
    const nextRunAt = !s.automation.enabled ? null : now < todayAt ? todayAt : new Date(todayAt.getTime() + 86400_000);
    // healthy = a scheduled run in the last ~26 h (or automation turned off, or installed today)
    const lastAny = runs[0];
    const healthy = !s.automation.enabled || (!!lastScheduled && now.getTime() - lastScheduled.startedAt.getTime() < 26 * 3600_000);
    res.json({
      settings: s.automation,
      support: { autoCloseHours: s.support.autoCloseHours },
      actions: AUTOMATION_ACTIONS,
      days: list,
      runs,
      lastRun: lastAny ?? null,
      lastScheduledRun: lastScheduled ?? null,
      nextRunAt,
      healthy,
    });
  }),
);

adminAutomation.get(
  "/automation/events",
  requireStaff("reports.view"),
  ah(async (req, res) => {
    const q = parse(z.object({ day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), action: z.string().max(40).optional(), runId: z.string().optional(), page: z.coerce.number().int().min(1).default(1) }), req.query);
    const where: Prisma.AutomationEventWhereInput = {
      ...(q.day ? { createdAt: { gte: dayStart(q.day), lt: new Date(dayStart(q.day).getTime() + 86400_000) } } : {}),
      ...(q.action ? { action: q.action } : {}),
      ...(q.runId ? { runId: q.runId } : {}),
    };
    const take = 50;
    const [items, total] = await Promise.all([prisma.automationEvent.findMany({ where, orderBy: { createdAt: "desc" }, skip: (q.page - 1) * take, take }), prisma.automationEvent.count({ where })]);
    const users = await prisma.user.findMany({ where: { id: { in: [...new Set(items.map((i) => i.userId).filter(Boolean) as string[])] } }, select: { id: true, email: true, firstName: true, lastName: true } });
    const u = new Map(users.map((x) => [x.id, x]));
    res.json({ items: items.map((i) => ({ ...i, user: i.userId ? u.get(i.userId) ?? null : null })), total, page: q.page, pages: Math.max(1, Math.ceil(total / take)) });
  }),
);

adminAutomation.post(
  "/automation/run",
  requireStaff("settings.manage"),
  ah(async (req, res) => {
    const r = await runAutomation({ trigger: "manual", actorId: req.user!.id });
    await audit({ actorId: req.user!.id, action: "automation.run_manual", details: r });
    res.json(r);
  }),
);

const days = z.array(z.coerce.number().int().min(1).max(365)).max(10);
const automationSchema = z.object({
  enabled: z.boolean(),
  runAt: z.string().regex(/^([01]?\d|2[0-3]):[0-5]\d$/, "Use HH:MM (24-hour)"),
  invoiceDaysBeforeDue: z.coerce.number().int().min(0).max(90),
  domainInvoiceDaysBeforeDue: z.coerce.number().int().min(0).max(120),
  invoiceCreatedEmail: z.boolean(),
  applyCreditAutomatically: z.boolean(),
  upiAutopay: z.boolean().optional(),
  autopayGateway: z.enum(["auto", "razorpay", "cashfree"]).optional(),
  autopayDaysBeforeDue: z.number().int().min(2).max(10).optional(),
  reminderDaysBefore: days,
  overdueReminderDaysAfter: days,
  lateFeeEnabled: z.boolean(),
  lateFeeType: z.enum(["percent", "fixed"]),
  lateFeeAmount: z.coerce.number().min(0).max(100000),
  lateFeeMinimum: z.coerce.number().min(0).max(100000),
  lateFeeDaysAfterDue: z.coerce.number().int().min(0).max(365),
  autoSuspend: z.boolean(),
  suspendDaysAfterDue: z.coerce.number().int().min(0).max(365),
  suspendEmail: z.boolean(),
  autoUnsuspend: z.boolean(),
  unsuspendEmail: z.boolean(),
  autoTerminate: z.boolean(),
  terminateDaysAfterDue: z.coerce.number().int().min(1).max(3650),
  terminateEmail: z.boolean(),
  cancelUnpaidOrdersAfterDays: z.coerce.number().int().min(0).max(365),
  domainExpiryNoticeDays: days,
  historyDays: z.coerce.number().int().min(7).max(3650),
  autoCloseHours: z.coerce.number().int().min(0).max(24 * 90),
}).partial();

adminAutomation.put(
  "/automation/settings",
  requireStaff("settings.manage"),
  ah(async (req, res) => {
    const { autoCloseHours, ...b } = parse(automationSchema, req.body);
    const cur = (await getSettings()).automation;
    const next = { ...cur, ...b };
    if (next.autoTerminate && next.autoSuspend && next.terminateDaysAfterDue <= next.suspendDaysAfterDue)
      return void res.status(400).json({ error: "Terminate days must be more than suspend days — a service is suspended first, then terminated" });
    // the new late-fee settings replace the old single percentage
    const saved = await updateSettings("automation", { ...b, ...(b.lateFeeEnabled !== undefined ? { lateFeePct: 0 } : {}) } as never);
    if (autoCloseHours !== undefined) await updateSettings("support", { autoCloseHours } as never);
    await audit({ actorId: req.user!.id, action: "settings.updated", entity: "settings", entityId: "automation", details: Object.keys(req.body ?? {}) });
    res.json({ automation: saved });
  }),
);
