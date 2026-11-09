"use client";
import Link from "next/link";
import { useState } from "react";
import { api, date, invNo, money } from "@/lib/api";
import { Button, Card, Field, Input, Loading, Modal, PageHeader, Pager, Select, Table, Td, Toggle, toast, useApi } from "@/components/ui";

export default function Transactions() {
  const [page, setPage] = useState(1);
  const [gateway, setGateway] = useState("");
  const { data, loading, reload } = useApi(`/admin/transactions?page=${page}&gateway=${gateway}`, [page, gateway]);
  const [refund, setRefund] = useState<any>(null);
  return (
    <>
      <PageHeader title="Transactions" actions={<Select className="w-44" value={gateway} onChange={(e) => setGateway(e.target.value)}><option value="">All gateways</option>{["razorpay", "cashfree", "payu", "stripe", "upi", "bank", "manual", "credit", "custom"].map((g) => <option key={g}>{g}</option>)}</Select>} />
      <Card pad={false}>
        {loading ? <Loading /> : (
          <>
            <Table head={["Date", "Customer", "Gateway", "Reference", "Type", "Amount", "Fee", "Invoice", ""]}>
              {data.transactions.map((t: any) => (
                <tr key={t.id}>
                  <Td className="whitespace-nowrap text-xs text-mute">{date(t.createdAt, true)}</Td>
                  <Td className="text-xs"><Link className="text-primary-dark" href={`/admin/clients/${t.user.id}`}>{t.user.email}</Link></Td>
                  <Td className="font-semibold uppercase">{t.gateway}</Td>
                  <Td className="max-w-[200px] truncate font-mono text-xs">{t.gatewayTxnId}</Td>
                  <Td className="text-xs">{t.type}</Td>
                  <Td className={t.type === "REFUND" ? "font-bold text-rose-600" : "font-bold"}>{money(t.amount, t.currency)}</Td>
                  <Td className="text-xs text-mute">{money(t.fee, t.currency)}</Td>
                  <Td>{t.invoice && <Link className="text-xs font-bold text-primary-dark" href={`/admin/invoices/${t.invoice.id}`}>{invNo(t.invoice)}</Link>}</Td>
                  <Td>{t.type === "PAYMENT" && <button className="text-xs font-bold text-rose-600" onClick={() => setRefund({ ...t, amountStr: String(t.amount / 100), reason: "", toCredit: true })}>Refund</button>}</Td>
                </tr>
              ))}
            </Table>
            <Pager page={data.page} pageSize={data.pageSize} total={data.total} onPage={setPage} />
          </>
        )}
      </Card>
      <Modal open={!!refund} onClose={() => setRefund(null)} title="Refund payment">
        {refund && <div className="space-y-4">
          <Field label="Amount (₹)"><Input type="number" step="0.01" value={refund.amountStr} onChange={(e) => setRefund({ ...refund, amountStr: e.target.value })} /></Field>
          <Field label="Reason"><Input value={refund.reason} onChange={(e) => setRefund({ ...refund, reason: e.target.value })} /></Field>
          <Toggle checked={refund.toCredit} onChange={(v) => setRefund({ ...refund, toCredit: v })} label="Refund to account credit (otherwise back via the gateway)" />
          <Button variant="danger" onClick={() => api(`/admin/transactions/${refund.id}/refund`, { body: { amount: Math.round(Number(refund.amountStr) * 100), reason: refund.reason, toCredit: refund.toCredit } }).then(() => { toast.success("Refund processed and credit note issued"); setRefund(null); reload(); }).catch((e) => toast.error(e.message))}>Refund</Button>
        </div>}
      </Modal>
    </>
  );
}
