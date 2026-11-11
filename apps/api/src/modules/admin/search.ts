/**
 * One search for staff: customers, services (IP, hostname, VPS id, cPanel user), orders, invoices,
 * domains, tickets and payments — by whatever the person types.
 */
import type { Prisma } from "../../db";

const ci = (v: string) => ({ contains: v, mode: "insensitive" as const });

/** Digits of a phone number (drops +91 / leading 0 / spaces) — null if it doesn't look like one. */
export function phoneDigits(q: string) {
  const d = q.replace(/\D/g, "");
  if (d.length < 5 || d.length > 15 || !/^[+\d\s()-]+$/.test(q.trim())) return null;
  return d.length > 10 ? d.slice(-10) : d.replace(/^0+/, "");
}

export function clientWhere(qRaw: string): Prisma.UserWhereInput {
  const q = qRaw.trim();
  const words = q.split(/\s+/).filter(Boolean);
  const phone = phoneDigits(q);
  const or: Prisma.UserWhereInput[] = [
    { email: ci(q) },
    { firstName: ci(q) },
    { lastName: ci(q) },
    { profile: { companyName: ci(q) } },
    { profile: { gstin: ci(q.toUpperCase()) } },
    { profile: { pan: ci(q.toUpperCase()) } },
    { profile: { city: ci(q) } },
    { id: q },
    { id: { endsWith: q.toLowerCase() } },
    // anything on their services: IP, hostname, VPS id, cPanel user
    { services: { some: { OR: [{ hostname: ci(q) }, { remoteId: q }, { username: q }, { ips: { some: { address: { startsWith: q } } } }] } } },
    { domains: { some: { name: ci(q) } } },
    { contacts: { some: { OR: [{ email: ci(q) }, { firstName: ci(q) }, ...(phone ? [{ phone: { contains: phone } }] : [])] } } },
  ];
  if (phone) or.push({ phone: { contains: phone } });
  // "Hemant Singh" → first + last name
  if (words.length >= 2) or.push({ AND: [{ firstName: ci(words[0]) }, { lastName: ci(words.slice(1).join(" ")) }] });
  return { OR: or };
}

export function serviceWhere(qRaw: string): Prisma.ServiceWhereInput {
  const q = qRaw.trim();
  const phone = phoneDigits(q);
  return {
    OR: [
      { hostname: ci(q) },
      { remoteId: q },
      { username: q },
      { id: q },
      { ips: { some: { address: { startsWith: q } } } },
      { ips: { some: { rdns: ci(q) } } },
      { product: { name: ci(q) } },
      { order: { number: ci(q) } },
      { user: clientWhereLite(q, phone) },
    ],
  };
}

/** Customer match without the service/domain relations (used inside other searches). */
function clientWhereLite(q: string, phone: string | null): Prisma.UserWhereInput {
  const words = q.split(/\s+/).filter(Boolean);
  return {
    OR: [
      { email: ci(q) },
      { firstName: ci(q) },
      { lastName: ci(q) },
      { profile: { companyName: ci(q) } },
      { profile: { gstin: ci(q.toUpperCase()) } },
      ...(phone ? [{ phone: { contains: phone } }] : []),
      ...(words.length >= 2 ? [{ AND: [{ firstName: ci(words[0]) }, { lastName: ci(words.slice(1).join(" ")) }] }] : []),
    ],
  };
}

export function invoiceWhere(qRaw: string): Prisma.InvoiceWhereInput {
  const q = qRaw.trim();
  return { OR: [{ number: ci(q) }, { proformaNumber: ci(q) }, { id: q }, { user: clientWhereLite(q, phoneDigits(q)) }, { transactions: { some: { gatewayTxnId: q } } }, { order: { number: ci(q) } }] };
}

export function orderWhere(qRaw: string): Prisma.OrderWhereInput {
  const q = qRaw.trim();
  return { OR: [{ number: ci(q) }, { id: q }, { ip: { startsWith: q } }, { services: { some: { OR: [{ hostname: ci(q) }, { ips: { some: { address: { startsWith: q } } } }, { remoteId: q }] } } }, { domains: { some: { name: ci(q) } } }, { user: clientWhereLite(q, phoneDigits(q)) }] };
}
