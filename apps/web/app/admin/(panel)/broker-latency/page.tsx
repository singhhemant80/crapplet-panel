"use client";
import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { Alert, Badge, Button, Card, Field, Icon, Input, Loading, PageHeader, Toggle, cx, toast, useApi } from "@/components/ui";
import { Ago } from "@/components/admin/list-kit";

const SUGGEST = ["IC Markets", "Exness", "XM", "Pepperstone", "FXTM", "OANDA", "FBS", "Vantage", "Deriv", "AvaTrade", "Tickmill", "RoboForex"];
type Row = { id?: string; name: string; host: string; port: number | string; region?: string; enabled: boolean; result?: any };

const tone = (ms: number | null | undefined) => (ms == null ? "text-slate-400" : ms < 30 ? "text-emerald-600" : ms < 120 ? "text-amber-600" : "text-rose-600");

/** Tiny line chart of the last hour. */
function Spark({ data }: { data: (number | null)[] }) {
  const pts = data.map((v, i) => [i, v] as const).filter(([, v]) => v != null) as [number, number][];
  if (pts.length < 2) return <span className="text-[11px] text-mute">collecting…</span>;
  const max = Math.max(...pts.map(([, v]) => v)) * 1.15 || 1;
  const w = 110, h = 26, n = Math.max(data.length - 1, 1);
  const d = pts.map(([i, v], k) => `${k ? "L" : "M"}${((i / n) * w).toFixed(1)},${(h - (v / max) * h).toFixed(1)}`).join(" ");
  return <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} className="overflow-visible"><path d={d} fill="none" stroke="#7c3aed" strokeWidth="1.6" strokeLinejoin="round" strokeLinecap="round" /></svg>;
}

export default function BrokerLatency() {
  const { data, loading, reload } = useApi("/admin/broker-latency");
  const [rows, setRows] = useState<Row[]>([]);
  const [enabled, setEnabled] = useState(true);
  const [from, setFrom] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [tests, setTests] = useState<Record<number, any>>({});

  useEffect(() => {
    if (!data) return;
    setRows(data.brokers.map((b: any) => ({ ...b })));
    setEnabled(data.enabled);
    setFrom(data.measuredFrom ?? "");
  }, [data]);
  // keep results fresh while the page is open
  useEffect(() => {
    const t = setInterval(reload, 30_000);
    return () => clearInterval(t);
  }, [reload]);

  if (loading && !data) return <Loading />;
  const set = (i: number, patch: Partial<Row>) => setRows(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const live = (data?.brokers ?? []).filter((b: any) => b.result?.ok);
  const best = live.length ? Math.min(...live.map((b: any) => b.result.ms)) : null;
  const dirty = JSON.stringify(rows.map(({ result, ...r }) => r)) !== JSON.stringify((data?.brokers ?? []).map(({ result, ...r }: any) => r)) || enabled !== data?.enabled || from !== (data?.measuredFrom ?? "");

  async function save(thenMeasure = false) {
    setBusy("save");
    try {
      await api("/admin/broker-latency", { method: "PUT", body: { enabled, measuredFrom: from, brokers: rows.map(({ result, ...r }) => ({ ...r, port: Number(r.port) || 443, region: r.region || undefined })) } });
      if (thenMeasure) await api("/admin/broker-latency/measure", { method: "POST" });
      toast.success(thenMeasure ? "Saved and measured" : "Saved — measured every minute");
      reload();
    } catch (e: any) {
      toast.error(e.message);
    } finally {
      setBusy(null);
    }
  }
  async function test(i: number) {
    const r = rows[i];
    setBusy(`t${i}`);
    try {
      setTests({ ...tests, [i]: await api("/admin/broker-latency/test", { body: { host: r.host, port: Number(r.port) || 443 } }) });
    } catch (e: any) {
      toast.error(e.message);
    } finally {
      setBusy(null);
    }
  }

  return (
    <>
      <PageHeader
        icon="network_ping"
        title="Broker Latency"
        subtitle="Live connection times from this server to brokers' trade servers — shown on the Forex VPS page."
        badge={<Badge status={enabled ? "ACTIVE" : "CANCELLED"}>{enabled ? "Live on website" : "Hidden"}</Badge>}
        actions={<>
          <Button size="sm" variant="outline" icon="open_in_new" onClick={() => window.open("/forex-vps-hosting.html", "_blank")}>View page</Button>
          <Button size="sm" icon="speed" loading={busy === "measure"} onClick={async () => { setBusy("measure"); try { await api("/admin/broker-latency/measure", { method: "POST" }); reload(); toast.success("Measured"); } catch (e: any) { toast.error(e.message); } finally { setBusy(null); } }}>Measure now</Button>
        </>}
        stats={[
          ["Brokers", String(rows.length), `${live.length} answering`],
          ["Fastest", best != null ? `${best} ms` : "—", live.find((b: any) => b.result.ms === best)?.name],
          ["Last measured", data?.measuredAt ? <Ago key="a" at={data.measuredAt} /> : "never", "every 60 seconds"],
          ["Measured from", from || "—"],
        ]}
      />

      <div className="grid items-start gap-5 xl:grid-cols-[minmax(0,1fr)_360px]">
        <Card title="Trade servers" pad={false} action={<Button size="sm" variant="secondary" icon="add" onClick={() => setRows([...rows, { name: "", host: "", port: 443, enabled: true }])}>Add broker</Button>}>
          {!rows.length ? (
            <div className="px-6 py-10 text-center">
              <span className="mx-auto grid h-12 w-12 place-items-center rounded-2xl bg-primary-soft text-primary-dark"><Icon name="candlestick_chart" /></span>
              <p className="mt-3 font-bold text-ink">No brokers yet</p>
              <p className="mx-auto mt-1 max-w-md text-sm text-mute">Add the brokers your customers trade with. The website shows nothing until at least one answers, so visitors never see made-up numbers.</p>
              <div className="mt-4 flex flex-wrap justify-center gap-2">
                {SUGGEST.map((n) => <button key={n} onClick={() => setRows([...rows, { name: n, host: "", port: 443, enabled: true }])} className="rounded-lg bg-white px-3 py-1.5 text-[12.5px] font-bold text-slate-600 ring-1 ring-line hover:text-primary-dark hover:ring-primary/40">+ {n}</button>)}
              </div>
            </div>
          ) : (
            <ul className="divide-y divide-line">
              {rows.map((r, i) => {
                const res = r.result;
                const t = tests[i];
                return (
                  <li key={r.id ?? `new-${i}`} className={cx("p-4 sm:p-5", !r.enabled && "opacity-60")}>
                    <div className="grid gap-3 sm:grid-cols-[1.2fr_1fr] lg:grid-cols-[1fr_1.4fr_90px]">
                      <Field label="Broker"><Input value={r.name} onChange={(e) => set(i, { name: e.target.value })} placeholder="IC Markets" /></Field>
                      <Field label="Trade server (host or IP)"><Input value={r.host} onChange={(e) => set(i, { host: e.target.value.trim() })} placeholder="e.g. 52.202.235.91" className="font-mono" /></Field>
                      <Field label="Port"><Input type="number" value={r.port} onChange={(e) => set(i, { port: e.target.value })} /></Field>
                    </div>
                    <div className="mt-3 flex flex-wrap items-center gap-3">
                      <div className="w-full sm:w-56"><Input value={r.region ?? ""} onChange={(e) => set(i, { region: e.target.value })} placeholder="Location label, e.g. London LD4" className="h-9 text-sm" /></div>
                      <Toggle checked={r.enabled} onChange={(v) => set(i, { enabled: v })} label="Show on website" />
                      <div className="ml-auto flex items-center gap-2">
                        <Button size="sm" variant="ghost" icon="bolt" disabled={!r.host} loading={busy === `t${i}`} onClick={() => test(i)}>Test</Button>
                        <button aria-label="Remove broker" onClick={() => setRows(rows.filter((_, j) => j !== i))} className="grid h-8 w-8 place-items-center rounded-lg text-slate-400 hover:bg-rose-50 hover:text-rose-600"><Icon name="delete" className="text-[19px]" /></button>
                      </div>
                    </div>
                    {!r.host && <p className="mt-3 flex items-center gap-1.5 text-[12.5px] font-semibold text-amber-700"><Icon name="hourglass_empty" className="text-[16px]" />Waiting for the trade server address — not measured or shown until it's added.</p>}
                    {(t || res) && (
                      <div className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-2 rounded-xl bg-[#fbf9ff] px-3 py-2 text-[12.5px] ring-1 ring-[#f0e6ff]">
                        {t && <span className={cx("font-bold", t.ms != null ? "text-emerald-700" : "text-rose-600")}>Test: {t.ms != null ? `${t.ms} ms${t.ip && t.ip !== r.host ? ` (${t.ip})` : ""}` : t.error}</span>}
                        {res && (
                          <>
                            <span className="flex items-center gap-1.5"><span className={cx("h-2 w-2 rounded-full", res.ok ? "bg-emerald-500" : "bg-rose-500")} /><b className={tone(res.ms)}>{res.ok ? `${res.ms} ms` : "not answering"}</b><span className="text-mute">· <Ago at={res.at} /></span></span>
                            {!res.ok && res.error && <span className="text-rose-600">{res.error}</span>}
                            <Spark data={res.history ?? []} />
                          </>
                        )}
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
          <div className="flex flex-wrap items-center gap-2 border-t border-line p-4">
            <Button icon="save" disabled={!dirty} loading={busy === "save"} onClick={() => save(true)}>Save & measure</Button>
            {rows.length > 0 && rows.length < 30 && <span className="text-[12px] text-mute">Up to 30 brokers. Order doesn't matter — the website sorts by speed.</span>}
          </div>
        </Card>

        <div className="space-y-5">
          <Card title="Website">
            <div className="space-y-4">
              <Toggle checked={enabled} onChange={setEnabled} label="Show live latency on the Forex VPS page" />
              <Field label="Measured from" hint="Shown under the numbers, e.g. “Measured live from our Gwalior data centre”">
                <Input value={from} onChange={(e) => setFrom(e.target.value)} placeholder="our Gwalior data centre" />
              </Field>
              <Alert tone="info">Measured from <b>this panel server</b>. If your VPS nodes are in another data centre, run the panel there or say where the numbers come from above.</Alert>
            </div>
          </Card>
          <Card title="Finding a broker's trade server">
            <ol className="list-decimal space-y-2 pl-5 text-[13px] leading-5 text-slate-600">
              <li>On any Windows VPS, open MT4/MT5 and log in to the broker (a demo account is fine).</li>
              <li>Open Command Prompt and run <code className="rounded bg-slate-100 px-1">netstat -n | findstr ESTABLISHED</code>.</li>
              <li>The terminal's connection is the remote address on port <b>443</b> (MT5) or <b>443 / 1950</b> (MT4). Enter that IP and port here.</li>
              <li>Click <b>Test</b> — a number means the server answers from here.</li>
            </ol>
            <p className="mt-3 text-[12px] text-mute">Website addresses like broker.com don't work — they're served from a CDN, not the trading server. Times are TCP connection times (what MT4/MT5 shows as ping), taken every 60 seconds; the page shows the median of 3 tries.</p>
          </Card>
        </div>
      </div>
    </>
  );
}
