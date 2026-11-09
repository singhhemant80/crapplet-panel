/**
 * Domains: registrar abstraction + lifecycle.
 * The built-in "manual" registrar uses public RDAP for availability and leaves registration to staff
 * (Admin → Domains → mark registered). Real registrar APIs plug in by implementing `Registrar`.
 */
import { request } from "undici";
import { prisma } from "../../db";
import { decrypt } from "../../lib/crypto";
import { addMonths } from "../../lib/money";
import { audit } from "../../lib/audit";

export interface Registrar {
  code: string;
  available(domain: string): Promise<boolean | null>;
  register?(domain: { name: string; years: number; nameservers: string[] }): Promise<{ expiryDate: Date }>;
  transfer?(domain: { name: string; eppCode: string }): Promise<void>;
  renew?(domain: { name: string; years: number }): Promise<{ expiryDate: Date }>;
  setNameservers?(name: string, ns: string[]): Promise<void>;
  setLock?(name: string, locked: boolean): Promise<void>;
}

/** RDAP (RFC 9083) availability check — 404 from the registry's RDAP means unregistered. */
export async function rdapAvailable(domain: string): Promise<boolean | null> {
  try {
    const res = await request(`https://rdap.org/domain/${encodeURIComponent(domain)}`, { method: "GET", maxRedirections: 3, headersTimeout: 8000, bodyTimeout: 8000 });
    await res.body.dump();
    if (res.statusCode === 404) return true;
    if (res.statusCode === 200) return false;
    return null;
  } catch {
    return null;
  }
}

const manual: Registrar = { code: "manual", available: rdapAvailable };
export const REGISTRARS: Record<string, Registrar> = { manual };

export async function checkDomain(name: string) {
  const tld = "." + name.split(".").slice(1).join(".");
  const pricing = await prisma.domainPricing.findUnique({ where: { tld } });
  const reg = REGISTRARS[pricing?.registrar ?? "manual"] ?? manual;
  const ours = await prisma.domain.findUnique({ where: { name } });
  const available = ours && !["CANCELLED", "TRANSFERRED_AWAY"].includes(ours.status) ? false : await reg.available(name);
  return { name, tld, available, pricing: pricing?.enabled ? { register: pricing.register, transfer: pricing.transfer, renew: pricing.renew } : null };
}

/** Called once the domain's invoice is paid. */
export async function onDomainPaid(domainId: string, kind: "initial" | "renew") {
  const d = await prisma.domain.findUniqueOrThrow({ where: { id: domainId } });
  const reg = REGISTRARS[d.registrar] ?? manual;
  if (kind === "renew") {
    if (reg.renew) {
      const r = await reg.renew({ name: d.name, years: 1 });
      await prisma.domain.update({ where: { id: d.id }, data: { expiryDate: r.expiryDate, nextDueDate: r.expiryDate, status: "ACTIVE" } });
    } else {
      const base = d.expiryDate && d.expiryDate > new Date() ? d.expiryDate : new Date();
      await prisma.domain.update({ where: { id: d.id }, data: { expiryDate: addMonths(base, 12), nextDueDate: addMonths(base, 12), status: "ACTIVE" } });
      await audit({ action: "domain.renewal_pending_manual", entity: "domain", entityId: d.id, details: { name: d.name } });
    }
    return;
  }
  if (d.action === "register" && reg.register) {
    const r = await reg.register({ name: d.name, years: d.years, nameservers: d.nameservers });
    await prisma.domain.update({ where: { id: d.id }, data: { status: "ACTIVE", registrationDate: new Date(), expiryDate: r.expiryDate, nextDueDate: r.expiryDate } });
  } else if (d.action === "transfer" && reg.transfer && d.eppCodeEnc) {
    await reg.transfer({ name: d.name, eppCode: decrypt(d.eppCodeEnc) });
  } else {
    // manual registrar: staff completes the registration and marks it active
    await audit({ action: "domain.awaiting_manual_registration", entity: "domain", entityId: d.id, details: { name: d.name, action: d.action } });
  }
}
