"use client";
import Link from "next/link";
import { useState } from "react";
import { api, date, money } from "@/lib/api";
import { Badge, Button, Card, Empty, Icon, Loading, PageHeader, Pager, Table, Td, toast, useApi } from "@/components/ui";

/** UPI AutoPay mandates: what renewals are charged to, with a way to turn it off. */
function AutoPayCard() {
  const { data, reload } = useApi("/client/autopay");
  const [busy, setBusy] = useState("");
  const list = (data?.methods ?? []).filter((m: any) => m.externalId);
  const off = async (m: any) => {
    if (!confirm("Turn off UPI AutoPay? Future renewal invoices will need to be paid by you.")) return;
    setBusy(m.id);
    try {
      await api(`/client/autopay/${m.id}`, { method: "DELETE" });
      toast.success("UPI AutoPay turned off");
      reload();
    } catch (e: any) {
      toast.error(e.message);
    } finally {
      setBusy("");
    }
  };
  return (
    <Card className="mb-5">
      <div className="flex flex-wrap items-start gap-4">
        <span className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-gradient-to-br from-sky-400 to-violet-600 text-white"><Icon name="autorenew" className="text-[22px]" /></span>
        <div className="min-w-0 flex-1">
          <div className="text-base font-extrabold text-ink">UPI AutoPay</div>
          {list.length ? (
            <div className="mt-2 space-y-2">
              {list.map((m: any) => (
                <div key={m.id} className="flex flex-wrap items-center gap-3 rounded-xl border border-line px-3.5 py-2.5">
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-bold text-ink">{m.label}</div>
                    <div className="text-xs text-mute">
                      {m.status === "PAUSED" ? "Paused in your UPI app" : m.autopay ? "Renewals are paid automatically" : "Not used for renewals"}
                      {m.maxAmount ? ` · up to ${money(m.maxAmount, "INR")} per debit` : ""} · set up {date(m.createdAt)}
                    </div>
                  </div>
                  <Badge status={m.status === "ACTIVE" && m.autopay ? "ACTIVE" : m.status === "PAUSED" ? "SUSPENDED" : "PENDING"}>{m.status === "ACTIVE" && m.autopay ? "On" : m.status.toLowerCase()}</Badge>
                  <Button size="sm" variant="outline" loading={busy === m.id} onClick={() => off(m)}>Turn off</Button>
                </div>
              ))}
              <p className="text-xs text-mute">Your UPI app notifies you 24 hours before each debit. You can also pause or cancel AutoPay in your UPI app.</p>
            </div>
          ) : (
            <p className="mt-1 text-sm text-mute">Not set up. Choose <b>UPI AutoPay</b> when you pay an invoice for a service, and renewals are paid automatically from then on.</p>
          )}
        </div>
      </div>
    </Card>
  );
}

export default function Payments() {
  const [page, setPage] = useState(1);
  const { data, loading } = useApi(`/client/transactions?page=${page}`, [page]);
  return (
    <>
      <PageHeader title="Payments" subtitle="Every payment, refund and credit applied to your account." />
      <AutoPayCard />
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
                  <Td className="whitespace-nowrap text-mute">{date(t.createdAt, true)}</Td>
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
