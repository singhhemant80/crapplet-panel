/**
 * Sync every Virtualizor service at once: IPs, operating system, node and hostname straight from Virtualizor.
 * Services that aren't linked to a VPS yet (e.g. imported from WHMCS without a VPS id) are linked by their
 * IP address, or else by a hostname only one VPS has.
 *
 * One paged "list VPS" call per Virtualizor master (≈ 1 request per 200 VPSes) instead of one
 * call per service, then only services that differ are written. Runs in the background; progress
 * is kept in a small file so any API process can report it.
 */
import fs from "node:fs";
import path from "node:path";
import { config } from "../../config";
import { prisma } from "../../db";
import { loginUserOf, recordServiceIps, virtualizorFor } from "./provisioner";
import { osTemplateForVps } from "./virtualizor-os";
import { vpsIpsOf } from "./virtualizor";

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
  changes: { serviceId: string; hostname: string | null; before: string[]; after: string[]; node?: string; os?: string; linked?: string }[];
  /** services that weren't linked to a VPS and now are */
  linked?: number;
  /** services that aren't linked to a VPS and couldn't be matched */
  notLinked?: { serviceId: string; hostname: string | null; reason: string }[];
  error?: string;
}

const FILE = path.resolve(config.uploadDir, "virtualizor-sync-all.json");
const ipsOf = (row: Record<string, unknown>): string[] => vpsIpsOf(row);

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

type Svc = { id: string; username?: string | null; hostname: string | null; remoteId: string | null; node: string | null; serverId: string | null; osTemplateId: string | null; ips: { address: string; isPrimary: boolean }[]; user: { email: string } };

export async function runSyncAll(s: SyncAllState) {
  let lastSave = 0;
  const progress = async (force = false) => {
    if (force || Date.now() - lastSave > 1500) {
      lastSave = Date.now();
      await save(s);
    }
  };
  s.linked = 0;
  s.notLinked = [];
  const masters = await prisma.server.findMany({ where: { type: "VIRTUALIZOR" } });
  const masterIds = new Set(masters.map((m) => m.id));
  const services: Svc[] = await prisma.service.findMany({
    where: { status: { notIn: ["TERMINATED", "CANCELLED"] }, product: { provisioner: "VIRTUALIZOR" } },
    select: { id: true, username: true, hostname: true, remoteId: true, node: true, serverId: true, osTemplateId: true, ips: { select: { address: true, isPrimary: true } }, user: { select: { email: true } } },
  });
  const linkedOk = (x: Svc) => !!x.remoteId && !!x.serverId && masterIds.has(x.serverId);
  const unlinked = services.filter((x) => !linkedOk(x));
  s.total = services.length;
  await progress(true);

  // 1. every VPS on every master that has services here (all masters when some services still need linking)
  const rowsBy = new Map<string, Map<string, Record<string, unknown>>>();
  for (const m of masters) {
    if (!unlinked.length && !services.some((x) => x.serverId === m.id)) continue;
    s.phase = `Reading VPS list from ${m.name}`;
    await progress(true);
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
      // some Virtualizor versions don't put IPs in the VPS list — take them from the IP list instead
      if ([...rows.values()].some((r) => !ipsOf(r).length)) {
        const byVps = await client.ipsByVps().catch(() => null);
        if (byVps) for (const [vpsid, r] of rows) if (!ipsOf(r).length && byVps.get(vpsid)?.length) r.ips = byVps.get(vpsid);
      }
      // the VPS owner's email (WHMCS creates the Virtualizor user with the customer's email) — to link by customer
      if (unlinked.length && [...rows.values()].some((r) => !r.email && r.uid !== undefined)) {
        const emails = await client.userEmails().catch(() => null);
        if (emails) for (const r of rows.values()) if (!r.email && r.uid !== undefined) r.email = emails.get(String(r.uid));
      }
      rowsBy.set(m.id, rows);
      s.servers.push({ name: m.name, vps: rows.size });
    } catch (e) {
      s.servers.push({ name: m.name, vps: 0, error: (e as Error).message });
    }
  }

  // services linked to a VPS id their master doesn't have (deleted, or a wrong id carried over from WHMCS):
  // try to find their real VPS the same way as unlinked ones
  const stale = services.filter((x) => linkedOk(x) && rowsBy.has(x.serverId!) && !rowsBy.get(x.serverId!)!.has(String(x.remoteId)));
  const staleIds = new Set(stale.map((x) => x.id));
  unlinked.push(...stale);

  // 2. link services that have no VPS yet: by IP first, then by a hostname only one VPS has
  if (unlinked.length) {
    s.phase = "Linking services to their VPS";
    await progress(true);
    const taken = new Set(services.filter((x) => linkedOk(x) && !staleIds.has(x.id)).map((x) => `${x.serverId}|${x.remoteId}`));
    const byIp = new Map<string, string[]>();
    const byHost = new Map<string, string[]>();
    for (const [mid, rows] of rowsBy)
      for (const [vpsid, row] of rows) {
        const ref = `${mid}|${vpsid}`;
        for (const ip of ipsOf(row)) byIp.set(ip, [...(byIp.get(ip) ?? []), ref]);
        const h = String(row.hostname ?? "").trim().toLowerCase();
        if (h) byHost.set(h, [...(byHost.get(h) ?? []), ref]);
      }
    // customer email → VPSes owned by that email, and → that customer's unlinked services
    const byEmail = new Map<string, string[]>();
    for (const [mid, rows] of rowsBy)
      for (const [vpsid, row] of rows) {
        const e = String(row.email ?? "").trim().toLowerCase();
        if (e) byEmail.set(e, [...(byEmail.get(e) ?? []), `${mid}|${vpsid}`]);
      }
    const unlinkedPerEmail = new Map<string, number>();
    for (const x of unlinked) unlinkedPerEmail.set(x.user.email.toLowerCase(), (unlinkedPerEmail.get(x.user.email.toLowerCase()) ?? 0) + 1);
    const hostCount = new Map<string, number>();
    for (const x of services) if (x.hostname) hostCount.set(x.hostname.trim().toLowerCase(), (hostCount.get(x.hostname.trim().toLowerCase()) ?? 0) + 1);
    for (const svc of unlinked) {
      let ref: string | null = null;
      let how = "";
      if (svc.remoteId && !staleIds.has(svc.id)) {
        // has a VPS id but no (known) master: the master whose list has that VPS
        const hits = [...rowsBy.entries()].filter(([, rows]) => rows.has(String(svc.remoteId))).map(([mid]) => `${mid}|${svc.remoteId}`);
        if (hits.length === 1) { ref = hits[0]; how = "VPS id"; }
      }
      if (!ref && svc.ips.length) {
        const hits = [...new Set(svc.ips.flatMap((i) => byIp.get(i.address) ?? []))];
        if (hits.length === 1) { ref = hits[0]; how = `IP ${svc.ips.map((i) => i.address).join(", ")}`; }
      }
      const h = svc.hostname?.trim().toLowerCase();
      if (!ref && h && hostCount.get(h) === 1) {
        const hits = byHost.get(h) ?? [];
        if (hits.length === 1) { ref = hits[0]; how = `hostname ${svc.hostname}`; }
      }
      // the customer's only VPS in Virtualizor, and this is their only service without one
      const em = svc.user.email.toLowerCase();
      if (!ref && unlinkedPerEmail.get(em) === 1) {
        const free = (byEmail.get(em) ?? []).filter((r) => !taken.has(r));
        if (free.length === 1) { ref = free[0]; how = `customer email ${svc.user.email}`; }
      }
      if (!ref || taken.has(ref)) {
        if (staleIds.has(svc.id)) continue; // keeps its old link; reported as missing below
        s.checked++;
        if (s.notLinked.length < 1000)
          s.notLinked.push({ serviceId: svc.id, hostname: svc.hostname, reason: ref ? "Its matching VPS already belongs to another service" : svc.ips.length || h ? "No VPS in Virtualizor has this IP, hostname or customer email" : "No IP or hostname to match on, and the customer's email isn't on exactly one free VPS" });
        continue;
      }
      taken.add(ref);
      const [mid, vpsid] = ref.split("|");
      await prisma.service.update({ where: { id: svc.id }, data: { remoteId: vpsid, serverId: mid } });
      await prisma.provisioningLog.create({ data: { serviceId: svc.id, action: "sync", success: true, message: `${staleIds.has(svc.id) ? `Re-linked (VPS ${svc.remoteId} isn't on its master any more) to` : "Linked to"} Virtualizor VPS ${vpsid} on ${masters.find((m) => m.id === mid)?.name} (matched by ${how})` } });
      svc.remoteId = vpsid;
      svc.serverId = mid;
      s.linked++;
      if (s.changes.length < 2000) s.changes.push({ serviceId: svc.id, hostname: svc.hostname, before: svc.ips.map((i) => i.address), after: svc.ips.map((i) => i.address), linked: `VPS ${vpsid}` });
    }
    await progress(true);
  }

  // 3. bring every linked service in line with its VPS
  const osCache = new Map<string, string | null>();
  const osFamily = new Map<string, string>();
  const osNames = new Map((await prisma.osTemplate.findMany({ where: { source: "virtualizor" }, select: { id: true, name: true } })).map((o) => [o.id, o.name]));
  for (const m of masters) {
    const mine = services.filter((x) => linkedOk(x) && x.serverId === m.id);
    if (!mine.length) continue;
    const rows = rowsBy.get(m.id);
    if (!rows) {
      s.checked += mine.length;
      await progress(true);
      continue;
    }
    // still no IPs for some of our VPSes: ask Virtualizor about each one (its single-VPS answer carries them)
    const bare = [...new Set(mine.map((x) => String(x.remoteId)))].filter((id) => rows.get(id) && !ipsOf(rows.get(id)!).length);
    if (bare.length) {
      s.phase = `Reading IPs of ${bare.length} VPS from ${m.name}`;
      await progress(true);
      const client = virtualizorFor(m);
      for (let i = 0; i < bare.length; i += 5)
        await Promise.all(
          bare.slice(i, i + 5).map(async (id) => {
            const got = await client.vpsIps(id).catch(() => [] as string[]);
            if (got.length) rows.get(id)!.ips = got;
          }),
        );
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
      const osId = await osTemplateForVps(m, row, osCache).catch(() => null);
      // compare as sets — Virtualizor's list order isn't meaningful
      const ipsChanged = after.length > 0 && (after.length !== before.length || after.some((a) => !before.includes(a)));
      const nodeChanged = node !== undefined && node !== svc.node;
      const hostChanged = !!hostname && hostname !== svc.hostname;
      const osChanged = !!osId && osId !== svc.osTemplateId;
      // the login follows the OS: Administrator on Windows, root on Linux (a custom username is left alone)
      let user: string | null = null;
      if (osId && (!svc.username || ["root", "Administrator"].includes(svc.username))) {
        if (!osFamily.has(osId)) osFamily.set(osId, loginUserOf(await prisma.osTemplate.findUnique({ where: { id: osId }, select: { family: true, name: true, remoteName: true } })));
        user = osFamily.get(osId)!;
        if (user === svc.username) user = null;
      }
      if (!ipsChanged && !nodeChanged && !hostChanged && !osChanged && !user) {
        s.unchanged++;
        await progress();
        continue;
      }
      try {
        if (ipsChanged) await recordServiceIps(svc.id, m.id, after);
        if (nodeChanged || hostChanged || osChanged || user) await prisma.service.update({ where: { id: svc.id }, data: { ...(nodeChanged ? { node } : {}), ...(hostChanged ? { hostname } : {}), ...(osChanged ? { osTemplateId: osId } : {}), ...(user ? { username: user } : {}) } });
        let osName: string | undefined;
        if (osChanged) {
          if (!osNames.has(osId!)) osNames.set(osId!, (await prisma.osTemplate.findUnique({ where: { id: osId! }, select: { name: true } }))?.name ?? "?");
          osName = osNames.get(osId!);
        }
        await prisma.provisioningLog.create({
          data: { serviceId: svc.id, action: "sync", success: true, message: `Bulk sync from Virtualizor: ${ipsChanged ? `IPs ${before.join(", ") || "none"} → ${after.join(", ")}` : "IPs unchanged"}${osChanged ? ` · OS → ${osName}` : ""}${nodeChanged ? ` · node ${svc.node ?? "?"} → ${node}` : ""}${hostChanged ? ` · hostname ${svc.hostname ?? "?"} → ${hostname}` : ""}` },
        });
        s.updated++;
        const prev = s.changes.find((c) => c.serviceId === svc.id);
        const change = { serviceId: svc.id, hostname: hostname ?? svc.hostname, before, after: ipsChanged ? after : before, ...(nodeChanged ? { node } : {}), ...(osName ? { os: osName } : {}) };
        if (prev) Object.assign(prev, change);
        else if (s.changes.length < 2000) s.changes.push(change);
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
