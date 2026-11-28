/**
 * Service IP history. After anything that can change a service's IPs, `trackServiceIps` compares
 * the IPs the service has now with what its history last recorded and writes the difference.
 * Because it compares rather than relies on each code path, changes made directly in Virtualizor
 * are caught too (the IP sync runs it for every VPS on a master every 10 minutes).
 */
import { prisma } from "../../db";

export type IpSource = "PROVISIONED" | "CHANGE_IP" | "VIRTUALIZOR" | "STAFF" | "SYNC" | "TERMINATED";

/** The addresses the history says the service has (latest event per address). */
async function recorded(serviceId: string) {
  const rows = await prisma.serviceIpChange.findMany({ where: { serviceId }, orderBy: { createdAt: "asc" }, select: { address: true, action: true } });
  const have = new Set<string>();
  for (const r of rows) r.action === "REMOVED" ? have.delete(r.address) : have.add(r.address);
  return { have, started: rows.length > 0 };
}

export async function trackServiceIps(serviceIds: string | string[], source: IpSource, opts: { actorId?: string | null; note?: string } = {}) {
  const ids = [...new Set(Array.isArray(serviceIds) ? serviceIds : [serviceIds])].filter(Boolean);
  let changes = 0;
  for (const serviceId of ids) {
    try {
      const now = await prisma.ipAddress.findMany({ where: { serviceId }, select: { address: true, isPrimary: true } });
      const { have, started } = await recorded(serviceId);
      const cur = new Set(now.map((i) => i.address));
      const added = now.filter((i) => !have.has(i.address));
      const removed = [...have].filter((a) => !cur.has(a));
      if (!added.length && !removed.length) continue;
      // first time we look at an existing service: its current IPs are the starting point, not a change
      const baseline = !started && !["PROVISIONED", "CHANGE_IP", "TERMINATED"].includes(source);
      await prisma.serviceIpChange.createMany({
        data: [
          ...removed.map((address) => ({ serviceId, address, action: "REMOVED", source, actorId: opts.actorId ?? null, note: opts.note ?? null })),
          ...added.map((i) => ({ serviceId, address: i.address, primary: i.isPrimary, action: baseline ? "BASELINE" : "ADDED", source: baseline ? "SYNC" : source, actorId: baseline ? null : opts.actorId ?? null, note: baseline ? "IP the service already had when history started" : opts.note ?? null })),
        ],
      });
      if (!baseline) changes += added.length + removed.length;
    } catch (e) {
      console.warn(`[ip-history] ${serviceId}: ${(e as Error).message}`);
    }
  }
  return changes;
}

/** History for one service, newest first, grouped into change events. */
export async function serviceIpHistory(serviceId: string) {
  const rows = await prisma.serviceIpChange.findMany({ where: { serviceId }, orderBy: { createdAt: "desc" }, take: 300 });
  const actors = [...new Set(rows.map((r) => r.actorId).filter(Boolean))] as string[];
  const names = new Map((await prisma.user.findMany({ where: { id: { in: actors } }, select: { id: true, firstName: true, lastName: true, email: true } })).map((u) => [u.id, [u.firstName, u.lastName].filter(Boolean).join(" ") || u.email]));
  // one event = same source within a few seconds
  const events: { at: Date; source: string; by: string | null; note: string | null; added: string[]; removed: string[]; baseline: string[] }[] = [];
  for (const r of rows) {
    const e = events[events.length - 1];
    const same = e && e.source === r.source && Math.abs(e.at.getTime() - r.createdAt.getTime()) < 60_000 && e.by === (r.actorId ? names.get(r.actorId) ?? null : null);
    const ev = same ? e : { at: r.createdAt, source: r.source, by: r.actorId ? names.get(r.actorId) ?? "Staff" : null, note: r.note, added: [], removed: [], baseline: [] };
    if (!same) events.push(ev);
    (r.action === "REMOVED" ? ev.removed : r.action === "BASELINE" ? ev.baseline : ev.added).push(r.address);
  }
  return events;
}
