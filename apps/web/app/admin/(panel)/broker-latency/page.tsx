"use client";
import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { Alert, Badge, Button, Card, Field, Icon, Input, Loading, PageHeader, Toggle, cx, toast, useApi } from "@/components/ui";
import { Ago } from "@/components/admin/list-kit";

const SUGGEST = ["IC Markets", "Exness", "XM", "Pepperstone", "FXTM", "OANDA", "FBS", "Vantage", "Deriv", "AvaTrade", "Tickmill", "RoboForex"];
type Row = { id?: string; name: string; host: string; port: number | string; region?: string; enabled: boolean; result?: any };

const norm = (x: string) => x.toLowerCase().replace(/[^a-z0-9]/g, "");

/** Runs on a Windows VPS with MT4/MT5 logged in: prints each terminal's broker server and the IP:port it trades through. */
const SCRIPT = "# Crapplet - find broker trade servers. Run in PowerShell on a Windows VPS\n# with MT4/MT5 open and logged in to each broker (demo accounts are fine).\n$found = @()\nforeach ($p in Get-Process terminal, terminal64 -ErrorAction SilentlyContinue) {\n  $server = ($p.MainWindowTitle -split '\\s+-\\s+|:\\s+') | Where-Object { $_ -match '^[A-Za-z][\\w.]*-[\\w.\\- ]+$' } | Select-Object -First 1\n  if (-not $server) { continue }\n  Get-NetTCPConnection -OwningProcess $p.Id -State Established -ErrorAction SilentlyContinue |\n    Where-Object { $_.RemoteAddress -notmatch '^(127\\.|::1|0\\.|10\\.|192\\.168\\.)' } |\n    ForEach-Object {\n      $ptr = (Resolve-DnsName $_.RemoteAddress -Type PTR -ErrorAction SilentlyContinue | Select-Object -First 1).NameHost\n      if ($ptr -notmatch 'mql5|metaquotes') { $found += \"$server`t$($_.RemoteAddress)`t$($_.RemotePort)\" }\n    }\n}\nif ($found) { $found | Sort-Object -Unique } else { \"No logged-in MT4/MT5 terminals found - open them and log in first.\" }";

function FinderCard({ onImport }: { onImport: (found: { server: string; ip: string; port: number }[]) => void }) {
  const [text, setText] = useState("");
  const parse = () => {
    const seen = new Set<string>();
    const out: { server: string; ip: string; port: number }[] = [];
    for (const line of text.split(/\r?\n/)) {
      const [server, ip, port] = line.split(/\t|\s*\|\s*|\s*,\s*/).map((x) => x?.trim());
      if (!server || !ip || !/^[\d.]+$|^[0-9a-f:]+$/i.test(ip)) continue;
      if (seen.has(server)) continue; // one address per broker server
      seen.add(server);
      out.push({ server, ip, port: Number(port) || 443 });
    }
    if (!out.length) return toast.error("Nothing found — paste the lines the script printed");
    onImport(out);
    setText("");
  };
  return (
    <Card title="Find brokers' trade servers">
      <ol className="list-decimal space-y-2 pl-5 text-[13px] leading-5 text-slate-600">
        <li>On a Windows VPS <b>in your data centre</b>, open MT4/MT5 and log in to each broker (free demo accounts work).</li>
        <li>Open <b>PowerShell</b>, paste this script and press Enter:</li>
      </ol>
      <div className="relative mt-2">
        <pre className="max-h-40 overflow-auto rounded-xl bg-slate-900 p-3 pr-10 text-[10.5px] leading-relaxed text-slate-100">{SCRIPT}</pre>
        <button onClick={() => navigator.clipboard?.writeText(SCRIPT).then(() => toast.success("Script copied"))} aria-label="Copy script" className="absolute right-2 top-2 grid h-7 w-7 place-items-center rounded-md bg-white/10 text-white hover:bg-white/20"><Icon name="content_copy" className="text-[16px]" /></button>
      </div>
      <p className="mt-3 text-[13px] text-slate-600">3. Paste what it prints here:</p>
      <textarea value={text} onChange={(e) => setText(e.target.value)} rows={4} placeholder={"ICMarketsSC-MT5-6\t203.0.113.10\t443\nExness-MT5Real8\t198.51.100.7\t443"} className="mt-1 w-full rounded-xl border border-line bg-white p-2.5 font-mono text-[11.5px] outline-none focus:border-primary focus:ring-2 focus:ring-primary/15" />
      <Button size="sm" variant="secondary" icon="download" className="mt-2" disabled={!text.trim()} onClick={parse}>Fill in addresses</Button>
      <p className="mt-3 text-[11.5px] leading-4 text-mute">Brokers don't publish these addresses and website addresses (broker.com) are CDNs, not trade servers — so they're read from a logged-in terminal. Times shown are TCP connection times (what MT4/MT5 shows as ping), every 60 s, median of 3.</p>
    </Card>
  );
}

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
              <Field label="Measured from" hint="Shown under the numbers, e.g. “Measured live from our Noida data centre”">
                <Input value={from} onChange={(e) => setFrom(e.target.value)} placeholder="our Noida data centre" />
              </Field>
              <Alert tone="info">Measured from <b>this panel server</b>. If your VPS nodes are in another data centre, run the panel there or say where the numbers come from above.</Alert>
            </div>
          </Card>
          <FinderCard onImport={(found) => {
            // fill in matching brokers (by name, e.g. "IC Markets" ↔ "ICMarketsSC-MT5-6"), add the rest
            const next = [...rows];
            let filled = 0, added = 0;
            for (const f of found) {
              const i = next.findIndex((r) => r.name && norm(f.server).includes(norm(r.name)));
              if (i >= 0) { if (next[i].host !== f.ip || Number(next[i].port) !== f.port) { next[i] = { ...next[i], host: f.ip, port: f.port }; filled++; } }
              else { next.push({ name: f.server.split("-")[0].replace(/([a-z])([A-Z])/g, "$1 $2"), host: f.ip, port: f.port, enabled: true }); added++; }
            }
            setRows(next);
            toast.success(`${filled} filled in, ${added} added — check them, then Save & measure`);
          }} />
        </div>
      </div>
    </>
  );
}
