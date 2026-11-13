/**
 * Email campaigns — offers and information emails to customers.
 *
 *  OFFER  marketing: only customers who accept offers (User.marketingEmails), with an unsubscribe link and the
 *         one-click List-Unsubscribe headers Gmail/Yahoo require for bulk mail.
 *  INFO   service information (maintenance, policy changes, new features) to every matching customer.
 *
 * The recipient list is fixed when sending starts. The worker sends a slice every minute (perMinute) so the
 * mail server isn't flooded; a campaign can be paused, resumed or cancelled half-way.
 */
import { stripActiveHtml } from "../../lib/html";
import crypto from "node:crypto";
import { z } from "zod";
import { prisma, type Prisma } from "../../db";
import { config } from "../../config";
import { getSettings } from "../../lib/settings";
import { buildMessage, esc, getTransport, htmlToText, isSuppressed, layout, render } from "../email/mailer";
import { getMailConfig } from "../email/mail-config";

export const LIVE: ("ACTIVE" | "SUSPENDED" | "PENDING" | "PROVISIONING")[] = ["ACTIVE", "SUSPENDED", "PENDING", "PROVISIONING"];

export const audienceSchema = z.object({
  /** all | with_active (has a live service) | without_active (no live service: leads, lapsed) */
  clients: z.enum(["all", "with_active", "without_active"]).default("all"),
  productTypes: z.array(z.string().max(40)).max(30).default([]),
  productIds: z.array(z.string().max(40)).max(200).default([]),
  country: z.enum(["all", "IN", "intl"]).default("all"),
  includeInactive: z.boolean().default(false),
  signedUpWithinDays: z.number().int().min(1).max(3650).nullable().default(null),
  /** hand-picked customers (overrides the filters above) */
  userIds: z.array(z.string().max(40)).max(5000).default([]),
});
export type Audience = z.infer<typeof audienceSchema>;

export const campaignSchema = z.object({
  name: z.string().trim().min(1).max(120),
  kind: z.enum(["OFFER", "INFO"]),
  subject: z.string().trim().min(1).max(200),
  preheader: z.string().trim().max(200).nullable().optional(),
  body: z.string().min(1).max(200_000).transform(stripActiveHtml),
  audience: audienceSchema.default({}),
  perMinute: z.number().int().min(1).max(1000).default(60),
});

export function audienceWhere(a: Audience, kind: string): Prisma.UserWhereInput {
  const and: Prisma.UserWhereInput[] = [{ type: "CLIENT" }, { status: { in: a.includeInactive ? ["ACTIVE", "INACTIVE"] : ["ACTIVE"] } }];
  if (kind === "OFFER") and.push({ marketingEmails: true });
  if (a.userIds.length) return { AND: [...and, { id: { in: a.userIds } }] };
  const product: Prisma.ProductWhereInput = {};
  if (a.productTypes.length) product.type = { in: a.productTypes as never };
  if (a.productIds.length) product.id = { in: a.productIds };
  const byProduct = a.productTypes.length || a.productIds.length;
  if (a.clients === "with_active" || byProduct) and.push({ services: { some: { status: { in: LIVE }, ...(byProduct ? { product } : {}) } } });
  if (a.clients === "without_active") and.push({ services: { none: { status: { in: LIVE } } } });
  if (a.country === "IN") and.push({ profile: { country: "IN" } });
  if (a.country === "intl") and.push({ OR: [{ profile: { country: { not: "IN" } } }, { profile: null }] });
  if (a.signedUpWithinDays) and.push({ createdAt: { gte: new Date(Date.now() - a.signedUpWithinDays * 86400_000) } });
  return { AND: and };
}

export async function audienceCount(a: Audience, kind: string) {
  const where = audienceWhere(a, kind);
  const [count, sample, optedOut] = await Promise.all([
    prisma.user.count({ where }),
    prisma.user.findMany({ where, take: 6, orderBy: { createdAt: "desc" }, select: { id: true, firstName: true, lastName: true, email: true } }),
    // how many matching customers are left out because they don't take offers
    kind === "OFFER" ? prisma.user.count({ where: audienceWhere(a, "INFO") }) : Promise.resolve(0),
  ]);
  return { count, sample, optedOut: kind === "OFFER" ? Math.max(0, optedOut - count) : 0 };
}

const urls = (token: string) => ({
  unsubscribeUrl: `${config.appUrl}/api/e/u/${token}`,
  pixel: `${config.appUrl}/api/e/o/${token}.gif`,
});

type Person = { firstName?: string | null; lastName?: string | null; email: string; companyName?: string | null };
export function personVars(p: Person, token: string) {
  const name = [p.firstName, p.lastName].filter(Boolean).join(" ").trim();
  return { firstName: p.firstName || "there", lastName: p.lastName ?? "", name: name || p.email, email: p.email, companyName: p.companyName ?? "", unsubscribeUrl: urls(token).unsubscribeUrl };
}

/** The finished email for one person (also used for the live preview and test sends). */
export async function renderCampaign(c: { kind: string; subject: string; preheader?: string | null; body: string }, person: Person, token: string, opts: { track?: boolean } = {}) {
  const settings = await getSettings();
  const vars = { company: settings.company, appUrl: config.appUrl, ...personVars(person, token) };
  const subject = render(c.subject, vars);
  const bodyHtml = render(c.body, vars);
  const u = urls(token);
  const footer =
    c.kind === "OFFER"
      ? `You're receiving this because you agreed to hear about offers and news from ${esc(settings.company.brand)}. <a href="${esc(u.unsubscribeUrl)}" style="color:#7c3aed">Unsubscribe</a> — you'll still get emails about your services and invoices.`
      : `This is a service announcement about your ${esc(settings.company.brand)} account.`;
  const pre = c.preheader ? render(c.preheader, vars) : htmlToText(bodyHtml).split("\n").find((l) => l.trim() && !/^(hi|hello|dear)\b/i.test(l))?.slice(0, 140) ?? "";
  let html = layout(bodyHtml, settings.company, pre, footer);
  if (opts.track) html = html.replace("</body>", `<img src="${esc(u.pixel)}" width="1" height="1" alt="" style="display:block;width:1px;height:1px;border:0" /></body>`);
  return { subject, html, unsubscribeUrl: u.unsubscribeUrl };
}

export const newToken = () => crypto.randomBytes(18).toString("base64url");

/** Fix the recipient list (when sending starts). Bounced addresses are skipped later, at send time. */
export async function materialise(campaignId: string) {
  const c = await prisma.emailCampaign.findUniqueOrThrow({ where: { id: campaignId } });
  const a = audienceSchema.parse(c.audience ?? {});
  const users = await prisma.user.findMany({ where: audienceWhere(a, c.kind), select: { id: true, email: true, firstName: true, lastName: true } });
  const seen = new Set<string>();
  const rows = users
    .filter((u) => u.email && !seen.has(u.email.toLowerCase()) && seen.add(u.email.toLowerCase()))
    .map((u) => ({ campaignId, userId: u.id, email: u.email, name: [u.firstName, u.lastName].filter(Boolean).join(" ") || null, token: newToken() }));
  for (let i = 0; i < rows.length; i += 1000) await prisma.emailCampaignRecipient.createMany({ data: rows.slice(i, i + 1000), skipDuplicates: true });
  const total = await prisma.emailCampaignRecipient.count({ where: { campaignId } });
  await prisma.emailCampaign.update({ where: { id: campaignId }, data: { total } });
  return total;
}

/** One minute's worth of sending for every campaign that's due. Run by the worker every minute (concurrency 1). */
export async function campaignTick(now = new Date()) {
  const due = await prisma.emailCampaign.findMany({ where: { status: "SCHEDULED", scheduledAt: { lte: now } }, select: { id: true } });
  for (const d of due) {
    const ok = await prisma.emailCampaign.updateMany({ where: { id: d.id, status: "SCHEDULED" }, data: { status: "SENDING", startedAt: now } });
    if (ok.count) await materialise(d.id);
  }
  const sending = await prisma.emailCampaign.findMany({ where: { status: "SENDING" }, orderBy: { startedAt: "asc" } });
  const out: { id: string; sent: number; failed: number; skipped: number; done: boolean; error?: string }[] = [];
  for (const c of sending) out.push(await sendBatch(c));
  return out;
}

type Campaign = Awaited<ReturnType<typeof prisma.emailCampaign.findUniqueOrThrow>>;
async function sendBatch(c: Campaign) {
  const res = { id: c.id, sent: 0, failed: 0, skipped: 0, done: false, error: undefined as string | undefined };
  const mc = await getMailConfig();
  const t = getTransport(mc);
  if (!t) {
    res.error = mc.host ? "Sending is switched off in Email Delivery" : "No mail server is set up — Admin → Email Delivery";
    await prisma.emailCampaign.update({ where: { id: c.id }, data: { status: "PAUSED", lastError: `Paused: ${res.error}` } });
    return res;
  }
  const batch = await prisma.emailCampaignRecipient.findMany({ where: { campaignId: c.id, status: "QUEUED" }, take: c.perMinute, orderBy: { id: "asc" } });
  const profiles = new Map(
    (await prisma.clientProfile.findMany({ where: { userId: { in: batch.map((b) => b.userId).filter((x): x is string => !!x) } }, select: { userId: true, companyName: true } })).map((p) => [p.userId, p.companyName]),
  );
  const users = new Map(
    (await prisma.user.findMany({ where: { id: { in: batch.map((b) => b.userId).filter((x): x is string => !!x) } }, select: { id: true, firstName: true, lastName: true, marketingEmails: true, status: true } })).map((u) => [u.id, u]),
  );
  let lastError: string | null = null;
  for (const r of batch) {
    // re-check: the campaign may have been paused or cancelled meanwhile, or the customer unsubscribed
    if (res.sent + res.failed + res.skipped > 0 && (res.sent + res.failed + res.skipped) % 20 === 0) {
      const st = await prisma.emailCampaign.findUnique({ where: { id: c.id }, select: { status: true } });
      if (st?.status !== "SENDING") return res;
    }
    const u = r.userId ? users.get(r.userId) : undefined;
    const skip = (c.kind === "OFFER" && u && !u.marketingEmails) ? "Unsubscribed from offers" : u && u.status === "CLOSED" ? "Account closed" : (await isSuppressed(r.email)) ? "Address bounced recently" : null;
    if (skip) {
      await prisma.emailCampaignRecipient.update({ where: { id: r.id }, data: { status: "SKIPPED", error: skip } });
      res.skipped++;
      continue;
    }
    try {
      const m = await renderCampaign(c, { email: r.email, firstName: u?.firstName, lastName: u?.lastName, companyName: r.userId ? profiles.get(r.userId) : null }, r.token, { track: true });
      const msg = buildMessage(mc, { to: r.email, subject: m.subject, html: m.html, ref: r.token });
      const headers = { ...(msg.headers as Record<string, string>) };
      delete headers["Auto-Submitted"];
      delete headers["X-Auto-Response-Suppress"];
      headers["Precedence"] = "bulk";
      headers["X-Campaign-ID"] = c.id;
      if (c.kind === "OFFER") {
        headers["List-Unsubscribe"] = `<${m.unsubscribeUrl}>`;
        headers["List-Unsubscribe-Post"] = "List-Unsubscribe=One-Click";
      }
      const info = await t.sendMail({ ...msg, headers });
      await prisma.emailCampaignRecipient.update({ where: { id: r.id }, data: { status: "SENT", sentAt: new Date(), error: null } });
      await prisma.emailLog.create({ data: { to: r.email, subject: m.subject, template: `campaign`, userId: r.userId, status: "SENT", messageId: info.messageId, response: info.response?.slice(0, 500) } }).catch(() => undefined);
      res.sent++;
    } catch (e) {
      const err = e as { responseCode?: number; message?: string; response?: string };
      const text = String(err.response ?? err.message ?? e).slice(0, 500);
      const hard = (err.responseCode ?? 0) >= 500;
      // the mail server itself is refusing (login, rate limit, connection) — keep this person queued,
      // pause, and let staff fix it and press Resume
      if (!hard || /auth|login|rate|limit|too many|quota/i.test(text)) {
        await prisma.emailCampaignRecipient.update({ where: { id: r.id }, data: { error: text } });
        res.error = text;
        await prisma.emailCampaign.update({ where: { id: c.id }, data: { status: "PAUSED", lastError: `Paused: ${text}` } });
        break;
      }
      await prisma.emailCampaignRecipient.update({ where: { id: r.id }, data: { status: "FAILED", error: text } });
      await prisma.emailLog.create({ data: { to: r.email, subject: c.subject, template: "campaign", userId: r.userId, status: /5\.1\.|user unknown|does not exist|no such user|mailbox unavailable/i.test(text) ? "BOUNCED" : "FAILED", error: text } }).catch(() => undefined);
      res.failed++;
      lastError = text;
    }
  }
  const left = await prisma.emailCampaignRecipient.count({ where: { campaignId: c.id, status: "QUEUED" } });
  const counts = await prisma.emailCampaignRecipient.groupBy({ by: ["status"], where: { campaignId: c.id }, _count: true });
  const n = (s: string) => counts.find((x) => x.status === s)?._count ?? 0;
  res.done = left === 0 && !res.error;
  await prisma.emailCampaign.update({
    where: { id: c.id },
    data: { sent: n("SENT"), failed: n("FAILED"), skipped: n("SKIPPED"), ...(res.done ? { status: "SENT", finishedAt: new Date() } : {}), ...(lastError && !res.error ? { lastError } : {}) },
  });
  return res;
}

// ───────── tracking & unsubscribe (public, by token) ─────────

export const PIXEL = Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64");

export async function markOpened(token: string) {
  const r = await prisma.emailCampaignRecipient.findUnique({ where: { token }, select: { id: true, campaignId: true, openedAt: true } });
  if (!r || r.openedAt) return;
  const u = await prisma.emailCampaignRecipient.updateMany({ where: { id: r.id, openedAt: null }, data: { openedAt: new Date() } });
  if (u.count) await prisma.emailCampaign.update({ where: { id: r.campaignId }, data: { opened: { increment: 1 } } });
}

export async function unsubscribe(token: string) {
  const r = await prisma.emailCampaignRecipient.findUnique({ where: { token }, select: { id: true, campaignId: true, userId: true, unsubscribedAt: true, email: true } });
  if (!r) return null;
  if (!r.unsubscribedAt) {
    await prisma.emailCampaignRecipient.update({ where: { id: r.id }, data: { unsubscribedAt: new Date() } });
    await prisma.emailCampaign.update({ where: { id: r.campaignId }, data: { unsubscribed: { increment: 1 } } });
  }
  if (r.userId) await prisma.user.update({ where: { id: r.userId }, data: { marketingEmails: false, marketingOptOutAt: new Date() } }).catch(() => undefined);
  return r;
}
