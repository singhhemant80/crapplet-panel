/**
 * Services keep a copy of their last known IPs (Service.lastIps). When a service has no IP rows right
 * now — Virtualizor unreachable, a sync that hasn't run, or one that dropped them — API answers still
 * show those IPs (marked `stale`) so staff and customers can find the server.
 */
type Any = Record<string, unknown>;

function fill(o: Any) {
  const ips = o.ips;
  const last = o.lastIps;
  if (Array.isArray(ips) && ips.length === 0 && Array.isArray(last) && last.length) {
    o.ips = last.map((address, i) => ({ id: `last-${address}`, address, isPrimary: i === 0, stale: true }));
    o.ipsStale = true;
  }
}

/** Walk an API answer (objects/arrays, a few levels deep) and fill empty `ips` from `lastIps`. */
export function withKnownIps<T>(v: T, depth = 0): T {
  if (!v || typeof v !== "object" || depth > 6 || v instanceof Date) return v;
  if (Array.isArray(v)) {
    for (const x of v) withKnownIps(x, depth + 1);
    return v;
  }
  const o = v as Any;
  if ("lastIps" in o) fill(o);
  for (const k of Object.keys(o)) {
    const x = o[k];
    if (x && typeof x === "object" && !(x instanceof Date) && k !== "lastIps") withKnownIps(x, depth + 1);
  }
  return v;
}
