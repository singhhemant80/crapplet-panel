/**
 * Reminders sent to many customers at once:
 *  - email verification links (selected customers, or every unverified one),
 *  - suspended services: "pay this invoice to restore it",
 *  - orders: payment reminder for the order's unpaid invoice, or the suspended-service reminder.
 * Reseller customers are never emailed (white-label); each send is skipped with a reason instead.
 */
import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../db";
import { config } from "../../config";
import { ah, parse } from "../../lib/http";
import { audit } from "../../lib/audit";
import { randomToken, sha256 } from "../../lib/crypto";
import { formatMoney } from "../../lib/money";
import { requireStaff } from "../../middleware/auth";
import { queueEmail } from "../email/mailer";
import { invoiceEmailVars } from "../billing/invoices";

export const adminReminders = Router();

class Skip extends Error {}
const DAY = 86400_000;
type Result = { id: string; ok: boolean; label?: string; reason?: string; sent?: string };

function summary(results: Result[]) {
  const skipped = results.filter((r) => !r.ok);
  const reasons: Record<string, number> = {};
  for (const r of skipped) reasons[r.reason ?? "Skipped"] = (reasons[r.reason ?? "Skipped"] ?? 0) + 1;
  return { sent: results.filter((r) => r.ok).length, skipped: skipped.length, reasons, results };
}

// ───── email verification ─────
const unverifiedWhere = { type: "CLIENT" as const, status: "ACTIVE" as const, emailVerifiedAt: null, ownerResellerId: null };

/** A fresh 24-hour verification link; refused if one went out recently (`within` ms). */
export async function sendVerificationLink(userId: string, within: number) {
  const u = await prisma.user.findUnique({ where: { id: userId }, select: { id: true, type: true, email: true, firstName: true, status: true, emailVerifiedAt: true, ownerResellerId: true } });
  if (!u || u.type !== "CLIENT") throw new Skip("Not a customer");
  if (u.ownerResellerId) throw new Skip("Reseller's customer — not emailed by us");
  if (u.status !== "ACTIVE") throw new Skip(`Account ${u.status.toLowerCase()}`);
  if (u.emailVerifiedAt) throw new Skip("Already verified");
  const recent = await prisma.verificationToken.findFirst({ where: { userId: u.id, type: "EMAIL_VERIFY", createdAt: { gt: new Date(Date.now() - within) } }, select: { id: true } });
  if (recent) throw new Skip(within >= DAY ? "Link already sent in the last 24 hours" : "Link sent less than a minute ago");
  const token = randomToken();
  await prisma.verificationToken.create({ data: { userId: u.id, type: "EMAIL_VERIFY", tokenHash: sha256(token), expiresAt: new Date(Date.now() + DAY) } });
  await queueEmail("auth.verify_email", u.email, { name: u.firstName, link: `${config.appUrl}/client/verify-email?token=${token}` }, u.id);
  return u.email;
}

adminReminders.get(
  "/reminders/verification",
  requireStaff("clients.view"),
  ah(async (_req, res) => {
    const [unverified, notSentToday] = await Promise.all([
      prisma.user.count({ where: unverifiedWhere }),
      prisma.user.count({ where: { ...unverifiedWhere, tokens: { none: { type: "EMAIL_VERIFY", createdAt: { gt: new Date(Date.now() - DAY) } } } } }),
    ]);
    res.json({ unverified, notSentToday });
  }),
);

adminReminders.post(
  "/reminders/verification",
  requireStaff("clients.manage"),
  ah(async (req, res) => {
    const b = parse(z.object({ ids: z.array(z.string()).min(1).max(500).optional(), all: z.literal(true).optional() }).refine((x) => x.ids || x.all, "Choose customers"), req.body);
    const ids = b.all ? (await prisma.user.findMany({ where: unverifiedWhere, select: { id: true }, orderBy: { createdAt: "desc" }, take: 20_000 })).map((u) => u.id) : b.ids!;
    const results: Result[] = [];
    for (const id of ids) {
      try {
        results.push({ id, ok: true, sent: await sendVerificationLink(id, DAY) });
      } catch (e) {
        if (!(e instanceof Skip)) throw e;
        results.push({ id, ok: false, reason: e.message });
      }
    }
    const out = summary(results);
    await audit({ actorId: req.user!.id, action: "client.bulk_verification_sent", entity: "user", entityId: "*", details: { all: !!b.all, sent: out.sent, skipped: out.reasons } });
    res.json({ ...out, results: b.all ? [] : out.results });
  }),
);

// ───── suspended services ─────
/** Remind the customer to pay the invoice that keeps this service suspended. */
export async function remindSuspended(serviceId: string) {
  const svc = await prisma.service.findUnique({ where: { id: serviceId }, include: { user: { select: { email: true, firstName: true, ownerResellerId: true } }, product: { select: { name: true } } } });
  if (!svc) throw new Skip("Service not found");
  if (svc.status !== "SUSPENDED") throw new Skip("Not suspended");
  if (svc.resellerId || svc.user.ownerResellerId) throw new Skip("Sold through a reseller — not emailed by us");
  const inv = await prisma.invoice.findFirst({ where: { userId: svc.userId, status: "UNPAID", items: { some: { relId: svc.id } } }, orderBy: { dueDate: "asc" } });
  if (!inv) throw new Skip("No unpaid invoice — suspended for another reason");
  await queueEmail(
    "service.suspended_reminder",
    svc.user.email,
    { ...invoiceEmailVars(inv, svc.user.firstName), amountDue: formatMoney(inv.total - inv.amountPaid, inv.currency), productName: svc.product.name, hostname: svc.hostname ?? "—" },
    svc.userId,
  );
  await prisma.invoice.update({ where: { id: inv.id }, data: { remindersSent: { increment: 1 }, lastReminderAt: new Date() } });
  return svc.user.email;
}

adminReminders.post(
  "/reminders/suspended",
  requireStaff("billing.manage"),
  ah(async (req, res) => {
    const b = parse(z.object({ ids: z.array(z.string()).min(1).max(500) }), req.body);
    const results: Result[] = [];
    for (const id of b.ids) {
      try {
        results.push({ id, ok: true, sent: await remindSuspended(id) });
      } catch (e) {
        if (!(e instanceof Skip)) throw e;
        results.push({ id, ok: false, reason: e.message });
      }
    }
    const out = summary(results);
    await audit({ actorId: req.user!.id, action: "service.bulk_suspended_reminder", entity: "service", entityId: "*", details: { ids: b.ids, sent: out.sent, skipped: out.reasons } });
    res.json(out);
  }),
);

// ───── orders ─────
/** Unpaid order → payment reminder for its invoice; paid order with suspended services → restore reminder. */
async function remindOrder(orderId: string): Promise<string> {
  const o = await prisma.order.findUnique({ where: { id: orderId }, include: { invoice: true, user: { select: { email: true, firstName: true, ownerResellerId: true } }, services: { where: { status: "SUSPENDED" }, select: { id: true } } } });
  if (!o) throw new Skip("Order not found");
  if (o.resellerId || o.user.ownerResellerId) throw new Skip("Sold through a reseller — not emailed by us");
  if (o.invoice && o.invoice.status === "UNPAID") {
    await queueEmail(o.invoice.dueDate < new Date() ? "invoice.overdue" : "invoice.reminder", o.user.email, invoiceEmailVars(o.invoice, o.user.firstName), o.userId);
    await prisma.invoice.update({ where: { id: o.invoice.id }, data: { remindersSent: { increment: 1 }, lastReminderAt: new Date() } });
    return o.user.email;
  }
  let sent = 0;
  let why = "Nothing to remind about — paid and nothing suspended";
  for (const s of o.services) {
    try {
      await remindSuspended(s.id);
      sent++;
    } catch (e) {
      if (!(e instanceof Skip)) throw e;
      why = e.message;
    }
  }
  if (!sent) throw new Skip(why);
  return o.user.email;
}

adminReminders.post(
  "/reminders/orders",
  requireStaff("billing.manage"),
  ah(async (req, res) => {
    const b = parse(z.object({ ids: z.array(z.string()).min(1).max(500) }), req.body);
    const results: Result[] = [];
    for (const id of b.ids) {
      try {
        results.push({ id, ok: true, sent: await remindOrder(id) });
      } catch (e) {
        if (!(e instanceof Skip)) throw e;
        results.push({ id, ok: false, reason: e.message });
      }
    }
    const out = summary(results);
    await audit({ actorId: req.user!.id, action: "order.bulk_reminder", entity: "order", entityId: "*", details: { ids: b.ids, sent: out.sent, skipped: out.reasons } });
    res.json(out);
  }),
);
