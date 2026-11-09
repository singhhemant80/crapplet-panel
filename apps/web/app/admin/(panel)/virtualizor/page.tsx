"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { Alert, Button, Card, Empty, Loading, PageHeader, Select, Table, Td, useApi } from "@/components/ui";

export default function Virtualizor() {
  const servers = useApi("/admin/servers");
  const list = (servers.data?.servers ?? []).filter((s: any) => s.type === "VIRTUALIZOR");
  const [sid, setSid] = useState("");
  const [data, setData] = useState<any>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => { if (list.length && !sid) setSid(list[0].id); }, [list, sid]);
  const load = () => { if (sid) api(`/admin/virtualizor/${sid}/overview`).then((d) => { setData(d); setErr(null); }).catch((e) => setErr(e.message)); };
  useEffect(load, [sid]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <>
      <PageHeader title="Virtualizor" subtitle="VPS on your Virtualizor panels; link unlinked VPS to customers from VPS & Services." actions={<><Select className="w-64" value={sid} onChange={(e) => setSid(e.target.value)}>{list.map((s: any) => <option key={s.id} value={s.id}>{s.name}</option>)}</Select><Button variant="outline" icon="refresh" onClick={load}>Refresh</Button></>} />
      {!list.length && !servers.loading && <Card><Empty icon="lan" title="No Virtualizor servers yet"><Link href="/admin/servers" className="font-bold text-primary-dark">Add one under Servers</Link></Empty></Card>}
      {err && <Alert tone="error">{err}</Alert>}
      {sid && !data && !err && <Loading />}
      {data && (
        <>
          <Card title={`VPS (${data.vps.length})`} pad={false} className="mb-6">
            <Table head={["VPS id", "Hostname", "IPs", "OS", "RAM", "Billing"]}>
              {data.vps.map((v: any) => <tr key={v.vpsid}><Td className="font-mono font-bold">{v.vpsid}</Td><Td>{v.hostname}</Td><Td className="font-mono text-xs">{Object.values(v.ips ?? {}).join(", ")}</Td><Td>{v.os_name}</Td><Td>{v.ram} MB</Td><Td>{v.service ? <Link className="text-xs font-bold text-primary-dark" href={`/admin/services/${v.service.id}`}>{v.service.user.email}</Link> : <span className="text-xs text-mute">unlinked</span>}</Td></tr>)}
            </Table>
          </Card>
          <Card title="Plans" pad={false}><Table head={["Plan id", "Name", "RAM", "Disk", "Cores"]}>{data.plans.map((p: any) => <tr key={p.plid}><Td>{p.plid}</Td><Td className="font-bold">{p.plan_name}</Td><Td>{p.ram} MB</Td><Td>{p.space} GB</Td><Td>{p.cores}</Td></tr>)}</Table></Card>
        </>
      )}
    </>
  );
}
