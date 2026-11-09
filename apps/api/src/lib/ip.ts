/** IPv4/IPv6 helpers for subnet import. */

export function ipv4ToInt(ip: string): number {
  const p = ip.trim().split(".");
  if (p.length !== 4) throw new Error(`Invalid IPv4 address: ${ip}`);
  let n = 0;
  for (const part of p) {
    if (!/^\d{1,3}$/.test(part)) throw new Error(`Invalid IPv4 address: ${ip}`);
    const v = Number(part);
    if (v > 255) throw new Error(`Invalid IPv4 address: ${ip}`);
    n = n * 256 + v;
  }
  return n;
}

export const intToIpv4 = (n: number) => [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join(".");

export function isIpv4(ip: string): boolean {
  try {
    ipv4ToInt(ip);
    return true;
  } catch {
    return false;
  }
}

export function isIpv6(ip: string): boolean {
  return /^[0-9a-f:]+$/i.test(ip) && ip.includes(":") && expandIpv6(ip) !== null;
}

export function expandIpv6(ip: string): string | null {
  const parts = ip.split("::");
  if (parts.length > 2) return null;
  const head = parts[0] ? parts[0].split(":") : [];
  const tail = parts.length === 2 && parts[1] ? parts[1].split(":") : [];
  const fill = 8 - head.length - tail.length;
  if (parts.length === 1 && head.length !== 8) return null;
  if (fill < 0) return null;
  const groups = [...head, ...Array(parts.length === 2 ? fill : 0).fill("0"), ...tail];
  if (groups.some((g) => !/^[0-9a-f]{1,4}$/i.test(g))) return null;
  return groups.map((g) => g.padStart(4, "0").toLowerCase()).join(":");
}

export interface ParsedCidr {
  version: 4 | 6;
  network: string;
  prefix: number;
  cidr: string;
}

export function parseCidr(input: string): ParsedCidr {
  const [addr, pfx] = input.trim().split("/");
  const prefix = Number(pfx);
  if (isIpv4(addr)) {
    if (!Number.isInteger(prefix) || prefix < 8 || prefix > 32) throw new Error("IPv4 prefix must be between /8 and /32");
    const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
    const net = (ipv4ToInt(addr) & mask) >>> 0;
    return { version: 4, network: intToIpv4(net), prefix, cidr: `${intToIpv4(net)}/${prefix}` };
  }
  if (isIpv6(addr)) {
    if (!Number.isInteger(prefix) || prefix < 16 || prefix > 128) throw new Error("IPv6 prefix must be between /16 and /128");
    return { version: 6, network: compressIpv6(expandIpv6(addr)!), prefix, cidr: `${compressIpv6(expandIpv6(addr)!)}/${prefix}` };
  }
  throw new Error(`Invalid CIDR: ${input}`);
}

/**
 * Usable host addresses of an IPv4 CIDR. For /31 and /32 all addresses are returned;
 * otherwise network and broadcast are excluded, plus the gateway (defaults to first usable).
 */
export function expandIpv4Cidr(cidr: string, opts: { gateway?: string | null; excludeGateway?: boolean } = {}): { hosts: string[]; gateway: string } {
  const p = parseCidr(cidr);
  if (p.version !== 4) throw new Error("Only IPv4 ranges can be expanded");
  if (p.prefix < 16) throw new Error("Refusing to expand ranges larger than /16");
  const base = ipv4ToInt(p.network);
  const size = 2 ** (32 - p.prefix);
  let first = base;
  let last = base + size - 1;
  if (p.prefix < 31) {
    first += 1;
    last -= 1;
  }
  const gateway = opts.gateway ?? intToIpv4(first);
  const hosts: string[] = [];
  for (let n = first; n <= last; n++) {
    const ip = intToIpv4(n);
    if (opts.excludeGateway !== false && ip === gateway) continue;
    hosts.push(ip);
  }
  return { hosts, gateway };
}

export function ipv4InCidr(ip: string, cidr: string): boolean {
  const p = parseCidr(cidr);
  if (p.version !== 4) return false;
  const mask = (0xffffffff << (32 - p.prefix)) >>> 0;
  return ((ipv4ToInt(ip) & mask) >>> 0) === ipv4ToInt(p.network);
}

export function compressIpv6(full: string): string {
  const groups = full.split(":").map((g) => g.replace(/^0+(?=.)/, ""));
  let bestStart = -1;
  let bestLen = 0;
  for (let i = 0; i < 8; ) {
    if (groups[i] === "0") {
      let j = i;
      while (j < 8 && groups[j] === "0") j++;
      if (j - i > bestLen && j - i > 1) {
        bestStart = i;
        bestLen = j - i;
      }
      i = j;
    } else i++;
  }
  if (bestStart < 0) return groups.join(":");
  const left = groups.slice(0, bestStart).join(":");
  const right = groups.slice(bestStart + bestLen).join(":");
  return `${left}::${right}`;
}

/** Sort key so 10.0.0.9 sorts before 10.0.0.10 */
export function ipSortKey(ip: string): string {
  if (isIpv4(ip)) return ipv4ToInt(ip).toString().padStart(10, "0");
  return expandIpv6(ip) ?? ip;
}
