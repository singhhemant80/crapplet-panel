/**
 * Signed event notifications to a reseller's website.
 *
 *   POST <webhookUrl>
 *   Content-Type: application/json
 *   X-Crapplet-Event: service.active
 *   X-Crapplet-Timestamp: 1763112345
 *   X-Crapplet-Signature: sha256=<hex HMAC-SHA256 of "<timestamp>.<raw body>" with the webhook secret>
 *   { "id": "evt_…", "event": "service.active", "createdAt": "…", "data": { … } }
 *
 * Delivered in the background with 3 attempts (now, +10 s, +60 s); any 2xx counts as delivered.
 */
import crypto from "node:crypto";
import dns from "node:dns/promises";
import net from "node:net";
import { prisma } from "../../db";
import { decrypt } from "../../lib/crypto";
import { badRequest } from "../../lib/http";

export const RESELLER_EVENTS = ["service.active", "service.failed", "service.suspended", "service.unsuspended", "service.terminated", "service.reinstalled", "invoice.paid"] as const;
export type ResellerEvent = (typeof RESELLER_EVENTS)[number];

const privateV4 = (ip: string) => {
  const [a, b] = ip.split(".").map(Number);
  return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
};
const privateIp = (ip: string) => (net.isIPv4(ip) ? privateV4(ip) : /^(::1|::|fc|fd|fe80|::ffff:(10|127|192\.168|172\.(1[6-9]|2\d|3[01]))\.)/i.test(ip));

/** Only public https endpoints — never our own network (no SSRF through a reseller's webhook URL). */
export async function assertPublicHttps(raw: string) {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw badRequest("Enter a full URL, e.g. https://example.com/crapplet-webhook");
  }
  // automated tests deliver to a local server; never set this in production
  if (process.env.NODE_ENV !== "production" && process.env.WEBHOOKS_ALLOW_LOCAL === "1") return u.toString();
  if (u.protocol !== "https:") throw badRequest("The webhook URL must use https://");
  if (u.username || u.password) throw badRequest("Don't put credentials in the webhook URL");
  const host = u.hostname.replace(/^\[|\]$/g, "");
  const addrs = net.isIP(host) ? [host] : (await dns.lookup(host, { all: true }).catch(() => [])).map((a) => a.address);
  if (!addrs.length) throw badRequest(`${host} doesn't resolve`);
  if (addrs.some(privateIp)) throw badRequest("The webhook URL must point to a public internet address");
  return u.toString();
}

export function sign(secret: string, timestamp: number, body: string) {
  return `sha256=${crypto.createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex")}`;
}

async function deliver(resellerId: string, url: string, secret: string, event: string, body: string, attempt = 1): Promise<void> {
  const ts = Math.floor(Date.now() / 1000);
  let status = "";
  try {
    await assertPublicHttps(url); // re-checked every time: DNS can change
    const r = await fetch(url, { method: "POST", redirect: "manual", signal: AbortSignal.timeout(10_000), headers: { "Content-Type": "application/json", "User-Agent": "Crapplet-Webhooks/1", "X-Crapplet-Event": event, "X-Crapplet-Timestamp": String(ts), "X-Crapplet-Signature": sign(secret, ts, body) }, body });
    status = `${r.status}`;
    if (r.ok) {
      await prisma.reseller.update({ where: { id: resellerId }, data: { webhookLastAt: new Date(), webhookLastStatus: `${event}: delivered (${r.status})` } }).catch(() => undefined);
      return;
    }
  } catch (e) {
    status = (e as Error).message.slice(0, 120);
  }
  await prisma.reseller.update({ where: { id: resellerId }, data: { webhookLastAt: new Date(), webhookLastStatus: `${event}: attempt ${attempt} failed (${status})` } }).catch(() => undefined);
  if (attempt < 3) setTimeout(() => void deliver(resellerId, url, secret, event, body, attempt + 1), attempt === 1 ? 10_000 : 60_000).unref?.();
}

/** Queue an event for the reseller (no-op when they have no webhook). Never throws. */
export async function notifyReseller(resellerId: string | null | undefined, event: ResellerEvent, data: Record<string, unknown>, opts: { wait?: boolean } = {}) {
  try {
    if (!resellerId) return;
    const r = await prisma.reseller.findUnique({ where: { id: resellerId }, select: { webhookUrl: true, webhookSecretEnc: true, status: true } });
    if (!r?.webhookUrl || !r.webhookSecretEnc) return;
    const body = JSON.stringify({ id: `evt_${crypto.randomBytes(12).toString("hex")}`, event, createdAt: new Date().toISOString(), data });
    const p = deliver(resellerId, r.webhookUrl, decrypt(r.webhookSecretEnc), event, body);
    if (opts.wait) await p;
    else void p;
  } catch (e) {
    console.error("[reseller-webhook]", (e as Error).message);
  }
}

/** The service as the API shows it — also the `data` of service.* events. */
export async function serviceEventData(serviceId: string) {
  const s = await prisma.service.findUnique({ where: { id: serviceId }, include: { product: true, ips: true, osTemplate: true } });
  if (!s) return null;
  return {
    id: s.id,
    reference: s.resellerRef,
    plan: s.product.name,
    planId: s.productId,
    status: s.status,
    hostname: s.hostname,
    ip: s.ips.find((i) => i.isPrimary)?.address ?? s.ips[0]?.address ?? null,
    ips: s.ips.map((i) => i.address),
    os: s.osTemplate?.name ?? null,
    customerId: ((s.config ?? {}) as { endCustomerId?: string }).endCustomerId ?? null,
    suspendReason: s.status === "SUSPENDED" ? s.suspendReason : null,
    terminationReason: ["TERMINATED", "CANCELLED"].includes(s.status) ? s.terminationReason : null,
  };
}
