/**
 * What kind of order flow a plan gets.
 * Hosting (shared / reseller / WordPress, or anything provisioned on cPanel) is ordered like WHMCS:
 * choose a domain first (register, transfer or use your own), then configure. Servers get OS + hostname.
 */
export const HOSTING_TYPES = ["SHARED", "RESELLER_HOSTING", "WORDPRESS"] as const;

export const isHostingProduct = (p: { type: string; provisioner: string }) => (HOSTING_TYPES as readonly string[]).includes(p.type) || p.provisioner === "CPANEL";
export const isVpsProduct = (p: { provisioner: string }) => p.provisioner === "PROXMOX" || p.provisioner === "VIRTUALIZOR";

/** Rack / colocation: the customer brings the hardware — no OS, no VM resources. */
export const isColoProduct = (p: { type: string }) => p.type === "COLOCATION";

/** What a colocation plan includes (Products → plan → Colocation), stored in moduleConfig.colo. */
export type ColoSpecs = { rackUnits: number | null; powerW: number | null; portSpeed: string | null; datacenter: string | null; remoteHands: string | null; crossConnects: number | null };
export function coloSpecs(moduleConfig: unknown): ColoSpecs {
  const c = ((moduleConfig ?? {}) as { colo?: Record<string, unknown> }).colo ?? {};
  const n = (v: unknown) => (v === null || v === undefined || v === "" || !Number.isFinite(Number(v)) ? null : Number(v));
  const t = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim().slice(0, 120) : null);
  return { rackUnits: n(c.rackUnits), powerW: n(c.powerW), portSpeed: t(c.portSpeed), datacenter: t(c.datacenter), remoteHands: t(c.remoteHands), crossConnects: n(c.crossConnects) };
}

/** A bare domain like example.com or shop.example.co.in (no scheme, path or www-prefix rules here). */
export const DOMAIN_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/;

export const tldOf = (domain: string) => "." + domain.split(".").slice(1).join(".");

export type FreeDomainRule = { freeDomain: string; freeDomainCycles: string[]; freeDomainTlds: string[] };

/** Does this plan, on this billing cycle, include this domain for free? */
export function qualifiesForFreeDomain(p: FreeDomainRule, cycle: string, domain: string) {
  if (p.freeDomain !== "once" && p.freeDomain !== "recurring") return false;
  if (p.freeDomainCycles.length && !p.freeDomainCycles.includes(cycle)) return false;
  const tld = tldOf(domain);
  if (p.freeDomainTlds.length && !p.freeDomainTlds.map((t) => (t.startsWith(".") ? t : `.${t}`).toLowerCase()).includes(tld)) return false;
  return true;
}
