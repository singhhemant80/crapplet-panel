import { Router } from "express";
import { z } from "zod";
import { prisma, Prisma } from "../../db";
import { ah, badRequest, notFound, parse } from "../../lib/http";
import { audit } from "../../lib/audit";
import { requireAuth, requireStaff } from "../../middleware/auth";
import { formatMoney } from "../../lib/money";
import { invoiceEmailVars } from "../billing/invoices";
import { whatsappQueue } from "../../jobs/queues";
import { WHATSAPP_EVENTS, getWhatsappConfig, redact, render, saveWhatsappConfig, sendManualWhatsapp, testWhatsapp } from "./service";
import { config } from "../../config";

export const adminWhatsapp = Router();
export const clientWhatsapp = Router();

const httpErr = (e: unknown) => {
  const m = (e as Error).message;
  return Object.assign(new Error(m), { status: (e as { status?: number }).status ?? 400 });
};

adminWhatsapp.get(
  "/whatsapp",
  requireStaff("settings.manage"),
  ah(async (_req, res) => {
    const cfg = await getWhatsappConfig();
    const since = new Date(Date.now() - 30 * 86400_000);
    const stats = await prisma.whatsappMessage.groupBy({ by: ["status"], where: { createdAt: { gte: since } }, _count: true });
    res.json({ config: redact(cfg), events: WHATSAPP_EVENTS, stats: Object.fromEntries(stats.map((s) => [s.status, s._count])) });
  }),
);

const eventSchema = z.object({ enabled: z.boolean(), text: z.string().min(1).max(1000), metaTemplate: z.string().max(120).optional(), metaLanguage: z.string().max(12).optional(), metaParams: z.string().max(400).optional() });
adminWhatsapp.put(
  "/whatsapp",
  requireStaff("settings.manage"),
  ah(async (req, res) => {
    const b = parse(
      z.object({
        enabled: z.boolean().optional(),
        provider: z.enum(["meta", "http"]).optional(),
        defaultCountryCode: z.string().regex(/^\d{1,4}$/).optional(),
        meta: z.object({ phoneNumberId: z.string().max(40), apiVersion: z.string().regex(/^v\d+\.\d+$/) }).partial().optional(),
        http: z.object({ url: z.string().max(1000), method: z.enum(["POST", "GET"]), headers: z.string().max(4000), body: z.string().max(4000), successMatch: z.string().max(200) }).partial().optional(),
        events: z.record(z.string(), eventSchema).optional(),
        token: z.string().max(2000).nullable().optional(),
      }),
      req.body,
    );
    if (b.events) for (const k of Object.keys(b.events)) if (!WHATSAPP_EVENTS[k]) throw badRequest(`Unknown event ${k}`);
    if (b.http?.headers) {
      try {
        JSON.parse(b.http.headers.replace(/\{\{\s*token\s*\}\}/g, "x"));
      } catch {
        throw badRequest("Headers must be valid JSON");
      }
    }
    const saved = await saveWhatsappConfig(b as never);
    await audit({ actorId: req.user!.id, action: "settings.updated", entity: "settings", entityId: "whatsapp", details: { fields: Object.keys(b).filter((k) => k !== "token"), tokenChanged: b.token !== undefined } });
    res.json({ config: redact(saved) });
  }),
);

adminWhatsapp.post(
  "/whatsapp/test",
  requireStaff("settings.manage"),
  ah(async (req, res) => {
    const b = parse(z.object({ to: z.string().min(6).max(20), text: z.string().min(1).max(1000) }), req.body);
    try {
      res.json(await testWhatsapp(b.to, b.text));
    } catch (e) {
      throw httpErr(e);
    }
  }),
);

adminWhatsapp.get(
  "/whatsapp/messages",
  requireStaff("clients.view"),
  ah(async (req, res) => {
    const q = parse(z.object({ status: z.string().optional(), userId: z.string().optional(), event: z.string().optional(), page: z.coerce.number().int().min(1).default(1) }), req.query);
    const where: Prisma.WhatsappMessageWhereInput = { ...(q.status ? { status: q.status } : {}), ...(q.userId ? { userId: q.userId } : {}), ...(q.event ? { event: q.event } : {}) };
    const take = 50;
    const [items, total] = await Promise.all([prisma.whatsappMessage.findMany({ where, orderBy: { createdAt: "desc" }, skip: (q.page - 1) * take, take }), prisma.whatsappMessage.count({ where })]);
    const users = new Map((await prisma.user.findMany({ where: { id: { in: [...new Set(items.map((i) => i.userId).filter(Boolean) as string[])] } }, select: { id: true, firstName: true, lastName: true, email: true } })).map((u) => [u.id, u]));
    res.json({ items: items.map((i) => ({ ...i, user: i.userId ? users.get(i.userId) ?? null : null })), total, page: q.page, pages: Math.max(1, Math.ceil(total / take)) });
  }),
);

adminWhatsapp.post(
  "/whatsapp/messages/:id/retry",
  requireStaff("clients.manage"),
  ah(async (req, res) => {
    const m = await prisma.whatsappMessage.findUnique({ where: { id: req.params.id } });
    if (!m) throw notFound();
    if (m.status === "SENT") throw badRequest("Already sent");
    await prisma.whatsappMessage.update({ where: { id: m.id }, data: { status: "QUEUED", error: null } });
    await whatsappQueue().add("retry", { messageId: m.id, vars: {} }, { attempts: 1 });
    res.json({ ok: true });
  }),
);

/** Staff → client message (client page). */
adminWhatsapp.post(
  "/clients/:id/whatsapp",
  requireStaff("clients.manage"),
  ah(async (req, res) => {
    const b = parse(z.object({ text: z.string().min(1).max(1000) }), req.body);
    try {
      const m = await sendManualWhatsapp({ userId: req.params.id, text: b.text, actorId: req.user!.id });
      await audit({ actorId: req.user!.id, userId: req.params.id, action: "client.whatsapp_sent", entity: "whatsappMessage", entityId: m.id });
      res.status(202).json(m);
    } catch (e) {
      throw httpErr(e);
    }
  }),
);

/** Switch a client's WhatsApp notifications on/off (staff). */
adminWhatsapp.put(
  "/clients/:id/whatsapp-pref",
  requireStaff("clients.manage"),
  ah(async (req, res) => {
    const { enabled } = parse(z.object({ enabled: z.boolean() }), req.body);
    await prisma.clientProfile.update({ where: { userId: req.params.id }, data: { whatsappNotifications: enabled } });
    await audit({ actorId: req.user!.id, userId: req.params.id, action: "client.whatsapp_pref", details: { enabled } });
    res.json({ ok: true });
  }),
);

/** WhatsApp payment reminder for one invoice (invoice page). Uses the reminder / overdue message. */
adminWhatsapp.post(
  "/invoices/:id/whatsapp",
  requireStaff("billing.manage"),
  ah(async (req, res) => {
    const inv = await prisma.invoice.findUnique({ where: { id: req.params.id }, include: { user: true } });
    if (!inv) throw notFound();
    if (inv.status !== "UNPAID") throw badRequest("Only unpaid invoices need a reminder");
    const cfg = await getWhatsappConfig();
    const event = inv.dueDate < new Date() ? "invoice.overdue" : "invoice.reminder";
    const vars = { ...invoiceEmailVars(inv, inv.user.firstName), total: formatMoney(inv.total - inv.amountPaid, inv.currency), companyName: "", payLink: `${config.appUrl}/client/invoices/${inv.id}`, clientAreaLink: config.appUrl };
    try {
      const m = await sendManualWhatsapp({ userId: inv.userId, text: render(cfg.events[event].text, vars), actorId: req.user!.id, event, vars });
      await audit({ actorId: req.user!.id, userId: inv.userId, action: "invoice.whatsapp_reminder", entity: "invoice", entityId: inv.id });
      res.status(202).json(m);
    } catch (e) {
      throw httpErr(e);
    }
  }),
);

// ───── client ─────
clientWhatsapp.get(
  "/whatsapp",
  requireAuth,
  ah(async (req, res) => {
    const p = await prisma.clientProfile.findUnique({ where: { userId: req.user!.id }, select: { whatsappNotifications: true } });
    const cfg = await getWhatsappConfig();
    res.json({ available: cfg.enabled, enabled: p?.whatsappNotifications ?? true });
  }),
);
clientWhatsapp.put(
  "/whatsapp",
  requireAuth,
  ah(async (req, res) => {
    const { enabled } = parse(z.object({ enabled: z.boolean() }), req.body);
    await prisma.clientProfile.update({ where: { userId: req.user!.id }, data: { whatsappNotifications: enabled } });
    res.json({ enabled });
  }),
);
