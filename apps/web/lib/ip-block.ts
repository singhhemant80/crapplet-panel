/**
 * IP block / IP pool services: the customer leases a range of addresses (e.g. 162.4.12.0/25),
 * not a server — so they get a block card (network, netmask, usable range, gateway, routed to) instead
 * of the VPS "server details" (hypervisor, vCPU, RAM …).
 */
const IP_WORDS = /\b(ip|ipv4|ipv6|ips)[\s-]*(pool|block|subnet|range|lease|space|allocation)s?\b|\bsubnets?\b|\/(1[6-9]|2\d|3[0-2])\b/i;

export function isIpBlockService(p: { type?: string; provisioner?: string; name?: string; group?: { name?: string } | null; moduleConfig?: any }) {
  if (p.moduleConfig?.kind === "ip_block") return true;
  if (p.type === "COLOCATION" || ["PROXMOX", "VIRTUALIZOR", "CPANEL"].includes(String(p.provisioner))) return false;
  return IP_WORDS.test(p.name ?? "") || IP_WORDS.test(p.group?.name ?? "");
}

const toInt = (ip: string) => ip.split(".").reduce((a, o) => a * 256 + Number(o), 0);
const toIp = (n: number) => [24, 16, 8, 0].map((s) => Math.floor(n / 2 ** s) % 256).join(".");
const isV4 = (ip: string) => /^\d{1,3}(\.\d{1,3}){3}$/.test(ip) && ip.split(".").every((o) => Number(o) <= 255);

/** "162.4.12.0/25", or a hostname written as "162-4-12-0-25" (WHMCS imports), → "162.4.12.0/25". */
export function parseCidr(v?: string | null): string | null {
  if (!v) return null;
  const t = v.trim();
  let m = t.match(/^(\d{1,3}(?:\.\d{1,3}){3})\s*\/\s*(\d{1,2})$/);
  if (!m) m = t.match(/^(\d{1,3}(?:-\d{1,3}){3})-(\d{1,2})$/)?.slice(0).map((x, i) => (i === 1 ? x.replace(/-/g, ".") : x)) as RegExpMatchArray | null;
  if (!m || !isV4(m[1]) || Number(m[2]) > 32) return null;
  return `${m[1]}/${Number(m[2])}`;
}

export type BlockInfo = { cidr: string; network: string; broadcast: string; netmask: string; first: string; last: string; total: number; usable: number };
export function blockInfo(cidr: string | null): BlockInfo | null {
  const c = parseCidr(cidr);
  if (!c) return null;
  const [ip, bits] = c.split("/");
  const size = 2 ** (32 - Number(bits));
  const net = Math.floor(toInt(ip) / size) * size;
  const bc = net + size - 1;
  const small = size <= 2; // /31 and /32: every address is usable
  return {
    cidr: `${toIp(net)}/${bits}`,
    network: toIp(net),
    broadcast: toIp(bc),
    netmask: toIp(2 ** 32 - size),
    first: toIp(small ? net : net + 1),
    last: toIp(small ? bc : bc - 1),
    total: size,
    usable: small ? size : size - 2,
  };
}

/** The block of a service: what staff saved, else the hostname ("162-4-12-0-25"), else its IPs' subnet. */
export function serviceBlock(s: { hostname?: string | null; ipBlock?: { cidr?: string } | null; config?: any; ips?: { subnet?: { cidr?: string } | null }[] }) {
  return parseCidr(s.ipBlock?.cidr ?? s.config?.ipBlock?.cidr) ?? parseCidr(s.hostname) ?? parseCidr(s.ips?.find((i) => i.subnet?.cidr)?.subnet?.cidr);
}
