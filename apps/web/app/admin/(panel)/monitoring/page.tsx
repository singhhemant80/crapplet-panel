"use client";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { api } from "@/lib/api";
import { Alert, Button, Card, Empty, Icon, Input, Loading, PageHeader, Select, cx, toast, useApi } from "@/components/ui";

type Node = {
  id: string; name: string; online: boolean; cpuPct: number; ramUsedMb: number; ramTotalMb: number; diskUsedGb: number; diskTotalGb: number; updatedAt: string;
  externalId: string | null;
  meta: null | { ip?: string | null; virt?: string | null; os?: string | null; cpuModel?: string | null; vpsCount?: number | null; load?: string | null; locked?: boolean; usageError?: string | null };
};
type Srv = { id: string; name: string; type: "PROXMOX" | "VIRTUALIZOR"; hostname: string; enabled: boolean; lastCheckAt: string | null; lastStatus: any; location: { name: string } | null; nodes: Node[]; _count: { services: number } };

const ago = (d: string | null) => {
  if (!d) return "never";
  const s = Math.max(0, (Date.now() - new Date(d).getTime()) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86400)} d ago`;
};
const gb = (mb: number) => (mb >= 1024 ? `${(mb / 1024).toFixed(mb >= 10240 ? 0 : 1)} GB` : `${mb} MB`);
const tb = (g: number) => (g >= 1024 ? `${(g / 1024).toFixed(1)} TB` : `${g} GB`);
const p = (u: number, t: number) => (t > 0 ? Math.min(100, (u / t) * 100) : 0);
const tone = (v: number) => (v >= 90 ? "bg-rose-500" : v >= 75 ? "bg-amber-400" : "bg-emerald-500");
const toneText = (v: number) => (v >= 90 ? "text-rose-600" : v >= 75 ? "text-amber-600" : "text-emerald-600");

function Meter({ label, value, detail }: { label: string; value: number; detail: string }) {
  return (
    <div>
      <div className="mb-1 flex items-baseline justify-between text-xs">
        <span className="font-bold uppercase tracking-wider text-mute">{label}</span>
        <span className="text-mute"><b className={cx("text-[13px]", toneText(value))}>{value.toFixed(value < 10 ? 1 : 0)}%</b> · {detail}</span>
      </div>
      <div className="h-2 overflow-hidden rounded-full bg-slate-100">
        <div className={cx("h-full rounded-full transition-all", tone(value))} style={{ width: `${Math.max(value, 1.5)}%` }} />
      </div>
    </div>
  );
}

function NodeCard({ n, server, onChanged }: { n: Node & { enabled: boolean }; server: Srv; onChanged: () => void }) {
  const ram = p(n.ramUsedMb, n.ramTotalMb);
  const disk = p(n.diskUsedGb, n.diskTotalGb);
  const m = n.meta ?? {};
  const hot = Math.max(n.cpuPct, ram, disk) >= 90;
  return (
    <div className={cx("rounded-2xl border bg-white p-5 shadow-sm transition hover:shadow-md", !n.online ? "border-rose-200" : hot ? "border-amber-200" : "border-line")}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className={cx("h-2.5 w-2.5 shrink-0 rounded-full", n.online ? "bg-emerald-500 shadow-[0_0_0_3px_rgba(16,185,129,.18)]" : "bg-rose-500 shadow-[0_0_0_3px_rgba(244,63,94,.18)]")} />
            <h3 className="truncate text-[15px] font-extrabold text-ink" title={n.name}>{n.name}</h3>
          </div>
          <div className="mt-0.5 truncate text-xs text-mute">
            {m.ip ? <span className="font-mono">{m.ip}</span> : server.hostname} · {server.name}
          </div>
        </div>
        <div className="flex shrink-0 flex-wrap justify-end gap-1">
          {m.virt && <span className="rounded-md bg-primary-tint px-2 py-0.5 text-[10.5px] font-extrabold uppercase text-primary-dark">{m.virt}</span>}
          {m.locked && <span className="rounded-md bg-amber-50 px-2 py-0.5 text-[10.5px] font-extrabold uppercase text-amber-700">locked</span>}
          {!n.online && <span className="rounded-md bg-rose-50 px-2 py-0.5 text-[10.5px] font-extrabold uppercase text-rose-700">offline</span>}
        </div>
      </div>

      <div className="mt-4 space-y-3">
        {m.usageError && !n.cpuPct ? (
          <div className="flex items-baseline justify-between text-xs"><span className="font-bold uppercase tracking-wider text-mute">CPU</span><span className="text-mute">no live data</span></div>
        ) : (
          <Meter label="CPU" value={n.cpuPct} detail={m.load ? `load ${m.load}` : "usage"} />
        )}
        <Meter label="RAM" value={ram} detail={`${gb(n.ramUsedMb)} / ${gb(n.ramTotalMb)}`} />
        <Meter label="Disk" value={disk} detail={`${tb(n.diskUsedGb)} / ${tb(n.diskTotalGb)}`} />
      </div>

      <div className="mt-4 flex items-center justify-between border-t border-line pt-3 text-xs text-mute">
        <span className="flex items-center gap-1"><Icon name="dns" className="text-[16px]" /> {m.vpsCount ?? "—"} VPS</span>
        {m.os && <span className="truncate px-2" title={m.cpuModel ?? undefined}>{m.os}</span>}
        <span title={new Date(n.updatedAt).toLocaleString()}>{ago(n.updatedAt)}</span>
      </div>
      {server.type === "VIRTUALIZOR" && (
        <label className="mt-3 flex cursor-pointer items-center justify-between rounded-lg bg-slate-50 px-3 py-2 text-xs font-semibold text-slate-600 ring-1 ring-line">
          <span>Accept new VPS{n.externalId ? <span className="ml-1 font-mono text-mute">#{n.externalId}</span> : null}</span>
          <input
            type="checkbox"
            className="h-4 w-4 accent-[#7c3aed]"
            checked={n.enabled}
            onChange={(e) =>
              api(`/admin/monitoring/nodes/${n.id}`, { method: "PATCH", body: { enabled: e.target.checked } })
                .then(() => { toast.success(e.target.checked ? `${n.name} accepts new VPS` : `${n.name} won't get new VPS`); onChanged(); })
                .catch((err) => toast.error(err.message))
            }
          />
        </label>
      )}
      {m.usageError && <div className="mt-2 rounded-lg bg-amber-50 px-3 py-2 text-[11.5px] text-amber-800">Live usage unavailable — {m.usageError.replace(/^Virtualizor manageserver: /, "").replace(/[\[\]"]/g, "")}</div>}
    </div>
  );
}

export default function Monitoring() {
  const { data, loading, error, reload } = useApi("/admin/monitoring");
  const [busy, setBusy] = useState(false);
  const [serverId, setServerId] = useState("");
  const [q, setQ] = useState("");
  const [sort, setSort] = useState<"name" | "cpu" | "ram" | "disk" | "status">("name");

  // keep the page fresh while it's open
  useEffect(() => {
    const t = setInterval(reload, 60_000);
    return () => clearInterval(t);
  }, [reload]);

  const servers: Srv[] = data?.servers ?? [];
  const rows = useMemo(() => {
    const all = servers.filter((s) => !serverId || s.id === serverId).flatMap((s) => s.nodes.map((n) => ({ n, s })));
    const f = q.trim().toLowerCase();
    const list = f ? all.filter(({ n }) => `${n.name} ${n.meta?.ip ?? ""}`.toLowerCase().includes(f)) : all;
    const key = (x: { n: Node }) =>
      sort === "cpu" ? -x.n.cpuPct : sort === "ram" ? -p(x.n.ramUsedMb, x.n.ramTotalMb) : sort === "disk" ? -p(x.n.diskUsedGb, x.n.diskTotalGb) : sort === "status" ? (x.n.online ? 1 : 0) : 0;
    return [...list].sort((a, b) => key(a) - key(b) || a.n.name.localeCompare(b.n.name));
  }, [servers, serverId, q, sort]);

  const t = rows.reduce(
    (a, { n }) => ({
      nodes: a.nodes + 1, online: a.online + (n.online ? 1 : 0), vps: a.vps + (n.meta?.vpsCount ?? 0), cpu: a.cpu + n.cpuPct,
      ramU: a.ramU + n.ramUsedMb, ramT: a.ramT + n.ramTotalMb, dU: a.dU + n.diskUsedGb, dT: a.dT + n.diskTotalGb,
      hot: a.hot + (Math.max(n.cpuPct, p(n.ramUsedMb, n.ramTotalMb), p(n.diskUsedGb, n.diskTotalGb)) >= 90 ? 1 : 0),
    }),
    { nodes: 0, online: 0, vps: 0, cpu: 0, ramU: 0, ramT: 0, dU: 0, dT: 0, hot: 0 },
  );

  async function refresh() {
    setBusy(true);
    try {
      const r = await api("/admin/monitoring/refresh", { body: serverId ? { serverId } : {} });
      const bad = r.results.filter((x: any) => !x.ok);
      if (bad.length) toast.error(`${bad.length} server(s) couldn't be reached — see the warning below`);
      else toast.success("Usage refreshed");
      await reload();
    } catch (e: any) {
      toast.error(e.message);
    } finally {
      setBusy(false);
    }
  }

  const failing = servers.filter((s) => (!serverId || s.id === serverId) && s.lastStatus && s.lastStatus.ok === false);
  const lastCheck = servers.map((s) => s.lastCheckAt).filter(Boolean).sort().pop() ?? null;

  return (
    <>
      <PageHeader
        title="Node Monitoring"
        subtitle={`Live CPU, RAM and disk for every Virtualizor and Proxmox node · auto-checked every 5 minutes · last check ${ago(lastCheck)}`}
        actions={<Button icon="refresh" loading={busy} onClick={refresh}>Refresh now</Button>}
      />

      {error && <Alert tone="error" className="mb-6">{error}</Alert>}
      {failing.map((s) => (
        <Alert key={s.id} tone="error" className="mb-4">
          <b>{s.name}</b>: {s.lastStatus.error} <Link href="/admin/servers" className="ml-1 font-bold underline">Check server settings</Link>
        </Alert>
      ))}

      {loading && !data ? (
        <Loading />
      ) : !servers.length ? (
        <Card><Empty icon="monitor_heart" title="No servers to monitor yet"><Link href="/admin/servers" className="font-bold text-primary-dark">Add a Virtualizor master or Proxmox server</Link></Empty></Card>
      ) : (
        <>
          <div className="mb-6 grid grid-cols-2 gap-4 lg:grid-cols-5">
            {[
              ["Nodes online", `${t.online} / ${t.nodes}`, "dns", t.online < t.nodes ? "text-rose-600" : "text-emerald-600"],
              ["VPS running", t.vps, "deployed_code", ""],
              ["Avg CPU", `${t.nodes ? (t.cpu / t.nodes).toFixed(1) : 0}%`, "memory", toneText(t.nodes ? t.cpu / t.nodes : 0)],
              ["RAM used", `${gb(t.ramU)} / ${gb(t.ramT)}`, "memory_alt", toneText(p(t.ramU, t.ramT))],
              ["Disk used", `${tb(t.dU)} / ${tb(t.dT)}`, "hard_drive", toneText(p(t.dU, t.dT))],
            ].map(([l, v, i, c]) => (
              <div key={l as string} className="rounded-2xl border border-line bg-white p-4 shadow-sm">
                <div className="flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-mute"><Icon name={i as string} className="text-[18px] text-primary-dark" />{l}</div>
                <div className={cx("mt-1.5 text-lg font-extrabold text-ink", c as string)}>{v}</div>
              </div>
            ))}
          </div>

          <div className="mb-5 flex flex-col gap-3 sm:flex-row sm:items-center">
            <Input className="sm:max-w-xs" placeholder="Search node name or IP…" value={q} onChange={(e) => setQ(e.target.value)} />
            <Select className="sm:w-56" value={serverId} onChange={(e) => setServerId(e.target.value)}>
              <option value="">All servers ({servers.length})</option>
              {servers.map((s) => <option key={s.id} value={s.id}>{s.name} · {s.nodes.length} node{s.nodes.length === 1 ? "" : "s"}</option>)}
            </Select>
            <Select className="sm:w-52" value={sort} onChange={(e) => setSort(e.target.value as any)}>
              <option value="name">Sort: name</option>
              <option value="cpu">Sort: highest CPU</option>
              <option value="ram">Sort: highest RAM</option>
              <option value="disk">Sort: highest disk</option>
              <option value="status">Sort: offline first</option>
            </Select>
            {t.hot > 0 && <span className="inline-flex items-center gap-1 rounded-full bg-rose-50 px-3 py-1.5 text-xs font-extrabold text-rose-700 sm:ml-auto"><Icon name="warning" className="text-[16px]" />{t.hot} node{t.hot === 1 ? "" : "s"} above 90%</span>}
          </div>

          {rows.length ? (
            <div className="grid gap-5 md:grid-cols-2 2xl:grid-cols-3">
              {rows.map(({ n, s }) => <NodeCard key={n.id} n={n as any} server={s} onChanged={reload} />)}
            </div>
          ) : (
            <Card>
              <Empty icon="search_off" title={q ? "No node matches your search" : "No nodes fetched yet"}>
                {!q && <>Click <b>Refresh now</b> to pull the node list from your servers.</>}
              </Empty>
            </Card>
          )}
        </>
      )}
    </>
  );
}
