"use client";
import { useParams } from "next/navigation";
import { useEffect, useState } from "react";
import { api, date } from "@/lib/api";
import { Badge, Button, Card, Field, Input, Loading, PageHeader, Select, Table, Td, Toggle, toast, useApi } from "@/components/ui";

export default function DomainPage() {
  const { id } = useParams<{ id: string }>();
  const { data, loading, reload } = useApi(`/client/domains/${id}`);
  const [ns, setNs] = useState<string[]>([]);
  const [rec, setRec] = useState({ type: "A", name: "@", content: "", ttl: 3600, priority: "" });
  useEffect(() => {
    if (data?.domain) setNs([...data.domain.nameservers, "", ""].slice(0, Math.max(4, data.domain.nameservers.length)));
  }, [data]);
  if (loading || !data) return <Loading />;
  const d = data.domain;
  const save = (p: string, body: unknown, msg: string) => api(`/client/domains/${id}${p}`, { method: "PUT", body }).then(() => { toast.success(msg); reload(); }).catch((e) => toast.error(e.message));
  return (
    <>
      <PageHeader back="/client/domains" title={<span className="flex items-center gap-3">{d.name} <Badge status={d.status} /></span>} subtitle={`Expires ${date(d.expiryDate)}`} />
      <div className="grid gap-6 lg:grid-cols-2">
        <Card title="Nameservers">
          <div className="space-y-3">
            {ns.map((n, i) => (
              <Field key={i} label={`Nameserver ${i + 1}`}>
                <Input value={n} onChange={(e) => setNs(ns.map((x, j) => (j === i ? e.target.value : x)))} placeholder={i < 2 ? "required" : "optional"} />
              </Field>
            ))}
            <Button onClick={() => save("/nameservers", { nameservers: ns.filter(Boolean) }, "Nameservers updated")}>Save nameservers</Button>
          </div>
        </Card>
        <Card title="Settings">
          <div className="space-y-4">
            <Toggle checked={d.locked} onChange={(v) => save("/lock", { locked: v }, v ? "Registrar lock enabled" : "Registrar lock disabled")} label="Registrar lock (prevents unauthorised transfers)" />
            <Toggle checked={d.autoRenew} onChange={(v) => save("/autorenew", { autoRenew: v }, "Auto-renew updated")} label="Auto-renew" />
          </div>
        </Card>
      </div>
      <Card title="DNS records" className="mt-6" pad={false}>
        <div className="grid gap-3 border-b border-line p-5 sm:grid-cols-[110px_1fr_2fr_100px_auto]">
          <Select value={rec.type} onChange={(e) => setRec({ ...rec, type: e.target.value })}>
            {["A", "AAAA", "CNAME", "MX", "TXT", "NS", "SRV", "CAA"].map((t) => <option key={t}>{t}</option>)}
          </Select>
          <Input value={rec.name} onChange={(e) => setRec({ ...rec, name: e.target.value })} placeholder="@ or www" />
          <Input value={rec.content} onChange={(e) => setRec({ ...rec, content: e.target.value })} placeholder="Value" />
          <Input type="number" value={rec.ttl} onChange={(e) => setRec({ ...rec, ttl: Number(e.target.value) })} />
          <Button onClick={() => api(`/client/domains/${id}/dns`, { body: { ...rec, priority: rec.priority ? Number(rec.priority) : null } }).then(() => { setRec({ ...rec, content: "" }); reload(); }).catch((e) => toast.error(e.message))}>Add</Button>
        </div>
        <Table head={["Type", "Name", "Value", "TTL", ""]}>
          {d.dnsRecords.map((r: any) => (
            <tr key={r.id}>
              <Td className="font-bold">{r.type}</Td>
              <Td>{r.name}</Td>
              <Td className="max-w-[320px] truncate font-mono text-xs">{r.content}</Td>
              <Td>{r.ttl}</Td>
              <Td className="text-right"><button className="text-sm font-bold text-rose-600" onClick={() => api(`/client/domains/${id}/dns/${r.id}`, { method: "DELETE" }).then(reload)}>Delete</button></Td>
            </tr>
          ))}
        </Table>
      </Card>
    </>
  );
}
