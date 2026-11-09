"use client";
import Link from "next/link";
import { useState } from "react";
import { ago } from "@/lib/api";
import { Badge, Card, Icon, Input, Loading, PageHeader, Pager, Select, Table, Td, useApi } from "@/components/ui";

export default function Tickets() {
  const depts = useApi("/admin/ticket-departments");
  const [f, setF] = useState({ status: "active", departmentId: "", priority: "", assigned: "", q: "" });
  const [page, setPage] = useState(1);
  const qs = new URLSearchParams({ page: String(page), ...Object.fromEntries(Object.entries(f).filter(([, v]) => v)) }).toString();
  const { data, loading } = useApi(`/admin/tickets?${qs}`, [qs]);
  return (
    <>
      <PageHeader title="Support tickets" />
      <div className="mb-4 grid gap-2 sm:grid-cols-2 xl:grid-cols-5">
        <Input className="h-10" placeholder="Search #, subject, email" value={f.q} onChange={(e) => setF({ ...f, q: e.target.value })} />
        <Select className="h-10" value={f.status} onChange={(e) => setF({ ...f, status: e.target.value })}><option value="active">Awaiting reply</option><option value="">All</option>{["OPEN", "CUSTOMER_REPLY", "ANSWERED", "IN_PROGRESS", "ON_HOLD", "CLOSED"].map((s) => <option key={s}>{s}</option>)}</Select>
        <Select className="h-10" value={f.departmentId} onChange={(e) => setF({ ...f, departmentId: e.target.value })}><option value="">All departments</option>{depts.data?.items?.map((d: any) => <option key={d.id} value={d.id}>{d.name}</option>)}</Select>
        <Select className="h-10" value={f.priority} onChange={(e) => setF({ ...f, priority: e.target.value })}><option value="">Any priority</option>{["URGENT", "HIGH", "MEDIUM", "LOW"].map((s) => <option key={s}>{s}</option>)}</Select>
        <Select className="h-10" value={f.assigned} onChange={(e) => setF({ ...f, assigned: e.target.value })}><option value="">Anyone</option><option value="me">Assigned to me</option><option value="none">Unassigned</option></Select>
      </div>
      <Card pad={false}>
        {loading ? <Loading /> : (
          <>
            <Table head={["Ticket", "Subject", "Customer", "Department", "Priority", "Status", "Assigned", "Last reply"]}>
              {data.tickets.map((t: any) => (
                <tr key={t.id} className="hover:bg-primary-tint">
                  <Td className="font-mono text-xs font-bold">#{t.number}</Td>
                  <Td><Link className="font-bold text-ink hover:text-primary-dark" href={`/admin/tickets/${t.id}`}>{t.subject}</Link>{t.slaBreached && <span className="ml-2 inline-flex items-center gap-0.5 text-[11px] font-bold text-rose-600"><Icon name="timer_off" className="text-[14px]" />SLA</span>}</Td>
                  <Td className="text-xs">{t.user.email}</Td>
                  <Td className="text-xs">{t.department.name}</Td>
                  <Td><Badge status={t.priority} /></Td>
                  <Td><Badge status={t.status} /></Td>
                  <Td className="text-xs">{t.assignedTo?.firstName ?? "—"}</Td>
                  <Td className="text-xs text-mute">{ago(t.lastReplyAt)}</Td>
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
