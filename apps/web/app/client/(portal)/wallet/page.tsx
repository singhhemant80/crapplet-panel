"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { api, date, money } from "@/lib/api";
import { useSession } from "@/lib/session";
import { Button, Card, Empty, Field, Input, Loading, PageHeader, Table, Td, toast, useApi } from "@/components/ui";

export default function Wallet() {
  const router = useRouter();
  const { data, loading } = useApi("/client/credit");
  const { me } = useSession();
  const ac: string = me?.profile?.currency ?? "INR";
  const inr = ac === "INR";
  const [amount, setAmount] = useState<string | null>(null);
  const amt = amount ?? (inr ? "1000" : "20");
  const [busy, setBusy] = useState(false);
  return (
    <>
      <PageHeader title="Wallet & Transactions" subtitle="Prepaid credit is applied automatically to renewal invoices." />
      <div className="mb-6 grid gap-6 md:grid-cols-2">
        <Card>
          <div className="text-sm font-semibold text-mute">Available balance</div>
          <div className="mt-1 text-4xl font-extrabold tracking-tight text-ink">{loading ? "…" : money(data?.balance, ac)}</div>
        </Card>
        <Card title="Add funds">
          <div className="flex flex-wrap items-end gap-3">
            <Field label={`Amount (${inr ? "₹" : ac})`} hint={inr ? "Minimum ₹100" : `Minimum 5 ${ac}`} className="min-w-[160px] flex-1">
              <Input type="number" min={inr ? 100 : 5} step={inr ? 100 : 5} value={amt} onChange={(e) => setAmount(e.target.value)} />
            </Field>
            <Button
              loading={busy}
              icon="add_card"
              onClick={async () => {
                setBusy(true);
                try {
                  const r = await api("/client/credit/topup", { body: { amount: Math.round(Number(amt) * 100) } });
                  router.push(`/client/invoices/${r.invoiceId}`);
                } catch (e: any) {
                  toast.error(e.message);
                  setBusy(false);
                }
              }}
            >
              Continue to payment
            </Button>
          </div>
          <p className="mt-2 text-xs text-mute">Minimum ₹100. A receipt voucher is issued; GST is charged on the invoices the credit pays for.</p>
        </Card>
      </div>
      <Card title="Credit history" pad={false}>
        {loading ? (
          <Loading />
        ) : !data?.ledger.length ? (
          <Empty icon="account_balance_wallet" title="No credit activity yet" />
        ) : (
          <Table head={["Date", "Description", "Amount", "Balance"]}>
            {data.ledger.map((l: any) => (
              <tr key={l.id}>
                <Td className="whitespace-nowrap text-mute">{date(l.createdAt, true)}</Td>
                <Td className="font-semibold text-ink">{l.description}</Td>
                <Td className={l.amount < 0 ? "font-bold text-rose-600" : "font-bold text-emerald-600"}>
                  {l.amount < 0 ? "−" : "+"}
                  {money(Math.abs(l.amount), ac)}
                </Td>
                <Td className="font-semibold">{money(l.balanceAfter, ac)}</Td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
    </>
  );
}
