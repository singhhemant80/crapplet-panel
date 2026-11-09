"use client";
import Link from "next/link";
import { Suspense, useState } from "react";
import { useSearchParams } from "next/navigation";
import { date, money } from "@/lib/api";
import { Badge, Card, Input, Loading, PageHeader, Pager, Select, Table, Td, useApi } from "@/components/ui";

function Services() {
  const sp = useSearchParams();
  const [status, setStatus] = useState(sp.get("status") ?? "");
  const [vps, setVps] = useState(sp.get("vps") ?? "");
  const [q, setQ] = useState("");
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  const { data, loading } = useApi(`/admin/services?page=${page}&status=${status}&vps=${vps}&q=${encodeURIComponent(query)}`, [page, status, vps, query]);
  return (
    <>
      <PageHeader title="VPS & Services" subtitle="Every customer service. Open a VPS to run power actions, reinstall or suspend." />
      <div className="mb-4 grid gap-3 sm:grid-cols-[1fr_180px_180px]">
        <form onSubmit={(e) => { e.preventDefault(); setPage(1); setQuery(q); }}><Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Hostname, IP, VMID or customer email" /></form>
        <Select value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }}><option value="">All statuses</option>{["PENDING", "PROVISIONING", "ACTIVE", "SUSPENDED", "FAILED", "TERMINATED", "CANCELLED"].map((s) => <option key={s}>{s}</option>)}</Select>
        <Select value={vps} onChange={(e) => { setVps(e.target.value); setPage(1); }}><option value="">All products</option><option value="1">VPS only</option></Select>
      </div>
      <Card pad={false}>
        {loading ? <Loading /> : (
          <>
            <Table head={["Service", "Customer", "IP", "Server / VMID", "Status", "Recurring", "Next due"]}>
              {data.services.map((s: any) => (
                <tr key={s.id} className="hover:bg-primary-tint">
                  <Td><Link href={`/admin/services/${s.id}`} className="font-bold text-ink hover:text-primary-dark">{s.product.name}</Link><div className="text-xs text-mute">{s.hostname}</div></Td>
                  <Td><Link href={`/admin/clients/${s.user.id}`} className="text-sm text-primary-dark">{s.user.email}</Link></Td>
                  <Td className="font-mono text-xs">{s.ips.map((i: any) => i.address).join(", ") || "—"}</Td>
                  <Td className="text-xs">{s.server?.name ?? "—"}{s.remoteId && <div className="text-mute">{s.node ? `${s.node} · ` : ""}#{s.remoteId}</div>}</Td>
                  <Td><Badge status={s.status} /></Td>
                  <Td>{money(s.recurringAmount)}</Td>
                  <Td className="whitespace-nowrap text-mute">{date(s.nextDueDate)}</Td>
                </tr>
              ))}
            </Table>
            <Pager page={data.page} pageSize={data.pageSize} total={data.total} onPage={setPage} />
          </>
        )}
      </Card>
    </>
  );
}
export default function Page() { return <Suspense><Services /></Suspense>; }
