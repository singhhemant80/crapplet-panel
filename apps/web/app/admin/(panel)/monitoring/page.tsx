"use client";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { api } from "@/lib/api";
import { Alert, Button, Card, Copy, Empty, Icon, Input, Loading, Modal, PageHeader, Select, cx, toast, useApi } from "@/components/ui";

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

type Storage = { stid: number; uuid: string | null; name: string; type: string; primary: boolean; serids: string[]; sgids: string[]; totalGb: number | null; freeGb: number | null };
type StorageInfo = { serverId: string; serverName: string; ok: boolean; error?: string; storages?: Storage[]; byNode?: Record<string, Storage[]>; mappingKnown?: boolean; raw?: string };

function NodeStorage({ list, info }: { list?: Storage[]; info?: StorageInfo }) {
  if (!info) return null;
  if (!info.ok) return <div className="mt-3 text-[11.5px] text-mute">Storage: couldn&apos;t read ({info.error})</div>;
  if (!list?.length)
    return (
      <div className="mt-3 rounded-lg bg-slate-50 px-3 py-2 text-[11.5px] text-slate-600 ring-1 ring-line">
        <b>Storage:</b> {info.mappingKnown ? "none attached to this node in Virtualizor — new VPS can't be built here" : "the master doesn't say which storage belongs to which node — the node's primary storage is used"}
      </div>
    );
  return (
    <div className="mt-3 flex flex-wrap gap-1.5">
      {list.map((st) => (
        <span key={st.stid} className={cx("inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-bold ring-1", st.primary ? "bg-emerald-50 text-emerald-800 ring-emerald-200" : "bg-slate-50 text-slate-600 ring-line")} title={`id ${st.stid}${st.uuid ? ` · ${st.uuid}` : ""} · ${st.type}`}>
          <Icon name="hard_drive" className="text-[14px]" />{st.name}{st.freeGb !== null && <span className="font-semibold opacity-75">· {Math.round(st.freeGb)} GB free</span>}{st.primary && <span className="rounded bg-emerald-600 px-1 text-[9.5px] uppercase text-white">primary</span>}
        </span>
      ))}
    </div>
  );
}

/** One-click report of what this master expects on a node — the panel learns from VPSes already running there. */
function Diagnose({ server, n }: { server: Srv; n: Node }) {
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<any>(null);
  const [err, setErr] = useState("");
  const run = () => {
    setOpen(true);
    setData(null);
    setErr("");
    api(`/admin/virtualizor/${server.id}/diagnose?serid=${n.externalId}`).then(setData).catch((e) => setErr(e.message));
  };
  const text = data ? JSON.stringify(data, null, 2) : "";
  const h = data?.vpsOnThisNode;
  return (
    <>
      <button onClick={run} className="mt-2 inline-flex items-center gap-1 text-xs font-bold text-primary-dark hover:underline"><Icon name="troubleshoot" className="text-[16px]" />Diagnose VPS creation</button>
      <Modal open={open} onClose={() => setOpen(false)} title={`Diagnose · ${n.name}`} wide>
        {err && <Alert tone="error">{err}</Alert>}
        {!data && !err && <Loading label="Asking Virtualizor about this node…" />}
        {data && (
          <div className="space-y-3 text-sm">
            <div className="grid gap-2 sm:grid-cols-2">
              <div className="rounded-xl bg-slate-50 p-3 ring-1 ring-line"><div className="text-xs font-bold uppercase text-mute">VPS type on this node</div><div className="mt-0.5 font-bold">{h?.ok ? (h.data.virts.join(", ") || "no VPS yet") : h?.error}</div></div>
              <div className="rounded-xl bg-slate-50 p-3 ring-1 ring-line"><div className="text-xs font-bold uppercase text-mute">Storage used by its VPSes</div><div className="mt-0.5 break-all font-bold">{h?.ok ? ([...h.data.uuids, ...h.data.stids.map((x: number) => `#${x}`)].join(", ") || "not reported") : "—"}</div></div>
              <div className="rounded-xl bg-slate-50 p-3 ring-1 ring-line"><div className="text-xs font-bold uppercase text-mute">Panel plans → Virtualizor</div><div className="mt-0.5 text-xs">{data.panelPlans.map((p: any) => <div key={p.name}><b>{p.name}</b>: plan #{p.virtualizorPlanId ?? "—"} · {p.virt ?? "?"}{p.virtualizorPlan ? ` (${p.virtualizorPlan.plan_name}, ${p.virtualizorPlan.virt})` : ""}</div>)}</div></div>
              <div className="rounded-xl bg-slate-50 p-3 ring-1 ring-line"><div className="text-xs font-bold uppercase text-mute">Storages in the Create VPS form</div><div className="mt-0.5 text-xs">{data.createForm?.storagesFound?.map((x: any) => `${x.name} #${x.stid}${x.primary ? " (primary)" : ""}`).join(", ") || "none found"}</div></div>
            </div>
            <div className="flex items-center justify-between"><span className="text-xs text-mute">Full report (passwords removed). Copy it and send it to support if VPS creation still fails.</span><span className="flex items-center gap-1 text-xs font-bold text-primary-dark">Copy <Copy text={text} /></span></div>
            <pre className="max-h-[50vh] overflow-auto rounded-xl bg-slate-900 p-3 font-mono text-[11px] leading-relaxed text-slate-100">{text}</pre>
          </div>
        )}
      </Modal>
    </>
  );
}

function NodeCard({ n, server, onChanged, storage }: { n: Node & { enabled: boolean }; server: Srv; onChanged: () => void; storage?: StorageInfo }) {
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
      {server.type === "VIRTUALIZOR" && n.externalId !== null && <NodeStorage list={storage?.byNode?.[n.externalId]} info={storage} />}
      {server.type === "VIRTUALIZOR" && n.externalId !== null && <Diagnose server={server} n={n} />}
      {m.usageError && <div className="mt-2 rounded-lg bg-amber-50 px-3 py-2 text-[11.5px] text-amber-800">Live usage unavailable — {m.usageError.replace(/^Virtualizor manageserver: /, "").replace(/[\[\]"]/g, "")}</div>}
    </div>
  );
}

export default function Monitoring() {
  const { data, loading, error, reload } = useApi("/admin/monitoring");
  const st = useApi<{ results: StorageInfo[] }>("/admin/virtualizor/all/storages");
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
              {rows.map(({ n, s }) => <NodeCard key={n.id} n={n as any} server={s} onChanged={reload} storage={st.data?.results.find((r) => r.serverId === s.id)} />)}
            </div>
          ) : null}
          {rows.length > 0 && st.data?.results.map((r) => (
            <Card key={r.serverId} className="mt-6" title={<span className="flex items-center gap-2"><Icon name="hard_drive" className="text-primary-dark" /> Storage on {r.serverName}</span>} action={<Button size="sm" variant="outline" icon="refresh" onClick={st.reload}>Reload</Button>}>
              {!r.ok ? <Alert tone="error">{r.error}</Alert> : (
                <>
                  <div className="overflow-x-auto">
                    <table className="w-full min-w-[560px] text-left text-sm">
                      <thead><tr className="text-[11px] font-bold uppercase tracking-wider text-mute"><th className="py-2 pr-3">Storage</th><th className="pr-3">Type</th><th className="pr-3">Free / size</th><th className="pr-3">Primary</th><th>Nodes</th></tr></thead>
                      <tbody className="divide-y divide-[#f3effb]">
                        {r.storages!.map((x) => (
                          <tr key={x.stid}>
                            <td className="py-2 pr-3 font-semibold">{x.name} <span className="font-mono text-xs text-mute">#{x.stid}</span></td>
                            <td className="pr-3 text-mute">{x.type || "—"}</td>
                            <td className="pr-3">{x.freeGb !== null ? `${Math.round(x.freeGb)} GB` : "—"}{x.totalGb !== null ? ` / ${Math.round(x.totalGb)} GB` : ""}</td>
                            <td className="pr-3">{x.primary ? <span className="font-bold text-emerald-700">Yes</span> : "No"}</td>
                            <td className="text-xs">{x.serids.length ? x.serids.map((id) => servers.find((sv) => sv.id === r.serverId)?.nodes.find((nd) => nd.externalId === id)?.name ?? `#${id}`).join(", ") : x.sgids.length ? `group ${x.sgids.join(", ")}` : <span className="text-mute">not reported</span>}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <details className="mt-3 text-xs"><summary className="cursor-pointer font-bold text-mute">Raw reply from Virtualizor (for support)</summary><pre className="mt-2 max-h-72 overflow-auto rounded-lg bg-slate-50 p-3 font-mono text-[11px] text-slate-600">{r.raw}</pre></details>
                </>
              )}
            </Card>
          ))}
          {!rows.length && (
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
