"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { Alert, Badge, Button, Card, Empty, Loading, PageHeader, Select, Table, Td, toast, useApi } from "@/components/ui";

const gbOf = (b: number) => `${Math.round(b / 1073741824)} GB`;

export default function Proxmox() {
  const servers = useApi("/admin/servers");
  const list = (servers.data?.servers ?? []).filter((s: any) => s.type === "PROXMOX");
  const [sid, setSid] = useState("");
  const [data, setData] = useState<any>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  useEffect(() => { if (list.length && !sid) setSid(list[0].id); }, [list, sid]);
  const load = () => { if (!sid) return; setLoading(true); setErr(null); api(`/admin/proxmox/${sid}/overview`).then(setData).catch((e) => { setErr(e.message); setData(null); }).finally(() => setLoading(false)); };
  useEffect(load, [sid]); // eslint-disable-line react-hooks/exhaustive-deps

  const guest = (v: any, action: string, extra: Record<string, unknown> = {}) =>
    api(`/admin/proxmox/${sid}/guest/${action}`, { body: { node: v.node, kind: v.type, vmid: v.vmid, ...extra } }).then((r) => { toast.success(r.snapshots ? `${r.snapshots.length} snapshots: ${r.snapshots.map((s: any) => s.name).join(", ")}` : r.backups ? `${r.backups.length} backups` : `${action} done`); load(); }).catch((e) => toast.error(e.message));

  return (
    <>
      <PageHeader title="Proxmox VE" subtitle="Cluster nodes, storage and every guest — linked to billing where possible." actions={<><Select className="w-64" value={sid} onChange={(e) => setSid(e.target.value)}>{list.map((s: any) => <option key={s.id} value={s.id}>{s.name}</option>)}</Select><Button variant="outline" icon="refresh" onClick={load}>Refresh</Button></>} />
      {!list.length && !servers.loading && <Card><Empty icon="hub" title="No Proxmox servers yet"><Link href="/admin/servers" className="font-bold text-primary-dark">Add one under Servers</Link></Empty></Card>}
      {err && <Alert tone="error">{err}</Alert>}
      {loading && <Loading />}
      {data && !loading && (
        <>
          <div className="mb-6 grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {data.nodes.map((n: any) => (
              <Card key={n.node}>
                <div className="flex items-center justify-between"><b className="text-ink">{n.node}</b><Badge status={n.status === "online" ? "ACTIVE" : "FAILED"}>{n.status}</Badge></div>
                <div className="mt-3 space-y-2 text-xs">
                  {[["CPU", n.cpu * 100, `${n.maxcpu} cores`], ["RAM", (n.mem / n.maxmem) * 100, `${gbOf(n.mem)} / ${gbOf(n.maxmem)}`], ["Root disk", (n.disk / n.maxdisk) * 100, `${gbOf(n.disk)} / ${gbOf(n.maxdisk)}`]].map(([l, p, h]: any) => (
                    <div key={l}><div className="flex justify-between text-mute"><span>{l}</span><span>{h}</span></div><div className="mt-1 h-2 overflow-hidden rounded-full bg-slate-100"><div className={`h-full rounded-full ${p > 85 ? "bg-rose-500" : p > 65 ? "bg-amber-400" : "bg-primary"}`} style={{ width: `${Math.min(100, p)}%` }} /></div></div>
                  ))}
                </div>
              </Card>
            ))}
          </div>
          <Card title={`Storage · PVE ${data.version?.version ?? ""}`} className="mb-6" pad={false}>
            <Table head={["Storage", "Node", "Used", "Total", "Usage"]}>
              {data.storage.map((s: any) => <tr key={s.id}><Td className="font-bold">{s.storage}</Td><Td>{s.node}</Td><Td>{gbOf(s.disk ?? 0)}</Td><Td>{gbOf(s.maxdisk ?? 0)}</Td><Td>{s.maxdisk ? Math.round(((s.disk ?? 0) / s.maxdisk) * 100) : 0}%</Td></tr>)}
            </Table>
          </Card>
          <Card title={`Guests (${data.vms.length})`} pad={false}>
            <Table head={["VMID", "Name", "Node", "Type", "Status", "Billing", "Actions"]}>
              {data.vms.sort((a: any, b: any) => a.vmid - b.vmid).map((v: any) => (
                <tr key={v.id}>
                  <Td className="font-mono font-bold">{v.vmid}</Td>
                  <Td>{v.name}{v.template ? <span className="ml-1 text-xs text-mute">(template)</span> : null}</Td>
                  <Td>{v.node}</Td>
                  <Td className="uppercase">{v.type}</Td>
                  <Td><Badge status={v.status} /></Td>
                  <Td>{v.service ? <Link className="text-xs font-bold text-primary-dark" href={`/admin/services/${v.service.id}`}>{v.service.user.email}</Link> : <span className="text-xs text-mute">unlinked</span>}</Td>
                  <Td className="whitespace-nowrap">
                    {!v.template && <Select className="h-8 w-40 text-xs" defaultValue="" onChange={(e) => {
                      const a = e.target.value; e.target.value = "";
                      if (!a) return;
                      if (a === "migrate") { const target = prompt("Target node", data.nodes.find((n: any) => n.node !== v.node)?.node ?? ""); if (target) guest(v, "migrate", { target }); }
                      else if (a === "snapshot") { const name = prompt("Snapshot name", `snap${new Date().toISOString().slice(0, 10).replace(/-/g, "")}`); if (name) guest(v, "snapshot", { snapname: name }); }
                      else if (a === "rollback") { const name = prompt("Snapshot name to roll back to"); if (name && confirm(`Roll back ${v.vmid} to ${name}?`)) guest(v, "rollback", { snapname: name }); }
                      else if (a === "backup") { const storage = prompt("Backup storage", "local"); if (storage) guest(v, "backup", { storage }); }
                      else if (a === "clone") { const name = prompt("Clone name", `clone-${v.vmid}`); if (name) guest(v, "clone", { name }); }
                      else if (["stop", "reboot", "shutdown"].includes(a) ? confirm(`${a} ${v.vmid}?`) : true) guest(v, a);
                    }}>
                      <option value="">Actions…</option>
                      <option value="start">Start</option><option value="shutdown">Shutdown</option><option value="reboot">Reboot</option><option value="stop">Stop</option>
                      <option value="snapshots">List snapshots</option><option value="snapshot">Snapshot</option><option value="rollback">Rollback</option>
                      <option value="backup">Backup now</option><option value="backups">List backups</option><option value="migrate">Migrate</option><option value="clone">Clone</option>
                    </Select>}
                  </Td>
                </tr>
              ))}
            </Table>
          </Card>
        </>
      )}
    </>
  );
}
