import { prisma, type Server } from "../../db";
import { virtualizorFor } from "./provisioner";

export type RemoteOs = { osid: number; name: string; virt: string | null; distro: string | null; active: boolean };

/**
 * Walks a Virtualizor `ostemplates` / `oslist` payload and returns every template it finds.
 * Shapes differ between versions: `{ osid: {...} }`, `{ virt: { distro: { osid: {...} } } }` or arrays.
 */
export function parseOsTemplates(payload: unknown): RemoteOs[] {
  const out = new Map<number, RemoteOs>();
  const walk = (node: unknown, ctx: { virt?: string; key?: string }) => {
    if (!node || typeof node !== "object") return;
    const o = node as Record<string, unknown>;
    const idRaw = o.osid ?? (o.name && ctx.key && /^\d+$/.test(ctx.key) ? ctx.key : undefined);
    if (idRaw !== undefined && (o.name || o.filename)) {
      const osid = Number(idRaw);
      if (Number.isFinite(osid) && osid > 0) {
        out.set(osid, {
          osid,
          name: String(o.name ?? o.filename),
          virt: (o.type ?? o.Nvirt ?? o.virt ?? ctx.virt ?? null) as string | null,
          distro: (o.distro ?? null) as string | null,
          active: o.active === undefined ? true : String(o.active) !== "0",
        });
        return;
      }
    }
    for (const [k, v] of Object.entries(o)) {
      // keys like "kvm" / "proxk" at the top of `oslist` are virt types
      const virt = ctx.virt ?? (/^(kvm|xen|xenhvm|xcp|xcphvm|openvz|vzk|vzo|proxk|proxl|proxo|lxc)$/.test(k) ? k : undefined);
      walk(v, { virt, key: k });
    }
  };
  walk(payload, {});
  return [...out.values()];
}

const DISTROS: Record<string, string> = {
  ubuntu: "Ubuntu", debian: "Debian", centos: "CentOS", almalinux: "AlmaLinux", alma: "AlmaLinux", rocky: "Rocky Linux", rockylinux: "Rocky Linux",
  fedora: "Fedora", windows: "Windows", win: "Windows", cloudlinux: "CloudLinux", rhel: "RHEL", opensuse: "openSUSE", suse: "SUSE", arch: "Arch Linux",
  freebsd: "FreeBSD", oracle: "Oracle Linux", ol: "Oracle Linux", gentoo: "Gentoo", alpine: "Alpine", vzlinux: "VzLinux", eurolinux: "EuroLinux", kali: "Kali Linux",
};

/** "ubuntu-22.04-x86_64" → "Ubuntu 22.04 (64-bit)"; "win2019" → "Windows Server 2019". */
export function prettyOsName(raw: string, distro?: string | null) {
  const base = raw.replace(/\.(img|qcow2|tar\.gz|tar\.xz|tar\.zst|iso)$/i, "");
  const win = /win(dows)?[-_ ]?(server)?[-_ ]?(20\d\d)/i.exec(base);
  if (win) return `Windows Server ${win[3]}${/r2/i.test(base) ? " R2" : ""}`;
  if (/win(dows)?[-_ ]?1[01]/i.test(base)) return `Windows ${/11/.test(base) ? "11" : "10"}`;
  const m = /^([a-z]+)[-_ ]?([\d.]+)?/i.exec(base);
  const key = (distro || m?.[1] || "").toLowerCase();
  const name = DISTROS[key] ?? (key ? key[0].toUpperCase() + key.slice(1) : base);
  const ver = m?.[2] ?? /(\d+(?:\.\d+)*)/.exec(base)?.[1] ?? "";
  const bits = /x86_64|amd64|64/.test(base) ? "" : /i386|x86(?!_64)|32/.test(base) ? " (32-bit)" : "";
  const extra = /cpanel/i.test(base) ? " + cPanel" : /plesk/i.test(base) ? " + Plesk" : /webuzo/i.test(base) ? " + Webuzo" : /docker/i.test(base) ? " + Docker" : "";
  return `${name}${ver ? " " + ver : ""}${extra}${bits}`.trim();
}

/**
 * Imports the master's OS templates as OsTemplate rows (one per server + osid).
 * Templates that vanished from the master are disabled, not deleted (services may still reference them).
 */
export async function syncVirtualizorOs(server: Server) {
  const raw = await virtualizorFor(server).osTemplates();
  const list = parseOsTemplates(raw.ostemplates ?? raw.oslist ?? raw);
  // an empty/unknown answer must never disable every template
  if (!list.length) throw new Error("Virtualizor returned no OS templates — download some under Virtualizor Admin → Media → OS Templates");
  const now = new Date();
  let created = 0, updated = 0;
  for (const os of list) {
    const family = /win/i.test(os.name) || os.distro === "windows" ? "windows" : "linux";
    const data = {
      remoteName: os.name,
      virtualizorVirt: os.virt,
      distro: os.distro ?? (/^([a-z]+)/i.exec(os.name)?.[1]?.toLowerCase() ?? null),
      family,
      source: "virtualizor",
      syncedAt: now,
    };
    const existing = await prisma.osTemplate.findUnique({ where: { virtualizorServerId_virtualizorOsId: { virtualizorServerId: server.id, virtualizorOsId: os.osid } } });
    if (existing) {
      // keep a name/enabled flag the admin changed; only refresh what comes from the master
      await prisma.osTemplate.update({ where: { id: existing.id }, data: { ...data, ...(os.active ? {} : { enabled: false }) } });
      updated++;
    } else {
      await prisma.osTemplate.create({
        data: { ...data, name: prettyOsName(os.name, os.distro), virtualizorServerId: server.id, virtualizorOsId: os.osid, defaultUser: family === "windows" ? "Administrator" : "root", enabled: os.active },
      });
      created++;
    }
  }
  const gone = await prisma.osTemplate.updateMany({
    where: { virtualizorServerId: server.id, source: "virtualizor", virtualizorOsId: { notIn: list.map((o) => o.osid) } },
    data: { enabled: false },
  });
  return { found: list.length, created, updated, disabled: gone.count };
}

/**
 * The OS template a VPS from Virtualizor's list runs (its `osid` / `os_name`), as an OsTemplate id.
 * A template the master no longer offers is recorded (switched off for new orders) so the service still shows its OS.
 * `cache` saves lookups across a bulk sync.
 */
export async function osTemplateForVps(server: { id: string }, row: Record<string, unknown>, cache = new Map<string, string | null>()): Promise<string | null> {
  const osid = Number(row.osid ?? row.os_id ?? 0);
  const name = String(row.os_name ?? row.osname ?? "").trim();
  if (!(osid > 0) && !name) return null;
  const key = `${server.id}|${osid}|${name}`;
  if (cache.has(key)) return cache.get(key)!;
  let id: string | null = null;
  if (osid > 0) id = (await prisma.osTemplate.findUnique({ where: { virtualizorServerId_virtualizorOsId: { virtualizorServerId: server.id, virtualizorOsId: osid } }, select: { id: true } }))?.id ?? null;
  if (!id && name) id = (await prisma.osTemplate.findFirst({ where: { virtualizorServerId: server.id, remoteName: name }, select: { id: true } }))?.id ?? null;
  if (!id && osid > 0 && name) {
    const distro = String(row.os_distro ?? row.distro ?? "").toLowerCase() || (/^([a-z]+)/i.exec(name)?.[1]?.toLowerCase() ?? null);
    const family = /win/i.test(name) || distro === "windows" ? "windows" : "linux";
    id = (
      await prisma.osTemplate.create({
        data: { name: prettyOsName(name, distro), remoteName: name, distro, family, source: "virtualizor", syncedAt: new Date(), virtualizorServerId: server.id, virtualizorOsId: osid, virtualizorVirt: row.virt ? String(row.virt) : null, defaultUser: family === "windows" ? "Administrator" : "root", enabled: false },
        select: { id: true },
      })
    ).id;
  }
  cache.set(key, id);
  return id;
}
