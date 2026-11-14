/**
 * Servers imported from WHMCS ("<name> (WHMCS)") are usually the same Virtualizor / Proxmox / WHM as a
 * server already set up here — under a different record, without synced OS templates or nodes.
 * These helpers find that twin and merge the imported record into it.
 */
import { promises as dns } from "node:dns";
import { prisma, type Server } from "../../db";

/** "https://Srv.Example.in:4085/" → "srv.example.in" */
export function normHost(h: string | null | undefined) {
  return String(h ?? "")
    .trim()
    .toLowerCase()
    .replace(/^[a-z]+:\/\//, "")
    .replace(/\/.*$/, "")
    .replace(/:\d+$/, "")
    .replace(/\.$/, "");
}

const dnsCache = new Map<string, { at: number; addrs: Promise<string[]> }>();
/** The addresses a hostname points at (the hostname itself when it's an IP). Cached 10 min (lookups in flight are shared), 3 s timeout. */
export function hostAddrs(host: string): Promise<string[]> {
  const h = normHost(host);
  if (!h) return Promise.resolve([]);
  if (/^[\d.]+$/.test(h) || h.includes(":")) return Promise.resolve([h]);
  const hit = dnsCache.get(h);
  if (hit && Date.now() - hit.at < 10 * 60_000) return hit.addrs;
  const addrs = Promise.race([
    dns.lookup(h, { all: true }).then((r) => r.map((a) => a.address)),
    new Promise<string[]>((r) => setTimeout(() => r([]), 3000).unref()),
  ]).catch(() => [] as string[]);
  dnsCache.set(h, { at: Date.now(), addrs });
  if (dnsCache.size > 5000) dnsCache.clear();
  return addrs;
}

/** Same kind of panel at the same address (hostname, or what the hostnames resolve to). */
export async function sameMaster(a: Pick<Server, "type" | "hostname">, b: Pick<Server, "type" | "hostname">) {
  if (a.type !== b.type) return false;
  const ha = normHost(a.hostname);
  const hb = normHost(b.hostname);
  if (!ha || !hb) return false;
  if (ha === hb) return true;
  const [x, y] = await Promise.all([hostAddrs(ha), hostAddrs(hb)]);
  return x.some((ip) => y.includes(ip));
}

/** Server ids that were created by the WHMCS import. */
export async function importedServerIds(): Promise<Set<string>> {
  const rows = await prisma.legacyMap.findMany({ where: { source: "whmcs", entity: "server" }, select: { localId: true } });
  return new Set(rows.map((r) => r.localId));
}

/**
 * The server set up here that this (imported) server is a copy of: same type and address, enabled,
 * and not itself an import. Prefers one with synced OS templates.
 */
export async function findTwin(server: Server): Promise<Server | null> {
  const imported = await importedServerIds();
  const others = await prisma.server.findMany({ where: { type: server.type, enabled: true, id: { not: server.id } } });
  const candidates = others.filter((o) => !imported.has(o.id));
  const same = await Promise.all(candidates.map((o) => sameMaster(server, o)));
  const matches = candidates.filter((_, i) => same[i]);
  if (matches.length <= 1) return matches[0] ?? null;
  const withOs = await prisma.osTemplate.groupBy({ by: ["virtualizorServerId"], where: { virtualizorServerId: { in: matches.map((m) => m.id) } }, _count: true });
  matches.sort((a, b) => (withOs.find((w) => w.virtualizorServerId === b.id)?._count ?? 0) - (withOs.find((w) => w.virtualizorServerId === a.id)?._count ?? 0));
  return matches[0];
}

/**
 * Move everything on `fromId` onto `intoId` (services, IPs, subnets, plan links, OS templates) and delete
 * `fromId`. Re-running the WHMCS import afterwards maps the old WHMCS server to `intoId`.
 */
export async function mergeServer(fromId: string, intoId: string) {
  if (fromId === intoId) throw new Error("Pick a different server to merge into");
  const [from, into] = await Promise.all([prisma.server.findUnique({ where: { id: fromId } }), prisma.server.findUnique({ where: { id: intoId } })]);
  if (!from || !into) throw new Error("Server not found");
  if (from.type !== into.type) throw new Error(`Can't merge a ${from.type} server into a ${into.type} server`);
  return prisma.$transaction(
    async (tx) => {
      const services = await tx.service.updateMany({ where: { serverId: fromId }, data: { serverId: intoId } });
      const ips = await tx.ipAddress.updateMany({ where: { serverId: fromId }, data: { serverId: intoId } });
      await tx.ipSubnet.updateMany({ where: { serverId: fromId }, data: { serverId: intoId } });
      const links = await tx.productServer.findMany({ where: { serverId: fromId } });
      if (links.length) await tx.productServer.createMany({ data: links.map((l) => ({ ...l, serverId: intoId })), skipDuplicates: true });
      await tx.productServer.deleteMany({ where: { serverId: fromId } });
      // OS templates synced from the imported record: same master → same OS ids; reuse the twin's
      let templates = 0;
      for (const t of await tx.osTemplate.findMany({ where: { virtualizorServerId: fromId } })) {
        const twin = await tx.osTemplate.findFirst({
          where: { virtualizorServerId: intoId, OR: [...(t.virtualizorOsId != null ? [{ virtualizorOsId: t.virtualizorOsId }] : []), ...(t.remoteName ? [{ remoteName: t.remoteName }] : [])] },
        });
        if (twin) {
          const po = await tx.productOs.findMany({ where: { osTemplateId: t.id } });
          if (po.length) await tx.productOs.createMany({ data: po.map((p) => ({ productId: p.productId, osTemplateId: twin.id })), skipDuplicates: true });
          await tx.service.updateMany({ where: { osTemplateId: t.id }, data: { osTemplateId: twin.id } });
          await tx.osTemplate.delete({ where: { id: t.id } });
        } else await tx.osTemplate.update({ where: { id: t.id }, data: { virtualizorServerId: intoId } });
        templates++;
      }
      await tx.legacyMap.updateMany({ where: { entity: "server", localId: fromId }, data: { localId: intoId } });
      await tx.server.delete({ where: { id: fromId } });
      return { from: from.name, into: into.name, services: services.count, ips: ips.count, planLinks: links.length, osTemplates: templates };
    },
    { timeout: 60_000 },
  );
}

export type MergeResult = Awaited<ReturnType<typeof mergeServer>>;
