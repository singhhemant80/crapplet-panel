/**
 * Sync every Virtualizor service at once: IPs, node and hostname straight from Virtualizor.
 *
 * One paged "list VPS" call per Virtualizor master (≈ 1 request per 200 VPSes) instead of one
 * call per service, then only services that differ are written. Runs in the background; progress
 * is kept in a small file so any API process can report it.
 */
import fs from "node:fs";
import path from "node:path";
import { config } from "../../config";
import { prisma } from "../../db";
import { recordServiceIps, virtualizorFor } from "./provisioner";

export interface SyncAllState {
  status: "running" | "done" | "error";
  startedAt: string;
  finishedAt?: string;
  startedBy?: string;
  phase: string;
  servers: { name: string; vps: number; error?: string }[];
  checked: number;
  total: number;
  updated: number;
  unchanged: number;
  missing: { serviceId: string; hostname: string | null; remoteId: string; server: string }[];
  /** several live services point at the same VPS — left untouched, fix by hand */
  duplicates?: { remoteId: string; server: string; services: { serviceId: string; hostname: string | null }[] }[];
  changes: { serviceId: string; hostname: string | null; before: string[]; after: string[]; node?: string }[];
  error?: string;
}

const FILE = path.resolve(config.uploadDir, "virtualizor-sync-all.json");
const isV4 = (s: string) => /^\d{1,3}(\.\d{1,3}){3}$/.test(s);
const ipsOf = (row: Record<string, unknown>): string[] => {
  const v = row.ips;
  const raw = Array.isArray(v) ? v : v && typeof v === "object" ? Object.values(v as Record<string, unknown>) : typeof v === "string" ? v.split(/[\s,]+/) : [];
  return raw.map(String).map((x) => x.trim()).filter(isV4);
};

export async function readSyncAll(): Promise<SyncAllState | null> {
  try {
    return JSON.parse(await fs.promises.readFile(FILE, "utf8"));
  } catch {
    return null;
  }
}
async function save(s: SyncAllState) {
  await fs.promises.mkdir(path.dirname(FILE), { recursive: true });
  const tmp = `${FILE}.${process.pid}.tmp`;
  await fs.promises.writeFile(tmp, JSON.stringify(s));
  await fs.promises.rename(tmp, FILE);
}

/** Start a sync in the background. Returns the initial state (or the running one). */
export async function startSyncAll(actorId?: string) {
  const cur = await readSyncAll();
  // a run that's been "running" for 30+ minutes died with its process — allow a new one
  if (cur?.status === "running" && Date.now() - new Date(cur.startedAt).getTime() < 30 * 60_000) return cur;
  const s: SyncAllState = { status: "running", startedAt: new Date().toISOString(), startedBy: actorId, phase: "Reading VPS lists from Virtualizor", servers: [], checked: 0, total: 0, updated: 0, unchanged: 0, missing: [], duplicates: [], changes: [] };
  await save(s);
  void runSyncAll(s).catch(async (e) => {
    await save({ ...s, status: "error", finishedAt: new Date().toISOString(), error: String((e as Error).message ?? e) });
  });
  return s;
}

export async function runSyncAll(s: SyncAllState) {
  let lastSave = 0;
  const progress = async (force = false) => {
    if (force || Date.now() - lastSave > 1500) {
      lastSave = Date.now();
      await save(s);
    }
  };
  const masters = await prisma.server.findMany({ where: { type: "VIRTUALIZOR" } });
  const services = await prisma.service.findMany({
    where: { serverId: { in: masters.map((m) => m.id) }, remoteId: { not: null }, status: { notIn: ["TERMINATED", "CANCELLED"] }, product: { provisioner: "VIRTUALIZOR" } },
    select: { id: true, hostname: true, remoteId: true, node: true, serverId: true, ips: { select: { address: true, isPrimary: true } } },
  });
  s.total = services.length;
  await progress(true);

  for (const m of masters) {
    const mine = services.filter((x) => x.serverId === m.id);
    if (!mine.length) continue;
    s.phase = `Reading VPS list from ${m.name}`;
    await progress(true);
    // every VPS on this master, page by page
    const rows = new Map<string, Record<string, unknown>>();
    try {
      const client = virtualizorFor(m);
      const per = 200;
      for (let page = 1; page <= 500; page++) {
        const r = await client.listVps(page, per);
        const list = Object.entries(r.vs ?? {});
        for (const [k, v] of list) rows.set(String((v as Record<string, unknown>).vpsid ?? k), v as Record<string, unknown>);
        if (list.length < per) break;
      }
      s.servers.push({ name: m.name, vps: rows.size });
    } catch (e) {
      s.servers.push({ name: m.name, vps: 0, error: (e as Error).message });
      s.checked += mine.length;
      await progress(true);
      continue;
    }

    s.phase = `Updating services on ${m.name}`;
    const byVps = new Map<string, typeof mine>();
    for (const svc of mine) byVps.set(String(svc.remoteId), [...(byVps.get(String(svc.remoteId)) ?? []), svc]);
    for (const [remoteId, list] of byVps) if (list.length > 1) (s.duplicates ??= []).push({ remoteId, server: m.name, services: list.map((x) => ({ serviceId: x.id, hostname: x.hostname })) });
    for (const svc of mine) {
      s.checked++;
      if ((byVps.get(String(svc.remoteId))?.length ?? 0) > 1) {
        await progress();
        continue;
      }
      const row = rows.get(String(svc.remoteId));
      if (!row) {
        if (s.missing.length < 1000) s.missing.push({ serviceId: svc.id, hostname: svc.hostname, remoteId: String(svc.remoteId), server: m.name });
        await progress();
        continue;
      }
      const after = ipsOf(row);
      const primary = svc.ips.find((i) => i.isPrimary)?.address;
      const before = [...(primary ? [primary] : []), ...svc.ips.map((i) => i.address).filter((a) => a !== primary)];
      const node = row.serid !== undefined && row.serid !== null ? String(row.serid) : undefined;
      const hostname = row.hostname ? String(row.hostname) : undefined;
      // compare as sets — Virtualizor's list order isn't meaningful
      const ipsChanged = after.length > 0 && (after.length !== before.length || after.some((a) => !before.includes(a)));
      const nodeChanged = node !== undefined && node !== svc.node;
      const hostChanged = !!hostname && hostname !== svc.hostname;
      if (!ipsChanged && !nodeChanged && !hostChanged) {
        s.unchanged++;
        await progress();
        continue;
      }
      try {
        if (ipsChanged) await recordServiceIps(svc.id, m.id, after);
        if (nodeChanged || hostChanged) await prisma.service.update({ where: { id: svc.id }, data: { ...(nodeChanged ? { node } : {}), ...(hostChanged ? { hostname } : {}) } });
        await prisma.provisioningLog.create({
          data: { serviceId: svc.id, action: "sync", success: true, message: `Bulk sync from Virtualizor: ${ipsChanged ? `IPs ${before.join(", ") || "none"} → ${after.join(", ")}` : "IPs unchanged"}${nodeChanged ? ` · node ${svc.node ?? "?"} → ${node}` : ""}${hostChanged ? ` · hostname ${svc.hostname ?? "?"} → ${hostname}` : ""}` },
        });
        s.updated++;
        if (s.changes.length < 2000) s.changes.push({ serviceId: svc.id, hostname: hostname ?? svc.hostname, before, after: ipsChanged ? after : before, ...(nodeChanged ? { node } : {}) });
      } catch (e) {
        if (s.missing.length < 1000) s.missing.push({ serviceId: svc.id, hostname: svc.hostname, remoteId: `${svc.remoteId} (error: ${(e as Error).message.slice(0, 120)})`, server: m.name });
      }
      await progress();
    }
  }
  s.status = "done";
  s.phase = "Finished";
  s.finishedAt = new Date().toISOString();
  await progress(true);
  return s;
}
