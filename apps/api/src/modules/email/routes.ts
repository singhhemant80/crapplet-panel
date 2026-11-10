import { Router } from "express";
import { z } from "zod";
import { prisma, Prisma } from "../../db";
import { ah, badRequest, notFound, pageParams, parse } from "../../lib/http";
import { audit } from "../../lib/audit";
import { requireStaff } from "../../middleware/auth";
import type { EmailJob } from "../../jobs/queues";
import { PRESETS, generateDkimKey, getMailConfig, publicMailConfig, saveMailConfig, domainOf, type MailConfig } from "./mail-config";
import { friendlySmtpError, makeTransport, sendRaw, sendTemplatedEmail } from "./mailer";
import { checkDeliverability, guessPublicIp } from "./deliverability";

export const adminEmail = Router();
const perm = requireStaff("settings.manage");

const cfgSchema = z.object({
  enabled: z.boolean(),
  preset: z.string(),
  host: z.string().trim(),
  port: z.coerce.number().int().min(1).max(65535),
  security: z.enum(["starttls", "ssl", "none"]),
  user: z.string().trim(),
  pass: z.string(),
  fromName: z.string().trim().max(80),
  fromEmail: z.union([z.literal(""), z.string().trim().toLowerCase().email()]),
  replyTo: z.union([z.literal(""), z.string().trim().toLowerCase().email()]),
  returnPath: z.union([z.literal(""), z.string().trim().toLowerCase().email()]),
  ehloName: z.string().trim(),
  allowSelfSigned: z.boolean(),
  providerDkimSelector: z.string().trim().regex(/^[a-z0-9._-]*$/i, "Letters, digits, dot, dash only"),
  sendingIp: z.union([z.literal(""), z.string().trim().ip({ version: "v4" })]),
  dkim: z.object({ enabled: z.boolean(), selector: z.string().trim().regex(/^[a-z0-9-]+$/i, "Letters, digits and dashes only").min(1) }).partial(),
}).partial();

/** Saved settings with any unsaved form values on top (so "Test" works before "Save"). */
async function withDraft(draft: unknown): Promise<MailConfig> {
  const cur = await getMailConfig();
  if (!draft) return cur;
  const d = parse(cfgSchema, draft);
  return { ...cur, ...d, pass: !d.pass || d.pass.startsWith("••") ? cur.pass : d.pass, dkim: { ...cur.dkim, ...(d.dkim ?? {}) } } as MailConfig;
}

adminEmail.get(
  "/email/settings",
  perm,
  ah(async (_req, res) => {
    const c = await getMailConfig();
    res.json({ config: publicMailConfig(c), fromDb: c.fromDb, presets: PRESETS, detectedIp: guessPublicIp() });
  }),
);

adminEmail.put(
  "/email/settings",
  perm,
  ah(async (req, res) => {
    const b = parse(cfgSchema, req.body);
    if (b.enabled && (!b.host || !b.fromEmail)) throw badRequest("SMTP host and From email are required to send mail");
    const saved = await saveMailConfig(b as Partial<MailConfig>);
    await audit({ actorId: req.user!.id, action: "email.settings_updated", entity: "settings", entityId: "mail", details: { host: saved.host, fromEmail: saved.fromEmail, passwordChanged: !!b.pass && !b.pass.startsWith("••") } });
    res.json({ config: publicMailConfig(saved) });
  }),
);

adminEmail.post(
  "/email/dkim/generate",
  perm,
  ah(async (req, res) => {
    const { selector } = parse(z.object({ selector: z.string().trim().regex(/^[a-z0-9-]+$/i).default("crapplet") }), req.body ?? {});
    const k = generateDkimKey();
    const saved = await saveMailConfig({ dkim: { enabled: false, selector, privateKey: k.privateKey, publicKey: k.publicKey } });
    await audit({ actorId: req.user!.id, action: "email.dkim_generated", entity: "settings", entityId: "mail", details: { selector } });
    // signing stays off until the DNS record is live — otherwise every email fails DKIM
    res.json({ config: publicMailConfig(saved), record: { type: "TXT", host: `${selector}._domainkey`, value: `v=DKIM1; k=rsa; p=${k.publicKey}`, domain: domainOf(saved.fromEmail) } });
  }),
);

adminEmail.post(
  "/email/test-connection",
  perm,
  ah(async (req, res) => {
    const c = await withDraft(req.body?.config);
    if (!c.host) throw badRequest("Enter the SMTP host first");
    const t = makeTransport(c);
    const started = Date.now();
    try {
      await t.verify();
      res.json({ ok: true, message: `Connected to ${c.host}:${c.port} and logged in${c.user ? ` as ${c.user}` : ""} (${Date.now() - started} ms).` });
    } catch (e) {
      res.json({ ok: false, message: friendlySmtpError(e) });
    } finally {
      t.close();
    }
  }),
);

adminEmail.post(
  "/email/test-send",
  perm,
  ah(async (req, res) => {
    const { to } = parse(z.object({ to: z.string().trim().email() }), req.body);
    const c = await withDraft(req.body?.config);
    if (!c.host || !c.fromEmail) throw badRequest("Set the SMTP host and From email first");
    try {
      const r = await sendRaw(
        c,
        to,
        `Test email from ${c.fromName || c.fromEmail}`,
        `<p>Hi,</p><p>This is a test message from your billing panel. If it reached your <b>inbox</b>, email delivery is set up correctly.</p>
<p style="color:#64748b">Sent through ${c.host}:${c.port} as ${c.fromEmail} at ${new Date().toUTCString()}.</p>
<p style="color:#64748b">If it went to spam, open Admin → Email Delivery → Deliverability check and fix the items marked in red.</p>`,
      );
      res.json({ ok: true, message: `Accepted by ${c.host}: ${r.response}`, ...r });
    } catch (e) {
      res.json({ ok: false, message: friendlySmtpError(e) });
    }
  }),
);

adminEmail.get(
  "/email/check",
  perm,
  ah(async (_req, res) => {
    res.json(await checkDeliverability(await getMailConfig()));
  }),
);

adminEmail.get(
  "/email/log",
  perm,
  ah(async (req, res) => {
    const { skip, take, page, pageSize } = pageParams(req.query);
    const q = String(req.query.q ?? "").trim();
    const status = String(req.query.status ?? "");
    const where: Prisma.EmailLogWhereInput = {
      ...(status ? { status } : {}),
      ...(q ? { OR: [{ to: { contains: q, mode: "insensitive" } }, { subject: { contains: q, mode: "insensitive" } }] } : {}),
    };
    const since = new Date(Date.now() - 7 * 86400_000);
    const [items, total, stats] = await Promise.all([
      prisma.emailLog.findMany({ where, orderBy: { createdAt: "desc" }, skip, take, select: { id: true, to: true, subject: true, template: true, status: true, error: true, messageId: true, response: true, createdAt: true, job: true } }),
      prisma.emailLog.count({ where }),
      prisma.emailLog.groupBy({ by: ["status"], where: { createdAt: { gte: since } }, _count: true }),
    ]);
    res.json({
      items: items.map(({ job, ...r }) => ({ ...r, canResend: !!job })),
      total,
      page,
      pageSize,
      last7Days: Object.fromEntries(stats.map((s) => [s.status, s._count])),
    });
  }),
);

adminEmail.post(
  "/email/log/:id/resend",
  perm,
  ah(async (req, res) => {
    const row = await prisma.emailLog.findUnique({ where: { id: req.params.id } });
    if (!row) throw notFound();
    if (!row.job) throw badRequest("This email can't be re-sent (it was sent before the log kept message data)");
    const job = row.job as unknown as EmailJob;
    const to = parse(z.object({ to: z.string().trim().email().optional() }), req.body ?? {}).to ?? job.to;
    try {
      const r = await sendTemplatedEmail({ ...job, to }, { ignoreSuppression: true });
      await audit({ actorId: req.user!.id, action: "email.resent", entity: "email", entityId: row.id, details: { to } });
      res.json({ ok: !("logged" in r), message: "logged" in r ? "Saved to the log only — sending is not set up." : `Sent to ${to}` });
    } catch (e) {
      res.json({ ok: false, message: friendlySmtpError(e) });
    }
  }),
);
