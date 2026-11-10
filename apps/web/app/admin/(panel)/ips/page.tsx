"use client";
import Link from "next/link";
import { useState } from "react";
import { api, date } from "@/lib/api";
import { Alert, Badge, Button, Card, Field, Input, Loading, Modal, PageHeader, Pager, Select, Table, Td, Textarea, cx, toast, useApi } from "@/components/ui";

const STATUSES = ["AVAILABLE", "RESERVED", "ALLOCATED", "BLOCKED", "MAINTENANCE", "QUARANTINED"];

export default function Ips() {
  const servers = useApi("/admin/servers");
  const subnets = useApi("/admin/subnets");
  const locs = useApi("/admin/locations");
  const [f, setF] = useState({ serverId: "", subnetId: "", status: "", locationId: "", customer: "", q: "" });
  const [applied, setApplied] = useState(f);
  const [page, setPage] = useState(1);
  const [sel, setSel] = useState<string[]>([]);
  const [modal, setModal] = useState<null | "cidr" | "csv" | "single">(null);
  const [edit, setEdit] = useState<any>(null);
  const [hist, setHist] = useState<any[] | null>(null);
  const qs = new URLSearchParams({ page: String(page), pageSize: "100", ...Object.fromEntries(Object.entries(applied).filter(([, v]) => v)) }).toString();
  const { data, loading, reload } = useApi(`/admin/ips?${qs}`, [qs]);
  const refresh = () => { reload(); subnets.reload(); };

  return (
    <>
      <PageHeader title="IP Management" subtitle="IPv4/IPv6 pools per server. Customers pick from AVAILABLE addresses; holds expire after 15 minutes."
        actions={<><SyncIpsButton onDone={() => window.location.reload()} /><Button variant="outline" icon="upload_file" onClick={() => setModal("csv")}>Import CSV</Button><Button variant="outline" icon="add" onClick={() => setModal("single")}>Add IP</Button><Button icon="lan" onClick={() => setModal("cidr")}>Import CIDR range</Button></>} />

      <div className="mb-5 grid gap-3 sm:grid-cols-3 xl:grid-cols-6">
        {STATUSES.map((s) => (
          <button key={s} onClick={() => { const n = { ...f, status: f.status === s ? "" : s }; setF(n); setApplied(n); setPage(1); }} className={cx("rounded-2xl border bg-white p-3 text-left shadow-card", applied.status === s ? "border-primary ring-2 ring-primary/20" : "border-line")}>
            <div className="text-[11px] font-bold uppercase tracking-wider text-mute">{s.toLowerCase()}</div>
            <div className="text-xl font-extrabold text-ink">{data?.counts?.[s] ?? 0}</div>
          </button>
        ))}
      </div>

      <Card className="mb-5" title="Subnets" pad={false}>
        <Table head={["Subnet", "Gateway", "Server", "Location", "VLAN", "Free / used", ""]}>
          {subnets.data?.subnets.map((s: any) => (
            <tr key={s.id}>
              <Td className="font-mono font-bold">{s.cidr}</Td>
              <Td className="font-mono text-xs">{s.gateway ?? "—"}</Td>
              <Td><Select className="h-8 w-48 text-xs" value={s.serverId ?? ""} onChange={(e) => api(`/admin/subnets/${s.id}`, { method: "PUT", body: { serverId: e.target.value || null } }).then(() => { toast.success("Subnet moved"); refresh(); })}><option value="">Unassigned</option>{servers.data?.servers.map((x: any) => <option key={x.id} value={x.id}>{x.name}</option>)}</Select></Td>
              <Td className="text-xs">{s.location?.name ?? "—"}</Td>
              <Td>{s.vlan ?? "—"}</Td>
              <Td className="text-xs"><b className="text-emerald-600">{s.counts.AVAILABLE ?? 0}</b> / {(s.counts.ALLOCATED ?? 0) + (s.counts.RESERVED ?? 0)}</Td>
              <Td className="text-right"><button className="text-xs font-bold text-rose-600" onClick={() => confirm(`Delete ${s.cidr} and its unused IPs?`) && api(`/admin/subnets/${s.id}`, { method: "DELETE" }).then(refresh).catch((e) => toast.error(e.message))}>Delete</button></Td>
            </tr>
          ))}
        </Table>
      </Card>

      <Card pad={false}>
        <form className="grid gap-2 border-b border-line p-4 sm:grid-cols-2 xl:grid-cols-6" onSubmit={(e) => { e.preventDefault(); setApplied(f); setPage(1); }}>
          <Input className="h-10" placeholder="IP, rDNS, hostname, note" value={f.q} onChange={(e) => setF({ ...f, q: e.target.value })} />
          <Select className="h-10" value={f.serverId} onChange={(e) => setF({ ...f, serverId: e.target.value })}><option value="">All servers</option><option value="none">No server</option>{servers.data?.servers.map((s: any) => <option key={s.id} value={s.id}>{s.name}</option>)}</Select>
          <Select className="h-10" value={f.subnetId} onChange={(e) => setF({ ...f, subnetId: e.target.value })}><option value="">All subnets</option>{subnets.data?.subnets.map((s: any) => <option key={s.id} value={s.id}>{s.cidr}</option>)}</Select>
          <Select className="h-10" value={f.locationId} onChange={(e) => setF({ ...f, locationId: e.target.value })}><option value="">All locations</option>{locs.data?.items?.map((l: any) => <option key={l.id} value={l.id}>{l.name}</option>)}</Select>
          <Input className="h-10" placeholder="Customer email" value={f.customer} onChange={(e) => setF({ ...f, customer: e.target.value })} />
          <Button size="sm" className="h-10" type="submit" icon="filter_alt">Filter</Button>
        </form>
        {sel.length > 0 && (
          <div className="flex flex-wrap items-center gap-2 border-b border-line bg-primary-tint px-4 py-2 text-sm">
            <b>{sel.length} selected</b>
            {["AVAILABLE", "BLOCKED", "MAINTENANCE", "QUARANTINED"].map((s) => <Button key={s} size="sm" variant="outline" onClick={() => api("/admin/ips/bulk-status", { body: { ids: sel, status: s } }).then((r) => { toast.success(`${r.changed} updated${r.skipped.length ? `, ${r.skipped.length} skipped (in use)` : ""}`); setSel([]); refresh(); })}>Mark {s.toLowerCase()}</Button>)}
          </div>
        )}
        {loading ? <Loading /> : (
          <>
            <Table head={[<input key="a" type="checkbox" onChange={(e) => setSel(e.target.checked ? data.ips.map((i: any) => i.id) : [])} />, "Address", "Status", "Server / subnet", "Assigned to", "rDNS", "Notes", ""]}>
              {data.ips.map((ip: any) => (
                <tr key={ip.id} className="hover:bg-primary-tint">
                  <Td><input type="checkbox" checked={sel.includes(ip.id)} onChange={(e) => setSel(e.target.checked ? [...sel, ip.id] : sel.filter((x) => x !== ip.id))} /></Td>
                  <Td className="font-mono font-bold">{ip.address}{ip.isPrimary && <span className="ml-1 text-[10px] text-primary-dark">primary</span>}</Td>
                  <Td><Badge status={ip.status} />{ip.status === "RESERVED" && <div className="text-[11px] text-mute">{ip.reservedBy?.email} · until {date(ip.reservedUntil, true)}</div>}</Td>
                  <Td className="text-xs">{ip.server?.name ?? "—"}<div className="text-mute">{ip.subnet?.cidr}</div></Td>
                  <Td className="text-xs">{ip.service ? <Link href={`/admin/services/${ip.service.id}`} className="font-bold text-primary-dark">{ip.service.hostname ?? ip.service.id.slice(-6)}</Link> : "—"}<div className="text-mute">{ip.service?.user?.email}</div></Td>
                  <Td className="text-xs">{ip.rdns ?? "—"}</Td>
                  <Td className="max-w-[180px] truncate text-xs text-mute">{ip.notes}</Td>
                  <Td className="whitespace-nowrap text-right">
                    <button className="text-xs font-bold text-primary-dark" onClick={() => setEdit({ ...ip })}>Edit</button>
                    <button className="ml-3 text-xs font-bold text-slate-500" onClick={() => api(`/admin/ips/${ip.id}/history`).then((r) => setHist(r.history))}>History</button>
                  </Td>
                </tr>
              ))}
            </Table>
            <Pager page={data.page} pageSize={data.pageSize} total={data.total} onPage={setPage} />
          </>
        )}
      </Card>

      <CidrModal open={modal === "cidr"} onClose={() => setModal(null)} servers={servers.data?.servers ?? []} locs={locs.data?.items ?? []} onDone={refresh} />
      <CsvModal open={modal === "csv"} onClose={() => setModal(null)} servers={servers.data?.servers ?? []} onDone={refresh} />
      <SingleModal open={modal === "single"} onClose={() => setModal(null)} servers={servers.data?.servers ?? []} onDone={refresh} />
      <Modal open={!!edit} onClose={() => setEdit(null)} title={`Edit ${edit?.address ?? ""}`}>
        {edit && (
          <div className="space-y-4">
            {edit.serviceId ? <Alert>Allocated to a service. Unassign it to change status.</Alert> : (
              <Field label="Status"><Select value={edit.status} onChange={(e) => setEdit({ ...edit, status: e.target.value })}>{["AVAILABLE", "BLOCKED", "MAINTENANCE", "QUARANTINED"].map((s) => <option key={s}>{s}</option>)}{edit.status === "RESERVED" && <option>RESERVED</option>}</Select></Field>
            )}
            <Field label="Reverse DNS"><Input value={edit.rdns ?? ""} onChange={(e) => setEdit({ ...edit, rdns: e.target.value })} /></Field>
            <Field label="Internal notes"><Textarea rows={3} value={edit.notes ?? ""} onChange={(e) => setEdit({ ...edit, notes: e.target.value })} /></Field>
            {!edit.serviceId && <Field label="Assign to service id" hint="For additional IPs on an existing VPS"><Input value={edit.assignTo ?? ""} onChange={(e) => setEdit({ ...edit, assignTo: e.target.value })} placeholder="service id" /></Field>}
            <div className="flex flex-wrap gap-2">
              <Button onClick={async () => {
                try {
                  await api(`/admin/ips/${edit.id}`, { method: "PUT", body: { rdns: edit.rdns || null, notes: edit.notes || null, ...(!edit.serviceId && edit.status !== "RESERVED" ? { status: edit.status } : {}) } });
                  if (edit.assignTo) await api(`/admin/ips/${edit.id}/assign`, { body: { serviceId: edit.assignTo } });
                  toast.success("Saved"); setEdit(null); refresh();
                } catch (e: any) { toast.error(e.message); }
              }}>Save</Button>
              {edit.serviceId && <Button variant="outline" onClick={() => confirm("Unassign from the service? Remember to remove it from the VM.") && api(`/admin/ips/${edit.id}/unassign`, { body: {} }).then((r) => { toast.info(r.note); setEdit(null); refresh(); })}>Unassign</Button>}
              {!edit.serviceId && edit.status !== "RESERVED" && <Button variant="danger" onClick={() => confirm("Delete this IP?") && api(`/admin/ips/${edit.id}`, { method: "DELETE" }).then(() => { setEdit(null); refresh(); }).catch((e) => toast.error(e.message))}>Delete</Button>}
            </div>
          </div>
        )}
      </Modal>
      <Modal open={!!hist} onClose={() => setHist(null)} title="Allocation history" wide>
        <Table head={["When", "Action", "From → to", "Note"]}>
          {hist?.map((h) => <tr key={h.id}><Td className="whitespace-nowrap text-xs">{date(h.createdAt, true)}</Td><Td className="font-semibold">{h.action}</Td><Td className="text-xs">{h.fromStatus ?? "—"} → {h.toStatus ?? "—"}</Td><Td className="text-xs text-mute">{h.note}{h.serviceId && <> · <Link className="text-primary-dark" href={`/admin/services/${h.serviceId}`}>service</Link></>}</Td></tr>)}
        </Table>
      </Modal>
    </>
  );
}

function CidrModal({ open, onClose, servers, locs, onDone }: any) {
  const [v, setV] = useState({ cidr: "", gateway: "", serverId: "", locationId: "", vlan: "", notes: "", expand: true });
  return (
    <Modal open={open} onClose={onClose} title="Import CIDR range">
      <div className="space-y-4">
        <Field label="CIDR" hint="IPv4 ranges are expanded into individual addresses (network, broadcast and gateway excluded). IPv6 subnets are stored as a block."><Input value={v.cidr} onChange={(e) => setV({ ...v, cidr: e.target.value })} placeholder="103.145.12.0/26" /></Field>
        <Field label="Gateway" hint="Defaults to the first usable address"><Input value={v.gateway} onChange={(e) => setV({ ...v, gateway: e.target.value })} /></Field>
        <Field label="Server"><Select value={v.serverId} onChange={(e) => setV({ ...v, serverId: e.target.value })}><option value="">Unassigned</option>{servers.map((s: any) => <option key={s.id} value={s.id}>{s.name}</option>)}</Select></Field>
        <Field label="Location"><Select value={v.locationId} onChange={(e) => setV({ ...v, locationId: e.target.value })}><option value="">—</option>{locs.map((l: any) => <option key={l.id} value={l.id}>{l.name}</option>)}</Select></Field>
        <Field label="VLAN tag (optional)"><Input type="number" value={v.vlan} onChange={(e) => setV({ ...v, vlan: e.target.value })} /></Field>
        <Button className="w-full" onClick={() => api("/admin/ips/import-cidr", { body: { ...v, gateway: v.gateway || null, serverId: v.serverId || null, locationId: v.locationId || null, vlan: v.vlan ? Number(v.vlan) : null } }).then((r) => { toast.success(`Imported ${r.created} addresses${r.skipped ? ` (${r.skipped} already existed)` : ""}`); onClose(); onDone(); }).catch((e) => toast.error(e.message))}>Import</Button>
      </div>
    </Modal>
  );
}
function CsvModal({ open, onClose, servers, onDone }: any) {
  const [csv, setCsv] = useState("address,server,status,rdns,notes\n");
  const [serverId, setServerId] = useState("");
  const [res, setRes] = useState<any>(null);
  return (
    <Modal open={open} onClose={() => { setRes(null); onClose(); }} title="Import IPs from CSV" wide>
      <div className="space-y-4">
        <Field label="CSV" hint="Columns: address (required), server (name or id), status (AVAILABLE/BLOCKED/MAINTENANCE/QUARANTINED), rdns, notes"><Textarea rows={8} className="font-mono text-xs" value={csv} onChange={(e) => setCsv(e.target.value)} /></Field>
        <input type="file" accept=".csv,text/csv" onChange={(e) => { const file = e.target.files?.[0]; if (file) file.text().then(setCsv); }} className="text-sm" />
        <Field label="Default server for rows without one"><Select value={serverId} onChange={(e) => setServerId(e.target.value)}><option value="">None</option>{servers.map((s: any) => <option key={s.id} value={s.id}>{s.name}</option>)}</Select></Field>
        {res && <Alert tone={res.errors.length ? "warn" : "success"}>Imported {res.created}. {res.errors.slice(0, 8).map((e: any) => `Line ${e.line}: ${e.error}`).join(" · ")}</Alert>}
        <Button onClick={() => api("/admin/ips/import-csv", { body: { csv, serverId: serverId || null } }).then((r) => { setRes(r); onDone(); }).catch((e) => toast.error(e.message))}>Import</Button>
      </div>
    </Modal>
  );
}
function SingleModal({ open, onClose, servers, onDone }: any) {
  const [v, setV] = useState({ address: "", serverId: "", status: "AVAILABLE", notes: "" });
  return (
    <Modal open={open} onClose={onClose} title="Add IP address">
      <div className="space-y-4">
        <Field label="Address (IPv4 or IPv6)"><Input value={v.address} onChange={(e) => setV({ ...v, address: e.target.value.trim() })} /></Field>
        <Field label="Server"><Select value={v.serverId} onChange={(e) => setV({ ...v, serverId: e.target.value })}><option value="">—</option>{servers.map((s: any) => <option key={s.id} value={s.id}>{s.name}</option>)}</Select></Field>
        <Field label="Status"><Select value={v.status} onChange={(e) => setV({ ...v, status: e.target.value })}>{["AVAILABLE", "BLOCKED", "MAINTENANCE", "QUARANTINED"].map((s) => <option key={s}>{s}</option>)}</Select></Field>
        <Field label="Notes"><Input value={v.notes} onChange={(e) => setV({ ...v, notes: e.target.value })} /></Field>
        <Button onClick={() => api("/admin/ips", { body: { ...v, serverId: v.serverId || null } }).then(() => { toast.success("Added"); onClose(); onDone(); }).catch((e) => toast.error(e.message))}>Add</Button>
      </div>
    </Modal>
  );
}

/** Imports Virtualizor IP pools + addresses (free ones become AVAILABLE for customers to pick). */
function SyncIpsButton({ onDone }: { onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  return (
    <Button
      variant="outline"
      icon="sync"
      loading={busy}
      onClick={async () => {
        setBusy(true);
        try {
          const r = await api("/admin/virtualizor/all/sync-ips", { body: {} });
          for (const x of r.results) x.ok ? toast.success(`${x.serverName}: ${x.pools} pool(s), ${x.ips} IPs — ${x.available} free, ${x.used} in use`) : toast.error(`${x.serverName}: ${x.error}`);
          setTimeout(onDone, 1200);
        } catch (e: any) {
          toast.error(e.message);
        } finally {
          setBusy(false);
        }
      }}
    >
      Sync from Virtualizor
    </Button>
  );
}
