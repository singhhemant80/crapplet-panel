import crypto from "crypto";
import nodemailer, { type Transporter } from "nodemailer";
import type Mail from "nodemailer/lib/mailer";
import { UnrecoverableError } from "bullmq";
import { config } from "../../config";
import { prisma, Prisma } from "../../db";
import { emailQueue, type EmailJob } from "../../jobs/queues";
import { getSettings } from "../../lib/settings";
import { DEFAULT_TEMPLATES } from "./templates";
import { domainOf, getMailConfig, type MailConfig } from "./mail-config";

let transport: { sig: string; t: Transporter } | null = null;

export function transportOptions(c: MailConfig) {
  return {
    host: c.host,
    port: c.port,
    secure: c.security === "ssl",
    requireTLS: c.security === "starttls",
    ignoreTLS: c.security === "none",
    name: c.ehloName || domainOf(c.fromEmail) || undefined,
    auth: c.user ? { user: c.user, pass: c.pass } : undefined,
    tls: { rejectUnauthorized: !c.allowSelfSigned, servername: c.host, minVersion: "TLSv1.2" as const },
    connectionTimeout: 15_000,
    greetingTimeout: 15_000,
    socketTimeout: 30_000,
    pool: true,
    maxConnections: 3,
    maxMessages: 100,
    dkim:
      c.dkim.enabled && c.dkim.privateKey
        ? { domainName: domainOf(c.fromEmail), keySelector: c.dkim.selector, privateKey: c.dkim.privateKey }
        : undefined,
  };
}

export function getTransport(c: MailConfig): Transporter | null {
  if (!c.enabled || !c.host) return null;
  const sig = JSON.stringify(transportOptions(c));
  if (transport?.sig !== sig) {
    transport?.t.close();
    transport = { sig, t: nodemailer.createTransport(transportOptions(c)) };
  }
  return transport.t;
}

/** A one-off transport (not pooled) for "Test connection" with unsaved settings. */
export function makeTransport(c: MailConfig) {
  const { pool: _pool, maxConnections: _mc, maxMessages: _mm, ...single } = transportOptions(c);
  return nodemailer.createTransport(single);
}

export const esc = (v: unknown) =>
  String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/** {{var}} is HTML-escaped; {{{var}}} is inserted raw (used for pre-built HTML blocks). */
export function render(tpl: string, vars: Record<string, unknown>) {
  return tpl
    .replace(/\{\{\{\s*([\w.]+)\s*\}\}\}/g, (_, k) => String(lookup(vars, k) ?? ""))
    .replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, k) => esc(lookup(vars, k)));
}
function lookup(vars: Record<string, unknown>, path: string): unknown {
  return path.split(".").reduce<unknown>((o, k) => (o && typeof o === "object" ? (o as Record<string, unknown>)[k] : undefined), vars);
}

/** Plain-text version of the HTML — spam filters penalise HTML-only mail. */
export function htmlToText(html: string) {
  return html
    .replace(/<(style|script|head)[\s\S]*?<\/\1>/gi, "")
    .replace(/<a\s[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi, (_, href, text) => {
      const t = text.replace(/<[^>]+>/g, "").trim();
      return t && t !== href ? `${t} (${href})` : href;
    })
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|h[1-6]|li|table)>/gi, "\n")
    .replace(/<li[^>]*>/gi, "• ")
    .replace(/<\/t[dh]>/gi, "  ")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

type Company = Awaited<ReturnType<typeof getSettings>>["company"];

export function layout(body: string, company: Company, preheader = "", footer?: string) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><title>${esc(company.brand)}</title></head>
<body style="margin:0;background:#f6f0ff;font-family:Inter,Segoe UI,Arial,sans-serif;color:#0f172a">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent">${esc(preheader)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="padding:32px 12px"><tr><td align="center">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;background:#ffffff;border-radius:16px;overflow:hidden;border:1px solid #ece4fb">
<tr><td bgcolor="#7c3aed" style="background:#7c3aed;background:linear-gradient(135deg,#a365fe,#7c3aed);padding:22px 28px;color:#ffffff;font-size:20px;font-weight:800">${esc(company.brand)}</td></tr>
<tr><td style="padding:28px;font-size:15px;line-height:1.6">${body}</td></tr>
<tr><td style="padding:18px 28px;background:#faf7ff;color:#64748b;font-size:12px;line-height:1.6">
${esc(company.legalName)} · ${esc(company.address)}<br>
${footer ?? `You're receiving this because you have an account with ${esc(company.brand)}.`} Questions? Reply to this email or write to <a href="mailto:${esc(company.email)}" style="color:#7c3aed">${esc(company.email)}</a>.<br>
<a href="${esc(company.website)}" style="color:#7c3aed">${esc(company.website)}</a></td></tr>
</table></td></tr></table></body></html>`;
}

/** Headers and envelope that mailbox providers expect from well-behaved transactional senders. */
export function buildMessage(c: MailConfig, m: { to: string; subject: string; html: string; attachments?: Mail.Attachment[]; ref?: string }): Mail.Options {
  const domain = domainOf(c.fromEmail) || "localhost";
  return {
    from: { name: c.fromName || "", address: c.fromEmail },
    sender: c.fromEmail,
    replyTo: c.replyTo || undefined,
    to: m.to,
    subject: m.subject,
    html: m.html,
    text: htmlToText(m.html),
    attachments: m.attachments,
    messageId: `<${crypto.randomUUID()}@${domain}>`,
    date: new Date(),
    envelope: { from: c.returnPath || c.fromEmail, to: m.to },
    headers: {
      "Auto-Submitted": "auto-generated",
      "X-Auto-Response-Suppress": "OOF, AutoReply",
      // stops Gmail from collapsing every invoice email into one thread
      "X-Entity-Ref-ID": m.ref ?? crypto.randomUUID(),
    },
  };
}

/** 5xx = the receiving server refused for good; retrying only hurts sender reputation. */
export function classifyError(e: unknown): { permanent: boolean; bounce: boolean; message: string } {
  const err = e as { responseCode?: number; code?: string; response?: string; message?: string };
  const code = err.responseCode ?? 0;
  const text = `${err.response ?? err.message ?? e}`;
  const bounce = code >= 550 && code < 560 && /(5\.1\.[0-3]|user unknown|no such user|does not exist|unknown recipient|recipient.*(rejected|invalid)|mailbox (unavailable|not found)|address rejected)/i.test(text);
  return { permanent: code >= 500 || err.code === "EENVELOPE", bounce, message: friendlySmtpError(e) };
}

export function friendlySmtpError(e: unknown): string {
  const err = e as { code?: string; responseCode?: number; response?: string; message?: string; command?: string };
  const raw = (err.response || err.message || String(e)).trim();
  switch (err.code) {
    case "EAUTH":
      return `Login refused by the mail server (${raw}). Check the username/password — Gmail, Zoho and Microsoft need an app-specific password when two-factor login is on.`;
    case "ETIMEDOUT":
    case "ECONNECTION":
    case "ESOCKET":
      if (/ECONNREFUSED/.test(raw)) return `Connection refused (${raw}). Nothing is listening on that host/port — check the SMTP host and port.`;
      if (/certificate|self.signed|wrong version number|SSL/i.test(raw)) return `TLS problem (${raw}). Use port 587 with STARTTLS or port 465 with SSL — not SSL on 587.`;
      return `Can't reach the mail server (${raw}). Many hosting providers block outgoing ports 25/465/587 — ask them to open 587, or try 465 or 2525.`;
    case "EDNS":
      return `The SMTP host name doesn't resolve (${raw}).`;
    case "EENVELOPE":
      return `Address rejected (${raw}).`;
  }
  if (err.responseCode === 550 || err.responseCode === 553 || err.responseCode === 554) {
    if (/relay|not permitted|sender|from address|not owned|send as|SendAsDenied/i.test(raw))
      return `The mail server won't send as this From address (${raw}). The From email must be the mailbox you log in with, or an alias/domain verified with your provider.`;
    if (/spam|block|blacklist|listed|reputation|policy/i.test(raw)) return `Rejected as spam (${raw}). Run the deliverability check — SPF/DKIM/DMARC or a blacklisting is usually the cause.`;
  }
  return raw;
}

/** Hard-bounced in the last 30 days → don't keep mailing a dead address (protects sender reputation). */
export async function isSuppressed(to: string) {
  const since = new Date(Date.now() - 30 * 86400_000);
  return !!(await prisma.emailLog.findFirst({ where: { to: { equals: to, mode: "insensitive" }, status: "BOUNCED", createdAt: { gte: since } }, select: { id: true } }));
}

export async function sendTemplatedEmail(job: EmailJob, opts: { ignoreSuppression?: boolean } = {}) {
  const settings = await getSettings();
  const db = await prisma.emailTemplate.findUnique({ where: { key: job.template } });
  const fallback = DEFAULT_TEMPLATES[job.template];
  if (db && !db.enabled) return { skipped: true };
  const tpl = db ?? (fallback ? { subject: fallback.subject, body: fallback.body } : null);
  if (!tpl) throw new Error(`Unknown email template ${job.template}`);
  const vars = { company: settings.company, appUrl: config.appUrl, ...job.vars };
  const subject = render(tpl.subject, vars);
  const bodyHtml = render(tpl.body, vars);
  const html = layout(bodyHtml, settings.company, htmlToText(bodyHtml).split("\n").find((l) => l.trim() && !/^hi\b/i.test(l))?.slice(0, 140) ?? "");
  const log = { to: job.to, subject, template: job.template, userId: job.userId, job: job as unknown as Prisma.InputJsonValue };

  if (!opts.ignoreSuppression && (await isSuppressed(job.to))) {
    await prisma.emailLog.create({ data: { ...log, status: "SUPPRESSED", error: "Not sent: this address hard-bounced in the last 30 days. Fix the address or press Resend in Email Delivery → Log." } });
    return { suppressed: true };
  }

  const attachments: Mail.Attachment[] = [];
  if (job.attachments?.length) {
    const { renderInvoicePdf } = await import("../billing/pdf");
    for (const a of job.attachments) attachments.push({ filename: a.filename, content: await renderInvoicePdf(a.invoiceId), contentType: "application/pdf" });
  }

  const c = await getMailConfig();
  const t = getTransport(c);
  if (!t) {
    console.log(`[mail:log-only] to=${job.to} subject="${subject}"`);
    await prisma.emailLog.create({ data: { ...log, status: "LOGGED", error: c.host ? "Sending is switched off in Email Delivery" : "No SMTP server configured — set one up in Admin → Email Delivery" } });
    return { subject, logged: true };
  }
  try {
    const info = await t.sendMail(buildMessage(c, { to: job.to, subject, html, attachments }));
    await prisma.emailLog.create({ data: { ...log, status: "SENT", messageId: info.messageId, response: info.response?.slice(0, 500) } });
    return { subject, messageId: info.messageId };
  } catch (e) {
    const k = classifyError(e);
    await prisma.emailLog.create({ data: { ...log, status: k.bounce ? "BOUNCED" : "FAILED", error: k.message.slice(0, 1000) } });
    if (k.permanent) throw new UnrecoverableError(k.message);
    throw e;
  }
}

/** Send arbitrary HTML (test emails). Returns the server's reply. */
export async function sendRaw(c: MailConfig, to: string, subject: string, bodyHtml: string) {
  const settings = await getSettings();
  const t = makeTransport(c);
  try {
    const info = await t.sendMail(buildMessage(c, { to, subject, html: layout(bodyHtml, settings.company, "Test message from your billing panel") }));
    await prisma.emailLog.create({ data: { to, subject, template: "test", status: "SENT", messageId: info.messageId, response: info.response?.slice(0, 500) } });
    return { messageId: info.messageId, response: info.response, accepted: info.accepted, rejected: info.rejected };
  } catch (e) {
    await prisma.emailLog.create({ data: { to, subject, template: "test", status: "FAILED", error: friendlySmtpError(e).slice(0, 1000) } });
    throw e;
  } finally {
    t.close();
  }
}

/** Queue an email; falls back to direct send if Redis is unavailable. */
export async function queueEmail(template: string, to: string, vars: Record<string, unknown>, userId?: string, attachments?: EmailJob["attachments"]) {
  const job: EmailJob = { template, to, vars, userId, attachments };
  // the WhatsApp version of client notifications (when switched on for this event)
  if (userId) await import("../whatsapp/service").then((m) => m.notifyWhatsapp(template, userId, vars)).catch(() => undefined);
  try {
    await emailQueue().add(template, job, { attempts: 5, backoff: { type: "exponential", delay: 60_000 } });
  } catch (e) {
    console.warn("[mail] queue unavailable, sending inline", e);
    await sendTemplatedEmail(job).catch((err) => console.error("[mail] send failed", err));
  }
}
