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
 * Mirrors Virtualizor's IPv4 pools and IPs into IP Management. For a Virtualizor master, Virtualizor is
 * the only source of truth — the panel never assigns these IPs itself:
 *  - each pool becomes an IpSubnet (linked to the nodes it's attached to)
 *  - free IPs → AVAILABLE; IPs on one of our VPSes → ALLOCATED to that service; on another VPS or
 *    locked → BLOCKED
 *  - IPs/ranges the panel holds for this master that Virtualizor doesn't have are removed
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
  let available = 0, used = 0, created = 0, removed = 0;
  const seen = new Set<string>();
  const perService = new Map<string, string[]>();
  for (const ip of ips) {
    const address = String(ip.ip ?? "");
    if (!isV4(address)) continue;
    seen.add(address);
    const vpsid = String(ip.vpsid ?? "0");
    const locked = String(ip.locked ?? "0") === "1";
    const subnetId = subnetByPool.get(Number(ip.ippid)) ?? null;
    const serviceId = vpsid !== "0" ? ourVps.get(vpsid) ?? null : null;
    const status = locked ? "BLOCKED" : vpsid !== "0" ? (serviceId ? "ALLOCATED" : "BLOCKED") : "AVAILABLE";
    const notes = vpsid !== "0" && !serviceId ? `In use by Virtualizor VPS ${vpsid}` : locked ? "Locked in Virtualizor" : serviceId ? "Assigned by Virtualizor" : null;
    if (serviceId) perService.set(serviceId, [...(perService.get(serviceId) ?? []), address]);
    const existing = await prisma.ipAddress.findUnique({ where: { address } });
    if (!existing) {
      await prisma.ipAddress.create({ data: { address, version: 4, subnetId, serverId: server.id, status, serviceId, notes } });
      created++;
    } else {
      await prisma.ipAddress.update({
        where: { id: existing.id },
        data: {
          subnetId: subnetId ?? existing.subnetId,
          serverId: server.id,
          status,
          serviceId,
          notes,
          isPrimary: serviceId && existing.serviceId === serviceId ? existing.isPrimary : false,
          reservedById: null,
          reservedOrderId: null,
          reservedUntil: null,
        },
      });
    }
    status === "AVAILABLE" ? available++ : used++;
  }
  // every VPS of ours keeps exactly one primary IP
  for (const [serviceId, addrs] of perService) {
    const hasPrimary = await prisma.ipAddress.count({ where: { serviceId, isPrimary: true } });
    if (!hasPrimary) await prisma.ipAddress.update({ where: { address: addrs.sort()[0] }, data: { isPrimary: true } });
  }
  // remove what Virtualizor doesn't have (typo'd or hand-added ranges) — only when Virtualizor answered with IPs
  if (seen.size) {
    const stale = await prisma.ipAddress.findMany({ where: { version: 4, OR: [{ serverId: server.id }, { subnet: { serverId: server.id } }], address: { notIn: [...seen] } }, select: { id: true } });
    if (stale.length) removed = (await prisma.ipAddress.deleteMany({ where: { id: { in: stale.map((x) => x.id) } } })).count;
    const keep = [...subnetByPool.values()];
    await prisma.ipSubnet.deleteMany({ where: { serverId: server.id, id: { notIn: keep }, ips: { none: {} } } });
  }
  return { pools: subnets, ips: ips.length, created, available, used, removed };
}
