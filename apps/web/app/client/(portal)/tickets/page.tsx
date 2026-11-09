"use client";
import Link from "next/link";
import { date } from "@/lib/api";
import { Badge, Button, Card, Empty, Loading, PageHeader, Table, Td, useApi } from "@/components/ui";

export default function Tickets() {
  const { data, loading } = useApi("/client/tickets");
  return (
    <>
      <PageHeader title="Support Tickets" subtitle="Our team responds 24/7 — urgent tickets within the hour." actions={<Button href="/client/tickets/new" icon="add">Open ticket</Button>} />
      <Card pad={false}>
        {loading ? <Loading /> : !data?.tickets.length ? (
          <Empty icon="support_agent" title="No tickets yet"><Button href="/client/tickets/new" className="mt-4">Open a ticket</Button></Empty>
        ) : (
          <Table head={["Ticket", "Subject", "Department", "Status", "Last update"]}>
            {data.tickets.map((t: any) => (
              <tr key={t.id} className="hover:bg-primary-tint">
                <Td className="font-mono text-xs font-bold">#{t.number}</Td>
                <Td><Link href={`/client/tickets/${t.id}`} className="font-bold text-ink hover:text-primary-dark">{t.subject}</Link></Td>
                <Td className="text-mute">{t.department}</Td>
                <Td><Badge status={t.status} /></Td>
                <Td className="text-mute">{date(t.lastReplyAt, true)}</Td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
    </>
  );
}
