import express, { Router } from "express";
import { z } from "zod";
import { prisma } from "../../db";
import { ah, badRequest, conflict, notFound, pageParams, parse } from "../../lib/http";
import { audit } from "../../lib/audit";
import { requireStaff } from "../../middleware/auth";
import { campaignQueue } from "../../jobs/queues";
import { getSettings } from "../../lib/settings";
import { getMailConfig } from "../email/mail-config";
import { buildMessage, esc, getTransport } from "../email/mailer";
import { PIXEL, audienceCount, audienceSchema, campaignSchema, markOpened, materialise, renderCampaign, unsubscribe } from "./service";

export const adminCampaigns = Router();
const PERM = "campaigns.manage";
const EDITABLE = ["DRAFT", "SCHEDULED"];

const kick = () => campaignQueue().add("campaign-tick", {}, { removeOnComplete: 50, removeOnFail: 50 }).catch(() => undefined);

adminCampaigns.get(
  "/campaigns",
  requireStaff(PERM),
  ah(async (req, res) => {
    const status = typeof req.query.status === "string" && req.query.status ? req.query.status : undefined;
    const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
    const where = { ...(status ? { status } : {}), ...(q ? { OR: [{ name: { contains: q, mode: "insensitive" as const } }, { subject: { contains: q, mode: "insensitive" as const } }] } : {}) };
    const [rows, byStatus, monthAgg, optedOut, clients] = await Promise.all([
      prisma.emailCampaign.findMany({ where, orderBy: { createdAt: "desc" }, take: 200, select: { id: true, name: true, kind: true, subject: true, status: true, scheduledAt: true, startedAt: true, finishedAt: true, total: true, sent: true, failed: true, skipped: true, opened: true, unsubscribed: true, lastError: true, createdAt: true, updatedAt: true } }),
      prisma.emailCampaign.groupBy({ by: ["status"], _count: true }),
      prisma.emailCampaign.aggregate({ where: { startedAt: { gte: new Date(Date.now() - 30 * 86400_000) } }, _sum: { sent: true, opened: true, unsubscribed: true } }),
      prisma.user.count({ where: { type: "CLIENT", status: "ACTIVE", marketingEmails: false } }),
      prisma.user.count({ where: { type: "CLIENT", status: "ACTIVE" } }),
    ]);
    const counts = Object.fromEntries(byStatus.map((b) => [b.status, b._count]));
    const sent30 = monthAgg._sum.sent ?? 0;
    res.json({
      campaigns: rows,
      counts,
      summary: { sent30, openRate30: sent30 ? (monthAgg._sum.opened ?? 0) / sent30 : null, unsubscribed30: monthAgg._sum.unsubscribed ?? 0, subscribers: clients - optedOut, clients },
    });
  }),
);

/** What the audience builder needs: product types and plans. */
adminCampaigns.get(
  "/campaigns/options",
  requireStaff(PERM),
  ah(async (_req, res) => {
    const products = await prisma.product.findMany({ orderBy: [{ type: "asc" }, { sortOrder: "asc" }], select: { id: true, name: true, type: true, group: { select: { name: true } } } });
    const types = [...new Set(products.map((p) => p.type))];
    res.json({ types, products: products.map((p) => ({ id: p.id, name: p.name, type: p.type, group: p.group?.name ?? null })) });
  }),
);

adminCampaigns.post(
  "/campaigns/audience",
  requireStaff(PERM),
  ah(async (req, res) => {
    const b = parse(z.object({ kind: z.enum(["OFFER", "INFO"]), audience: audienceSchema }), req.body);
    res.json(await audienceCount(b.audience, b.kind));
  }),
);

/** Find customers for "hand-picked" audiences. */
adminCampaigns.get(
  "/campaigns/customers",
  requireStaff(PERM),
  ah(async (req, res) => {
    const q = String(req.query.q ?? "").trim();
    const ids = String(req.query.ids ?? "").split(",").filter(Boolean).slice(0, 500);
    const rows = await prisma.user.findMany({
      where: { type: "CLIENT", ...(ids.length ? { id: { in: ids } } : q ? { OR: [{ email: { contains: q, mode: "insensitive" } }, { firstName: { contains: q, mode: "insensitive" } }, { lastName: { contains: q, mode: "insensitive" } }, { profile: { companyName: { contains: q, mode: "insensitive" } } }] } : {}) },
      take: ids.length ? 500 : 12,
      orderBy: { createdAt: "desc" },
      select: { id: true, email: true, firstName: true, lastName: true, status: true, marketingEmails: true },
    });
    res.json({ customers: rows });
  }),
);

/** Live preview with the staff member's own name in place of the customer's. */
adminCampaigns.post(
  "/campaigns/preview",
  requireStaff(PERM),
  ah(async (req, res) => {
    const b = parse(campaignSchema.pick({ kind: true, subject: true, preheader: true, body: true }).partial({ subject: true, body: true }), req.body);
    const me = await prisma.user.findUniqueOrThrow({ where: { id: req.user!.id }, select: { firstName: true, lastName: true, email: true } });
    const r = await renderCampaign({ kind: b.kind, subject: b.subject || "(no subject)", preheader: b.preheader, body: b.body || "<p style=\"color:#94a3b8\">Your message appears here.</p>" }, me, "preview");
    res.json({ subject: r.subject, html: r.html });
  }),
);

adminCampaigns.post(
  "/campaigns",
  requireStaff(PERM),
  ah(async (req, res) => {
    const b = parse(campaignSchema, req.body);
    const c = await prisma.emailCampaign.create({ data: { ...b, audience: b.audience as never, createdById: req.user!.id } });
    await audit({ actorId: req.user!.id, action: "campaign.created", entity: "EmailCampaign", entityId: c.id, details: { name: c.name, kind: c.kind } });
    res.status(201).json({ campaign: c });
  }),
);

adminCampaigns.get(
  "/campaigns/:id",
  requireStaff(PERM),
  ah(async (req, res) => {
    const c = await prisma.emailCampaign.findUnique({ where: { id: req.params.id } });
    if (!c) throw notFound("Campaign not found");
    const { skip, take, page } = pageParams(req.query);
    const status = typeof req.query.rstatus === "string" && req.query.rstatus ? req.query.rstatus : undefined;
    const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
    const rWhere = { campaignId: c.id, ...(status === "OPENED" ? { openedAt: { not: null } } : status === "UNSUBSCRIBED" ? { unsubscribedAt: { not: null } } : status ? { status } : {}), ...(q ? { email: { contains: q, mode: "insensitive" as const } } : {}) };
    const [recipients, rTotal, by] = await Promise.all([
      prisma.emailCampaignRecipient.findMany({ where: rWhere, orderBy: [{ sentAt: { sort: "desc", nulls: "last" } }, { id: "asc" }], skip, take, select: { id: true, userId: true, email: true, name: true, status: true, error: true, sentAt: true, openedAt: true, unsubscribedAt: true } }),
      prisma.emailCampaignRecipient.count({ where: rWhere }),
      prisma.emailCampaignRecipient.groupBy({ by: ["status"], where: { campaignId: c.id }, _count: true }),
    ]);
    const creator = c.createdById ? await prisma.user.findUnique({ where: { id: c.createdById }, select: { firstName: true, lastName: true, email: true } }) : null;
    res.json({ campaign: c, createdBy: creator, recipients, recipientTotal: rTotal, page, recipientCounts: Object.fromEntries(by.map((x) => [x.status, x._count])), queued: by.find((x) => x.status === "QUEUED")?._count ?? 0 });
  }),
);

adminCampaigns.put(
  "/campaigns/:id",
  requireStaff(PERM),
  ah(async (req, res) => {
    const c = await prisma.emailCampaign.findUnique({ where: { id: req.params.id } });
    if (!c) throw notFound("Campaign not found");
    if (!EDITABLE.includes(c.status)) throw conflict("This campaign has started sending — duplicate it to make changes");
    const b = parse(campaignSchema.partial(), req.body);
    const u = await prisma.emailCampaign.update({ where: { id: c.id }, data: { ...b, audience: b.audience as never } });
    res.json({ campaign: u });
  }),
);

adminCampaigns.delete(
  "/campaigns/:id",
  requireStaff(PERM),
  ah(async (req, res) => {
    const c = await prisma.emailCampaign.findUnique({ where: { id: req.params.id } });
    if (!c) throw notFound("Campaign not found");
    if (["SENDING", "PAUSED", "SCHEDULED"].includes(c.status)) throw conflict("Cancel the campaign first");
    await prisma.emailCampaign.delete({ where: { id: c.id } });
    await audit({ actorId: req.user!.id, action: "campaign.deleted", entity: "EmailCampaign", entityId: c.id, details: { name: c.name } });
    res.json({ ok: true });
  }),
);

adminCampaigns.post(
  "/campaigns/:id/duplicate",
  requireStaff(PERM),
  ah(async (req, res) => {
    const c = await prisma.emailCampaign.findUnique({ where: { id: req.params.id } });
    if (!c) throw notFound("Campaign not found");
    const copy = await prisma.emailCampaign.create({ data: { name: `${c.name} (copy)`.slice(0, 120), kind: c.kind, subject: c.subject, preheader: c.preheader, body: c.body, audience: c.audience as never, perMinute: c.perMinute, createdById: req.user!.id } });
    res.status(201).json({ campaign: copy });
  }),
);

/** Send the email to yourself (or up to 5 addresses) before sending it for real. */
adminCampaigns.post(
  "/campaigns/:id/test",
  requireStaff(PERM),
  ah(async (req, res) => {
    const c = await prisma.emailCampaign.findUnique({ where: { id: req.params.id } });
    if (!c) throw notFound("Campaign not found");
    const b = parse(z.object({ to: z.array(z.string().email()).max(5).optional() }), req.body);
    const me = await prisma.user.findUniqueOrThrow({ where: { id: req.user!.id }, select: { firstName: true, lastName: true, email: true } });
    const to = b.to?.length ? b.to : [me.email];
    const mc = await getMailConfig();
    const t = getTransport(mc);
    if (!t) throw badRequest(mc.host ? "Sending is switched off in Email Delivery" : "Set up a mail server first — Admin → Email Delivery");
    const m = await renderCampaign(c, me, "test");
    const results: { to: string; ok: boolean; error?: string }[] = [];
    for (const addr of to) {
      try {
        await t.sendMail(buildMessage(mc, { to: addr, subject: `[Test] ${m.subject}`, html: m.html }));
        results.push({ to: addr, ok: true });
      } catch (e) {
        results.push({ to: addr, ok: false, error: String((e as Error).message).slice(0, 300) });
      }
    }
    await prisma.emailLog.create({ data: { to: to.join(", ").slice(0, 300), subject: `[Test] ${m.subject}`, template: "campaign-test", status: results.every((r) => r.ok) ? "SENT" : "FAILED", error: results.find((r) => !r.ok)?.error } }).catch(() => undefined);
    res.json({ results });
  }),
);

/** Send now, or schedule. Asks for the staff password (see admin/reauth.ts). */
adminCampaigns.post(
  "/campaigns/:id/send",
  requireStaff(PERM),
  ah(async (req, res) => {
    const b = parse(z.object({ scheduledAt: z.coerce.date().nullable().optional() }), req.body);
    const c = await prisma.emailCampaign.findUnique({ where: { id: req.params.id } });
    if (!c) throw notFound("Campaign not found");
    if (!EDITABLE.includes(c.status)) throw conflict("This campaign has already been sent");
    const a = audienceSchema.parse(c.audience ?? {});
    const { count } = await audienceCount(a, c.kind);
    if (!count) throw badRequest("No customers match this audience");
    if (b.scheduledAt && b.scheduledAt.getTime() > Date.now() + 60_000) {
      const u = await prisma.emailCampaign.update({ where: { id: c.id }, data: { status: "SCHEDULED", scheduledAt: b.scheduledAt, lastError: null } });
      await audit({ actorId: req.user!.id, action: "campaign.scheduled", entity: "EmailCampaign", entityId: c.id, details: { name: c.name, at: b.scheduledAt, audience: count } });
      return void res.json({ campaign: u });
    }
    const ok = await prisma.emailCampaign.updateMany({ where: { id: c.id, status: { in: EDITABLE } }, data: { status: "SENDING", startedAt: new Date(), scheduledAt: null, lastError: null } });
    if (!ok.count) throw conflict("This campaign has already been sent");
    const total = await materialise(c.id);
    await audit({ actorId: req.user!.id, action: "campaign.sent", entity: "EmailCampaign", entityId: c.id, details: { name: c.name, kind: c.kind, recipients: total } });
    await kick();
    res.json({ campaign: await prisma.emailCampaign.findUnique({ where: { id: c.id } }) });
  }),
);

const transition = (action: "pause" | "resume" | "cancel" | "unschedule") =>
  ah(async (req, res) => {
    const c = await prisma.emailCampaign.findUnique({ where: { id: req.params.id } });
    if (!c) throw notFound("Campaign not found");
    const from: Record<typeof action, string[]> = { pause: ["SENDING"], resume: ["PAUSED"], cancel: ["SENDING", "PAUSED", "SCHEDULED"], unschedule: ["SCHEDULED"] };
    const to = { pause: "PAUSED", resume: "SENDING", cancel: "CANCELLED", unschedule: "DRAFT" }[action];
    if (!from[action].includes(c.status)) throw conflict(`Can't ${action} a campaign that is ${c.status.toLowerCase()}`);
    const u = await prisma.emailCampaign.update({ where: { id: c.id }, data: { status: to, ...(action === "unschedule" ? { scheduledAt: null } : {}), ...(action === "resume" ? { lastError: null } : {}), ...(action === "cancel" ? { finishedAt: new Date() } : {}) } });
    if (action === "cancel") await prisma.emailCampaignRecipient.updateMany({ where: { campaignId: c.id, status: "QUEUED" }, data: { status: "SKIPPED", error: "Campaign cancelled" } });
    if (action === "resume") await kick();
    await audit({ actorId: req.user!.id, action: `campaign.${action}`, entity: "EmailCampaign", entityId: c.id, details: { name: c.name } });
    res.json({ campaign: u });
  });
adminCampaigns.post("/campaigns/:id/pause", requireStaff(PERM), transition("pause"));
adminCampaigns.post("/campaigns/:id/resume", requireStaff(PERM), transition("resume"));
adminCampaigns.post("/campaigns/:id/cancel", requireStaff(PERM), transition("cancel"));
adminCampaigns.post("/campaigns/:id/unschedule", requireStaff(PERM), transition("unschedule"));

// ───────── public: open pixel + unsubscribe ─────────

export const publicCampaigns = Router();
const TOKEN = /^[A-Za-z0-9_-]{16,40}$/;

publicCampaigns.get("/e/o/:token.gif", (req, res) => {
  if (TOKEN.test(req.params.token)) void markOpened(req.params.token).catch(() => undefined);
  res.setHeader("content-type", "image/gif");
  res.setHeader("cache-control", "no-store, max-age=0");
  res.end(PIXEL);
});

async function page(title: string, body: string) {
  const s = await getSettings();
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)} · ${esc(s.company.brand)}</title><meta name="robots" content="noindex"></head>
<body style="margin:0;min-height:100vh;display:grid;place-items:center;background:#f6f0ff;font-family:Inter,Segoe UI,Arial,sans-serif;color:#0f172a;padding:16px;box-sizing:border-box">
<div style="max-width:440px;width:100%;background:#fff;border:1px solid #ece4fb;border-radius:18px;overflow:hidden;box-shadow:0 20px 50px -25px rgba(76,29,149,.35)">
<div style="background:linear-gradient(135deg,#a365fe,#7c3aed);color:#fff;padding:18px 24px;font-weight:800;font-size:18px">${esc(s.company.brand)}</div>
<div style="padding:24px;font-size:15px;line-height:1.6">${body}</div></div></body></html>`;
}

publicCampaigns.get(
  "/e/u/:token",
  ah(async (req, res) => {
    const ok = TOKEN.test(req.params.token) && (await prisma.emailCampaignRecipient.findUnique({ where: { token: req.params.token }, select: { email: true, unsubscribedAt: true } }));
    res.setHeader("cache-control", "no-store");
    if (!ok) return void res.status(404).send(await page("Link expired", `<h1 style="font-size:20px;margin:0 0 8px">This link has expired</h1><p style="margin:0;color:#475569">You can turn offers on or off any time in your client area under <b>Profile</b>.</p>`));
    if (ok.unsubscribedAt) return void res.send(await page("Unsubscribed", `<h1 style="font-size:20px;margin:0 0 8px">You're unsubscribed</h1><p style="margin:0;color:#475569"><b>${esc(ok.email)}</b> won't get offers and news from us. You'll still get emails about your services and invoices.</p>`));
    // a button, not a one-tap GET — mail scanners follow links and would unsubscribe people by accident
    res.send(await page("Unsubscribe", `<h1 style="font-size:20px;margin:0 0 8px">Unsubscribe from offers?</h1><p style="margin:0 0 18px;color:#475569">Stop sending offers and news to <b>${esc(ok.email)}</b>. You'll still get emails about your services and invoices.</p>
<form method="post"><button type="submit" style="width:100%;border:0;border-radius:12px;background:#7c3aed;color:#fff;font-weight:700;font-size:15px;padding:13px;cursor:pointer">Unsubscribe</button></form>`));
  }),
);

/** The button above, and Gmail/Yahoo "one-click" (RFC 8058: POST List-Unsubscribe=One-Click). */
publicCampaigns.post(
  "/e/u/:token",
  express.urlencoded({ extended: false }),
  ah(async (req, res) => {
    const r = TOKEN.test(req.params.token) ? await unsubscribe(req.params.token) : null;
    res.setHeader("cache-control", "no-store");
    if (!r) return void res.status(404).send(await page("Link expired", `<h1 style="font-size:20px;margin:0 0 8px">This link has expired</h1>`));
    res.send(await page("Unsubscribed", `<h1 style="font-size:20px;margin:0 0 8px">You're unsubscribed</h1><p style="margin:0;color:#475569"><b>${esc(r.email)}</b> won't get offers and news from us any more. Changed your mind? Turn offers back on in your client area under <b>Profile</b>.</p>`));
  }),
);

