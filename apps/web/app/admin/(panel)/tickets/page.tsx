"use client";
import { DateRangeFilter, type Range } from "@/components/admin/date-range";
import Link from "next/link";
import { useEffect, useState } from "react";
import { ago, api } from "@/lib/api";
import { Badge, Button, Card, Icon, Input, Loading, PageHeader, Pager, Select, Table, Td, cx, toast, useApi } from "@/components/ui";

const STATUSES = ["OPEN", "CUSTOMER_REPLY", "ANSWERED", "IN_PROGRESS", "ON_HOLD", "CLOSED"];
const label = (s: string) => s.charAt(0) + s.slice(1).toLowerCase().replace(/_/g, " ");

export default function Tickets() {
  const depts = useApi("/admin/ticket-departments");
  const staff = useApi("/admin/ticket-assignees");
  const [f, setF] = useState({ status: "active", departmentId: "", priority: "", assigned: "", q: "" });
  const [range, setRange] = useState<Range>({ from: "", to: "" });
  const [page, setPage] = useState(1);
  const qs = new URLSearchParams({ page: String(page), ...Object.fromEntries(Object.entries(f).filter(([, v]) => v)), ...(range.from && { from: range.from }), ...(range.to && { to: range.to }) }).toString();
  const { data, loading, reload } = useApi(`/admin/tickets?${qs}`, [qs]);
  const [sel, setSel] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  useEffect(() => setSel([]), [qs]);

  const rows: any[] = data?.tickets ?? [];
  const allOnPage = rows.length > 0 && rows.every((t) => sel.includes(t.id));
  const toggle = (id: string) => setSel((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));

  async function bulk(change: Record<string, unknown>, what: string) {
    if (!sel.length) return;
    if (change.status === "CLOSED" && !confirm(`Close ${sel.length} ticket${sel.length === 1 ? "" : "s"}?`)) return;
    setBusy(true);
    try {
      const r = await api("/admin/tickets/bulk", { body: { ids: sel, ...change } });
      toast.success(`${what}: ${r.updated} ticket${r.updated === 1 ? "" : "s"}${r.skipped ? ` (${r.skipped} already done)` : ""}`);
      setSel([]);
      reload();
    } catch (e: any) {
      toast.error(e.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <PageHeader title="Support tickets" />
      <div className="mb-4 grid gap-2 sm:grid-cols-2 xl:grid-cols-6">
        <Input className="h-10" placeholder="Search #, subject, email" value={f.q} onChange={(e) => setF({ ...f, q: e.target.value })} />
        <Select className="h-10" value={f.status} onChange={(e) => setF({ ...f, status: e.target.value })}><option value="active">Awaiting reply</option><option value="">All</option>{STATUSES.map((s) => <option key={s} value={s}>{label(s)}</option>)}</Select>
        <Select className="h-10" value={f.departmentId} onChange={(e) => setF({ ...f, departmentId: e.target.value })}><option value="">All departments</option>{depts.data?.items?.map((d: any) => <option key={d.id} value={d.id}>{d.name}</option>)}</Select>
        <Select className="h-10" value={f.priority} onChange={(e) => setF({ ...f, priority: e.target.value })}><option value="">Any priority</option>{["URGENT", "HIGH", "MEDIUM", "LOW"].map((s) => <option key={s} value={s}>{label(s)}</option>)}</Select>
        <Select className="h-10" value={f.assigned} onChange={(e) => setF({ ...f, assigned: e.target.value })}><option value="">Anyone</option><option value="me">Assigned to me</option><option value="none">Unassigned</option></Select>
        <DateRangeFilter value={range} onChange={(r) => { setRange(r); setPage(1); }} label="Opened any time" />
      </div>

      {sel.length > 0 && (
        <div className="sticky top-2 z-20 mb-3 flex flex-wrap items-center gap-2 rounded-2xl bg-ink px-4 py-3 text-white shadow-lg">
          <span className="mr-1 text-sm font-bold">{sel.length} selected</span>
          <button onClick={() => setSel([])} className="mr-2 text-xs font-semibold text-white/70 hover:text-white hover:underline">Clear</button>
          <Button size="sm" icon="task_alt" loading={busy} onClick={() => bulk({ status: "CLOSED" }, "Closed")}>Close</Button>
          <BulkSelect disabled={busy} label="Status" onPick={(v) => bulk({ status: v }, `Set to ${label(v)}`)} options={STATUSES.filter((s) => s !== "CLOSED").map((s) => [s, label(s)])} />
          <BulkSelect disabled={busy} label="Priority" onPick={(v) => bulk({ priority: v }, `Priority ${label(v)}`)} options={["URGENT", "HIGH", "MEDIUM", "LOW"].map((s) => [s, label(s)])} />
          <BulkSelect disabled={busy} label="Assign to" onPick={(v) => bulk({ assignedToId: v === "none" ? null : v }, v === "none" ? "Unassigned" : "Assigned")} options={[["none", "Nobody"], ...(staff.data?.staff ?? []).map((u: any) => [u.id, `${u.firstName ?? ""} ${u.lastName ?? ""}`.trim() || u.email])]} />
          <BulkSelect disabled={busy} label="Department" onPick={(v) => bulk({ departmentId: v }, "Moved")} options={(depts.data?.items ?? []).map((d: any) => [d.id, d.name])} />
        </div>
      )}

      <Card pad={false}>
        {loading ? <Loading /> : (
          <>
            <Table
              empty={rows.length === 0 ? <div className="px-5 py-10 text-center text-sm text-mute">No tickets match these filters.</div> : null}
              head={[
                <input key="all" type="checkbox" aria-label="Select all on this page" className="h-4 w-4 accent-primary" checked={allOnPage} onChange={() => setSel(allOnPage ? sel.filter((id) => !rows.some((t) => t.id === id)) : [...new Set([...sel, ...rows.map((t) => t.id)])])} />,
                "Ticket", "Subject", "Customer", "Department", "Priority", "Status", "Assigned", "Last reply",
              ]}
            >
              {rows.map((t: any) => (
                <tr key={t.id} className={cx("hover:bg-primary-tint", sel.includes(t.id) && "bg-primary-tint/70")}>
                  <Td className="w-10"><input type="checkbox" aria-label={`Select #${t.number}`} className="h-4 w-4 accent-primary" checked={sel.includes(t.id)} onChange={() => toggle(t.id)} /></Td>
                  <Td className="whitespace-nowrap font-mono text-xs font-bold">#{t.number}</Td>
                  <Td><Link className="font-bold text-ink hover:text-primary-dark" href={`/admin/tickets/${t.id}`}>{t.subject}</Link>{t.slaBreached && <span className="ml-2 inline-flex items-center gap-0.5 whitespace-nowrap text-[11px] font-bold text-rose-600"><Icon name="timer_off" className="text-[14px]" />SLA</span>}</Td>
                  <Td className="text-xs">{t.user.email}</Td>
                  <Td className="text-xs">{t.department.name}</Td>
                  <Td><Badge status={t.priority} /></Td>
                  <Td><Badge status={t.status} /></Td>
                  <Td className="text-xs">{t.assignedTo?.firstName ?? "—"}</Td>
                  <Td className="whitespace-nowrap text-xs text-mute">{ago(t.lastReplyAt)}</Td>
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

/** A compact dropdown in the bulk bar: picking an option applies it to every selected ticket. */
function BulkSelect({ label, options, onPick, disabled }: { label: string; options: string[][]; onPick: (v: string) => void; disabled?: boolean }) {
  return (
    <select
      disabled={disabled}
      value=""
      onChange={(e) => e.target.value && onPick(e.target.value)}
      className="h-9 rounded-lg border-0 bg-white/10 px-3 text-sm font-semibold text-white outline-none ring-1 ring-white/20 hover:bg-white/15 focus:ring-2 focus:ring-white/50 [&>option]:text-ink"
    >
      <option value="">{label}…</option>
      {options.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
    </select>
  );
}
