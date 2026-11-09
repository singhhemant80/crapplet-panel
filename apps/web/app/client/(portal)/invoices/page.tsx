"use client";
import Link from "next/link";
import { Suspense, useState } from "react";
import { useSearchParams } from "next/navigation";
import { date, invNo, money } from "@/lib/api";
import { Badge, Card, Empty, Loading, PageHeader, Pager, Table, Td, cx, useApi } from "@/components/ui";

function Invoices() {
  const sp = useSearchParams();
  const status = sp.get("status") ?? "";
  const [page, setPage] = useState(1);
  const { data, loading } = useApi(`/client/invoices?page=${page}${status ? `&status=${status}` : ""}`, [status, page]);
  return (
    <>
      <PageHeader title="Invoices" subtitle="GST tax invoices are issued when an invoice is paid." />
      <div className="mb-4 flex gap-2 overflow-x-auto">
        {[["", "All"], ["UNPAID", "Unpaid"], ["PAID", "Paid"], ["CANCELLED", "Cancelled"]].map(([k, l]) => (
          <Link key={k} href={k ? `/client/invoices?status=${k}` : "/client/invoices"} className={cx("rounded-full px-4 py-2 text-sm font-bold", status === k ? "bg-primary-dark text-white" : "bg-white text-slate-600 ring-1 ring-line")}>
            {l}
          </Link>
        ))}
      </div>
      <Card pad={false}>
        {loading ? (
          <Loading />
        ) : !data?.invoices.length ? (
          <Empty icon="receipt_long" title="No invoices" />
        ) : (
          <>
            <Table head={["Invoice", "Date", "Due", "Total", "Status", ""]}>
              {data.invoices.map((i: any) => (
                <tr key={i.id} className="hover:bg-primary-tint">
                  <Td className="font-bold text-ink">
                    {invNo(i)}
                    {i.isWalletTopup && <span className="ml-2 text-xs font-semibold text-mute">wallet</span>}
                  </Td>
                  <Td className="text-mute">{date(i.issueDate)}</Td>
                  <Td className="text-mute">{date(i.dueDate)}</Td>
                  <Td className="font-semibold">{money(i.total, i.currency)}</Td>
                  <Td>
                    <Badge status={i.status} />
                  </Td>
                  <Td className="text-right">
                    <Link href={`/client/invoices/${i.id}`} className="font-bold text-primary-dark hover:underline">
                      {i.status === "UNPAID" ? "Pay now" : "View"}
                    </Link>
                  </Td>
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
export default function Page() {
  return (
    <Suspense>
      <Invoices />
    </Suspense>
  );
}
