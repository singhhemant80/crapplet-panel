import crypto from "crypto";
import { config } from "../../config";
import { prisma } from "../../db";
import { decrypt, encrypt } from "../../lib/crypto";

/**
 * Outgoing mail settings. Saved in the database from Admin → Email Delivery (the SMTP password and
 * DKIM private key are encrypted). Until that page is saved once, the SMTP_* values in .env are used.
 */
export type Security = "starttls" | "ssl" | "none";

export interface MailConfig {
  /** false = don't send, only write to the email log (dev / staging) */
  enabled: boolean;
  preset: string;
  host: string;
  port: number;
  security: Security;
  user: string;
  pass: string;
  fromName: string;
  fromEmail: string;
  replyTo: string;
  /** envelope sender (Return-Path) — bounces go here; empty = the From address */
  returnPath: string;
  /** name we greet the SMTP server with; empty = the From domain */
  ehloName: string;
  /** accept self-signed TLS certificates (own Postfix on the same server) */
  allowSelfSigned: boolean;
  /** selector the mail provider gave you (google, zmail, selector1…) — only used by the DNS check */
  providerDkimSelector: string;
  /** panel-side DKIM signing — needed when sending through your own server; providers sign for you */
  dkim: { enabled: boolean; selector: string; privateKey: string; publicKey: string };
  /** public IPv4 mail leaves from when sending with your own server (for SPF / PTR / blacklist checks) */
  sendingIp: string;
}

type Stored = Omit<MailConfig, "pass" | "dkim"> & { passEnc?: string; dkim?: { enabled: boolean; selector: string; privateKeyEnc?: string; publicKey?: string } };

export interface Preset {
  label: string;
  host: string;
  port: number;
  security: Security;
  user?: string;
  /** any of these in the SPF record counts as authorised */
  spf: string[];
  dkimSelector?: string;
  note: string;
}

export const PRESETS: Record<string, Preset> = {
  zoho_in: { label: "Zoho Mail (India — zoho.in)", host: "smtp.zoho.in", port: 587, security: "starttls", spf: ["include:zoho.in"], note: "Use the full mailbox address as the username. If two-factor login is on, create an application-specific password in Zoho → My Account → Security. Add the DKIM record from Zoho Mail Admin → Domains → Email configuration → DKIM." },
  zoho_com: { label: "Zoho Mail (global — zoho.com)", host: "smtp.zoho.com", port: 587, security: "starttls", spf: ["include:zoho.com"], note: "Same as Zoho India, for accounts created on zoho.com." },
  zeptomail: { label: "Zoho ZeptoMail (transactional)", host: "smtp.zeptomail.in", port: 587, security: "starttls", user: "emailapikey", spf: ["include:zeptomail.net", "include:zeptomail.in", "include:zoho.in"], note: "Built for transactional mail such as invoices. Username is emailapikey; the password is the Send Mail token. Add the DKIM and bounce (CNAME) records ZeptoMail shows for your domain." },
  google: { label: "Google Workspace / Gmail", host: "smtp.gmail.com", port: 587, security: "starttls", spf: ["include:_spf.google.com"], dkimSelector: "google", note: "Needs an App Password (Google Account → Security → 2-Step Verification → App passwords). Turn on DKIM in Google Admin → Apps → Gmail → Authenticate email. Limit: about 2,000 messages a day." },
  microsoft365: { label: "Microsoft 365 / Outlook", host: "smtp.office365.com", port: 587, security: "starttls", spf: ["include:spf.protection.outlook.com"], dkimSelector: "selector1", note: "SMTP AUTH must be enabled for the mailbox. Microsoft is retiring password-based SMTP AUTH, so a dedicated sending service is the safer choice." },
  ses: { label: "Amazon SES (Mumbai)", host: "email-smtp.ap-south-1.amazonaws.com", port: 587, security: "starttls", spf: ["include:amazonses.com"], note: "Use SMTP credentials from SES → SMTP settings (not your AWS keys). Verify the domain with Easy DKIM (3 CNAME records) and request production access." },
  brevo: { label: "Brevo (Sendinblue)", host: "smtp-relay.brevo.com", port: 587, security: "starttls", spf: ["include:spf.brevo.com", "include:spf.sendinblue.com", "include:sendinblue.com"], note: "Use the SMTP login and SMTP key from Brevo → SMTP & API. Authenticate the domain in Brevo → Senders, Domains & Dedicated IPs." },
  mailgun: { label: "Mailgun", host: "smtp.mailgun.org", port: 587, security: "starttls", spf: ["include:mailgun.org"], note: "Use the SMTP credentials of your verified Mailgun domain." },
  sendgrid: { label: "SendGrid", host: "smtp.sendgrid.net", port: 587, security: "starttls", user: "apikey", spf: ["include:sendgrid.net"], note: "Username is literally apikey; the password is an API key with Mail Send permission. Complete Domain Authentication in SendGrid." },
  postmark: { label: "Postmark", host: "smtp.postmarkapp.com", port: 587, security: "starttls", spf: [], note: "Username and password are both your Server API token. Add the DKIM and Return-Path records Postmark shows." },
  local: { label: "This server (Postfix on localhost)", host: "127.0.0.1", port: 25, security: "none", spf: [], note: "Only for experienced admins: the server's IP needs reverse DNS (PTR) set to your mail hostname, outbound port 25 open, a clean IP reputation, and the panel's DKIM signing turned on. A sending service gets to the inbox far more reliably." },
  custom: { label: "Other SMTP server", host: "", port: 587, security: "starttls", spf: [], note: "Enter the details your mail provider gives you." },
};

function parseFrom(from: string) {
  const m = from.match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/);
  return m ? { name: m[1].trim(), email: m[2].trim() } : { name: "", email: from.trim() };
}

function fromEnv(): MailConfig {
  const f = parseFrom(config.smtp.from);
  return {
    enabled: !!config.smtp.host,
    preset: config.smtp.host.includes("zoho.in") ? "zoho_in" : "custom",
    host: config.smtp.host,
    port: config.smtp.port,
    security: config.smtp.secure ? "ssl" : config.smtp.port === 25 && /^(127\.|localhost)/.test(config.smtp.host) ? "none" : "starttls",
    user: config.smtp.user,
    pass: config.smtp.pass,
    fromName: f.name,
    fromEmail: f.email,
    replyTo: "",
    returnPath: "",
    ehloName: "",
    allowSelfSigned: false,
    providerDkimSelector: "",
    dkim: { enabled: false, selector: "crapplet", privateKey: "", publicKey: "" },
    sendingIp: "",
  };
}

let cache: { at: number; cfg: MailConfig; fromDb: boolean } | null = null;

export async function getMailConfig(): Promise<MailConfig & { fromDb: boolean }> {
  if (cache && Date.now() - cache.at < 15_000) return { ...cache.cfg, fromDb: cache.fromDb };
  const row = await prisma.setting.findUnique({ where: { key: "mail" } });
  let cfg = fromEnv();
  if (row) {
    const s = row.value as unknown as Stored;
    const safe = (v?: string) => {
      try {
        return decrypt(v);
      } catch {
        return "";
      }
    };
    cfg = {
      ...cfg,
      ...s,
      pass: safe(s.passEnc),
      dkim: { enabled: !!s.dkim?.enabled, selector: s.dkim?.selector || "crapplet", privateKey: safe(s.dkim?.privateKeyEnc), publicKey: s.dkim?.publicKey ?? "" },
    };
    delete (cfg as Partial<Stored>).passEnc;
  }
  cache = { at: Date.now(), cfg, fromDb: !!row };
  return { ...cfg, fromDb: !!row };
}

export function clearMailCache() {
  cache = null;
}

/** Saves settings. A password of "" or "••••…" keeps the current one. */
export async function saveMailConfig(input: Partial<MailConfig>) {
  const cur = await getMailConfig();
  const next: MailConfig = { ...cur, ...input, dkim: { ...cur.dkim, ...(input.dkim ?? {}) } };
  if (!input.pass || input.pass.startsWith("••")) next.pass = cur.pass;
  if (!input.dkim?.privateKey) next.dkim.privateKey = cur.dkim.privateKey;
  const { pass, dkim, ...rest } = next;
  delete (rest as Record<string, unknown>).fromDb;
  const stored: Stored = {
    ...rest,
    passEnc: pass ? encrypt(pass) : "",
    dkim: { enabled: dkim.enabled, selector: dkim.selector, privateKeyEnc: dkim.privateKey ? encrypt(dkim.privateKey) : "", publicKey: dkim.publicKey },
  };
  await prisma.setting.upsert({ where: { key: "mail" }, update: { value: stored as never }, create: { key: "mail", value: stored as never } });
  clearMailCache();
  return getMailConfig();
}

/** The settings as shown to the admin: secrets masked. */
export function publicMailConfig(c: MailConfig & { fromDb?: boolean }) {
  return { ...c, pass: c.pass ? "••••••••" : "", dkim: { ...c.dkim, privateKey: c.dkim.privateKey ? "(stored)" : "" } };
}

/** New 2048-bit RSA key for DKIM; the public half goes into DNS as p=… */
export function generateDkimKey() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  return {
    privateKey: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    publicKey: (publicKey.export({ type: "spki", format: "der" }) as Buffer).toString("base64"),
  };
}

export const domainOf = (email: string) => email.split("@")[1]?.toLowerCase().trim() ?? "";
