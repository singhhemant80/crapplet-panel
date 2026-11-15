"use client";
import { useState } from "react";
import { date } from "@/lib/api";
import { Card, Input, Loading, PageHeader, Pager, Select, Table, Td, useApi } from "@/components/ui";
import { DateRangeFilter, rangeQs, type Range } from "@/components/admin/date-range";

/** Areas of the panel, by action prefix. */
const AREAS: [string, string][] = [
  ["", "All actions"], ["auth.", "Sign-ins & security"], ["client.", "Customers"], ["service.", "Services"], ["invoice.", "Invoices"], ["payment.", "Payments"], ["credit.", "Credit"],
  ["order.", "Orders"], ["ticket.", "Tickets"], ["domain.", "Domains"], ["server.", "Servers"], ["settings.", "Settings"], ["staff.", "Staff"], ["billing.", "Billing tools"], ["reseller.", "Resellers"],
];

export default function Activity() {
  const [page, setPage] = useState(1);
  const [q, setQ] = useState("");
  const [query, setQuery] = useState("");
  const [action, setAction] = useState("");
  const [actor, setActor] = useState("");
  const [range, setRange] = useState<Range>({ from: "", to: "" });
  const qs = [`page=${page}`, "pageSize=50", query && `q=${encodeURIComponent(query)}`, action && `action=${encodeURIComponent(action)}`, actor && `actor=${actor}`, rangeQs(range)].filter(Boolean).join("&");
  const { data, loading } = useApi(`/admin/activity?${qs}`, [qs]);
  const reset = (fn: () => void) => { fn(); setPage(1); };
  return (
    <>
      <PageHeader title="Activity log" subtitle="Audit trail of staff and system actions." />
      <div className="mb-4 grid gap-2 md:grid-cols-2 xl:grid-cols-[1.3fr_190px_190px_1.3fr]">
        <form onSubmit={(e) => { e.preventDefault(); reset(() => setQuery(q.trim())); }}><Input className="h-10" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Action, customer email, IP or record id" /></form>
        <Select className="h-10" value={action} onChange={(e) => reset(() => setAction(e.target.value))}>{AREAS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</Select>
        <Select className="h-10" value={actor} onChange={(e) => reset(() => setActor(e.target.value))}>
          <option value="">Anyone</option><option value="staff">Any staff member</option><option value="system">System & customers</option>
          {(data?.staff ?? []).map((u: any) => <option key={u.id} value={u.id}>{u.name}</option>)}
        </Select>
        <DateRangeFilter value={range} onChange={(r) => reset(() => setRange(r))} />
      </div>
      <Card pad={false}>
        {loading && !data ? <Loading /> : (
          <>
            <Table head={["Time", "Action", "By", "Entity", "Customer", "IP", "Details"]} empty={!data.items.length ? <div className="px-5 py-10 text-center text-sm text-mute">Nothing matches these filters.</div> : null}>
              {data.items.map((a: any) => <tr key={a.id}><Td className="whitespace-nowrap text-xs text-mute">{date(a.createdAt, true)}</Td><Td className="font-semibold">{a.action}</Td><Td className="whitespace-nowrap text-xs">{a.actorName ?? <span className="text-mute">System</span>}</Td><Td className="text-xs">{a.entity} {a.entityId?.slice(-8)}</Td><Td className="text-xs">{a.user?.email ?? "—"}</Td><Td className="font-mono text-xs">{a.ip}</Td><Td className="max-w-[320px] truncate font-mono text-[11px] text-mute">{a.details ? JSON.stringify(a.details) : ""}</Td></tr>)}
            </Table>
            <Pager page={data.page} pageSize={data.pageSize} total={data.total} onPage={setPage} />
          </>
        )}
      </Card>
    </>
  );
}
