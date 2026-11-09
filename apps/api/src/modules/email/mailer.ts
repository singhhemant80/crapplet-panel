import nodemailer, { type Transporter } from "nodemailer";
import { config } from "../../config";
import { prisma } from "../../db";
import { emailQueue, type EmailJob } from "../../jobs/queues";
import { getSettings } from "../../lib/settings";
import { DEFAULT_TEMPLATES } from "./templates";

let transport: Transporter | null = null;
function getTransport(): Transporter | null {
  if (!config.smtp.host) return null;
  if (!transport) {
    transport = nodemailer.createTransport({
      host: config.smtp.host,
      port: config.smtp.port,
      secure: config.smtp.secure,
      auth: config.smtp.user ? { user: config.smtp.user, pass: config.smtp.pass } : undefined,
    });
  }
  return transport;
}

const esc = (v: unknown) =>
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

function layout(body: string, brand: string, website: string) {
  return `<!doctype html><html><body style="margin:0;background:#f6f0ff;font-family:Inter,Segoe UI,Arial,sans-serif;color:#0f172a">
<table width="100%" cellpadding="0" cellspacing="0" style="padding:32px 12px"><tr><td align="center">
<table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;background:#fff;border-radius:16px;overflow:hidden;border:1px solid #ece4fb">
<tr><td style="background:linear-gradient(135deg,#a365fe,#7c3aed);padding:22px 28px;color:#fff;font-size:20px;font-weight:800">${esc(brand)}</td></tr>
<tr><td style="padding:28px;font-size:15px;line-height:1.6">${body}</td></tr>
<tr><td style="padding:18px 28px;background:#faf7ff;color:#64748b;font-size:12px">${esc(brand)} · <a href="${esc(website)}" style="color:#7c3aed">${esc(website)}</a></td></tr>
</table></td></tr></table></body></html>`;
}

export async function sendTemplatedEmail(job: EmailJob) {
  const settings = await getSettings();
  const db = await prisma.emailTemplate.findUnique({ where: { key: job.template } });
  const fallback = DEFAULT_TEMPLATES[job.template];
  if (db && !db.enabled) return { skipped: true };
  const tpl = db ?? (fallback ? { subject: fallback.subject, body: fallback.body } : null);
  if (!tpl) throw new Error(`Unknown email template ${job.template}`);
  const vars = { company: settings.company, appUrl: config.appUrl, ...job.vars };
  const subject = render(tpl.subject, vars);
  const html = layout(render(tpl.body, vars), settings.company.brand, settings.company.website);

  const attachments: { filename: string; content: Buffer }[] = [];
  if (job.attachments?.length) {
    const { renderInvoicePdf } = await import("../billing/pdf");
    for (const a of job.attachments) attachments.push({ filename: a.filename, content: await renderInvoicePdf(a.invoiceId) });
  }

  const t = getTransport();
  try {
    if (t) await t.sendMail({ from: config.smtp.from, to: job.to, subject, html, attachments });
    else console.log(`[mail:dev] to=${job.to} subject="${subject}"`);
    await prisma.emailLog.create({ data: { to: job.to, subject, template: job.template, userId: job.userId, status: t ? "SENT" : "LOGGED" } });
  } catch (e) {
    await prisma.emailLog.create({ data: { to: job.to, subject, template: job.template, userId: job.userId, status: "FAILED", error: String(e) } });
    throw e;
  }
  return { subject };
}

/** Queue an email; falls back to direct send if Redis is unavailable. */
export async function queueEmail(template: string, to: string, vars: Record<string, unknown>, userId?: string, attachments?: EmailJob["attachments"]) {
  const job: EmailJob = { template, to, vars, userId, attachments };
  try {
    await emailQueue().add(template, job, { attempts: 5, backoff: { type: "exponential", delay: 60_000 } });
  } catch (e) {
    console.warn("[mail] queue unavailable, sending inline", e);
    await sendTemplatedEmail(job).catch((err) => console.error("[mail] send failed", err));
  }
}
