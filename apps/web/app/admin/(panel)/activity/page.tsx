"use client";
import { useState } from "react";
import { date } from "@/lib/api";
import { Card, Loading, PageHeader, Pager, Table, Td, useApi } from "@/components/ui";

export default function Activity() {
  const [page, setPage] = useState(1);
  const { data, loading } = useApi(`/admin/activity?page=${page}&pageSize=50`, [page]);
  return (
    <>
      <PageHeader title="Activity log" subtitle="Audit trail of staff and system actions." />
      <Card pad={false}>
        {loading ? <Loading /> : (
          <>
            <Table head={["Time", "Action", "Entity", "Customer", "IP", "Details"]}>
              {data.items.map((a: any) => <tr key={a.id}><Td className="whitespace-nowrap text-xs text-mute">{date(a.createdAt, true)}</Td><Td className="font-semibold">{a.action}</Td><Td className="text-xs">{a.entity} {a.entityId?.slice(-8)}</Td><Td className="text-xs">{a.user?.email ?? "—"}</Td><Td className="font-mono text-xs">{a.ip}</Td><Td className="max-w-[320px] truncate font-mono text-[11px] text-mute">{a.details ? JSON.stringify(a.details) : ""}</Td></tr>)}
            </Table>
            <Pager page={data.page} pageSize={data.pageSize} total={data.total} onPage={setPage} />
          </>
        )}
      </Card>
    </>
  );
}
