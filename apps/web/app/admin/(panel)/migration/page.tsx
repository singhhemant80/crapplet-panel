"use client";
import { useEffect, useState } from "react";
import { api, date } from "@/lib/api";
import { Alert, Badge, Button, Card, Field, Input, PageHeader, Table, Td, Toggle, cx, toast, useApi } from "@/components/ui";

const LABELS: Record<string, string> = {
  currencies: "Currencies", staff: "Staff accounts", clients: "Clients (with passwords, GSTIN, credit)", productGroups: "Product groups", servers: "Servers (imported disabled)",
  products: "Products & pricing", addons: "Product add-ons", promotions: "Promo codes", orders: "Orders", services: "Services / VPS (IPs, VM IDs, passwords)",
  domains: "Domains", invoices: "Invoices & GST", transactions: "Transactions", tickets: "Support tickets", announcements: "Announcements", knowledgebase: "Knowledgebase", affiliates: "Affiliates",
};

export default function Migration() {
  const runs = useApi("/admin/migration/runs");
  const [conn, setConn] = useState({ host: "", port: 3306, database: "", user: "", password: "", ssl: false });
  const [hash, setHash] = useState("");
  const [entities, setEntities] = useState<string[]>([]);
  const [overwritePricing, setOverwritePricing] = useState(false);
  const [since, setSince] = useState("");
  const [info, setInfo] = useState<any>(null);
  const [connErr, setConnErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);

  useEffect(() => { if (runs.data && !entities.length) setEntities(runs.data.defaults); }, [runs.data]); // eslint-disable-line react-hooks/exhaustive-deps
  const active = runs.data?.runs?.some((r: any) => r.status === "RUNNING" || r.status === "QUEUED");
  useEffect(() => {
    if (!active) return;
    const t = setInterval(runs.reload, 2000);
    return () => clearInterval(t);
  }, [active, runs.reload]);

  async function test() {
    setBusy("test");
    setConnErr(null); try { setInfo(await api("/admin/migration/whmcs/test", { body: { connection: conn } })); } catch (e: any) { toast.error("Couldn't connect to the WHMCS database — see the details below"); setConnErr(e.message); setInfo(null); } finally { setBusy(null); }
  }
  async function start(dryRun: boolean) {
    if (!dryRun && !confirm("Import into the live database now? Re-running later only adds/updates records — nothing is duplicated.")) return;
    setBusy(dryRun ? "dry" : "real");
    try {
      const r = await api("/admin/migration/whmcs/runs", { body: { connection: conn, ccEncryptionHash: hash || undefined, entities, dryRun, overwritePricing, historySince: since || null } });
      toast.success(dryRun ? "Dry run started" : "Import started");
      setOpen(r.id);
      runs.reload();
    } catch (e: any) { toast.error(e.message); } finally { setBusy(null); }
  }

  return (
    <>
      <PageHeader title="WHMCS Migration" subtitle="Copy customers, services, IPs, invoices, tickets and more from your existing WHMCS into this panel." />
      <div className="grid gap-6 xl:grid-cols-[1fr_380px]">
        <div className="space-y-6">
          <Card title="1. Connect to the WHMCS database">
            <Alert className="mb-4">Create a <b>read-only</b> MySQL user on the WHMCS server, e.g. <code className="text-xs">GRANT SELECT ON whmcs.* TO &apos;migrate&apos;@&apos;&lt;this server IP&gt;&apos;</code>, and allow port 3306 from this server only (or use an SSH tunnel and host 127.0.0.1).</Alert>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="MySQL host"><Input value={conn.host} onChange={(e) => setConn({ ...conn, host: e.target.value })} placeholder="whmcs-db.crapplet.in" /></Field>
              <Field label="Port"><Input type="number" value={conn.port} onChange={(e) => setConn({ ...conn, port: Number(e.target.value) })} /></Field>
              <Field label="Database"><Input value={conn.database} onChange={(e) => setConn({ ...conn, database: e.target.value })} placeholder="whmcs" /></Field>
              <Field label="User"><Input value={conn.user} onChange={(e) => setConn({ ...conn, user: e.target.value })} /></Field>
              <Field label="Password"><Input type="password" value={conn.password} onChange={(e) => setConn({ ...conn, password: e.target.value })} /></Field>
              <div className="flex items-end pb-2"><Toggle checked={conn.ssl} onChange={(v) => setConn({ ...conn, ssl: v })} label="Use TLS" /></div>
              <Field label="cc_encryption_hash" className="sm:col-span-2" hint="From WHMCS configuration.php. Needed to carry over VPS root passwords and server passwords; everything else imports without it.">
                <Input type="password" value={hash} onChange={(e) => setHash(e.target.value)} />
              </Field>
            </div>
            <Button className="mt-4" variant="outline" icon="cable" loading={busy === "test"} disabled={!conn.host || !conn.database || !conn.user} onClick={test}>Test connection</Button>
            {connErr && <Alert tone="error" className="mt-4"><div className="text-sm leading-relaxed">{connErr.replace(/^Could not read the WHMCS database: /, "")}</div></Alert>}
            {info && (
              <div className="mt-4 rounded-xl bg-[#fbf9ff] p-4 text-sm">
                <div className="font-bold text-ink">Connected — WHMCS {info.version} {info.company && `· ${info.company}`}</div>
                <div className="mt-2 grid grid-cols-2 gap-x-6 gap-y-1 sm:grid-cols-5">
                  {Object.entries(info.counts).map(([t, n]: any) => <div key={t}><span className="text-mute">{t.replace("tbl", "")}</span> <b>{n}</b></div>)}
                </div>
              </div>
            )}
          </Card>

          <Card title="2. Choose what to import">
            <div className="grid gap-2 sm:grid-cols-2">
              {(runs.data?.entities ?? []).map((e: string) => (
                <label key={e} className={cx("flex cursor-pointer items-center gap-2.5 rounded-xl border px-3 py-2 text-sm", entities.includes(e) ? "border-primary bg-primary-tint font-semibold" : "border-line")}>
                  <input type="checkbox" className="accent-[#7c3aed]" checked={entities.includes(e)} onChange={(ev) => setEntities(ev.target.checked ? [...entities, e] : entities.filter((x) => x !== e))} />
                  {LABELS[e] ?? e}
                  {runs.data?.mapped?.[e.replace(/s$/, "")] ? <span className="ml-auto text-xs text-mute">{runs.data.mapped[e.replace(/s$/, "")]} linked</span> : null}
                </label>
              ))}
            </div>
            <div className="mt-4 grid gap-4 sm:grid-cols-2">
              <Toggle checked={overwritePricing} onChange={setOverwritePricing} label="Overwrite prices of plans that already exist here (matched by WHMCS pid)" />
              <Field label="Skip closed history older than (optional)" hint="Unpaid invoices and open tickets are always imported."><Input type="date" value={since} onChange={(e) => setSince(e.target.value)} /></Field>
            </div>
            <div className="mt-5 flex flex-wrap gap-2">
              <Button icon="science" loading={busy === "dry"} disabled={!info || active} onClick={() => start(true)}>Dry run (no changes)</Button>
              <Button variant="danger" icon="move_up" loading={busy === "real"} disabled={!info || active} onClick={() => start(false)}>Import now</Button>
              {!info && <span className="self-center text-xs text-mute">Test the connection first.</span>}
            </div>
          </Card>

          <Card title="Runs" pad={false}>
            <Table head={["Started", "Mode", "Status", "Result", ""]}>
              {(runs.data?.runs ?? []).map((r: any) => (
                <tr key={r.id} className="align-top">
                  <Td className="whitespace-nowrap text-xs text-mute">{date(r.createdAt, true)}</Td>
                  <Td>{r.dryRun ? <Badge>dry run</Badge> : <Badge status="ACTIVE">import</Badge>}</Td>
                  <Td><Badge status={r.status === "COMPLETED" ? "PAID" : r.status === "FAILED" ? "FAILED" : "PROVISIONING"}>{r.status.toLowerCase()}</Badge></Td>
                  <Td className="text-xs">
                    {r.status === "RUNNING" && Object.entries(r.progress ?? {}).map(([k, p]: any) => (
                      <div key={k} className="mb-1 flex items-center gap-2"><span className="w-24">{k}</span><div className="h-1.5 w-32 overflow-hidden rounded-full bg-slate-100"><div className="h-full bg-primary" style={{ width: `${(p.done / Math.max(1, p.total)) * 100}%` }} /></div><span className="text-mute">{p.done}/{p.total}</span></div>
                    ))}
                    {r.summary?.counts && <span className="text-mute">{Object.entries(r.summary.counts).map(([k, v]: any) => `${k} +${v.created}${v.updated ? ` ~${v.updated}` : ""}`).join(" · ")}</span>}
                    {r.error && <span className="text-rose-600">{r.error}</span>}
                  </Td>
                  <Td>{r.status === "COMPLETED" && <button className="text-xs font-bold text-primary-dark" onClick={() => setOpen(open === r.id ? null : r.id)}>{open === r.id ? "Hide" : "Report"}</button>}</Td>
                </tr>
              ))}
            </Table>
          </Card>
          {open && <RunReport id={open} />}
        </div>

        <div className="space-y-6">
          <Card title="How it works">
            <ul className="space-y-2.5 text-sm text-slate-600">
              <li>• <b>Dry run</b> performs the complete import inside a transaction and rolls it back — you get the exact report with zero changes.</li>
              <li>• <b>Import</b> is all-or-nothing: if anything fails, nothing is written.</li>
              <li>• Re-running is safe. Every WHMCS record is linked to its copy here, so a second run only updates changes (paid invoices, new replies, due dates, credit).</li>
              <li>• Customers keep their <b>existing passwords</b> (WHMCS bcrypt/MD5 hashes are accepted and upgraded on first login).</li>
              <li>• Plans keep their WHMCS <b>pid</b>, so website order links and existing services line up with the plans already here.</li>
              <li>• Imported services do <b>not</b> trigger provisioning or emails. Imported unpaid renewal invoices are respected, so customers aren&apos;t billed twice.</li>
            </ul>
          </Card>
          <Card title="Cutover checklist">
            <ol className="list-decimal space-y-2 pl-5 text-sm text-slate-600">
              <li>Dry run, read the warnings, fix anything in WHMCS (e.g. invalid GSTINs).</li>
              <li>Import. Check a few customers, services and invoices.</li>
              <li>Servers come in <b>disabled</b>: add Proxmox API tokens, Test connection, then enable.</li>
              <li>On cutover day: disable the WHMCS cron and payment gateways, run the import again (delta), then point gateway webhooks here.</li>
              <li>Copy ticket attachments manually if you need them.</li>
            </ol>
          </Card>
        </div>
      </div>
    </>
  );
}

function RunReport({ id }: { id: string }) {
  const { data } = useApi(`/admin/migration/runs/${id}`, [id]);
  const [filter, setFilter] = useState("");
  if (!data) return null;
  const r = data.run;
  const warnings = (r.warnings ?? []).filter((w: any) => !filter || w.entity === filter);
  return (
    <Card title={`Report — ${r.dryRun ? "dry run" : "import"} · ${Math.round((r.summary?.ms ?? 0) / 1000)}s`} pad={false}>
      <Table head={["Entity", "Created", "Updated", "Skipped"]}>
        {Object.entries(r.summary?.counts ?? {}).map(([k, v]: any) => <tr key={k}><Td className="font-semibold">{LABELS[k]?.split(" (")[0] ?? k}</Td><Td>{v.created}</Td><Td>{v.updated}</Td><Td>{v.skipped}</Td></tr>)}
      </Table>
      {r.warnings?.length > 0 && (
        <div className="border-t border-line p-5">
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <b className="text-sm">{r.warnings.length} warnings</b>
            {[...new Set(r.warnings.map((w: any) => w.entity))].map((e: any) => <button key={e} onClick={() => setFilter(filter === e ? "" : e)} className={cx("rounded-full px-2.5 py-0.5 text-xs font-bold", filter === e ? "bg-primary-dark text-white" : "bg-slate-100 text-slate-600")}>{e}</button>)}
          </div>
          <ul className="max-h-80 space-y-1 overflow-y-auto text-xs">
            {warnings.map((w: any, i: number) => <li key={i} className="rounded-lg bg-amber-50 px-3 py-1.5 text-amber-900"><b>{w.entity}</b> #{w.id}: {w.message}</li>)}
          </ul>
        </div>
      )}
    </Card>
  );
}
