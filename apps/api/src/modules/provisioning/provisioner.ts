/**
 * Provisioning orchestration for Proxmox, Virtualizor and manual products.
 * Every action is executed by the BullMQ worker (jobs/worker.ts) — never inside an HTTP request.
 */
import { prisma, type Server, ServiceStatus } from "../../db";
import { config } from "../../config";
import { decrypt, encrypt, generatePassword } from "../../lib/crypto";
import { HttpError } from "../../lib/http";
import { getSettings } from "../../lib/settings";
import { queueEmail } from "../email/mailer";
import { allocateIpsForService, releaseServiceIps } from "../ipam/service";
import { ProxmoxClient, type PveNode } from "./proxmox";
import { VirtualizorClient } from "./virtualizor";
import type { ProvisionAction } from "../../jobs/queues";

export class ProvisionError extends Error {
  constructor(message: string, public retryable = true) {
    super(message);
  }
}

export function proxmoxFor(server: Server): ProxmoxClient {
  if (config.provisionDryRun) return new DryRunProxmox() as unknown as ProxmoxClient;
  return new ProxmoxClient({ host: server.hostname, port: server.port, tokenId: server.apiUser ?? "", secret: decrypt(server.apiSecretEnc), verifyTls: server.verifyTls });
}
export function virtualizorFor(server: Server): VirtualizorClient {
  return new VirtualizorClient({ host: server.hostname, port: server.port || 4085, apiKey: server.apiUser ?? "", apiPass: decrypt(server.apiSecretEnc), verifyTls: server.verifyTls });
}

async function log(serviceId: string, action: string, success: boolean, message?: string, details?: unknown) {
  await prisma.provisioningLog.create({ data: { serviceId, action, success, message: message?.slice(0, 2000), details: (details ?? undefined) as object | undefined } });
}

const loadService = (id: string) =>
  prisma.service.findUniqueOrThrow({
    where: { id },
    include: { product: { include: { servers: { include: { server: true } } } }, user: true, osTemplate: true, server: true, ips: { include: { subnet: true } } },
  });
type FullService = Awaited<ReturnType<typeof loadService>>;

// ───────────────────────── server / node selection ─────────────────────────

export function nodeFits(n: PveNode, server: Pick<Server, "maxCpuPct" | "maxRamPct" | "maxDiskPct">, need: { ramMb: number; diskGb: number }) {
  if (n.status !== "online") return false;
  const ramAfter = ((n.mem + need.ramMb * 1024 * 1024) / n.maxmem) * 100;
  const cpuPct = n.cpu * 100;
  const diskAfter = n.maxdisk ? ((n.disk + need.diskGb * 1024 ** 3) / n.maxdisk) * 100 : 0;
  return ramAfter <= server.maxRamPct && cpuPct <= server.maxCpuPct && diskAfter <= server.maxDiskPct;
}

async function pickServer(svc: FullService): Promise<Server> {
  const cfg = (svc.config ?? {}) as { requestedIpId?: string };
  if (svc.server) return svc.server;
  if (cfg.requestedIpId) {
    const ip = await prisma.ipAddress.findUnique({ where: { id: cfg.requestedIpId }, include: { server: true } });
    if (ip?.server?.enabled) return ip.server;
  }
  const type = svc.product.provisioner === "VIRTUALIZOR" ? "VIRTUALIZOR" : "PROXMOX";
  const candidates = svc.product.servers.map((ps) => ps.server).filter((s) => s.enabled && s.type === type);
  if (!candidates.length) throw new ProvisionError(`No enabled ${type} server is assigned to product "${svc.product.name}"`, false);
  // prefer the server with the most free IPs (they all serve the product)
  const withIps = await Promise.all(
    candidates.map(async (s) => ({ s, free: await prisma.ipAddress.count({ where: { serverId: s.id, status: "AVAILABLE", version: 4 } }) })),
  );
  withIps.sort((a, b) => b.free - a.free);
  return withIps[0].s;
}

async function pickNode(client: ProxmoxClient, server: Server, need: { ramMb: number; diskGb: number }): Promise<string> {
  const [nodes, registered] = await Promise.all([client.nodes(), prisma.serverNode.findMany({ where: { serverId: server.id } })]);
  const disabled = new Set(registered.filter((r) => !r.enabled).map((r) => r.name));
  const fits = nodes.filter((n) => !disabled.has(n.node) && nodeFits(n, server, need));
  if (server.defaultNode) {
    const pref = fits.find((n) => n.node === server.defaultNode);
    if (pref) return pref.node;
  }
  if (!fits.length) throw new ProvisionError(`No Proxmox node in "${server.name}" has capacity (thresholds: CPU ${server.maxCpuPct}%, RAM ${server.maxRamPct}%, disk ${server.maxDiskPct}%)`);
  fits.sort((a, b) => b.maxmem - b.mem - (a.maxmem - a.mem));
  return fits[0].node;
}

// ───────────────────────── Proxmox create ─────────────────────────

async function proxmoxCreate(svc: FullService) {
  const server = await pickServer(svc);
  const client = proxmoxFor(server);
  const p = svc.product;
  const mc = ((p.moduleConfig ?? {}) as { proxmox?: Record<string, unknown> }).proxmox ?? {};
  const kind = p.virtType === "LXC" ? "lxc" : "qemu";
  const ramMb = p.ramMb ?? 1024;
  const diskGb = p.diskGb ?? 20;
  const cores = p.cpuCores ?? 1;
  const cfg = (svc.config ?? {}) as Record<string, unknown>;
  const extraRamGb = Number(cfg.extra_ram_gb ?? 0);
  const extraIps = Number(cfg.extra_ipv4 ?? 0);
  const totalRam = ramMb + extraRamGb * 1024;

  if (!svc.osTemplate) throw new ProvisionError("No operating system selected for this service", false);
  const node = svc.node ?? (await pickNode(client, server, { ramMb: totalRam, diskGb }));

  // 1. IPs — allocated in a DB transaction before touching the hypervisor
  const ips = await prisma.$transaction((tx) =>
    allocateIpsForService(tx, {
      serviceId: svc.id,
      userId: svc.userId,
      serverId: server.id,
      orderId: svc.orderId,
      requestedIpId: (cfg.requestedIpId as string) ?? null,
      count: Math.max(1, p.ipv4Count + extraIps),
    }),
  );
  const primary = await prisma.ipAddress.findUniqueOrThrow({ where: { id: ips[0].id }, include: { subnet: true } });
  if (ips.some((i) => i.fallback)) await log(svc.id, "create", true, `Requested IP no longer available; auto-assigned ${primary.address}`);
  const prefix = primary.subnet?.prefix ?? 24;
  const gateway = primary.subnet?.gateway;
  if (!gateway) throw new ProvisionError(`Subnet for ${primary.address} has no gateway configured`, false);

  const password = svc.passwordEnc ? decrypt(svc.passwordEnc) : generatePassword(18);
  const username = svc.osTemplate.family === "windows" ? "Administrator" : svc.osTemplate.defaultUser || "root";
  const hostname = (svc.hostname || `vps-${svc.id.slice(-6)}.crapplet.cloud`).toLowerCase().replace(/[^a-z0-9.-]/g, "-");
  const bridge = (mc.bridge as string) || server.bridge || "vmbr0";
  const storage = (mc.storage as string) || server.storage || "local-lvm";
  const vlan = primary.subnet?.vlan ? `,tag=${primary.subnet.vlan}` : "";
  const rate = mc.rateMbps ? `,rate=${Number(mc.rateMbps) / 8}` : "";
  const ipv6 = p.ipv6Enabled && cfg.ipv6Address ? String(cfg.ipv6Address) : null;

  // 2. VMID — persisted before creation so a retried job never creates a second guest
  let vmid = svc.remoteId ? Number(svc.remoteId) : 0;
  if (!vmid) {
    vmid = await client.nextId();
    await prisma.service.update({ where: { id: svc.id }, data: { remoteId: String(vmid), node, serverId: server.id, virtType: p.virtType, hostname, username, passwordEnc: encrypt(password) } });
  }
  const exists = await client.guestStatus(node, kind, vmid).then(() => true, () => false);

  if (kind === "qemu") {
    if (!exists) {
      const tplVmid = svc.osTemplate.proxmoxKvmVmid;
      if (!tplVmid) throw new ProvisionError(`OS template "${svc.osTemplate.name}" has no Proxmox KVM template VMID`, false);
      const res = await client.resources("vm");
      const tpl = res.find((r) => r.vmid === tplVmid);
      if (!tpl) throw new ProvisionError(`KVM template VMID ${tplVmid} not found in cluster ${server.name}`, false);
      await client.cloneQemu(tpl.node, tplVmid, { newid: vmid, name: hostname, target: tpl.node !== node ? node : undefined, storage, full: true });
      await log(svc.id, "create", true, `Cloned template ${tplVmid} → VM ${vmid} on ${node}`);
    }
    const ipconfig0 = `ip=${primary.address}/${prefix},gw=${gateway}` + (ipv6 ? `,ip6=${ipv6}` : "");
    await client.setConfig(node, "qemu", vmid, {
      name: hostname,
      cores,
      sockets: 1,
      memory: totalRam,
      cpu: (mc.cpuType as string) || "host",
      net0: `virtio,bridge=${bridge}${vlan}${rate}`,
      ipconfig0,
      ciuser: username === "Administrator" ? undefined : username,
      cipassword: password,
      nameserver: (mc.nameserver as string) || "1.1.1.1 8.8.8.8",
      searchdomain: (mc.searchdomain as string) || undefined,
      onboot: 1,
      agent: "enabled=1",
      description: `Crapplet service ${svc.id} · ${svc.user.email}`,
    });
    const disk = (mc.disk as string) || "scsi0";
    const conf = await client.config(node, "qemu", vmid);
    const currentSize = String(conf[disk] ?? "").match(/size=(\d+)G/);
    if (!currentSize || Number(currentSize[1]) < diskGb) await client.resizeDisk(node, "qemu", vmid, disk, diskGb);
  } else if (!exists) {
    const volid = svc.osTemplate.proxmoxLxcVolid;
    if (!volid) throw new ProvisionError(`OS template "${svc.osTemplate.name}" has no LXC template volume`, false);
    await client.createLxc(node, {
      vmid,
      ostemplate: volid,
      hostname,
      password,
      cores,
      memory: totalRam,
      swap: Number(mc.swapMb ?? 512),
      rootfs: `${storage}:${diskGb}`,
      net0: `name=eth0,bridge=${bridge}${vlan}${rate},ip=${primary.address}/${prefix},gw=${gateway}` + (ipv6 ? `,ip6=${ipv6}` : ""),
      nameserver: (mc.nameserver as string) || "1.1.1.1",
      unprivileged: mc.unprivileged === false ? 0 : 1,
      features: (mc.features as string) || "nesting=1",
      onboot: 1,
      description: `Crapplet service ${svc.id}`,
    });
    await log(svc.id, "create", true, `Created container ${vmid} on ${node}`);
  }

  // extra IPs → additional NICs on the same bridge (KVM) / net1.. (LXC)
  for (const [i, extra] of ips.slice(1).entries()) {
    const ip = await prisma.ipAddress.findUniqueOrThrow({ where: { id: extra.id }, include: { subnet: true } });
    const pfx = ip.subnet?.prefix ?? 32;
    if (kind === "qemu") await client.setConfig(node, "qemu", vmid, { [`net${i + 1}`]: `virtio,bridge=${bridge}${vlan}`, [`ipconfig${i + 1}`]: `ip=${ip.address}/${pfx}` });
    else await client.setConfig(node, "lxc", vmid, { [`net${i + 1}`]: `name=eth${i + 1},bridge=${bridge}${vlan},ip=${ip.address}/${pfx}` });
  }

  const st = await client.guestStatus(node, kind, vmid);
  if (st.status !== "running") await client.power(node, kind, vmid, "start");

  await prisma.service.update({
    where: { id: svc.id },
    data: { status: "ACTIVE", node, serverId: server.id, remoteId: String(vmid), hostname, username, passwordEnc: encrypt(password), ipv6Address: ipv6 },
  });
  await log(svc.id, "create", true, `VPS ${vmid} running on ${node} with ${ips.map((i) => i.address).join(", ")}`);
  return { password, username, hostname, ip: primary.address };
}

// ───────────────────────── Virtualizor create ─────────────────────────

async function virtualizorCreate(svc: FullService) {
  const server = await pickServer(svc);
  const client = virtualizorFor(server);
  const p = svc.product;
  const mc = ((p.moduleConfig ?? {}) as { virtualizor?: { planId?: number; virt?: string; slaveServerId?: number } }).virtualizor ?? {};
  const cfg = (svc.config ?? {}) as Record<string, unknown>;
  if (!svc.osTemplate?.virtualizorOsId) throw new ProvisionError("OS template has no Virtualizor OS id", false);
  const ips = await prisma.$transaction((tx) =>
    allocateIpsForService(tx, { serviceId: svc.id, userId: svc.userId, serverId: server.id, orderId: svc.orderId, requestedIpId: (cfg.requestedIpId as string) ?? null, count: Math.max(1, p.ipv4Count) }),
  );
  const password = svc.passwordEnc ? decrypt(svc.passwordEnc) : generatePassword(18);
  const hostname = (svc.hostname || `vps-${svc.id.slice(-6)}.crapplet.cloud`).toLowerCase();
  let vpsid = svc.remoteId;
  if (!vpsid) {
    await prisma.service.update({ where: { id: svc.id }, data: { serverId: server.id, hostname, passwordEnc: encrypt(password), username: "root" } });
    vpsid = await client.createVps({
      virt: mc.virt || (p.virtType === "LXC" ? "lxc" : "kvm"),
      planId: mc.planId,
      serverId: mc.slaveServerId,
      userEmail: svc.user.email,
      userPass: generatePassword(16),
      hostname,
      rootPass: password,
      osId: svc.osTemplate.virtualizorOsId,
      ips: ips.map((i) => i.address),
      ramMb: p.ramMb ?? undefined,
      diskGb: p.diskGb ?? undefined,
      cores: p.cpuCores ?? undefined,
      bandwidthGb: p.bandwidthGb ?? 0,
    });
  }
  await prisma.service.update({ where: { id: svc.id }, data: { status: "ACTIVE", remoteId: vpsid, serverId: server.id } });
  await log(svc.id, "create", true, `Virtualizor VPS ${vpsid} created with ${ips.map((i) => i.address).join(", ")}`);
  return { password, username: "root", hostname, ip: ips[0].address };
}

// ───────────────────────── dispatcher ─────────────────────────

const kindOf = (svc: FullService) => ((svc.virtType ?? svc.product.virtType) === "LXC" ? "lxc" : "qemu") as "qemu" | "lxc";

function requireRemote(svc: FullService) {
  if (!svc.server || !svc.remoteId || (svc.product.provisioner === "PROXMOX" && !svc.node)) throw new ProvisionError("Service has not been provisioned on a hypervisor yet", false);
  return { server: svc.server, remoteId: svc.remoteId, node: svc.node ?? "" };
}

/** One hypervisor operation per service at a time (prevents duplicate VMs / conflicting power actions). */
async function withServiceLock<T>(serviceId: string, fn: () => Promise<T>): Promise<T> {
  const { redis } = await import("../../jobs/queues");
  const key = `crapplet:lock:service:${serviceId}`;
  const token = generatePassword(12);
  const ok = await redis().set(key, token, "PX", 30 * 60_000, "NX");
  if (!ok) throw new ProvisionError("Another operation is already running for this service — will retry", true);
  try {
    return await fn();
  } finally {
    // release only if we still own it
    await redis().eval("if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end", 1, key, token);
  }
}

export async function runProvisionAction(serviceId: string, action: ProvisionAction, params: Record<string, unknown> = {}) {
  if (action === "sync") return runProvisionActionUnlocked(serviceId, action, params);
  return withServiceLock(serviceId, () => runProvisionActionUnlocked(serviceId, action, params));
}

/** Services imported from WHMCS know their VMID but often not the Proxmox node — look it up once and store it. */
async function ensureNode(svc: FullService) {
  if (svc.product.provisioner !== "PROXMOX" || svc.node || !svc.remoteId || !svc.server) return svc;
  const vm = (await proxmoxFor(svc.server).resources("vm")).find((r) => String(r.vmid) === String(svc.remoteId));
  if (vm) {
    await prisma.service.update({ where: { id: svc.id }, data: { node: vm.node, virtType: vm.type === "lxc" ? "LXC" : "KVM" } });
    svc.node = vm.node;
    svc.virtType = vm.type === "lxc" ? "LXC" : "KVM";
  }
  return svc;
}

async function runProvisionActionUnlocked(serviceId: string, action: ProvisionAction, params: Record<string, unknown> = {}) {
  const svc = await ensureNode(await loadService(serviceId));
  const prov = svc.product.provisioner;
  const settings = await getSettings();
  const name = svc.user.firstName;
  const vars = { name, productName: svc.product.name, hostname: svc.hostname ?? "", serviceId: svc.id };

  try {
    switch (action) {
      case "create": {
        if (svc.status === "ACTIVE") return { skipped: "already active" };
        if (prov !== "PROXMOX" && prov !== "VIRTUALIZOR") {
          await prisma.service.update({ where: { id: svc.id }, data: { status: "ACTIVE" } });
          await queueEmail("service.activated", svc.user.email, vars, svc.userId);
          return { ok: true };
        }
        await prisma.service.update({ where: { id: svc.id }, data: { status: "PROVISIONING" } });
        const r = prov === "PROXMOX" ? await proxmoxCreate(svc) : await virtualizorCreate(svc);
        await queueEmail("service.vps_ready", svc.user.email, { ...vars, ...r, os: svc.osTemplate?.name ?? "" }, svc.userId);
        return { ok: true, ip: r.ip };
      }
      case "suspend": {
        const reason = String(params.reason ?? "Suspended by administrator");
        if (prov === "PROXMOX") {
          const { server, remoteId, node } = requireRemote(svc);
          const c = proxmoxFor(server);
          const st = await c.guestStatus(node, kindOf(svc), remoteId);
          if (st.status === "running") await c.power(node, kindOf(svc), remoteId, "stop");
        } else if (prov === "VIRTUALIZOR") {
          const { server, remoteId } = requireRemote(svc);
          await virtualizorFor(server).suspend(remoteId);
        }
        await prisma.service.update({ where: { id: svc.id }, data: { status: "SUSPENDED", suspendReason: reason } });
        await log(svc.id, action, true, reason);
        await queueEmail("service.suspended", svc.user.email, { ...vars, reason }, svc.userId);
        return { ok: true };
      }
      case "unsuspend": {
        if (prov === "PROXMOX") {
          const { server, remoteId, node } = requireRemote(svc);
          await proxmoxFor(server).power(node, kindOf(svc), remoteId, "start");
        } else if (prov === "VIRTUALIZOR") {
          const { server, remoteId } = requireRemote(svc);
          await virtualizorFor(server).unsuspend(remoteId);
        }
        await prisma.service.update({ where: { id: svc.id }, data: { status: "ACTIVE", suspendReason: null } });
        await log(svc.id, action, true);
        await queueEmail("service.unsuspended", svc.user.email, vars, svc.userId);
        return { ok: true };
      }
      case "terminate": {
        if (svc.remoteId && svc.server) {
          if (prov === "PROXMOX" && svc.node) {
            const c = proxmoxFor(svc.server);
            const kind = kindOf(svc);
            const st = await c.guestStatus(svc.node, kind, svc.remoteId).catch(() => null);
            if (st) {
              if (st.status === "running") await c.power(svc.node, kind, svc.remoteId, "stop");
              await c.destroy(svc.node, kind, svc.remoteId);
            }
          } else if (prov === "VIRTUALIZOR") await virtualizorFor(svc.server).terminate(svc.remoteId);
        }
        await prisma.$transaction(async (tx) => {
          await releaseServiceIps(tx, svc.id, { quarantine: params.quarantine !== false });
          await tx.service.update({ where: { id: svc.id }, data: { status: "TERMINATED", terminationDate: new Date() } });
        });
        await log(svc.id, action, true);
        if (params.notify !== false) await queueEmail("service.terminated", svc.user.email, vars, svc.userId);
        return { ok: true };
      }
      case "start":
      case "stop":
      case "shutdown":
      case "reboot": {
        if (svc.status !== "ACTIVE") throw new ProvisionError(`Power actions are not allowed while the service is ${svc.status}`, false);
        const { server, remoteId, node } = requireRemote(svc);
        if (prov === "PROXMOX") await proxmoxFor(server).power(node, kindOf(svc), remoteId, action);
        else if (prov === "VIRTUALIZOR") {
          const map = { start: "start", stop: "poweroff", shutdown: "stop", reboot: "restart" } as const;
          await virtualizorFor(server).power(remoteId, map[action]);
        }
        await log(svc.id, action, true);
        return { ok: true };
      }
      case "reset_password": {
        const { server, remoteId, node } = requireRemote(svc);
        const password = (params.password as string) || generatePassword(18);
        if (prov === "PROXMOX") {
          if (kindOf(svc) === "lxc") throw new ProvisionError("Password reset for LXC containers is not supported by the Proxmox API — use Reinstall", false);
          const c = proxmoxFor(server);
          await c.setConfig(node, "qemu", remoteId, { cipassword: password });
          await c.regenerateCloudInit(node, remoteId).catch(() => undefined);
          await c.power(node, "qemu", remoteId, "reboot");
        } else if (prov === "VIRTUALIZOR") await virtualizorFor(server).changeRootPassword(remoteId, password);
        await prisma.service.update({ where: { id: svc.id }, data: { passwordEnc: encrypt(password) } });
        await log(svc.id, action, true);
        return { ok: true };
      }
      case "reinstall": {
        const osTemplateId = String(params.osTemplateId ?? svc.osTemplateId);
        const os = await prisma.osTemplate.findUniqueOrThrow({ where: { id: osTemplateId } });
        const password = generatePassword(18);
        if (prov === "PROXMOX") {
          const { server, remoteId, node } = requireRemote(svc);
          const c = proxmoxFor(server);
          const kind = kindOf(svc);
          const st = await c.guestStatus(node, kind, remoteId).catch(() => null);
          if (st) {
            if (st.status === "running") await c.power(node, kind, remoteId, "stop");
            await c.destroy(node, kind, remoteId);
          }
          await prisma.service.update({ where: { id: svc.id }, data: { osTemplateId: os.id, passwordEnc: encrypt(password), status: "PROVISIONING" } });
          const fresh = await loadService(svc.id);
          const r = await proxmoxCreate(fresh); // re-uses the same VMID, node and IPs
          await queueEmail("service.vps_ready", svc.user.email, { ...vars, ...r, os: os.name }, svc.userId);
        } else if (prov === "VIRTUALIZOR") {
          const { server, remoteId } = requireRemote(svc);
          if (!os.virtualizorOsId) throw new ProvisionError("OS has no Virtualizor id", false);
          await virtualizorFor(server).rebuild(remoteId, os.virtualizorOsId, password);
          await prisma.service.update({ where: { id: svc.id }, data: { osTemplateId: os.id, passwordEnc: encrypt(password) } });
          await queueEmail("service.vps_ready", svc.user.email, { ...vars, password, username: "root", ip: svc.ips[0]?.address ?? "", os: os.name }, svc.userId);
        }
        await log(svc.id, action, true, `Reinstalled with ${os.name}`);
        return { ok: true };
      }
      case "sync": {
        const status = await liveStatus(svc.id);
        return { ok: true, status };
      }
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await log(svc.id, action, false, msg);
    if (action === "create") {
      const retryable = !(e instanceof ProvisionError) || e.retryable;
      if (!retryable) await markCreateFailed(svc.id, msg);
    }
    throw e;
  }
  void settings;
  return { ok: true };
}

export async function markCreateFailed(serviceId: string, error: string) {
  const svc = await prisma.service.update({ where: { id: serviceId }, data: { status: "FAILED" }, include: { product: true, user: true } });
  const s = await getSettings();
  await queueEmail("admin.provisioning_failed", s.company.billingEmail, { serviceId, productName: svc.product.name, clientEmail: svc.user.email, error });
}

// ───────────────────────── read-only live data ─────────────────────────

export async function liveStatus(serviceId: string) {
  const svc = await ensureNode(await loadService(serviceId));
  if (!svc.server || !svc.remoteId) return null;
  if (svc.product.provisioner === "PROXMOX" && svc.node) {
    const st = await proxmoxFor(svc.server).guestStatus(svc.node, kindOf(svc), svc.remoteId);
    return {
      state: st.status,
      cpuPct: Math.round(st.cpu * 1000) / 10,
      cpus: st.cpus,
      memUsedMb: Math.round(st.mem / 1048576),
      memTotalMb: Math.round(st.maxmem / 1048576),
      diskTotalGb: Math.round(st.maxdisk / 1073741824),
      netInMb: Math.round(st.netin / 1048576),
      netOutMb: Math.round(st.netout / 1048576),
      uptimeSec: st.uptime,
    };
  }
  if (svc.product.provisioner === "VIRTUALIZOR") {
    const r = await virtualizorFor(svc.server).getVps(svc.remoteId);
    const v = Object.values(r.vs ?? {})[0] ?? {};
    return { state: v.status === 1 || v.status === "1" ? "running" : "stopped", raw: v };
  }
  return null;
}

export async function usageHistory(serviceId: string, timeframe: "hour" | "day" | "week" | "month" = "day") {
  const svc = await ensureNode(await loadService(serviceId));
  if (svc.product.provisioner !== "PROXMOX" || !svc.server || !svc.remoteId || !svc.node) return [];
  const rows = await proxmoxFor(svc.server).rrd(svc.node, kindOf(svc), svc.remoteId, timeframe);
  return rows.map((r) => ({ t: r.time, cpu: r.cpu ?? 0, mem: r.mem ?? 0, maxmem: r.maxmem ?? 0, netin: r.netin ?? 0, netout: r.netout ?? 0 }));
}

/** Statuses from which a client may trigger actions. */
export const CLIENT_ACTIONABLE: ServiceStatus[] = ["ACTIVE"];

export function assertClientCan(svc: { status: ServiceStatus }) {
  if (!CLIENT_ACTIONABLE.includes(svc.status)) throw new HttpError(409, `This action isn't available while the service is ${svc.status.toLowerCase()}`);
}

// ───────────────────────── dry-run hypervisor ─────────────────────────

/** In-memory stand-in used when PROVISION_DRY_RUN=true (staging / demos). */
class DryRunProxmox {
  static guests = new Map<string, { status: string; config: Record<string, string | number> }>();
  private static next = 9000;
  async nodes(): Promise<PveNode[]> {
    return [{ node: "pve-dry", status: "online", cpu: 0.1, maxcpu: 32, mem: 8 * 1024 ** 3, maxmem: 128 * 1024 ** 3, disk: 100 * 1024 ** 3, maxdisk: 2000 * 1024 ** 3 }];
  }
  async nextId() {
    return DryRunProxmox.next++;
  }
  async resources() {
    const tpls = await prisma.osTemplate.findMany({ where: { proxmoxKvmVmid: { not: null } } });
    return tpls.map((t) => ({ id: `qemu/${t.proxmoxKvmVmid}`, type: "qemu", node: "pve-dry", vmid: t.proxmoxKvmVmid!, template: 1 }));
  }
  async guestStatus(_n: string, _k: string, vmid: number | string) {
    const g = DryRunProxmox.guests.get(String(vmid));
    if (!g) throw new Error("not found");
    return { status: g.status, cpu: 0.03, cpus: 2, mem: 512 * 1048576, maxmem: 2048 * 1048576, disk: 0, maxdisk: 40 * 1073741824, netin: 1e7, netout: 2e7, uptime: 3600 };
  }
  async cloneQemu(_n: string, _t: number, p: { newid: number }) {
    DryRunProxmox.guests.set(String(p.newid), { status: "stopped", config: { scsi0: "local-lvm:vm-disk,size=10G" } });
  }
  async createLxc(_n: string, p: Record<string, unknown>) {
    DryRunProxmox.guests.set(String(p.vmid), { status: "stopped", config: {} });
  }
  async setConfig(_n: string, _k: string, vmid: number | string, params: Record<string, unknown>) {
    const g = DryRunProxmox.guests.get(String(vmid));
    if (g) Object.assign(g.config, params);
    return null;
  }
  async config(_n: string, _k: string, vmid: number | string) {
    return DryRunProxmox.guests.get(String(vmid))?.config ?? {};
  }
  async resizeDisk() {}
  async regenerateCloudInit() {}
  async power(_n: string, _k: string, vmid: number | string, action: string) {
    const g = DryRunProxmox.guests.get(String(vmid));
    if (g) g.status = action === "start" || action === "reboot" || action === "reset" ? "running" : "stopped";
    return "UPID:dry";
  }
  async destroy(_n: string, _k: string, vmid: number | string) {
    DryRunProxmox.guests.delete(String(vmid));
  }
  async rrd() {
    const now = Math.floor(Date.now() / 1000);
    return Array.from({ length: 24 }, (_, i) => ({ time: now - (23 - i) * 3600, cpu: 0.05 + Math.random() * 0.2, mem: 6e8 + Math.random() * 3e8, maxmem: 2147483648, netin: Math.random() * 2e5, netout: Math.random() * 4e5 }));
  }
  async snapshots() {
    return [];
  }
}
