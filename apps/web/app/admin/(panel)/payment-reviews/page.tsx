"use client";
import Link from "next/link";
import { useState } from "react";
import { api, date, invNo, money } from "@/lib/api";
import { Badge, Button, Card, Empty, Input, Loading, PageHeader, Select, Table, Td, toast, useApi } from "@/components/ui";
import { DateRangeFilter, rangeQs, type Range } from "@/components/admin/date-range";

export default function Reviews() {
  const [status, setStatus] = useState("");
  const [q, setQ] = useState("");
  const [query, setQuery] = useState("");
  const [range, setRange] = useState<Range>({ from: "", to: "" });
  const qs = [status && `status=${status}`, query && `q=${encodeURIComponent(query)}`, rangeQs(range)].filter(Boolean).join("&");
  const { data, loading, reload } = useApi(`/admin/payment-reviews${qs ? `?${qs}` : ""}`, [qs]);
  const act = (id: string, approve: boolean) => {
    const note = approve ? undefined : prompt("Reason for rejection") ?? undefined;
    api(`/admin/payment-reviews/${id}`, { body: { approve, note } }).then(() => { toast.success(approve ? "Approved — invoice updated and services activated" : "Rejected"); reload(); }).catch((e) => toast.error(e.message));
  };
  return (
    <>
      <PageHeader title="Payment reviews" subtitle="UPI / bank transfer references submitted by customers. Match the UTR against your bank statement before approving." />
      <div className="mb-4 grid gap-2 md:grid-cols-[1.2fr_200px_1.3fr]">
        <form onSubmit={(e) => { e.preventDefault(); setQuery(q.trim()); }}><Input className="h-10" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Customer email" /></form>
        <Select className="h-10" value={status} onChange={(e) => setStatus(e.target.value)}><option value="">Waiting for review</option><option value="PAID">Approved</option><option value="REJECTED">Rejected</option><option value="all">All</option></Select>
        <DateRangeFilter value={range} onChange={setRange} />
      </div>
      <Card pad={false}>
        {loading && !data ? <Loading /> : !data.intents.length ? <Empty icon="fact_check" title={status || query || range.from || range.to ? "Nothing matches these filters" : "Nothing to review"} /> : (
          <Table head={["Submitted", "Customer", "Invoice", "Method", "UTR / reference", "Amount", ""]}>
            {data.intents.map((p: any) => (
              <tr key={p.id}>
                <Td className="whitespace-nowrap text-xs text-mute">{date(p.updatedAt, true)}</Td>
                <Td className="text-sm">{p.user.firstName} {p.user.lastName}<div className="text-xs text-mute">{p.user.email}</div></Td>
                <Td><Link className="font-bold text-primary-dark" href={`/admin/invoices/${p.invoice.id}`}>{invNo(p.invoice)}</Link></Td>
                <Td className="uppercase">{p.gateway}</Td>
                <Td className="font-mono font-bold">{p.reference}</Td>
                <Td className="font-bold">{money(p.amount, p.currency)}</Td>
                <Td className="whitespace-nowrap text-right">{p.status !== "PENDING_REVIEW" ? <Badge status={p.status === "PAID" ? "APPROVED" : p.status} /> : <><Button size="sm" onClick={() => confirm(`Confirm ₹${p.amount / 100} received with reference ${p.reference}?`) && act(p.id, true)}>Approve</Button><button className="ml-3 text-sm font-bold text-rose-600" onClick={() => act(p.id, false)}>Reject</button></>}</Td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
    </>
  );
}
