import { Router } from "express";
import { z } from "zod";
import { parse as parseCsv } from "csv-parse/sync";
import { prisma, Prisma, IpStatus, ServerType } from "../../db";
import { ah, badRequest, conflict, notFound, pageParams, parse } from "../../lib/http";
import { audit } from "../../lib/audit";
import { encrypt } from "../../lib/crypto";
import { requireStaff } from "../../middleware/auth";
import { adminAssignIp, importCidr, importCsv, logIp, setIpStatus } from "../ipam/service";
import { proxmoxFor, virtualizorFor } from "../provisioning/provisioner";
import { checkServer } from "../../jobs/health";
import { syncVirtualizorOs } from "../provisioning/virtualizor-os";
import { crud } from "./crud";

export const adminInfra = Router();

// ───────────── Locations ─────────────
crud(adminInfra, "/locations", "location", z.object({ name: z.string().min(1), code: z.string().trim().toUpperCase().min(2).max(12), country: z.string().length(2).default("IN") }), "servers.manage", {
  include: { _count: { select: { servers: true } } },
});

// ───────────── Servers ─────────────
const serverSchema = z.object({
  name: z.string().min(1),
  type: z.nativeEnum(ServerType),
  locationId: z.string().nullable().optional(),
  hostname: z.string().min(1),
  port: z.number().int().min(1).max(65535).default(8006),
  apiUser: z.string().nullable().optional(),
  apiSecret: z.string().optional(),
  verifyTls: z.boolean().default(true),
  defaultNode: z.string().nullable().optional(),
  storage: z.string().nullable().optional(),
  bridge: z.string().nullable().optional(),
  maxCpuPct: z.number().int().min(10).max(100).default(85),
  maxRamPct: z.number().int().min(10).max(100).default(90),
  maxDiskPct: z.number().int().min(10).max(100).default(90),
  maxServices: z.number().int().min(0).default(0),
  enabled: z.boolean().default(true),
});

const serverPublic = { id: true, name: true, type: true, locationId: true, location: true, hostname: true, port: true, apiUser: true, verifyTls: true, defaultNode: true, storage: true, bridge: true, maxCpuPct: true, maxRamPct: true, maxDiskPct: true, maxServices: true, enabled: true, lastCheckAt: true, lastStatus: true, createdAt: true, nodes: true } satisfies Prisma.ServerSelect;

adminInfra.get(
  "/servers",
  requireStaff("servers.manage"),
  ah(async (_req, res) => {
    const servers = await prisma.server.findMany({ orderBy: { name: "asc" }, select: { ...serverPublic, apiSecretEnc: true, _count: { select: { services: { where: { status: { in: ["ACTIVE", "SUSPENDED"] } } }, ips: true } } } });
    const free = await prisma.ipAddress.groupBy({ by: ["serverId"], where: { status: "AVAILABLE" }, _count: true });
    res.json({ servers: servers.map(({ apiSecretEnc, ...s }) => ({ ...s, hasSecret: !!apiSecretEnc, freeIps: free.find((f) => f.serverId === s.id)?._count ?? 0 })) });
  }),
);

adminInfra.get(
  "/servers/:id",
  requireStaff("servers.manage"),
  ah(async (req, res) => {
    const s = await prisma.server.findUnique({ where: { id: req.params.id }, select: serverPublic });
    if (!s) throw notFound();
    res.json({ server: s });
  }),
);

adminInfra.post(
  "/servers",
  requireStaff("servers.manage"),
  ah(async (req, res) => {
    const { apiSecret, ...b } = parse(serverSchema, req.body);
    const s = await prisma.server.create({ data: { ...b, apiSecretEnc: apiSecret ? encrypt(apiSecret) : null } });
    await audit({ actorId: req.user!.id, action: "server.created", entity: "server", entityId: s.id });
    res.status(201).json({ id: s.id });
  }),
);

adminInfra.put(
  "/servers/:id",
  requireStaff("servers.manage"),
  ah(async (req, res) => {
    const { apiSecret, ...b } = parse(serverSchema.partial(), req.body);
    await prisma.server.update({ where: { id: req.params.id }, data: { ...b, ...(apiSecret ? { apiSecretEnc: encrypt(apiSecret) } : {}) } });
    await audit({ actorId: req.user!.id, action: "server.updated", entity: "server", entityId: req.params.id, details: { secretChanged: !!apiSecret } });
    res.json({ ok: true });
  }),
);

adminInfra.delete(
  "/servers/:id",
  requireStaff("servers.manage"),
  ah(async (req, res) => {
    const used = await prisma.service.count({ where: { serverId: req.params.id, status: { notIn: ["TERMINATED", "CANCELLED"] } } });
    if (used) throw conflict(`${used} live services are on this server`);
    await prisma.ipAddress.updateMany({ where: { serverId: req.params.id, serviceId: null }, data: { serverId: null } });
    await prisma.server.delete({ where: { id: req.params.id } });
    res.json({ ok: true });
  }),
);

adminInfra.post(
  "/servers/:id/test",
  requireStaff("servers.manage"),
  ah(async (req, res) => {
    const s = await prisma.server.findUniqueOrThrow({ where: { id: req.params.id } });
    res.json(await checkServer(s.id));
  }),
);

adminInfra.put(
  "/servers/:id/nodes/:node",
  requireStaff("servers.manage"),
  ah(async (req, res) => {
    const { enabled } = parse(z.object({ enabled: z.boolean() }), req.body);
    await prisma.serverNode.upsert({ where: { serverId_name: { serverId: req.params.id, name: req.params.node } }, update: { enabled }, create: { serverId: req.params.id, name: req.params.node, enabled } });
    res.json({ ok: true });
  }),
);

// ───────────── Proxmox ─────────────
async function pve(serverId: string) {
  const s = await prisma.server.findUniqueOrThrow({ where: { id: serverId } });
  if (s.type !== "PROXMOX") throw badRequest("Not a Proxmox server");
  return { s, c: proxmoxFor(s) };
}

adminInfra.get(
  "/proxmox/:serverId/overview",
  requireStaff("servers.manage"),
  ah(async (req, res) => {
    const { s, c } = await pve(req.params.serverId);
    const [version, nodes, resources, cluster] = await Promise.all([c.version(), c.nodes(), c.resources(), c.clusterStatus().catch(() => [])]);
    const vms = resources.filter((r) => r.type === "qemu" || r.type === "lxc");
    const linked = await prisma.service.findMany({ where: { serverId: s.id, remoteId: { in: vms.map((v) => String(v.vmid)) } }, select: { id: true, remoteId: true, status: true, user: { select: { email: true } } } });
    res.json({
      version,
      cluster,
      nodes,
      storage: resources.filter((r) => r.type === "storage"),
      vms: vms.map((v) => ({ ...v, service: linked.find((l) => l.remoteId === String(v.vmid)) ?? null })),
    });
  }),
);

const guestParams = z.object({ node: z.string(), kind: z.enum(["qemu", "lxc"]), vmid: z.coerce.number().int() });

adminInfra.post(
  "/proxmox/:serverId/guest/:action",
  requireStaff("servers.manage"),
  ah(async (req, res) => {
    const { c } = await pve(req.params.serverId);
    const g = parse(guestParams.extend({ target: z.string().optional(), snapname: z.string().regex(/^[a-zA-Z0-9_-]+$/).optional(), storage: z.string().optional(), newid: z.number().int().optional(), name: z.string().optional() }), req.body);
    const a = req.params.action;
    let result: unknown = { ok: true };
    switch (a) {
      case "start":
      case "stop":
      case "shutdown":
      case "reboot":
      case "suspend":
      case "resume":
        await c.power(g.node, g.kind, g.vmid, a);
        break;
      case "migrate":
        if (!g.target) throw badRequest("target node required");
        await c.migrate(g.node, g.kind, g.vmid, g.target);
        await prisma.service.updateMany({ where: { serverId: req.params.serverId, remoteId: String(g.vmid) }, data: { node: g.target } });
        break;
      case "snapshots":
        result = { snapshots: await c.snapshots(g.node, g.kind, g.vmid) };
        break;
      case "snapshot":
        await c.snapshot(g.node, g.kind, g.vmid, g.snapname ?? `snap${Date.now()}`, "Created from Crapplet admin");
        break;
      case "rollback":
        if (!g.snapname) throw badRequest("snapname required");
        await c.rollback(g.node, g.kind, g.vmid, g.snapname);
        break;
      case "delete-snapshot":
        if (!g.snapname) throw badRequest("snapname required");
        await c.deleteSnapshot(g.node, g.kind, g.vmid, g.snapname);
        break;
      case "backup":
        result = { upid: await c.backup(g.node, g.vmid, g.storage ?? "local") };
        break;
      case "backups":
        result = { backups: await c.backups(g.node, g.storage ?? "local", g.vmid) };
        break;
      case "clone":
        await c.cloneGuest(g.node, g.kind, g.vmid, g.newid ?? (await c.nextId()), g.name ?? `clone-${g.vmid}`, g.target);
        break;
      case "status":
        result = { status: await c.guestStatus(g.node, g.kind, g.vmid), config: await c.config(g.node, g.kind, g.vmid) };
        break;
      case "rrd":
        result = { points: await c.rrd(g.node, g.kind, g.vmid, "day") };
        break;
      default:
        throw badRequest("Unknown action");
    }
    await audit({ actorId: req.user!.id, action: `proxmox.${a}`, entity: "server", entityId: req.params.serverId, details: g });
    res.json(result);
  }),
);

// ───────────── Monitoring ─────────────
/** Every node of every server with its latest usage snapshot (refreshed by the worker every 5 min). */
adminInfra.get(
  "/monitoring",
  requireStaff("servers.manage"),
  ah(async (_req, res) => {
    // disabled servers aren't polled, so they're left out
    const servers = await prisma.server.findMany({
      where: { type: { in: ["PROXMOX", "VIRTUALIZOR"] }, enabled: true },
      orderBy: { name: "asc" },
      select: { id: true, name: true, type: true, hostname: true, enabled: true, lastCheckAt: true, lastStatus: true, location: { select: { name: true } }, nodes: { orderBy: { name: "asc" } }, _count: { select: { services: { where: { status: { in: ["ACTIVE", "SUSPENDED"] } } } } } },
    });
    res.json({ servers });
  }),
);

/** Re-poll one server (or all) right now instead of waiting for the next 5-minute check. */
adminInfra.post(
  "/monitoring/refresh",
  requireStaff("servers.manage"),
  ah(async (req, res) => {
    const id = typeof req.body?.serverId === "string" ? req.body.serverId : null;
    const servers = await prisma.server.findMany({ where: { type: { in: ["PROXMOX", "VIRTUALIZOR"] }, ...(id ? { id } : { enabled: true }) }, select: { id: true } });
    const results = await Promise.all(servers.map((s) => checkServer(s.id).then((r) => ({ id: s.id, ...r }))));
    res.json({ results });
  }),
);

// ───────────── Virtualizor ─────────────
adminInfra.get(
  "/virtualizor/:serverId/overview",
  requireStaff("servers.manage"),
  ah(async (req, res) => {
    const s = await prisma.server.findUniqueOrThrow({ where: { id: req.params.serverId } });
    if (s.type !== "VIRTUALIZOR") throw badRequest("Not a Virtualizor server");
    const c = virtualizorFor(s);
    const [vps, plans] = await Promise.all([c.listVps(1, 200), c.plans().catch(() => ({ plans: {} }))]);
    const ids = Object.keys(vps.vs ?? {});
    const linked = await prisma.service.findMany({ where: { serverId: s.id, remoteId: { in: ids } }, select: { id: true, remoteId: true, status: true, user: { select: { email: true } } } });
    res.json({ vps: Object.entries(vps.vs ?? {}).map(([id, v]) => ({ vpsid: id, ...v, service: linked.find((l) => l.remoteId === id) ?? null })), plans: Object.values(plans.plans ?? {}) });
  }),
);

/** Import OS templates from one Virtualizor master (or all of them with :serverId = "all"). */
adminInfra.post(
  "/virtualizor/:serverId/sync-os",
  requireStaff("products.manage"),
  ah(async (req, res) => {
    const servers = await prisma.server.findMany({ where: { type: "VIRTUALIZOR", ...(req.params.serverId === "all" ? { enabled: true } : { id: req.params.serverId }) } });
    if (!servers.length) throw badRequest("Add a Virtualizor server first (Infrastructure → Servers)");
    const results = await Promise.all(
      servers.map((s) =>
        syncVirtualizorOs(s).then(
          (r) => ({ serverId: s.id, serverName: s.name, ok: true as const, ...r }),
          (e) => ({ serverId: s.id, serverName: s.name, ok: false as const, error: String((e as Error).message ?? e) }),
        ),
      ),
    );
    await audit({ actorId: req.user!.id, action: "os.synced", entity: "server", entityId: req.params.serverId, details: results });
    res.json({ results });
  }),
);

/**
 * Plans defined in Virtualizor, for the product editor's plan picker.
 * ?serverIds=a,b limits to those servers; default = every enabled Virtualizor server.
 */
adminInfra.get(
  "/virtualizor/plans",
  requireStaff("products.manage"),
  ah(async (req, res) => {
    const ids = String(req.query.serverIds ?? "").split(",").filter(Boolean);
    const servers = await prisma.server.findMany({ where: { type: "VIRTUALIZOR", ...(ids.length ? { id: { in: ids } } : { enabled: true }) }, orderBy: { name: "asc" } });
    const num = (v: unknown) => (v === undefined || v === null || v === "" ? null : Number(v));
    const out = await Promise.all(
      servers.map(async (s) => {
        try {
          const r = await virtualizorFor(s).plans();
          const plans = Object.values(r.plans ?? {}).map((p: any) => ({
            plid: Number(p.plid),
            name: String(p.plan_name ?? `Plan ${p.plid}`),
            virt: String(p.virt ?? "kvm"),
            ramMb: num(p.ram),
            diskGb: num(p.space),
            cores: num(p.cores),
            bandwidthGb: num(p.bandwidth),
            ips: num(p.ips),
          }));
          return { serverId: s.id, serverName: s.name, plans, error: null as string | null };
        } catch (e: any) {
          return { serverId: s.id, serverName: s.name, plans: [], error: String(e?.message ?? e) };
        }
      }),
    );
    res.json({ servers: out });
  }),
);

/** Import an existing Virtualizor / Proxmox guest into billing by linking it to a client service. */
adminInfra.post(
  "/servers/:serverId/import-guest",
  requireStaff("services.manage"),
  ah(async (req, res) => {
    const b = parse(z.object({ remoteId: z.string(), node: z.string().optional(), userId: z.string(), productId: z.string(), billingCycle: z.enum(["MONTHLY", "QUARTERLY", "SEMIANNUAL", "ANNUAL", "BIENNIAL", "TRIENNIAL"]), recurringAmount: z.number().int().min(0), nextDueDate: z.coerce.date(), hostname: z.string().optional(), ips: z.array(z.string().ip()).default([]) }), req.body);
    const svc = await prisma.$transaction(async (tx) => {
      const svc = await tx.service.create({
        data: { userId: b.userId, productId: b.productId, serverId: req.params.serverId, node: b.node, remoteId: b.remoteId, status: "ACTIVE", billingCycle: b.billingCycle, firstAmount: b.recurringAmount, recurringAmount: b.recurringAmount, nextDueDate: b.nextDueDate, nextInvoiceDate: b.nextDueDate, hostname: b.hostname },
      });
      for (const [i, addr] of b.ips.entries()) {
        const ip = await tx.ipAddress.findUnique({ where: { address: addr } });
        if (ip?.serviceId) throw conflict(`${addr} is already allocated`);
        const row = ip
          ? await tx.ipAddress.update({ where: { id: ip.id }, data: { status: "ALLOCATED", serviceId: svc.id, isPrimary: i === 0, serverId: req.params.serverId } })
          : await tx.ipAddress.create({ data: { address: addr, status: "ALLOCATED", serviceId: svc.id, isPrimary: i === 0, serverId: req.params.serverId } });
        await logIp(tx, { ipId: row.id, action: "allocated", to: "ALLOCATED", serviceId: svc.id, actorId: req.user!.id, note: "imported existing guest" });
      }
      return svc;
    });
    res.status(201).json({ id: svc.id });
  }),
);

// ───────────── IP management ─────────────
adminInfra.get(
  "/ips",
  requireStaff("ips.view"),
  ah(async (req, res) => {
    const { skip, take, page, pageSize } = pageParams(req.query);
    const q = req.query as Record<string, string | undefined>;
    const where: Prisma.IpAddressWhereInput = {
      ...(q.serverId ? { serverId: q.serverId === "none" ? null : q.serverId } : {}),
      ...(q.subnetId ? { subnetId: q.subnetId } : {}),
      ...(q.status ? { status: q.status as IpStatus } : {}),
      ...(q.version ? { version: Number(q.version) } : {}),
      ...(q.locationId ? { OR: [{ server: { locationId: q.locationId } }, { subnet: { locationId: q.locationId } }] } : {}),
      ...(q.serviceId ? { serviceId: q.serviceId } : {}),
      ...(q.customer ? { service: { user: { OR: [{ email: { contains: q.customer, mode: "insensitive" } }, { id: q.customer }] } } } : {}),
      ...(q.q ? { OR: [{ address: { contains: q.q } }, { rdns: { contains: q.q } }, { notes: { contains: q.q, mode: "insensitive" } }, { service: { hostname: { contains: q.q } } }] } : {}),
    };
    const [rows, total, counts] = await Promise.all([
      prisma.ipAddress.findMany({
        where,
        skip,
        take,
        orderBy: [{ subnetId: "asc" }, { address: "asc" }],
        include: { server: { select: { id: true, name: true } }, subnet: { select: { id: true, cidr: true } }, service: { select: { id: true, hostname: true, remoteId: true, user: { select: { id: true, email: true } } } }, reservedBy: { select: { email: true } } },
      }),
      prisma.ipAddress.count({ where }),
      prisma.ipAddress.groupBy({ by: ["status"], _count: true }),
    ]);
    const { ipSortKey } = await import("../../lib/ip");
    rows.sort((a, b) => (a.subnetId ?? "").localeCompare(b.subnetId ?? "") || ipSortKey(a.address).localeCompare(ipSortKey(b.address)));
    res.json({ ips: rows, total, page, pageSize, counts: Object.fromEntries(counts.map((c) => [c.status, c._count])) });
  }),
);

adminInfra.get(
  "/subnets",
  requireStaff("ips.view"),
  ah(async (_req, res) => {
    const subnets = await prisma.ipSubnet.findMany({ orderBy: { cidr: "asc" }, include: { server: { select: { id: true, name: true } }, location: true } });
    const counts = await prisma.ipAddress.groupBy({ by: ["subnetId", "status"], _count: true });
    res.json({ subnets: subnets.map((s) => ({ ...s, counts: Object.fromEntries(counts.filter((c) => c.subnetId === s.id).map((c) => [c.status, c._count])) })) });
  }),
);

adminInfra.put(
  "/subnets/:id",
  requireStaff("ips.manage"),
  ah(async (req, res) => {
    const b = parse(z.object({ serverId: z.string().nullable().optional(), locationId: z.string().nullable().optional(), gateway: z.string().ip().nullable().optional(), vlan: z.number().int().nullable().optional(), notes: z.string().nullable().optional(), applyServerToIps: z.boolean().default(true) }), req.body);
    const { applyServerToIps, ...data } = b;
    await prisma.ipSubnet.update({ where: { id: req.params.id }, data });
    if (applyServerToIps && b.serverId !== undefined) await prisma.ipAddress.updateMany({ where: { subnetId: req.params.id, serviceId: null }, data: { serverId: b.serverId } });
    res.json({ ok: true });
  }),
);

adminInfra.delete(
  "/subnets/:id",
  requireStaff("ips.manage"),
  ah(async (req, res) => {
    const used = await prisma.ipAddress.count({ where: { subnetId: req.params.id, OR: [{ serviceId: { not: null } }, { status: "RESERVED" }] } });
    if (used) throw conflict(`${used} IPs in this subnet are allocated or reserved`);
    await prisma.ipAddress.deleteMany({ where: { subnetId: req.params.id } });
    await prisma.ipSubnet.delete({ where: { id: req.params.id } });
    res.json({ ok: true });
  }),
);

adminInfra.post(
  "/ips/import-cidr",
  requireStaff("ips.manage"),
  ah(async (req, res) => {
    const b = parse(z.object({ cidr: z.string(), serverId: z.string().nullable().optional(), locationId: z.string().nullable().optional(), gateway: z.string().ip().nullable().optional(), vlan: z.number().int().nullable().optional(), notes: z.string().nullable().optional(), expand: z.boolean().default(true) }), req.body);
    let r;
    try {
      r = await importCidr({ ...b, actorId: req.user!.id });
    } catch (e) {
      throw badRequest((e as Error).message);
    }
    await audit({ actorId: req.user!.id, action: "ip.import_cidr", details: { cidr: b.cidr, created: r.created } });
    res.status(201).json({ subnetId: r.subnet.id, created: r.created, skipped: r.skipped });
  }),
);

adminInfra.post(
  "/ips/import-csv",
  requireStaff("ips.manage"),
  ah(async (req, res) => {
    const b = parse(z.object({ csv: z.string().min(3).max(2_000_000), serverId: z.string().nullable().optional() }), req.body);
    let rows: Record<string, string>[];
    try {
      rows = parseCsv(b.csv, { columns: (h: string[]) => h.map((x) => x.trim().toLowerCase()), skip_empty_lines: true, trim: true });
    } catch (e) {
      throw badRequest(`CSV parse error: ${(e as Error).message}`);
    }
    if (!rows.length || !("address" in rows[0] || "ip" in rows[0])) throw badRequest('CSV needs a header row with an "address" column');
    const r = await importCsv(rows, { serverId: b.serverId });
    await audit({ actorId: req.user!.id, action: "ip.import_csv", details: { created: r.created, errors: r.errors.length } });
    res.json(r);
  }),
);

adminInfra.post(
  "/ips",
  requireStaff("ips.manage"),
  ah(async (req, res) => {
    const b = parse(z.object({ address: z.string().ip(), serverId: z.string().nullable().optional(), status: z.enum(["AVAILABLE", "BLOCKED", "MAINTENANCE", "QUARANTINED"]).default("AVAILABLE"), rdns: z.string().nullable().optional(), notes: z.string().nullable().optional() }), req.body);
    const r = await importCsv([{ address: b.address, status: b.status, rdns: b.rdns ?? "", notes: b.notes ?? "" }], { serverId: b.serverId });
    if (r.errors.length) throw badRequest(r.errors[0].error);
    res.status(201).json({ ok: true });
  }),
);

adminInfra.put(
  "/ips/:id",
  requireStaff("ips.manage"),
  ah(async (req, res) => {
    const b = parse(z.object({ status: z.enum(["AVAILABLE", "BLOCKED", "MAINTENANCE", "QUARANTINED"]).optional(), rdns: z.string().nullable().optional(), notes: z.string().nullable().optional(), serverId: z.string().nullable().optional(), note: z.string().optional() }), req.body);
    if (b.status) await setIpStatus(req.params.id, b.status, req.user!.id, b.note);
    if (b.rdns !== undefined || b.notes !== undefined || b.serverId !== undefined) {
      const ip = await prisma.ipAddress.findUniqueOrThrow({ where: { id: req.params.id } });
      if (b.serverId !== undefined && ip.serviceId) throw conflict("Cannot move an allocated IP to another server");
      await prisma.ipAddress.update({ where: { id: req.params.id }, data: { rdns: b.rdns, notes: b.notes, serverId: b.serverId } });
      await logIp(prisma, { ipId: ip.id, action: "edited", actorId: req.user!.id, note: Object.keys(b).join(", ") });
    }
    res.json({ ok: true });
  }),
);

adminInfra.post(
  "/ips/bulk-status",
  requireStaff("ips.manage"),
  ah(async (req, res) => {
    const b = parse(z.object({ ids: z.array(z.string()).min(1).max(1000), status: z.enum(["AVAILABLE", "BLOCKED", "MAINTENANCE", "QUARANTINED"]) }), req.body);
    let changed = 0;
    const skipped: string[] = [];
    for (const id of b.ids) {
      try {
        await setIpStatus(id, b.status, req.user!.id, "bulk update");
        changed++;
      } catch {
        skipped.push(id);
      }
    }
    res.json({ changed, skipped });
  }),
);

adminInfra.post(
  "/ips/:id/assign",
  requireStaff("ips.manage"),
  ah(async (req, res) => {
    const { serviceId } = parse(z.object({ serviceId: z.string() }), req.body);
    res.json({ ip: await adminAssignIp(req.params.id, serviceId, req.user!.id) });
  }),
);

adminInfra.post(
  "/ips/:id/unassign",
  requireStaff("ips.manage"),
  ah(async (req, res) => {
    const { quarantine } = parse(z.object({ quarantine: z.boolean().default(true) }), req.body ?? {});
    const ip = await prisma.ipAddress.findUniqueOrThrow({ where: { id: req.params.id } });
    if (!ip.serviceId) throw badRequest("IP is not assigned");
    const to: IpStatus = quarantine ? "QUARANTINED" : "AVAILABLE";
    await prisma.ipAddress.update({ where: { id: ip.id }, data: { status: to, serviceId: null, isPrimary: false } });
    await logIp(prisma, { ipId: ip.id, action: "unassigned", from: ip.status, to, serviceId: ip.serviceId, actorId: req.user!.id });
    res.json({ ok: true, note: "Remember to remove the address from the VM's network configuration." });
  }),
);

adminInfra.delete(
  "/ips/:id",
  requireStaff("ips.manage"),
  ah(async (req, res) => {
    const ip = await prisma.ipAddress.findUniqueOrThrow({ where: { id: req.params.id } });
    if (ip.serviceId || ip.status === "RESERVED" || ip.status === "ALLOCATED") throw conflict("IP is in use");
    await prisma.ipAddress.delete({ where: { id: ip.id } });
    res.json({ ok: true });
  }),
);

adminInfra.get(
  "/ips/:id/history",
  requireStaff("ips.view"),
  ah(async (req, res) => {
    res.json({ history: await prisma.ipHistory.findMany({ where: { ipId: req.params.id }, orderBy: { createdAt: "desc" }, take: 200 }) });
  }),
);
