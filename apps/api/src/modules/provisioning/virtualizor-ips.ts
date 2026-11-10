import { prisma, type Server } from "../../db";
import { virtualizorFor } from "./provisioner";

const ipToInt = (ip: string) => ip.split(".").reduce((a, o) => (a << 8) + Number(o), 0) >>> 0;
const intToIp = (n: number) => [24, 16, 8, 0].map((s) => (n >>> s) & 255).join(".");
const isV4 = (s: unknown): s is string => typeof s === "string" && /^\d{1,3}(\.\d{1,3}){3}$/.test(s);
function prefixOf(mask: string) {
  return ipToInt(mask).toString(2).replace(/0+$/, "").length;
}

/** gateway 103.1.2.1 + netmask 255.255.255.0 → "103.1.2.0/24" */
export function poolCidr(gateway: string, netmask: string) {
  const prefix = isV4(netmask) ? prefixOf(netmask) : Number(netmask) || 24;
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return { cidr: `${intToIp(ipToInt(gateway) & mask)}/${prefix}`, prefix };
}

const list = (v: unknown): string[] =>
  Array.isArray(v) ? v.map(String) : v && typeof v === "object" ? Object.keys(v as object) : typeof v === "string" && v ? v.split(",").map((x) => x.trim()).filter(Boolean) : [];

/**
 * Imports Virtualizor IPv4 pools and their IPs into IP Management:
 *  - each pool becomes an IpSubnet (linked to the nodes it's attached to)
 *  - free IPs become AVAILABLE (customers can pick them on the order page)
 *  - IPs Virtualizor already uses are ALLOCATED (linked to our service when the VPS is ours) or BLOCKED,
 *    locked IPs are BLOCKED. IPs the panel already holds are never downgraded.
 */
export async function syncVirtualizorIps(server: Server) {
  const c = virtualizorFor(server);
  const poolsRaw = (await c.ipPools()).ippools ?? {};
  const pools = Object.entries(poolsRaw).map(([k, p]) => ({
    ippid: Number(p.ippid ?? k),
    name: String(p.ippool_name ?? p.name ?? `Pool ${k}`),
    gateway: String(p.gateway ?? ""),
    netmask: String(p.netmask ?? "255.255.255.0"),
    ipv6: String(p.ipv6 ?? "0") === "1",
    nodes: list(p.servers ?? p.serid ?? p.ipp_serid),
  }));
  const subnetByPool = new Map<number, string>();
  let subnets = 0;
  for (const p of pools.filter((x) => !x.ipv6 && isV4(x.gateway))) {
    const { cidr, prefix } = poolCidr(p.gateway, p.netmask);
    const sn = await prisma.ipSubnet.upsert({
      where: { cidr },
      update: { gateway: p.gateway, prefix, serverId: server.id, externalPoolId: p.ippid, nodeIds: p.nodes, notes: `Virtualizor pool “${p.name}”` },
      create: { cidr, version: 4, gateway: p.gateway, prefix, serverId: server.id, externalPoolId: p.ippid, nodeIds: p.nodes, notes: `Virtualizor pool “${p.name}”` },
    });
    subnetByPool.set(p.ippid, sn.id);
    subnets++;
  }

  // walk all pages of IPs
  const ips: Record<string, unknown>[] = [];
  for (let page = 1; page < 100; page++) {
    const r = (await c.ips(page, 1000)).ips ?? {};
    const rows = Object.values(r);
    ips.push(...rows);
    if (rows.length < 1000) break;
  }
  const ourVps = new Map((await prisma.service.findMany({ where: { serverId: server.id, remoteId: { not: null } }, select: { id: true, remoteId: true } })).map((s) => [s.remoteId!, s.id]));
  let available = 0, used = 0, created = 0;
  for (const ip of ips) {
    const address = String(ip.ip ?? "");
    if (!isV4(address)) continue;
    const vpsid = String(ip.vpsid ?? "0");
    const locked = String(ip.locked ?? "0") === "1";
    const subnetId = subnetByPool.get(Number(ip.ippid)) ?? null;
    const serviceId = vpsid !== "0" ? ourVps.get(vpsid) ?? null : null;
    const status = locked ? "BLOCKED" : vpsid !== "0" ? (serviceId ? "ALLOCATED" : "BLOCKED") : "AVAILABLE";
    const existing = await prisma.ipAddress.findUnique({ where: { address } });
    if (!existing) {
      await prisma.ipAddress.create({ data: { address, version: 4, subnetId, serverId: server.id, status, serviceId, notes: vpsid !== "0" && !serviceId ? `In use by Virtualizor VPS ${vpsid}` : locked ? "Locked in Virtualizor" : null } });
      created++;
    } else if (existing.status === "AVAILABLE" || existing.status === "BLOCKED") {
      // keep panel reservations/allocations; refresh what Virtualizor says about free/used
      await prisma.ipAddress.update({ where: { id: existing.id }, data: { subnetId: subnetId ?? existing.subnetId, serverId: server.id, status, serviceId: serviceId ?? existing.serviceId } });
    }
    status === "AVAILABLE" ? available++ : used++;
  }
  return { pools: subnets, ips: ips.length, created, available, used };
}
