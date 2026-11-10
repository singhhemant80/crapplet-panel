import { promises as dnsp } from "dns";
import os from "os";
import { PRESETS, domainOf, type MailConfig } from "./mail-config";

/**
 * Inbox-placement checks: everything Gmail, Outlook, Yahoo and Zoho look at before deciding
 * between inbox and spam — SPF, DKIM, DMARC alignment, MX, reverse DNS and blocklists.
 */
export type Status = "ok" | "warn" | "error" | "info";
export interface DnsRecord {
  type: "TXT" | "CNAME" | "PTR" | "MX";
  host: string;
  value: string;
  why: string;
}
export interface Check {
  key: string;
  label: string;
  status: Status;
  detail: string;
  found?: string;
  fix?: string;
  record?: DnsRecord;
}

export interface Resolver {
  resolveTxt(name: string): Promise<string[][]>;
  resolveMx(name: string): Promise<{ exchange: string; priority: number }[]>;
  resolve4(name: string): Promise<string[]>;
  resolveCname(name: string): Promise<string[]>;
  reverse(ip: string): Promise<string[]>;
}

const sysResolver = (): Resolver => {
  const r = new dnsp.Resolver({ timeout: 4000, tries: 2 });
  return r as unknown as Resolver;
};

const FREE_MAIL = /^(gmail|googlemail|yahoo|ymail|outlook|hotmail|live|msn|rediffmail|aol|icloud|me|proton|protonmail|zohomail)\.(com|in|co\.in|me)$/i;

async function txt(r: Resolver, name: string): Promise<string[]> {
  try {
    return (await r.resolveTxt(name)).map((parts) => parts.join(""));
  } catch {
    return [];
  }
}
async function safe<T>(p: Promise<T>, fallback: T): Promise<T> {
  try {
    return await p;
  } catch {
    return fallback;
  }
}

const isPrivate = (ip: string) => /^(10\.|127\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)/.test(ip);

/** The server's own public IPv4, used when mail goes out directly from this machine. */
export function guessPublicIp() {
  for (const list of Object.values(os.networkInterfaces()))
    for (const a of list ?? []) if (a.family === "IPv4" && !a.internal && !isPrivate(a.address)) return a.address;
  return "";
}

/** Counts mechanisms that cost a DNS lookup; more than 10 makes SPF fail (permerror). */
export function spfLookups(spf: string) {
  return spf.split(/\s+/).filter((t) => /^[+~?-]?(include:|a\b|a:|a\/|mx\b|mx:|mx\/|ptr|exists:|redirect=)/i.test(t)).length;
}

/** Adds the mechanism we need to an existing SPF record (or builds a new one). */
export function mergeSpf(current: string | undefined, add: string[]) {
  if (!current) return `v=spf1 ${[...add, "mx"].join(" ")} ~all`;
  const parts = current.trim().split(/\s+/);
  const missing = add.filter((m) => !parts.some((p) => p.toLowerCase() === m.toLowerCase()));
  if (!missing.length) return current;
  const allIdx = parts.findIndex((p) => /^[+~?-]?all$/i.test(p) || /^redirect=/i.test(p));
  if (allIdx === -1) return [...parts, ...missing, "~all"].join(" ");
  parts.splice(allIdx, 0, ...missing);
  return parts.join(" ").replace(/\s\+?all$/i, " ~all");
}

const BLOCKLISTS = [
  { zone: "zen.spamhaus.org", name: "Spamhaus ZEN" },
  { zone: "bl.spamcop.net", name: "SpamCop" },
  { zone: "b.barracudacentral.org", name: "Barracuda" },
  { zone: "psbl.surriel.com", name: "PSBL" },
  { zone: "bl.mailspike.net", name: "Mailspike" },
  { zone: "dnsbl-1.uceprotect.net", name: "UCEPROTECT-1" },
];

export async function blocklistCheck(r: Resolver, ip: string) {
  const rev = ip.split(".").reverse().join(".");
  return Promise.all(
    BLOCKLISTS.map(async (b) => {
      const a = await safe(r.resolve4(`${rev}.${b.zone}`), [] as string[]);
      // 127.255.255.x = Spamhaus refusing queries from public resolvers, not a listing
      const unknown = a.some((x) => x.startsWith("127.255.255."));
      return { ...b, listed: !unknown && a.some((x) => x.startsWith("127.")), unknown, answer: a.join(", ") };
    }),
  );
}

export async function checkDeliverability(c: MailConfig, r: Resolver = sysResolver()) {
  const domain = domainOf(c.fromEmail);
  const preset = PRESETS[c.preset] ?? PRESETS.custom;
  const checks: Check[] = [];
  const records: DnsRecord[] = [];
  const own = c.preset === "local" || /^(127\.|localhost$)/.test(c.host);
  const ip = c.sendingIp || (own ? guessPublicIp() : "");

  // ── 1. Sending setup
  if (!c.host || !c.enabled) {
    checks.push({ key: "smtp", label: "Mail server", status: "error", detail: !c.host ? "No SMTP server is set, so emails are only written to the log and never sent." : "Sending is switched off — emails are only logged.", fix: "Choose your mail provider below, fill in the login and press Save." });
  } else checks.push({ key: "smtp", label: "Mail server", status: "ok", detail: `Sending through ${c.host}:${c.port} (${c.security.toUpperCase()}).` });

  if (!domain) {
    checks.push({ key: "from", label: "From address", status: "error", detail: "No From email address is set." });
    return { domain, checks, records, ip, summary: summary(checks) };
  }
  if (FREE_MAIL.test(domain)) {
    checks.push({ key: "from", label: "From address", status: "error", detail: `${c.fromEmail} is a free mailbox domain. You can't publish SPF/DKIM for ${domain}, so mail sent through the panel fails DMARC and lands in spam or is rejected.`, fix: `Send from an address on your own domain, e.g. billing@crapplet.co.in.` });
  } else {
    const userDomain = c.user.includes("@") ? domainOf(c.user) : "";
    const strict = ["zoho_in", "zoho_com", "google", "microsoft365"].includes(c.preset);
    if (strict && userDomain && userDomain !== domain)
      checks.push({ key: "from", label: "From address", status: "warn", detail: `You log in as ${c.user} but send as ${c.fromEmail}. ${preset.label} only lets a mailbox send as itself or as an alias you've added.`, fix: `Add ${c.fromEmail} as an alias/"send as" address in ${preset.label}, or log in with that mailbox.` });
    else checks.push({ key: "from", label: "From address", status: "ok", detail: `Emails are sent as ${c.fromName ? `"${c.fromName}" ` : ""}<${c.fromEmail}>.` });
  }
  if (!c.fromName) checks.push({ key: "fromName", label: "Sender name", status: "warn", detail: "No sender name — inboxes show only the bare address, which looks less trustworthy.", fix: "Set the From name, e.g. Crapplet Cloud." });

  // ── 2. MX — replies and bounces need somewhere to go
  const mx = await safe(r.resolveMx(domain), []);
  checks.push(
    mx.length
      ? { key: "mx", label: "MX (incoming mail)", status: "ok", detail: `${domain} receives mail at ${mx.sort((a, b) => a.priority - b.priority).map((m) => m.exchange).join(", ")}.` }
      : { key: "mx", label: "MX (incoming mail)", status: "warn", detail: `${domain} has no MX record, so customers' replies and bounce reports can't be delivered. Some filters treat this as a sign of a throw-away domain.`, fix: "Add the MX records from your mail provider." },
  );

  // ── 3. SPF
  const spfs = (await txt(r, domain)).filter((t) => /^v=spf1(\s|$)/i.test(t));
  const need = own ? (ip ? [`ip4:${ip}`] : []) : preset.spf.slice(0, 1);
  const spf = spfs[0];
  if (spfs.length > 1) {
    checks.push({ key: "spf", label: "SPF", status: "error", detail: `${domain} has ${spfs.length} SPF records. More than one makes SPF fail everywhere.`, found: spfs.join("\n"), fix: "Delete the extras and keep a single combined record:", record: { type: "TXT", host: "@", value: mergeSpf(spfs[0], need), why: "One SPF record listing every service that sends as your domain" } });
  } else if (!spf) {
    checks.push({ key: "spf", label: "SPF", status: "error", detail: `${domain} has no SPF record, so receiving servers can't tell whether ${c.host || "your server"} may send for you.`, fix: "Add this TXT record:", record: { type: "TXT", host: "@", value: mergeSpf(undefined, need), why: "Authorises your mail provider to send as your domain" } });
  } else {
    const okAny = own ? !ip || spf.includes(`ip4:${ip}`) || /\b(a|mx)\b/.test(spf) : !preset.spf.length || preset.spf.some((m) => spf.toLowerCase().includes(m.toLowerCase()));
    const lookups = spfLookups(spf);
    if (/[\s]\+?all$/i.test(spf)) checks.push({ key: "spf", label: "SPF", status: "error", detail: "Your SPF record ends in +all, which lets anyone in the world send as your domain. Filters treat that as no SPF at all.", found: spf, fix: "Replace it with:", record: { type: "TXT", host: "@", value: mergeSpf(spf.replace(/\s\+?all$/i, ""), need), why: "Only your providers may send" } });
    else if (!okAny) checks.push({ key: "spf", label: "SPF", status: "error", detail: `SPF exists but doesn't include ${need.join(" ") || preset.label}, so mail from the panel fails SPF.`, found: spf, fix: "Change the TXT record to:", record: { type: "TXT", host: "@", value: mergeSpf(spf, need), why: "Adds your mail provider to the existing SPF record" } });
    else if (lookups > 10) checks.push({ key: "spf", label: "SPF", status: "error", detail: `SPF needs ${lookups} DNS lookups; the limit is 10, so it fails.`, found: spf, fix: "Remove services you no longer use from the record." });
    else if (/\?all$/i.test(spf)) checks.push({ key: "spf", label: "SPF", status: "warn", detail: "SPF ends in ?all (neutral), which gives no protection.", found: spf, fix: "Change ?all to ~all." });
    else checks.push({ key: "spf", label: "SPF", status: "ok", detail: `SPF authorises ${own ? ip || "this server" : preset.label}.`, found: spf });
  }

  // ── 4. DKIM
  if (c.dkim.enabled && c.dkim.publicKey) {
    const host = `${c.dkim.selector}._domainkey.${domain}`;
    const found = (await txt(r, host)).find((t) => /p=/.test(t));
    const value = `v=DKIM1; k=rsa; p=${c.dkim.publicKey}`;
    const record: DnsRecord = { type: "TXT", host: `${c.dkim.selector}._domainkey`, value, why: "Public key for the signatures the panel adds" };
    if (!found) checks.push({ key: "dkim", label: "DKIM (panel signing)", status: "error", detail: `Emails are signed with selector "${c.dkim.selector}", but ${host} has no key, so the signature fails.`, fix: "Add this TXT record (long values are split into 255-character chunks automatically by most DNS panels):", record });
    else if (found.replace(/\s/g, "").includes(`p=${c.dkim.publicKey}`)) checks.push({ key: "dkim", label: "DKIM (panel signing)", status: "ok", detail: `${host} matches the panel's signing key.` });
    else checks.push({ key: "dkim", label: "DKIM (panel signing)", status: "error", detail: `${host} has a different key than the one the panel signs with.`, found, fix: "Replace the record with:", record });
  } else {
    const sel = c.providerDkimSelector || preset.dkimSelector;
    if (own) checks.push({ key: "dkim", label: "DKIM", status: "error", detail: "Mail sent straight from this server isn't DKIM-signed. Gmail and Outlook send most unsigned mail to spam.", fix: "Turn on DKIM signing below and add the record it shows." });
    else if (!sel) checks.push({ key: "dkim", label: "DKIM", status: "warn", detail: `Can't check DKIM without the selector name. ${preset.label === PRESETS.custom.label ? "Your provider" : preset.label} signs your mail only after you add its DKIM record to DNS.`, fix: "Enable DKIM in your mail provider's admin console, add the record it gives you, then type its selector (the part before ._domainkey) in “Provider DKIM selector”." });
    else {
      const host = `${sel}._domainkey.${domain}`;
      const [t, cname] = await Promise.all([txt(r, host), safe(r.resolveCname(host), [] as string[])]);
      const ok = t.some((x) => /p=/.test(x)) || cname.length > 0;
      checks.push(ok ? { key: "dkim", label: "DKIM", status: "ok", detail: `DKIM key found at ${host}${cname.length ? ` (→ ${cname[0]})` : ""}.` } : { key: "dkim", label: "DKIM", status: "error", detail: `No DKIM key at ${host}. Without it your provider's signature can't be verified.`, fix: `Turn on DKIM in ${preset.label} and add the TXT/CNAME record it shows.` });
    }
  }

  // ── 5. DMARC
  const dmarc = (await txt(r, `_dmarc.${domain}`)).find((t) => /^v=DMARC1/i.test(t));
  const dmarcRec: DnsRecord = { type: "TXT", host: "_dmarc", value: `v=DMARC1; p=none; rua=mailto:dmarc@${domain}; adkim=r; aspf=r; pct=100`, why: "Required by Gmail/Yahoo for bulk senders; start with p=none, move to p=quarantine once reports look clean" };
  if (!dmarc) checks.push({ key: "dmarc", label: "DMARC", status: "error", detail: `${domain} has no DMARC policy. Gmail and Yahoo require one, and without it spoofed mail can hurt your domain's reputation.`, fix: "Add this TXT record:", record: dmarcRec });
  else {
    const p = dmarc.match(/;\s*p=(\w+)/i)?.[1]?.toLowerCase();
    if (p === "none") checks.push({ key: "dmarc", label: "DMARC", status: "ok", detail: "DMARC is published in monitoring mode (p=none). Once SPF and DKIM pass for a few weeks, consider p=quarantine.", found: dmarc });
    else checks.push({ key: "dmarc", label: "DMARC", status: "ok", detail: `DMARC policy p=${p}.`, found: dmarc });
  }

  // ── 6. Own server: reverse DNS + blocklists
  if (own) {
    if (!ip) checks.push({ key: "ptr", label: "Reverse DNS", status: "warn", detail: "Couldn't detect this server's public IP.", fix: "Type it in “Sending IP”." });
    else {
      const ptr = await safe(r.reverse(ip), [] as string[]);
      const fwd = ptr[0] ? await safe(r.resolve4(ptr[0]), [] as string[]) : [];
      const generic = ptr[0] && (ptr[0].includes(ip.replace(/\./g, "-")) || /(^|\.)(ip|static|dynamic|host|vps|cust|pool)[-.]/i.test(ptr[0]));
      if (!ptr.length) checks.push({ key: "ptr", label: "Reverse DNS (PTR)", status: "error", detail: `${ip} has no reverse DNS. Gmail and Outlook reject or junk mail from IPs without it.`, fix: `Ask your server/IP provider to set the PTR of ${ip} to mail.${domain}, and add an A record mail.${domain} → ${ip}.`, record: { type: "PTR", host: ip, value: `mail.${domain}`, why: "Set at your IP provider, not in your domain's DNS" } });
      else if (!fwd.includes(ip)) checks.push({ key: "ptr", label: "Reverse DNS (PTR)", status: "error", detail: `${ip} → ${ptr[0]}, but ${ptr[0]} doesn't point back to ${ip}.`, fix: `Add an A record ${ptr[0]} → ${ip}.` });
      else if (generic) checks.push({ key: "ptr", label: "Reverse DNS (PTR)", status: "warn", detail: `PTR is ${ptr[0]}, which looks like a generic hosting name.`, fix: `Ask your provider to set it to mail.${domain}.` });
      else checks.push({ key: "ptr", label: "Reverse DNS (PTR)", status: "ok", detail: `${ip} ↔ ${ptr[0]}` });

      const bl = await blocklistCheck(r, ip);
      const listed = bl.filter((b) => b.listed);
      checks.push(
        listed.length
          ? { key: "blocklist", label: "Blocklists", status: "error", detail: `${ip} is listed on ${listed.map((b) => b.name).join(", ")}. Mail from it will be rejected or junked.`, fix: "Request delisting on each list's website after fixing the cause (compromised account, open relay, bulk mail). Until then, send through a mail provider instead." }
          : { key: "blocklist", label: "Blocklists", status: "ok", detail: `${ip} isn't on ${bl.filter((b) => !b.unknown).length} major blocklists${bl.some((b) => b.unknown) ? " (Spamhaus refused the lookup from this DNS resolver — check it at check.spamhaus.org)" : ""}.` },
      );
    }
  }

  return { domain, checks, records: checks.map((c) => c.record).filter((x): x is DnsRecord => !!x), ip, summary: summary(checks) };
}

function summary(checks: Check[]) {
  const errors = checks.filter((c) => c.status === "error").length;
  const warns = checks.filter((c) => c.status === "warn").length;
  return { errors, warns, ok: checks.filter((c) => c.status === "ok").length, verdict: errors ? "Likely to land in spam" : warns ? "Mostly good — fix the warnings" : "Ready for the inbox" };
}
