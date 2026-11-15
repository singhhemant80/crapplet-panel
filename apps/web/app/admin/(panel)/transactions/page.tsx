"use client";
import Link from "next/link";
import { useState } from "react";
import { api, date, invNo, money } from "@/lib/api";
import { Button, Card, Field, Input, Loading, Modal, PageHeader, Pager, Select, Table, Td, toast, useApi } from "@/components/ui";
import { DateRangeFilter, rangeQs, type Range } from "@/components/admin/date-range";

const TYPES: [string, string][] = [["", "All types"], ["PAYMENT", "Payments"], ["REFUND", "Refunds"], ["WALLET_TOPUP", "Wallet top-ups"], ["CREDIT_APPLIED", "Paid from credit"]];
const GATEWAYS = ["razorpay", "cashfree", "payu", "stripe", "upi", "bank", "manual", "credit", "custom"];

export default function Transactions() {
  const [page, setPage] = useState(1);
  const [gateway, setGateway] = useState("");
  const [type, setType] = useState("");
  const [range, setRange] = useState<Range>({ from: "", to: "" });
  const [q, setQ] = useState("");
  const [query, setQuery] = useState("");
  const qs = [`page=${page}`, gateway && `gateway=${gateway}`, type && `type=${type}`, query && `q=${encodeURIComponent(query)}`, rangeQs(range)].filter(Boolean).join("&");
  const { data, loading, reload } = useApi(`/admin/transactions?${qs}`, [qs]);
  const [refund, setRefund] = useState<any>(null);
  const reset = (fn: () => void) => { fn(); setPage(1); };
  const filtered = !!(gateway || type || query || range.from || range.to);
  return (
    <>
      <PageHeader title="Transactions" />
      <div className="mb-3 grid gap-2 md:grid-cols-2 xl:grid-cols-[1.4fr_170px_170px_1.4fr]">
        <form onSubmit={(e) => { e.preventDefault(); reset(() => setQuery(q.trim())); }}><Input className="h-10" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Customer, email, reference or invoice no." /></form>
        <Select className="h-10" value={type} onChange={(e) => reset(() => setType(e.target.value))}>{TYPES.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</Select>
        <Select className="h-10" value={gateway} onChange={(e) => reset(() => setGateway(e.target.value))}><option value="">All gateways</option>{GATEWAYS.map((g) => <option key={g} value={g}>{g === "credit" ? "Account credit" : g.charAt(0).toUpperCase() + g.slice(1)}</option>)}</Select>
        <DateRangeFilter value={range} onChange={(r) => reset(() => setRange(r))} />
      </div>
      {(data?.totals ?? []).map((t: any) => (
        <div key={t.currency} className="mb-3 flex flex-wrap items-center gap-x-6 gap-y-1 rounded-xl bg-white px-4 py-2.5 text-sm text-mute shadow-card">
          <span className="font-extrabold text-ink">{t.currency}</span>
          <span>Received <b className="text-emerald-700">{money(t.received, t.currency)}</b></span>
          {t.refunded > 0 && <span>Refunded <b className="text-rose-600">{money(t.refunded, t.currency)}</b></span>}
          <span>Net <b className="text-ink">{money(t.net, t.currency)}</b></span>
          {t.fees > 0 && <span>Gateway fees <b className="text-ink">{money(t.fees, t.currency)}</b></span>}
          {t.creditApplied > 0 && <span>Paid from credit <b className="text-ink">{money(t.creditApplied, t.currency)}</b></span>}
          <span className="ml-auto text-xs">{t.count.toLocaleString("en-IN")} transaction{t.count === 1 ? "" : "s"}{filtered ? " matching" : ""}</span>
        </div>
      ))}
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
                  <Td className="whitespace-nowrap text-xs">{TYPES.find(([k]) => k === t.type)?.[1].replace(/s$/, "") ?? t.type}</Td>
                  <Td className={t.type === "REFUND" ? "font-bold text-rose-600" : "font-bold"}>{money(t.amount, t.currency)}</Td>
                  <Td className="text-xs text-mute">{money(t.fee, t.currency)}</Td>
                  <Td>{t.invoice && <Link className="text-xs font-bold text-primary-dark" href={`/admin/invoices/${t.invoice.id}`}>{invNo(t.invoice)}</Link>}</Td>
                  <Td>{t.type === "PAYMENT" && <button className="text-xs font-bold text-rose-600" onClick={() => setRefund({ ...t, amountStr: String(t.amount / 100), reason: "", method: ["bank", "upi", "manual", "wire"].includes(t.gateway) ? "manual" : "gateway" })}>Refund</button>}</Td>
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
          <Field label="Refund to">
            <Select value={refund.method ?? (refund.toCredit ? "wallet" : "gateway")} onChange={(e) => setRefund({ ...refund, method: e.target.value })}>
              <option value="gateway">Original payment method (refund through the gateway)</option>
              <option value="wallet">Customer wallet (account credit)</option>
              <option value="manual">Already refunded outside the panel (record only)</option>
            </Select>
          </Field>
          <Button variant="danger" onClick={() => api(`/admin/transactions/${refund.id}/refund`, { body: { amount: Math.round(Number(refund.amountStr) * 100), reason: refund.reason, method: refund.method ?? (refund.toCredit ? "wallet" : "gateway") } }).then(() => { toast.success("Refund processed and credit note issued"); setRefund(null); reload(); }).catch((e) => toast.error(e.message))}>Refund</Button>
        </div>}
      </Modal>
    </>
  );
}
