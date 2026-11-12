/**
 * Live broker latency for the Forex VPS page.
 *
 * Staff list the brokers' trade servers (host + port, as seen from an MT4/MT5 terminal). Every minute the
 * worker opens a TCP connection to each one from this server and records how long the handshake took —
 * the same "ping" a trading terminal sees, without needing ICMP (most broker servers block it).
 * The public page shows the latest round with a short history so visitors see real, current numbers.
 */
import net from "node:net";
import dns from "node:dns/promises";
import { randomUUID } from "node:crypto";
import { prisma } from "../../db";

export type Broker = { id: string; name: string; host: string; port: number; region?: string; enabled: boolean };
export type LatencyConfig = { enabled: boolean; measuredFrom: string; brokers: Broker[] };
type Result = { ms: number | null; ok: boolean; error?: string; at: string; ip?: string; history: (number | null)[] };
type Results = { at: string | null; results: Record<string, Result> };

const CFG = "brokerLatency";
const RES = "brokerLatencyResults";
const HISTORY = 60; // one hour at one sample a minute

// Vantage is listed from the start; it is measured (and shown) once staff enter its trade server address
const DEFAULTS: LatencyConfig = { enabled: true, measuredFrom: "our Gwalior data centre", brokers: [{ id: "vantage", name: "Vantage", host: "", port: 443, enabled: true }] };

export async function getLatencyConfig(): Promise<LatencyConfig> {
  const row = await prisma.setting.findUnique({ where: { key: CFG } });
  const v = (row?.value ?? {}) as Partial<LatencyConfig>;
  return { ...DEFAULTS, ...v, brokers: (v.brokers ?? DEFAULTS.brokers).map((b) => ({ ...b, enabled: b.enabled !== false })) };
}

export async function saveLatencyConfig(patch: Partial<Omit<LatencyConfig, "brokers">> & { brokers?: Omit<Broker, "id">[] & { id?: string }[] }) {
  const cur = await getLatencyConfig();
  const brokers = patch.brokers ? (patch.brokers as (Omit<Broker, "id"> & { id?: string })[]).map((b) => ({ ...b, id: b.id || randomUUID() })) : cur.brokers;
  const next: LatencyConfig = { ...cur, ...patch, brokers };
  await prisma.setting.upsert({ where: { key: CFG }, update: { value: next as never }, create: { key: CFG, value: next as never } });
  // forget results for brokers that were removed
  const res = await getResults();
  const keep = Object.fromEntries(Object.entries(res.results).filter(([id]) => brokers.some((b) => b.id === id)));
  await prisma.setting.upsert({ where: { key: RES }, update: { value: { ...res, results: keep } as never }, create: { key: RES, value: { ...res, results: keep } as never } });
  return next;
}

async function getResults(): Promise<Results> {
  const row = await prisma.setting.findUnique({ where: { key: RES } });
  return ((row?.value ?? null) as Results | null) ?? { at: null, results: {} };
}

/** One TCP handshake, in milliseconds (connect only — nothing is sent). */
function connectOnce(ip: string, port: number, timeoutMs: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const start = process.hrtime.bigint();
    const sock = net.connect({ host: ip, port });
    const done = (err?: Error) => {
      sock.removeAllListeners();
      sock.destroy();
      if (err) reject(err);
      else resolve(Number(process.hrtime.bigint() - start) / 1e6);
    };
    sock.setTimeout(timeoutMs, () => done(new Error(`no answer within ${timeoutMs / 1000}s`)));
    sock.once("connect", () => done());
    sock.once("error", (e: NodeJS.ErrnoException) => done(new Error(e.code === "ECONNREFUSED" ? `port ${port} refused the connection` : e.code ?? e.message)));
  });
}

/** Median of a few handshakes to host:port (DNS is resolved once and not counted). */
export async function measure(host: string, port: number, samples = 3, timeoutMs = 3000): Promise<{ ms: number | null; ip?: string; error?: string }> {
  let ip = host;
  if (!net.isIP(host)) {
    try {
      ip = (await dns.lookup(host)).address;
    } catch {
      return { ms: null, error: `${host} doesn't resolve (DNS)` };
    }
  }
  const times: number[] = [];
  let error: string | undefined;
  for (let i = 0; i < samples; i++) {
    try {
      times.push(await connectOnce(ip, port, timeoutMs));
    } catch (e) {
      error = (e as Error).message;
    }
  }
  if (!times.length) return { ms: null, ip, error };
  times.sort((a, b) => a - b);
  return { ms: Math.round(times[Math.floor(times.length / 2)] * 10) / 10, ip };
}

/** Measure every enabled broker (worker job, once a minute). */
export async function measureAll() {
  const cfg = await getLatencyConfig();
  if (!cfg.enabled) return { skipped: "off" };
  const live = cfg.brokers.filter((b) => b.enabled && b.host);
  if (!live.length) return { skipped: "no brokers" };
  const prev = await getResults();
  const at = new Date().toISOString();
  const measured = await Promise.all(live.map(async (b) => [b.id, await measure(b.host, b.port || 443)] as const));
  const results: Record<string, Result> = {};
  for (const b of cfg.brokers) {
    const m = measured.find(([id]) => id === b.id)?.[1];
    const old = prev.results[b.id];
    if (!m) {
      if (old) results[b.id] = old;
      continue;
    }
    results[b.id] = { ms: m.ms, ok: m.ms !== null, error: m.error, ip: m.ip, at, history: [...(old?.history ?? []), m.ms].slice(-HISTORY) };
  }
  await prisma.setting.upsert({ where: { key: RES }, update: { value: { at, results } as never }, create: { key: RES, value: { at, results } as never } });
  return { measured: measured.length, failed: measured.filter(([, m]) => m.ms === null).length };
}

/** Admin view: config with the latest result per broker. */
export async function adminView() {
  const [cfg, res] = await Promise.all([getLatencyConfig(), getResults()]);
  return { ...cfg, measuredAt: res.at, brokers: cfg.brokers.map((b) => ({ ...b, result: res.results[b.id] ?? null })) };
}

/** What the website shows: only working, recently measured brokers — never stale or made-up numbers. */
export async function publicView() {
  const [cfg, res] = await Promise.all([getLatencyConfig(), getResults()]);
  const fresh = res.at && Date.now() - new Date(res.at).getTime() < 10 * 60_000;
  if (!cfg.enabled || !fresh) return { live: false, brokers: [] as unknown[] };
  const brokers = cfg.brokers
    .filter((b) => b.enabled && b.host && res.results[b.id]?.ok)
    .map((b) => {
      const r = res.results[b.id];
      const hist = r.history.filter((x): x is number => typeof x === "number");
      return {
        name: b.name,
        region: b.region || null,
        ms: r.ms,
        avg: hist.length ? Math.round((hist.reduce((a, x) => a + x, 0) / hist.length) * 10) / 10 : r.ms,
        min: hist.length ? Math.min(...hist) : r.ms,
        trend: r.history.slice(-20),
      };
    })
    .sort((a, b) => (a.ms ?? 9e9) - (b.ms ?? 9e9));
  return { live: brokers.length > 0, measuredAt: res.at, measuredFrom: cfg.measuredFrom, intervalSeconds: 60, brokers };
}
