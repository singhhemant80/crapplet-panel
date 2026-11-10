import { prisma, Prisma, type Server } from "../../db";
import { virtualizorFor } from "./provisioner";

/** Parses "12.5", "12.5 %", 12.5 → 12.5; anything else → null. */
const num = (v: unknown): number | null => {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : parseFloat(String(v).replace(/[^\d.\-]/g, ""));
  return Number.isFinite(n) ? n : null;
};
const pct = (used: number | null, total: number | null) => (used !== null && total ? Math.min(100, Math.max(0, (used / total) * 100)) : null);
const round1 = (n: number) => Math.round(n * 10) / 10;

/** `{limit, used, free, percent}` style usage block → { used, total, percent }. */
function usageBlock(b: any): { used: number | null; total: number | null; percent: number | null } {
  if (!b || typeof b !== "object") return { used: null, total: null, percent: num(b) };
  const total = num(b.limit ?? b.total ?? b.size ?? b.max);
  let used = num(b.used ?? b.usage);
  const free = num(b.free ?? b.available);
  if (used === null && total !== null && free !== null) used = total - free;
  const percent = num(b.percent ?? b.used_percent ?? b.percentage) ?? pct(used, total);
  return { used, total, percent };
}

/** Disk usage may be one block or one block per mount point — sum the mounts. */
function diskUsage(d: any) {
  if (!d || typeof d !== "object") return { used: null, total: null, percent: null };
  const direct = usageBlock(d);
  if (direct.total !== null || direct.percent !== null) return direct;
  let used = 0, total = 0, seen = false;
  for (const v of Object.values(d)) {
    const b = usageBlock(v);
    if (b.total !== null && b.used !== null) { used += b.used; total += b.total; seen = true; }
  }
  return seen ? { used, total, percent: pct(used, total) } : { used: null, total: null, percent: null };
}

function loadFor(loads: any, serid: string): string | null {
  if (!loads || typeof loads !== "object") return null;
  const v = loads[serid] ?? Object.values(loads).find((x: any) => x && typeof x === "object" && String(x.serid) === serid);
  if (v === undefined || v === null) return null;
  if (typeof v === "string" || typeof v === "number") return String(v);
  const l = v.load ?? v.loadavg ?? v.server_load ?? v.loads;
  if (l !== undefined) return Array.isArray(l) ? l.join(", ") : String(l);
  const parts = [v["1"] ?? v.one, v["5"] ?? v.five, v["15"] ?? v.fifteen].filter((x) => x !== undefined);
  return parts.length ? parts.join(", ") : null;
}

async function pool<T, R>(items: T[], size: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k]); }
  }));
  return out;
}

/**
 * Pulls every node (master + slaves) from a Virtualizor master with live usage,
 * stores them as ServerNode rows and removes nodes that no longer exist.
 */
export async function syncVirtualizorNodes(server: Server) {
  const c = virtualizorFor(server);
  const [list, loadsRes] = await Promise.all([c.servers(), c.serverLoads().catch(() => null)]);
  const servs = Array.isArray(list.servs) ? list.servs : Object.entries(list.servs ?? {}).map(([k, v]) => ({ serid: k, ...(v as object) }));
  const loads = (loadsRes as any)?.loads ?? (loadsRes as any)?.server_loads ?? (loadsRes as any)?.serverloads ?? null;

  const nodes = await pool(servs as Record<string, any>[], 5, async (s) => {
    const serid = String(s.serid ?? s.id ?? "0");
    const name = String(s.server_name ?? s.servername ?? s.name ?? `Node ${serid}`);
    // figures from the server list (ram/space = FREE amounts in Virtualizor)
    const ramTotal = num(s.total_ram);
    const ramFree = num(s.ram);
    const diskTotal = num(s.total_space);
    const diskFree = num(s.space);
    let cpuPct: number | null = null;
    let ramUsed = ramTotal !== null && ramFree !== null ? ramTotal - ramFree : null;
    let ramTot = ramTotal;
    let diskUsed = diskTotal !== null && diskFree !== null ? diskTotal - diskFree : null;
    let diskTot = diskTotal;
    let usageError: string | null = null;
    let online = !(s.status !== undefined && String(s.status) === "0");
    let uptime: unknown = null;
    try {
      const u = await c.serverUsage(serid);
      const usage = u.usage ?? {};
      const cpu = usageBlock(usage.cpu);
      cpuPct = cpu.percent ?? (cpu.used !== null && cpu.total ? pct(cpu.used, cpu.total) : cpu.used);
      const ram = usageBlock(usage.ram);
      if (ram.total) { ramTot = ram.total; ramUsed = ram.used ?? (ram.percent !== null ? (ram.percent / 100) * ram.total : ramUsed); }
      const disk = diskUsage(usage.disk);
      if (disk.total) { diskTot = disk.total; diskUsed = disk.used ?? diskUsed; }
      uptime = usage.uptime ?? u.info?.uptime ?? null;
    } catch (e) {
      usageError = (e as Error).message.slice(0, 300);
      if (/timed out|refused|reach/i.test(usageError)) online = false;
    }
    const meta = {
      serid,
      ip: s.ip ?? null,
      internalIp: s.internal_ip ?? null,
      virt: s.virt ?? null,
      sgid: s.sgid !== undefined && s.sgid !== null ? String(s.sgid) : null,
      os: s.os ?? null,
      cpuModel: typeof s.cpu === "string" ? s.cpu : null,
      vpsCount: num(s.numvps),
      locked: String(s.locked ?? "0") === "1",
      load: loadFor(loads, serid),
      uptime,
      allocRamMb: num(s.alloc_ram),
      allocDiskGb: num(s.alloc_space),
      usageError,
    };
    const data = {
      externalId: serid,
      online,
      cpuPct: cpuPct === null ? 0 : round1(cpuPct),
      ramUsedMb: Math.round(Math.max(0, ramUsed ?? 0)),
      ramTotalMb: Math.round(ramTot ?? 0),
      diskUsedGb: Math.round(Math.max(0, diskUsed ?? 0)),
      diskTotalGb: Math.round(diskTot ?? 0),
      meta: meta as Prisma.InputJsonValue,
    };
    await prisma.serverNode.upsert({ where: { serverId_name: { serverId: server.id, name } }, update: data, create: { serverId: server.id, name, ...data } });
    return { name, online };
  });

  await prisma.serverNode.deleteMany({ where: { serverId: server.id, name: { notIn: nodes.map((n) => n.name) } } });
  return { nodes: nodes.length, online: nodes.filter((n) => n.online).length };
}
