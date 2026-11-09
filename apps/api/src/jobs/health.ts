import { prisma, Prisma } from "../db";
import { proxmoxFor, virtualizorFor } from "../modules/provisioning/provisioner";

/** Connection test + node resource snapshot for one server. */
export async function checkServer(serverId: string) {
  const s = await prisma.server.findUniqueOrThrow({ where: { id: serverId } });
  const started = Date.now();
  try {
    let status: Record<string, unknown> = {};
    if (s.type === "PROXMOX") {
      const c = proxmoxFor(s);
      const [version, nodes] = await Promise.all([c.version(), c.nodes()]);
      for (const n of nodes) {
        const data = {
          online: n.status === "online",
          cpuPct: Math.round(n.cpu * 1000) / 10,
          ramUsedMb: Math.round(n.mem / 1048576),
          ramTotalMb: Math.round(n.maxmem / 1048576),
          diskUsedGb: Math.round(n.disk / 1073741824),
          diskTotalGb: Math.round(n.maxdisk / 1073741824),
        };
        await prisma.serverNode.upsert({ where: { serverId_name: { serverId: s.id, name: n.node } }, update: data, create: { serverId: s.id, name: n.node, ...data } });
      }
      status = { ok: true, version: version.version, nodes: nodes.length, online: nodes.filter((n) => n.status === "online").length };
    } else if (s.type === "VIRTUALIZOR") {
      const v = await virtualizorFor(s).listVps(1, 1);
      status = { ok: true, vps: Object.keys(v.vs ?? {}).length >= 0 };
    } else status = { ok: true, manual: true };
    status.latencyMs = Date.now() - started;
    await prisma.server.update({ where: { id: s.id }, data: { lastCheckAt: new Date(), lastStatus: status as Prisma.InputJsonValue } });
    return status;
  } catch (e) {
    const status = { ok: false, error: (e as Error).message, latencyMs: Date.now() - started };
    await prisma.server.update({ where: { id: s.id }, data: { lastCheckAt: new Date(), lastStatus: status } });
    return status;
  }
}

export async function checkAllServers() {
  const servers = await prisma.server.findMany({ where: { enabled: true, type: { in: ["PROXMOX", "VIRTUALIZOR"] } } });
  const out: Record<string, unknown> = {};
  for (const s of servers) out[s.name] = await checkServer(s.id);
  return out;
}
