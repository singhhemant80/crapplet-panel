"use client";
import Link from "next/link";
import { useState } from "react";
import { date, money } from "@/lib/api";
import { Badge, Card, Empty, Loading, PageHeader, Pager, Table, Td, useApi } from "@/components/ui";

export default function Payments() {
  const [page, setPage] = useState(1);
  const { data, loading } = useApi(`/client/transactions?page=${page}`, [page]);
  return (
    <>
      <PageHeader title="Payments" subtitle="Every payment, refund and credit applied to your account." />
      <Card pad={false}>
        {loading ? (
          <Loading />
        ) : !data?.transactions.length ? (
          <Empty icon="payments" title="No payments yet" />
        ) : (
          <>
            <Table head={["Date", "Method", "Reference", "Type", "Amount", "Invoice"]}>
              {data.transactions.map((t: any) => (
                <tr key={t.id}>
                  <Td className="text-mute">{date(t.createdAt, true)}</Td>
                  <Td className="font-semibold uppercase">{t.gateway}</Td>
                  <Td className="max-w-[220px] truncate font-mono text-xs">{t.gatewayTxnId}</Td>
                  <Td>
                    <Badge status={t.type === "REFUND" ? "REFUNDED" : "PAID"}>{t.type.replace("_", " ").toLowerCase()}</Badge>
                  </Td>
                  <Td className={t.type === "REFUND" ? "font-bold text-rose-600" : "font-bold text-ink"}>{money(t.amount, t.currency)}</Td>
                  <Td>{t.invoiceId && <Link className="font-bold text-primary-dark hover:underline" href={`/client/invoices/${t.invoiceId}`}>View</Link>}</Td>
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
