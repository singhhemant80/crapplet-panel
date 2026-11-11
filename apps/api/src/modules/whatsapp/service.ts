/**
 * WhatsApp notifications to clients.
 *
 * Providers:
 *   meta — the official WhatsApp Business Cloud API (graph.facebook.com). Business-initiated messages
 *          must use an approved template; free text only reaches a client who messaged you in the
 *          last 24 hours.
 *   http — any WhatsApp gateway with an HTTP API (Interakt, AiSensy, WATI, UltraMsg, Wablas, …):
 *          URL / headers / body are templates with {{phone}}, {{message}} and {{token}}.
 *
 * Every client email that has a WhatsApp event (invoice created, reminders, overdue, suspended, VPS
 * ready, …) also queues a WhatsApp message when that event is switched on, the client has a mobile
 * number, and they haven't switched WhatsApp off in their profile. Passwords are never sent.
 */
import { prisma } from "../../db";
import { config } from "../../config";
import { decrypt, encrypt } from "../../lib/crypto";
import { getSettings } from "../../lib/settings";
import { whatsappQueue } from "../../jobs/queues";

export type Provider = "meta" | "http";
export interface EventConfig {
  enabled: boolean;
  text: string;
  /** meta: approved template name; params = comma-separated variable names in template order */
  metaTemplate?: string;
  metaLanguage?: string;
  metaParams?: string;
}
export interface WhatsappConfig {
  enabled: boolean;
  provider: Provider;
  defaultCountryCode: string;
  meta: { phoneNumberId: string; apiVersion: string };
  http: { url: string; method: "POST" | "GET"; headers: string; body: string; successMatch: string };
  events: Record<string, EventConfig>;
  /** encrypted: { token } (Meta access token / gateway API key) */
  secretEnc?: string | null;
}

export const WHATSAPP_EVENTS: Record<string, { name: string; group: string; vars: string[]; text: string; on: boolean }> = {
  "order.confirmation": { name: "Order received", group: "Orders", vars: ["name", "orderNumber", "total"], on: true, text: "Hi {{name}}, thanks for your order {{orderNumber}} ({{total}}) with {{companyName}}. We'll let you know as soon as it's ready." },
  "invoice.created": { name: "Invoice created", group: "Billing", vars: ["name", "invoiceNumber", "total", "dueDate", "payLink"], on: true, text: "Hi {{name}}, invoice {{invoiceNumber}} for {{total}} is due on {{dueDate}}. Pay online: {{payLink}}" },
  "invoice.paid": { name: "Payment received", group: "Billing", vars: ["name", "invoiceNumber", "total"], on: true, text: "Hi {{name}}, we've received your payment of {{total}} for invoice {{invoiceNumber}}. Thank you!" },
  "invoice.reminder": { name: "Payment reminder (before due)", group: "Billing", vars: ["name", "invoiceNumber", "total", "dueDate", "payLink"], on: true, text: "Reminder: invoice {{invoiceNumber}} for {{total}} is due on {{dueDate}}. Pay now to avoid interruption: {{payLink}}" },
  "invoice.overdue": { name: "Overdue notice", group: "Billing", vars: ["name", "invoiceNumber", "total", "dueDate", "payLink"], on: true, text: "Hi {{name}}, invoice {{invoiceNumber}} for {{total}} was due on {{dueDate}} and is overdue. Your service may be suspended — please pay now: {{payLink}}" },
  "service.renewal_reminder": { name: "Renewal reminder", group: "Services", vars: ["name", "productName", "dueDate"], on: true, text: "Hi {{name}}, your {{productName}} renews on {{dueDate}}." },
  "service.vps_ready": { name: "VPS ready", group: "Services", vars: ["name", "hostname", "ip", "os"], on: true, text: "Hi {{name}}, your VPS {{hostname}} is ready! IP: {{ip}} · OS: {{os}}. Login details are in your email and client area: {{clientAreaLink}}" },
  "service.hosting_ready": { name: "Hosting ready", group: "Services", vars: ["name", "domain"], on: true, text: "Hi {{name}}, your hosting for {{domain}} is ready. Login details are in your email and client area: {{clientAreaLink}}" },
  "service.activated": { name: "Service activated", group: "Services", vars: ["name", "productName", "hostname"], on: true, text: "Hi {{name}}, your {{productName}} {{hostname}} is now active." },
  "service.suspended": { name: "Service suspended", group: "Services", vars: ["name", "productName", "hostname", "reason"], on: true, text: "Hi {{name}}, your {{productName}} {{hostname}} has been suspended: {{reason}}. Pay the overdue invoice to restore it: {{clientAreaLink}}/client/invoices" },
  "service.unsuspended": { name: "Service unsuspended", group: "Services", vars: ["name", "productName", "hostname"], on: true, text: "Hi {{name}}, your {{productName}} {{hostname}} is active again. Thank you!" },
  "service.terminated": { name: "Service terminated", group: "Services", vars: ["name", "productName", "hostname"], on: false, text: "Hi {{name}}, your {{productName}} {{hostname}} has been terminated." },
  "ticket.reply": { name: "Ticket reply", group: "Support", vars: ["name", "ticketNumber", "subject"], on: true, text: "Hi {{name}}, we've replied to your ticket #{{ticketNumber}} \"{{subject}}\": {{clientAreaLink}}/client/tickets" },
  "domain.expiry": { name: "Domain expiring", group: "Domains", vars: ["name", "domain", "expiryDate"], on: true, text: "Hi {{name}}, your domain {{domain}} expires on {{expiryDate}}. Renew it to keep your website and email working: {{clientAreaLink}}/client/domains" },
  "auth.welcome": { name: "Welcome", group: "Account", vars: ["name"], on: false, text: "Welcome to {{companyName}}, {{name}}! Your client area: {{clientAreaLink}}" },
};

/** variables never sent over WhatsApp */
const SECRET = /pass(word)?|secret|token|otp|code|link$|url$/i;

const DEFAULTS: WhatsappConfig = {
  enabled: false,
  provider: "meta",
  defaultCountryCode: "91",
  meta: { phoneNumberId: "", apiVersion: "v21.0" },
  http: { url: "", method: "POST", headers: '{"Content-Type": "application/json", "Authorization": "Bearer {{token}}"}', body: '{"to": "{{phone}}", "message": "{{message}}"}', successMatch: "" },
  events: {},
};

export async function getWhatsappConfig(): Promise<WhatsappConfig> {
  const row = await prisma.setting.findUnique({ where: { key: "whatsapp" } });
  const v = (row?.value ?? {}) as Partial<WhatsappConfig>;
  const events: Record<string, EventConfig> = {};
  for (const [k, d] of Object.entries(WHATSAPP_EVENTS)) events[k] = { enabled: d.on, text: d.text, metaLanguage: "en", ...(v.events?.[k] ?? {}) };
  return { ...DEFAULTS, ...v, meta: { ...DEFAULTS.meta, ...(v.meta ?? {}) }, http: { ...DEFAULTS.http, ...(v.http ?? {}) }, events };
}

export async function saveWhatsappConfig(patch: Partial<WhatsappConfig> & { token?: string | null }) {
  const cur = await getWhatsappConfig();
  const { token, ...rest } = patch;
  const next: WhatsappConfig = {
    ...cur,
    ...rest,
    meta: { ...cur.meta, ...(rest.meta ?? {}) },
    http: { ...cur.http, ...(rest.http ?? {}) },
    events: { ...cur.events, ...(rest.events ?? {}) },
    // token: undefined = keep, "" / null = clear, string = replace
    secretEnc: token === undefined ? cur.secretEnc ?? null : token ? encrypt(token) : null,
  };
  await prisma.setting.upsert({ where: { key: "whatsapp" }, update: { value: next as never }, create: { key: "whatsapp", value: next as never } });
  return next;
}

/** public view of the config (no secret) */
export function redact(c: WhatsappConfig) {
  const { secretEnc, ...rest } = c;
  return { ...rest, hasToken: !!secretEnc };
}

/** "+91 98765-43210" / "098765 43210" / "9876543210" → "919876543210" */
export function normalizePhone(raw: string | null | undefined, cc = "91"): string | null {
  if (!raw) return null;
  let d = String(raw).replace(/[^\d+]/g, "");
  if (d.startsWith("+")) d = d.slice(1);
  else if (d.startsWith("00")) d = d.slice(2);
  else {
    d = d.replace(/^0+/, "");
    if (d.length <= 10) d = cc + d;
  }
  d = d.replace(/\D/g, "");
  return d.length >= 10 && d.length <= 15 ? d : null;
}

export function render(text: string, vars: Record<string, unknown>) {
  return text
    .replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, k: string) => {
      const v = k.split(".").reduce<unknown>((o, p) => (o && typeof o === "object" ? (o as Record<string, unknown>)[p] : undefined), vars);
      return v === undefined || v === null ? "" : String(v);
    })
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

/** variables available to WhatsApp messages: email vars minus anything secret, plus links */
async function messageVars(vars: Record<string, unknown>) {
  const s = await getSettings();
  const safe = Object.fromEntries(Object.entries(vars).filter(([k, v]) => !SECRET.test(k) && (typeof v !== "object" || v === null)));
  return {
    ...safe,
    companyName: s.company.brand,
    clientAreaLink: config.appUrl,
    payLink: vars.invoiceId ? `${config.appUrl}/client/invoices/${vars.invoiceId}` : `${config.appUrl}/client/invoices`,
  };
}

/** Called for every client email: queue the WhatsApp version when it's switched on. Never throws. */
export async function notifyWhatsapp(event: string, userId: string | undefined, vars: Record<string, unknown>) {
  try {
    if (!userId || !WHATSAPP_EVENTS[event]) return;
    const cfg = await getWhatsappConfig();
    const ev = cfg.events[event];
    if (!cfg.enabled || !ev?.enabled) return;
    const user = await prisma.user.findUnique({ where: { id: userId }, select: { phone: true, type: true, profile: { select: { whatsappNotifications: true } } } });
    if (!user || user.type !== "CLIENT" || user.profile?.whatsappNotifications === false) return;
    const to = normalizePhone(user.phone, cfg.defaultCountryCode);
    if (!to) return;
    const v = await messageVars(vars);
    const body = render(ev.text, v);
    const msg = await prisma.whatsappMessage.create({ data: { userId, to, event, body } });
    await whatsappQueue().add(event, { messageId: msg.id, vars: v }, { attempts: 3, backoff: { type: "exponential", delay: 60_000 } });
  } catch (e) {
    console.error("[whatsapp] notify failed", e);
  }
}

/** A message typed by staff (client page, invoice page). */
export async function sendManualWhatsapp(args: { userId: string; text: string; actorId: string; event?: string; vars?: Record<string, unknown> }) {
  const cfg = await getWhatsappConfig();
  if (!cfg.enabled) throw Object.assign(new Error("WhatsApp isn't set up yet — Admin → WhatsApp"), { status: 400 });
  const user = await prisma.user.findUniqueOrThrow({ where: { id: args.userId }, select: { phone: true } });
  const to = normalizePhone(user.phone, cfg.defaultCountryCode);
  if (!to) throw Object.assign(new Error("This client has no valid mobile number"), { status: 400 });
  const msg = await prisma.whatsappMessage.create({ data: { userId: args.userId, to, event: args.event ?? "manual", body: args.text.trim(), sentById: args.actorId } });
  await whatsappQueue().add("manual", { messageId: msg.id, vars: args.vars ?? {} }, { attempts: 2, backoff: { type: "fixed", delay: 30_000 } });
  return msg;
}

// ───────────────────────── delivery ─────────────────────────

const jsonEscape = (s: string) => JSON.stringify(s).slice(1, -1);

async function sendMeta(cfg: WhatsappConfig, token: string, to: string, body: string, ev: EventConfig | undefined, vars: Record<string, unknown>) {
  if (!cfg.meta.phoneNumberId) throw new Error("Phone number ID is not set");
  const payload = ev?.metaTemplate
    ? {
        messaging_product: "whatsapp",
        to,
        type: "template",
        template: {
          name: ev.metaTemplate,
          language: { code: ev.metaLanguage || "en" },
          components: (ev.metaParams ?? "").trim()
            ? [{ type: "body", parameters: (ev.metaParams ?? "").split(",").map((p) => p.trim()).filter(Boolean).map((p) => ({ type: "text", text: String(vars[p] ?? "-").slice(0, 1000) || "-" })) }]
            : [],
        },
      }
    : { messaging_product: "whatsapp", to, type: "text", text: { body, preview_url: true } };
  const r = await fetch(`https://graph.facebook.com/${cfg.meta.apiVersion || "v21.0"}/${cfg.meta.phoneNumberId}/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(20_000),
  });
  const j = (await r.json().catch(() => ({}))) as { messages?: { id: string }[]; error?: { message?: string; error_data?: { details?: string } } };
  if (!r.ok) throw new Error(j.error?.error_data?.details ?? j.error?.message ?? `Meta API error ${r.status}`);
  return j.messages?.[0]?.id ?? null;
}

async function sendHttp(cfg: WhatsappConfig, token: string, to: string, body: string) {
  if (!cfg.http.url) throw new Error("Gateway URL is not set");
  const url = cfg.http.url.replace(/\{\{\s*phone\s*\}\}/g, encodeURIComponent(to)).replace(/\{\{\s*message\s*\}\}/g, encodeURIComponent(body)).replace(/\{\{\s*token\s*\}\}/g, encodeURIComponent(token));
  let headers: Record<string, string> = {};
  try {
    headers = JSON.parse(cfg.http.headers.replace(/\{\{\s*token\s*\}\}/g, jsonEscape(token)) || "{}");
  } catch {
    throw new Error("Gateway headers are not valid JSON");
  }
  const init: RequestInit = { method: cfg.http.method, headers, signal: AbortSignal.timeout(20_000) };
  if (cfg.http.method === "POST") {
    const json = (headers["Content-Type"] ?? headers["content-type"] ?? "").includes("json");
    init.body = cfg.http.body
      .replace(/\{\{\s*phone\s*\}\}/g, json ? jsonEscape(to) : encodeURIComponent(to))
      .replace(/\{\{\s*message\s*\}\}/g, json ? jsonEscape(body) : encodeURIComponent(body))
      .replace(/\{\{\s*token\s*\}\}/g, json ? jsonEscape(token) : encodeURIComponent(token));
  }
  const r = await fetch(url, init);
  const text = await r.text();
  if (!r.ok) throw new Error(`Gateway answered ${r.status}: ${text.slice(0, 300)}`);
  if (cfg.http.successMatch && !text.includes(cfg.http.successMatch)) throw new Error(`Gateway response didn't contain "${cfg.http.successMatch}": ${text.slice(0, 300)}`);
  try {
    const j = JSON.parse(text);
    return String(j.id ?? j.messageId ?? j.message_id ?? j.data?.id ?? j.result?.id ?? "") || null;
  } catch {
    return null;
  }
}

/** Send one queued message (worker). */
export async function deliverWhatsapp(messageId: string, vars: Record<string, unknown> = {}) {
  const msg = await prisma.whatsappMessage.findUnique({ where: { id: messageId } });
  if (!msg || msg.status === "SENT") return;
  const cfg = await getWhatsappConfig();
  if (!cfg.enabled) {
    await prisma.whatsappMessage.update({ where: { id: msg.id }, data: { status: "SKIPPED", error: "WhatsApp is switched off" } });
    return;
  }
  const token = cfg.secretEnc ? decrypt(cfg.secretEnc) : "";
  try {
    const id = cfg.provider === "meta" ? await sendMeta(cfg, token, msg.to, msg.body, cfg.events[msg.event], vars) : await sendHttp(cfg, token, msg.to, msg.body);
    await prisma.whatsappMessage.update({ where: { id: msg.id }, data: { status: "SENT", providerId: id, error: null } });
  } catch (e) {
    await prisma.whatsappMessage.update({ where: { id: msg.id }, data: { status: "FAILED", error: String((e as Error).message).slice(0, 1000) } });
    throw e;
  }
}

/** Send a test message right away (settings page). */
export async function testWhatsapp(to: string, text: string) {
  const cfg = await getWhatsappConfig();
  const n = normalizePhone(to, cfg.defaultCountryCode);
  if (!n) throw new Error("Enter a valid mobile number");
  const token = cfg.secretEnc ? decrypt(cfg.secretEnc) : "";
  const msg = await prisma.whatsappMessage.create({ data: { to: n, event: "test", body: text } });
  try {
    const id = cfg.provider === "meta" ? await sendMeta(cfg, token, n, text, undefined, {}) : await sendHttp(cfg, token, n, text);
    await prisma.whatsappMessage.update({ where: { id: msg.id }, data: { status: "SENT", providerId: id } });
    return { ok: true, id };
  } catch (e) {
    await prisma.whatsappMessage.update({ where: { id: msg.id }, data: { status: "FAILED", error: String((e as Error).message).slice(0, 1000) } });
    throw e;
  }
}
