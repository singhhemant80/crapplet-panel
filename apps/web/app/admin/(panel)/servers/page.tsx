"use client";
import { useState } from "react";
import { api, date } from "@/lib/api";
import { Alert, Badge, Button, Card, Field, Input, Loading, Modal, PageHeader, Select, Toggle, toast, useApi } from "@/components/ui";

const blank = { name: "", type: "PROXMOX", locationId: "", hostname: "", port: 8006, apiUser: "", apiSecret: "", verifyTls: true, defaultNode: "", storage: "local-lvm", bridge: "vmbr0", maxCpuPct: 85, maxRamPct: 90, maxDiskPct: 90, maxServices: 0, nameservers: [] as string[], enabled: true };
const PORTS: Record<string, number> = { PROXMOX: 8006, VIRTUALIZOR: 4085, CPANEL: 2087, MANUAL: 22 };

export default function Servers() {
  const { data, loading, reload } = useApi("/admin/servers");
  const locs = useApi("/admin/locations");
  const [f, setF] = useState<any>(null);
  const [testing, setTesting] = useState<string | null>(null);
  async function save() {
    const body = { ...f, maxServices: Number(f.maxServices) || 0, nameservers: (Array.isArray(f.nameservers) ? f.nameservers : String(f.nameservers ?? "").split(/[\s,]+/)).map((x: string) => x.trim().toLowerCase()).filter(Boolean), port: Number(f.port), maxCpuPct: Number(f.maxCpuPct), maxRamPct: Number(f.maxRamPct), maxDiskPct: Number(f.maxDiskPct), locationId: f.locationId || null, defaultNode: f.defaultNode || null, apiSecret: f.apiSecret || undefined };
    delete body.id; delete body.nodes; delete body._count; delete body.freeIps; delete body.location; delete body.lastStatus; delete body.lastCheckAt; delete body.createdAt;
    try {
      if (f.id) await api(`/admin/servers/${f.id}`, { method: "PUT", body });
      else await api("/admin/servers", { body });
      toast.success("Server saved"); setF(null); reload();
    } catch (e: any) { toast.error(e.message); }
  }
  return (
    <>
      <PageHeader title="Servers" subtitle="Proxmox clusters, Virtualizor panels and cPanel/WHM servers used for provisioning." actions={<Button icon="add" onClick={() => setF({ ...blank })}>Add server</Button>} />
      {loading ? <Loading /> : (
        <div className="grid gap-5 lg:grid-cols-2">
          {data.servers.map((s: any) => (
            <Card key={s.id}>
              <div className="flex items-start justify-between gap-3">
                <div>
                  <div className="flex items-center gap-2 text-lg font-extrabold text-ink"><span className={`h-2.5 w-2.5 rounded-full ${s.lastStatus?.ok ? "bg-emerald-500" : s.lastStatus ? "bg-rose-500" : "bg-slate-300"}`} />{s.name}</div>
                  <div className="text-sm text-mute">{s.type === "CPANEL" ? "cPanel/WHM" : s.type}{s.lastStatus?.version ? ` ${s.lastStatus.version}` : ""} · {s.hostname}:{s.port} · {s.location?.name ?? "no location"}</div>
                </div>
                <Badge status={s.enabled ? "ACTIVE" : "SUSPENDED"}>{s.enabled ? "enabled" : "disabled"}</Badge>
              </div>
              {s.type === "CPANEL" ? (
              <div className="mt-4 grid grid-cols-3 gap-2 text-center text-sm">
                <div className="rounded-xl bg-[#fbf9ff] p-2"><div className="text-xs text-mute">Panel accounts</div><b>{s._count.services}</b>{s.maxServices ? ` / ${s.maxServices}` : ""}</div>
                <div className="rounded-xl bg-[#fbf9ff] p-2"><div className="text-xs text-mute">All on WHM</div><b>{s.lastStatus?.accounts ?? "—"}</b></div>
                <div className="rounded-xl bg-[#fbf9ff] p-2"><div className="text-xs text-mute">Load (1 min)</div><b>{s.lastStatus?.load ?? "—"}</b></div>
                {s.nameservers?.length > 0 && <div className="col-span-3 truncate rounded-xl bg-[#fbf9ff] p-2 text-xs"><span className="text-mute">Nameservers </span><b>{s.nameservers.join(", ")}</b></div>}
              </div>
              ) : (
              <div className="mt-4 grid grid-cols-3 gap-2 text-center text-sm">
                <div className="rounded-xl bg-[#fbf9ff] p-2"><div className="text-xs text-mute">Live services</div><b>{s._count.services}</b></div>
                <div className="rounded-xl bg-[#fbf9ff] p-2"><div className="text-xs text-mute">Free IPs</div><b>{s.freeIps}</b> / {s._count.ips}</div>
                <div className="rounded-xl bg-[#fbf9ff] p-2"><div className="text-xs text-mute">Thresholds</div><b className="text-xs">CPU {s.maxCpuPct}% · RAM {s.maxRamPct}%</b></div>
              </div>
              )}
              {s.lastStatus?.error && <Alert tone="error" className="mt-3">{s.lastStatus.error}</Alert>}
              {s.nodes.length > 0 && (
                <div className="mt-3 space-y-1.5">
                  {s.nodes.map((n: any) => (
                    <div key={n.id} className="flex items-center justify-between rounded-lg border border-line px-3 py-1.5 text-xs">
                      <span className="font-bold">{n.name} {!n.online && <span className="text-rose-600">offline</span>}</span>
                      <span className="text-mute">CPU {n.cpuPct}% · RAM {Math.round((n.ramUsedMb / (n.ramTotalMb || 1)) * 100)}% · Disk {n.diskUsedGb}/{n.diskTotalGb} GB</span>
                      <Toggle checked={n.enabled} onChange={(v) => api(`/admin/servers/${s.id}/nodes/${n.name}`, { method: "PUT", body: { enabled: v } }).then(reload)} />
                    </div>
                  ))}
                </div>
              )}
              <div className="mt-4 flex flex-wrap items-center gap-2">
                <Button size="sm" variant="outline" icon="network_check" loading={testing === s.id} onClick={() => { setTesting(s.id); api(`/admin/servers/${s.id}/test`, { body: {} }).then((r) => { r.ok ? toast.success(`Connected${r.version ? ` · ${s.type === "CPANEL" ? "WHM" : s.type === "PROXMOX" ? "PVE" : ""} ${r.version}` : ""}${r.accounts !== undefined && r.accounts !== null ? ` · ${r.accounts} accounts` : ""} · ${r.latencyMs} ms`) : toast.error(r.error); reload(); }).finally(() => setTesting(null)); }}>Test connection</Button>
                {s.type === "CPANEL" && <Button size="sm" variant="ghost" icon="open_in_new" onClick={() => { const w = window.open("about:blank", "_blank"); api<{ url: string }>(`/admin/servers/${s.id}/whm-login`, { body: {} }).then((r) => { if (w) w.location.href = r.url; else window.location.href = r.url; }).catch((e) => { w?.close(); toast.error(e.message); }); }}>Login to WHM</Button>}
                <Button size="sm" variant="ghost" onClick={() => setF({ ...s, apiSecret: "", locationId: s.locationId ?? "", defaultNode: s.defaultNode ?? "", nameservers: (s.nameservers ?? []).join(", ") })}>Edit</Button>
                <span className="ml-auto text-xs text-mute">checked {date(s.lastCheckAt, true)}</span>
              </div>
            </Card>
          ))}
        </div>
      )}
      <Modal open={!!f} onClose={() => setF(null)} title={f?.id ? "Edit server" : "Add server"} wide>
        {f && (
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Name"><Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
            <Field label="Type"><Select value={f.type} onChange={(e) => setF({ ...f, type: e.target.value, port: PORTS[e.target.value] ?? 8006, apiUser: e.target.value === "CPANEL" && !f.apiUser ? "root" : f.apiUser })}><option value="PROXMOX">Proxmox VE</option><option value="VIRTUALIZOR">Virtualizor</option><option value="CPANEL">cPanel / WHM (shared & reseller hosting)</option><option value="MANUAL">Manual / other</option></Select></Field>
            <Field label="Hostname or IP"><Input value={f.hostname} onChange={(e) => setF({ ...f, hostname: e.target.value })} placeholder="pve1.crapplet.co.in" /></Field>
            <Field label="Port"><Input type="number" value={f.port} onChange={(e) => setF({ ...f, port: e.target.value })} /></Field>
            <Field label={f.type === "VIRTUALIZOR" ? "Admin API key" : f.type === "CPANEL" ? "WHM username" : "API token ID"} hint={f.type === "PROXMOX" ? "user@realm!tokenname — e.g. billing@pve!crapplet" : f.type === "CPANEL" ? "Usually root" : undefined}><Input value={f.apiUser ?? ""} onChange={(e) => setF({ ...f, apiUser: e.target.value })} /></Field>
            <Field label={f.type === "VIRTUALIZOR" ? "Admin API password" : f.type === "CPANEL" ? "WHM API token" : "API token secret"} hint={f.type === "CPANEL" && !f.id ? "WHM → Development → Manage API Tokens → Generate Token (full access, or the account, package and reseller functions)" : f.id ? (f.hasSecret ? "A secret is saved — leave empty to keep it, or type a new one to replace it" : "⚠ No secret saved yet — enter it now") : "Stored AES-256-GCM encrypted"}><Input type="password" value={f.apiSecret} onChange={(e) => setF({ ...f, apiSecret: e.target.value })} /></Field>
            <Field label="Location"><Select value={f.locationId} onChange={(e) => setF({ ...f, locationId: e.target.value })}><option value="">—</option>{locs.data?.items?.map((l: any) => <option key={l.id} value={l.id}>{l.name}</option>)}</Select></Field>
            {f.type === "CPANEL" && <>
              <Field label="Nameservers" hint="Comma-separated; shown in the welcome email and client area" className="sm:col-span-2"><Input value={Array.isArray(f.nameservers) ? f.nameservers.join(", ") : f.nameservers ?? ""} onChange={(e) => setF({ ...f, nameservers: e.target.value })} placeholder="ns1.crapplet.co.in, ns2.crapplet.co.in" /></Field>
              <Field label="Max accounts (0 = no limit)" hint="New orders go to the cPanel server with the fewest accounts"><Input type="number" min={0} value={f.maxServices ?? 0} onChange={(e) => setF({ ...f, maxServices: e.target.value })} /></Field>
            </>}
            {f.type === "PROXMOX" && <>
              <Field label="Preferred node (optional)"><Input value={f.defaultNode} onChange={(e) => setF({ ...f, defaultNode: e.target.value })} /></Field>
              <Field label="Default storage"><Input value={f.storage ?? ""} onChange={(e) => setF({ ...f, storage: e.target.value })} /></Field>
              <Field label="Default bridge"><Input value={f.bridge ?? ""} onChange={(e) => setF({ ...f, bridge: e.target.value })} /></Field>
              <Field label="Max CPU %"><Input type="number" value={f.maxCpuPct} onChange={(e) => setF({ ...f, maxCpuPct: e.target.value })} /></Field>
              <Field label="Max RAM % (after placement)"><Input type="number" value={f.maxRamPct} onChange={(e) => setF({ ...f, maxRamPct: e.target.value })} /></Field>
              <Field label="Max disk %"><Input type="number" value={f.maxDiskPct} onChange={(e) => setF({ ...f, maxDiskPct: e.target.value })} /></Field>
            </>}
            <div className="flex gap-5 sm:col-span-2"><Toggle checked={f.verifyTls} onChange={(v) => setF({ ...f, verifyTls: v })} label="Verify TLS certificate" /><Toggle checked={f.enabled} onChange={(v) => setF({ ...f, enabled: v })} label="Enabled for new orders" /></div>
            <div className="sm:col-span-2"><Button onClick={save} icon="save">Save server</Button></div>
          </div>
        )}
      </Modal>
    </>
  );
}
