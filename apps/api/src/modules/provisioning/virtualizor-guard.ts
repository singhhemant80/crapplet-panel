/**
 * Keeps the panel from overloading a Virtualizor master.
 *
 * Every API call to a master goes through here:
 *  - rate limit: at most VIRTUALIZOR_MAX_RPS requests a second per master (default 3, short bursts of 6),
 *    the rest wait their turn instead of all hitting the master at once;
 *  - shared answers: read-only calls (VPS info, status, node usage, IP lists…) are kept for a short
 *    while and identical calls running at the same time share one request — 50 customers looking at
 *    their VPS page cost the master the same as one;
 *  - back-off: when the master stops answering or returns server errors, the panel pauses its
 *    background reads to it (30 s, doubling up to 5 min) and serves the last known answers, so it
 *    doesn't keep hammering a master that's already struggling. Changes customers ask for (start,
 *    reinstall …) still go through.
 *  - any change (POST, start/stop/suspend/delete) clears that master's kept answers.
 */
export const MAX_RPS = Math.max(0.5, Number(process.env.VIRTUALIZOR_MAX_RPS) || 3);
const BURST = Math.max(1, Math.round(MAX_RPS * 2));

/** seconds a read-only answer is reused, by API action (0 / missing = not cached) */
const TTL: Record<string, number> = {
  vs: 20, // VPS info / status / lists
  vps_stats: 60,
  vpsmanage: 30,
  monitor: 60,
  bandwidth: 120,
  servers: 60,
  serverloads: 60,
  manageserver: 60,
  ippool: 120,
  ips: 120,
  storage: 300,
  servergroups: 300,
  plans: 300,
  ostemplates: 600,
  users: 120,
};
/** query keys that make a GET a change, never cached */
const WRITE_KEYS = ["suspend", "unsuspend", "delete", "action", "start", "stop", "restart", "poweroff"];

interface Entry { at: number; ttl: number; value: unknown }
interface Master {
  tokens: number;
  last: number;
  queue: (() => void)[];
  timer: NodeJS.Timeout | null;
  cache: Map<string, Entry>;
  inflight: Map<string, Promise<unknown>>;
  fails: number;
  pausedUntil: number;
  pauseMs: number;
  stats: { calls: number; cached: number; shared: number; waited: number; failed: number; since: number };
}
const masters = new Map<string, Master>();
/** callers get their own copy, so one can't change another's answer */
const copy = <T>(v: T): T => (v === null || typeof v !== "object" ? v : structuredClone(v));
const STALE_MS = 10 * 60_000;

function m(key: string): Master {
  let x = masters.get(key);
  if (!x) {
    x = { tokens: BURST, last: Date.now(), queue: [], timer: null, cache: new Map(), inflight: new Map(), fails: 0, pausedUntil: 0, pauseMs: 0, stats: { calls: 0, cached: 0, shared: 0, waited: 0, failed: 0, since: Date.now() } };
    masters.set(key, x);
  }
  return x;
}

function refill(x: Master) {
  const now = Date.now();
  x.tokens = Math.min(BURST, x.tokens + ((now - x.last) / 1000) * MAX_RPS);
  x.last = now;
}
function pump(x: Master) {
  refill(x);
  while (x.queue.length && x.tokens >= 1) {
    x.tokens -= 1;
    x.queue.shift()!();
  }
  if (x.queue.length && !x.timer) {
    x.timer = setTimeout(() => {
      x.timer = null;
      pump(x);
    }, Math.ceil(1000 / MAX_RPS));
  }
}
/** wait for a free slot under the master's rate limit */
function slot(x: Master) {
  refill(x);
  if (!x.queue.length && x.tokens >= 1) {
    x.tokens -= 1;
    return Promise.resolve();
  }
  x.stats.waited++;
  return new Promise<void>((ok) => {
    x.queue.push(ok);
    pump(x);
  });
}

export function isRead(act: string, query: Record<string, unknown>, post: unknown) {
  if (post !== undefined) return false;
  if (!TTL[act]) return false;
  return !WRITE_KEYS.some((k) => query[k] !== undefined);
}

/** failures that mean "the master is struggling" (not "wrong VPS id") */
const overload = (e: unknown) => {
  const msg = String((e as Error)?.message ?? "");
  return /timed out|timeout|ECONNRESET|ECONNREFUSED|socket|closed|reach|HTTP 5\d\d|HTTP 429|503|502|504|not with API data/i.test(msg);
};

/**
 * Run one API call to master `key` under the guard. `run` does the actual request.
 * `cacheKey` is the action + query without credentials.
 */
export async function guarded<T>(key: string, act: string, query: Record<string, unknown>, post: unknown, run: () => Promise<T>, fresh = false): Promise<T> {
  const x = m(key);
  const read = isRead(act, query, post);
  const ck = read ? `${act}?${Object.keys(query).sort().map((k) => `${k}=${query[k]}`).join("&")}` : "";
  const now = Date.now();
  if (read) {
    const hit = x.cache.get(ck);
    // fresh: staff asked for an up-to-date answer (Refresh now) — skip the kept one
    if (hit && !fresh && now - hit.at < hit.ttl * 1000) {
      x.stats.cached++;
      return copy(hit.value as T);
    }
    const running = x.inflight.get(ck);
    if (running) {
      x.stats.shared++;
      return (running as Promise<T>).then(copy);
    }
    // master backing off: serve what we last saw rather than adding to its load
    if (x.pausedUntil > now) {
      if (hit && now - hit.at < STALE_MS) {
        x.stats.cached++;
        return copy(hit.value as T);
      }
      const err = new Error(`Virtualizor isn't answering right now — the panel is giving it ${Math.ceil((x.pausedUntil - now) / 1000)} s to recover before asking again`);
      (err as any).paused = true;
      throw err;
    }
  }
  const p = (async () => {
    await slot(x);
    x.stats.calls++;
    try {
      const v = await run();
      x.fails = 0;
      x.pauseMs = 0;
      x.pausedUntil = 0;
      if (read) x.cache.set(ck, { at: Date.now(), ttl: TTL[act], value: copy(v) });
      else x.cache.clear(); // something changed on the master — don't serve old answers
      return v;
    } catch (e) {
      if (overload(e)) {
        x.stats.failed++;
        x.fails++;
        if (x.fails >= 3) {
          x.pauseMs = Math.min(5 * 60_000, x.pauseMs ? x.pauseMs * 2 : 30_000);
          x.pausedUntil = Date.now() + x.pauseMs;
          console.warn(`[virtualizor] ${key.split("|")[0]} isn't answering (${x.fails} failures in a row) — pausing reads for ${x.pauseMs / 1000}s`);
        }
        // a failed read falls back to the last good answer when there is one
        const old = read ? x.cache.get(ck) : undefined;
        if (old && Date.now() - old.at < STALE_MS) return copy(old.value as T);
      }
      throw e;
    }
  })();
  if (read) {
    x.inflight.set(ck, p);
    p.finally(() => x.inflight.delete(ck)).catch(() => undefined);
  }
  return p;
}

/** For Admin → Node Monitoring / diagnostics: how hard the panel is using each master. */
export function guardStats() {
  return [...masters.entries()].map(([k, x]) => ({
    master: k.split("|")[0],
    maxPerSecond: MAX_RPS,
    queued: x.queue.length,
    pausedForSec: x.pausedUntil > Date.now() ? Math.ceil((x.pausedUntil - Date.now()) / 1000) : 0,
    ...x.stats,
  }));
}

/** tests */
export function resetGuard() {
  for (const x of masters.values()) if (x.timer) clearTimeout(x.timer);
  masters.clear();
}
