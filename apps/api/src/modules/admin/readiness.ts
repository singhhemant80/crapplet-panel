import { prisma } from "../../db";
import type { VirtualizorModuleConfig } from "../provisioning/provisioner";

export type Check = { key: string; label: string; status: "ok" | "warn" | "error"; detail: string; fix?: string; href?: string };

/**
 * Everything a plan needs before an order can be provisioned automatically.
 * Shown in the product editor and on failed services, so problems are found before customers order.
 */
export async function productReadiness(productId: string): Promise<{ ready: boolean; checks: Check[] }> {
  const p = await prisma.product.findUniqueOrThrow({
    where: { id: productId },
    include: { pricing: true, servers: { include: { server: true } }, osTemplates: { include: { osTemplate: true } } },
  });
  const checks: Check[] = [];
  const add = (c: Check) => checks.push(c);
  const edit = `/admin/products/${p.id}`;

  add(p.enabled ? { key: "enabled", label: "Plan is on sale", status: "ok", detail: p.hidden ? "Enabled (hidden from the order page)" : "Enabled" } : { key: "enabled", label: "Plan is on sale", status: "warn", detail: "Disabled — customers can't order it", fix: "Turn on “Enabled”", href: edit });
  const inr = p.pricing.filter((x) => x.currency === "INR" && x.enabled);
  add(inr.length ? { key: "pricing", label: "Pricing", status: "ok", detail: `${inr.length} billing cycle${inr.length === 1 ? "" : "s"} priced` } : { key: "pricing", label: "Pricing", status: "error", detail: "No INR price", fix: "Add at least a monthly price", href: edit });

  const vps = p.provisioner === "PROXMOX" || p.provisioner === "VIRTUALIZOR";
  if (!vps) {
    add({ key: "module", label: "Provisioning", status: "ok", detail: p.provisioner === "MANUAL" ? "Manual — staff set these up by hand" : p.provisioner });
    return { ready: !checks.some((c) => c.status === "error"), checks };
  }
  const type = p.provisioner as "PROXMOX" | "VIRTUALIZOR";
  const name = type === "VIRTUALIZOR" ? "Virtualizor" : "Proxmox";

  // servers
  let servers = p.servers.map((s) => s.server).filter((s) => s.type === type && s.enabled);
  if (!servers.length) {
    const any = await prisma.server.findMany({ where: { type, enabled: true } });
    if (!any.length) add({ key: "server", label: `${name} server`, status: "error", detail: `No ${name} server exists`, fix: "Add it under Infrastructure → Servers", href: "/admin/servers" });
    else {
      add({ key: "server", label: `${name} server`, status: "warn", detail: `None ticked on this plan — orders fall back to ${any.map((a) => a.name).join(", ")}`, fix: "Tick the server under “Servers, operating systems & add-ons”", href: edit });
      servers = any;
    }
  } else add({ key: "server", label: `${name} server`, status: "ok", detail: servers.map((s) => s.name).join(", ") });

  for (const s of servers) {
    const st = s.lastStatus as { ok?: boolean; error?: string } | null;
    add(
      st?.ok
        ? { key: `conn-${s.id}`, label: `Connection to ${s.name}`, status: "ok", detail: `Last checked ${s.lastCheckAt?.toISOString().slice(0, 16).replace("T", " ") ?? "—"} UTC` }
        : { key: `conn-${s.id}`, label: `Connection to ${s.name}`, status: st ? "error" : "warn", detail: st?.error ?? "Not checked yet", fix: "Fix credentials / firewall, then “Test connection”", href: "/admin/servers" },
    );
  }

  // plan / specs
  const mc = ((p.moduleConfig ?? {}) as { virtualizor?: VirtualizorModuleConfig }).virtualizor ?? {};
  if (type === "VIRTUALIZOR") {
    add(mc.planId ? { key: "plan", label: "Virtualizor plan", status: "ok", detail: `Plan id ${mc.planId} · ${mc.virt ?? "kvm"}` } : { key: "plan", label: "Virtualizor plan", status: p.cpuCores && p.ramMb && p.diskGb ? "warn" : "error", detail: p.cpuCores && p.ramMb && p.diskGb ? "No plan — VPS will be created from the vCPU/RAM/disk values" : "No plan and no vCPU/RAM/disk set", fix: "Choose a Virtualizor plan", href: edit });
  } else {
    add(p.cpuCores && p.ramMb && p.diskGb ? { key: "specs", label: "Resources", status: "ok", detail: `${p.cpuCores} vCPU · ${p.ramMb} MB · ${p.diskGb} GB` } : { key: "specs", label: "Resources", status: "error", detail: "vCPU, RAM or disk missing", fix: "Fill in vCPU / RAM / disk", href: edit });
  }

  // operating systems
  const os = p.osTemplates.map((o) => o.osTemplate).filter((o) => o.enabled);
  const usable = os.filter((o) => (type === "VIRTUALIZOR" ? !!o.virtualizorOsId : !!o.proxmoxKvmVmid || !!o.proxmoxLxcVolid));
  const bad = os.filter((o) => !usable.includes(o));
  if (!os.length) add({ key: "os", label: "Operating systems", status: "error", detail: "No OS offered — customers can't order", fix: type === "VIRTUALIZOR" ? "Sync from Virtualizor and tick the templates" : "Tick OS templates", href: edit });
  else if (bad.length) add({ key: "os", label: "Operating systems", status: usable.length ? "warn" : "error", detail: `${bad.map((b) => b.name).join(", ")} can't be installed by ${name}`, fix: "Untick them and pick synced templates", href: edit });
  else add({ key: "os", label: "Operating systems", status: "ok", detail: `${usable.length} offered` });

  // IPs
  const serverIds = servers.map((s) => s.id);
  const [free, total] = await Promise.all([
    prisma.ipAddress.count({ where: { serverId: { in: serverIds }, version: 4, status: "AVAILABLE" } }),
    prisma.ipAddress.count({ where: { serverId: { in: serverIds }, version: 4 } }),
  ]);
  const virtualizorIps = type === "VIRTUALIZOR" && (mc.ipSource === "virtualizor" || (mc.ipSource !== "panel" && total === 0));
  if (virtualizorIps) {
    add({ key: "ips", label: "IPv4 addresses", status: p.allowIpSelection ? "warn" : "ok", detail: p.allowIpSelection ? "Virtualizor assigns IPs, so customers can't choose one" : "Assigned automatically by Virtualizor from its IP pools", fix: p.allowIpSelection ? "Sync IPs from Virtualizor (IP Management) to let customers choose" : undefined, href: "/admin/ips" });
  } else if (free < Math.max(1, p.ipv4Count)) {
    add({ key: "ips", label: "IPv4 addresses", status: "error", detail: `${free} free IP${free === 1 ? "" : "s"} for this plan's server${serverIds.length === 1 ? "" : "s"}`, fix: type === "VIRTUALIZOR" ? "IP Management → Sync from Virtualizor, or add a subnet" : "Add a subnet in IP Management", href: "/admin/ips" });
  } else add({ key: "ips", label: "IPv4 addresses", status: free < 5 ? "warn" : "ok", detail: `${free} free${free < 5 ? " — running low" : ""}` });

  // node placement (Virtualizor)
  if (type === "VIRTUALIZOR" && (mc.placement === "least_loaded" || mc.placement === "fixed")) {
    const nodes = await prisma.serverNode.findMany({ where: { serverId: { in: serverIds }, ...(mc.nodeIds?.length ? { externalId: { in: mc.nodeIds } } : {}) } });
    const ok = nodes.filter((n) => n.online && n.enabled);
    add(ok.length ? { key: "nodes", label: "Nodes", status: "ok", detail: `${ok.length} usable node${ok.length === 1 ? "" : "s"} (${mc.placement === "fixed" ? "fixed" : "least loaded"})` } : { key: "nodes", label: "Nodes", status: "error", detail: "None of the selected nodes is online and accepting new VPS", fix: "Check Node Monitoring or change the placement", href: "/admin/monitoring" });
  }

  return { ready: !checks.some((c) => c.status === "error"), checks };
}
