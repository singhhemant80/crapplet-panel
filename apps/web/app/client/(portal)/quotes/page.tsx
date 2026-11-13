"use client";
import Link from "next/link";
import { date, money } from "@/lib/api";
import { Badge, Card, Empty, Loading, PageHeader, Table, Td, useApi } from "@/components/ui";

export default function Quotes() {
  const { data, loading } = useApi("/client/quotes");
  return (
    <>
      <PageHeader title="Quotes" subtitle="Custom offers prepared for you. Accept one and we'll raise the invoice straight away." />
      <Card pad={false}>
        {loading ? <Loading /> : !data?.quotes.length ? <Empty icon="request_quote" title="No quotes yet">Need a custom server or a bulk deal? Open a ticket and we'll send you a quote.</Empty> : (
          <Table head={["Quote", "Date", "Valid until", "Total", "Status", ""]}>
            {data.quotes.map((q: any) => {
              const open = q.status === "SENT" && new Date(q.validUntil) >= new Date();
              return (
                <tr key={q.id} className="hover:bg-primary-tint">
                  <Td><Link href={`/client/quotes/${q.id}`} className="font-bold text-ink hover:text-primary-dark">{q.number}</Link><div className="max-w-xs truncate text-xs text-mute">{q.subject}</div></Td>
                  <Td className="whitespace-nowrap text-mute">{date(q.createdAt)}</Td>
                  <Td className="whitespace-nowrap text-mute">{date(q.validUntil)}</Td>
                  <Td className="font-semibold">{money(q.total, q.currency)}</Td>
                  <Td><Badge status={q.status === "SENT" ? "PENDING" : q.status}>{q.status === "SENT" ? "awaiting you" : q.status === "INVOICED" ? "accepted" : undefined}</Badge></Td>
                  <Td className="text-right"><Link href={`/client/quotes/${q.id}`} className="text-sm font-bold text-primary-dark">{open ? "Review" : "View"} →</Link></Td>
                </tr>
              );
            })}
          </Table>
        )}
      </Card>
    </>
  );
}
