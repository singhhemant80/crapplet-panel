"use client";
import Link from "next/link";
import { Suspense, useState } from "react";
import { useSearchParams } from "next/navigation";
import { date, invNo, money } from "@/lib/api";
import { Badge, Card, Input, Loading, PageHeader, Pager, Select, Table, Td, useApi } from "@/components/ui";

function Invoices() {
  const sp = useSearchParams();
  const [status, setStatus] = useState(sp.get("status") ?? "");
  const [overdue, setOverdue] = useState("");
  const [q, setQ] = useState("");
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  const { data, loading } = useApi(`/admin/invoices?page=${page}&status=${status}&overdue=${overdue}&q=${encodeURIComponent(query)}`, [page, status, overdue, query]);
  return (
    <>
      <PageHeader title="Invoices" />
      <div className="mb-4 grid gap-3 sm:grid-cols-[1fr_180px_180px]">
        <form onSubmit={(e) => { e.preventDefault(); setQuery(q); setPage(1); }}><Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Invoice number or customer email" /></form>
        <Select value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }}><option value="">All statuses</option>{["UNPAID", "PAID", "CANCELLED", "REFUNDED"].map((s) => <option key={s}>{s}</option>)}</Select>
        <Select value={overdue} onChange={(e) => { setOverdue(e.target.value); setPage(1); }}><option value="">Any due date</option><option value="1">Overdue only</option></Select>
      </div>
      {data?.sums && <div className="mb-4 flex flex-wrap gap-6 text-sm text-mute"><span>Total <b className="text-ink">{money(data.sums.total)}</b></span><span>Collected <b className="text-ink">{money(data.sums.amountPaid)}</b></span><span>GST <b className="text-ink">{money(data.sums.taxTotal)}</b></span></div>}
      <Card pad={false}>
        {loading ? <Loading /> : (
          <>
            <Table head={["Invoice", "Customer", "Issued", "Due", "Total", "GST", "Status"]}>
              {data.invoices.map((i: any) => (
                <tr key={i.id} className="hover:bg-primary-tint">
                  <Td><Link href={`/admin/invoices/${i.id}`} className="font-bold text-ink hover:text-primary-dark">{invNo(i)}</Link>{i.isWalletTopup && <div className="text-xs text-mute">wallet top-up</div>}</Td>
                  <Td className="text-xs">{i.user.firstName} {i.user.lastName}<div className="text-mute">{i.user.email}</div></Td>
                  <Td className="text-mute">{date(i.issueDate)}</Td>
                  <Td className={i.status === "UNPAID" && new Date(i.dueDate) < new Date() ? "font-bold text-rose-600" : "text-mute"}>{date(i.dueDate)}</Td>
                  <Td className="font-semibold">{money(i.total)}</Td>
                  <Td className="text-xs text-mute">{money(i.taxTotal)}</Td>
                  <Td><Badge status={i.status} /></Td>
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
export default function Page() { return <Suspense><Invoices /></Suspense>; }
