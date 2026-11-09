"use client";
import { InvoiceSheet } from "@/components/invoice-sheet";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useState } from "react";
import { api, date, money } from "@/lib/api";
import { Badge, Button, Card, Field, Input, Loading, Modal, PageHeader, Select, Table, Td, Toggle, toast, useApi } from "@/components/ui";

export default function AdminInvoice() {
  const { id } = useParams<{ id: string }>();
  const { data, loading, reload } = useApi(`/admin/invoices/${id}`);
  const [pay, setPay] = useState(false);
  const [cn, setCn] = useState(false);
  if (loading || !data) return <Loading />;
  const i = data.invoice;
  return (
    <>
      <PageHeader back="/admin/invoices" title={<span className="flex items-center gap-3">{data.label} <Badge status={i.status} /></span>} subtitle={<span><Link className="font-bold text-primary-dark" href={`/admin/clients/${i.user.id}`}>{i.user.firstName} {i.user.lastName}</Link> · proforma {i.proformaNumber} · place of supply {i.placeOfSupply ?? "—"}</span>}
        actions={<>
          <Button variant="outline" size="sm" icon="picture_as_pdf" onClick={() => window.open(`/api/admin/invoices/${id}/pdf`, "_blank")}>PDF</Button>
          {i.status === "UNPAID" && <>
            <Button size="sm" icon="add_card" onClick={() => setPay(true)}>Record payment</Button>
            <Button size="sm" variant="outline" icon="mail" onClick={() => api(`/admin/invoices/${id}/remind`, { body: {} }).then(() => toast.success("Reminder sent"))}>Send reminder</Button>
            <Button size="sm" variant="danger" onClick={() => confirm("Cancel invoice? Pending order services and IP holds will be released.") && api(`/admin/invoices/${id}/cancel`, { body: {} }).then(() => { toast.success("Cancelled"); reload(); }).catch((e) => toast.error(e.message))}>Cancel</Button>
          </>}
          {i.status === "PAID" && <Button size="sm" variant="outline" icon="undo" onClick={() => setCn(true)}>Credit note</Button>}
        </>} />
      <div className="grid items-start gap-6 xl:grid-cols-[minmax(0,1fr)_340px]">
        <InvoiceSheet data={data} admin />
        <div className="space-y-6">
          <Card title="Customer">
            <div className="flex items-center gap-3">
              <span className="grid h-11 w-11 place-items-center rounded-xl bg-primary-tint text-sm font-black text-primary-dark">{(i.user.firstName?.[0] ?? "") + (i.user.lastName?.[0] ?? "")}</span>
              <div className="min-w-0 text-sm">
                <Link className="font-bold text-primary-dark hover:underline" href={`/admin/clients/${i.user.id}`}>{i.user.firstName} {i.user.lastName}</Link>
                <div className="truncate text-mute">{i.user.email}</div>
              </div>
            </div>
            <dl className="mt-4 space-y-1.5 text-sm">
              {i.order && <div className="flex justify-between"><dt className="text-mute">Order</dt><dd><Link className="font-bold text-primary-dark hover:underline" href={`/admin/orders/${i.order.id}`}>{i.order.number}</Link></dd></div>}
              <div className="flex justify-between"><dt className="text-mute">Due</dt><dd className="font-semibold">{date(i.dueDate)}</dd></div>
              {i.currency !== "INR" && <div className="flex justify-between"><dt className="text-mute">INR value</dt><dd className="font-semibold">{money(Math.round(i.total * i.exchangeRate))}</dd></div>}
            </dl>
          </Card>
          <Card title="Ledger" pad={false}>
            <ul className="divide-y divide-[#f3effb] text-sm">{i.transactions.map((t: any) => <li key={t.id} className="flex justify-between px-5 py-2.5"><span><b className="uppercase">{t.gateway}</b> <span className="font-mono text-xs text-mute">{t.gatewayTxnId.slice(0, 22)}</span><div className="text-xs text-mute">{date(t.createdAt, true)} · {t.type}</div></span><b>{money(t.amount, t.currency)}</b></li>)}{!i.transactions.length && <li className="px-5 py-4 text-mute">None</li>}</ul>
          </Card>
          {i.creditNotes.length > 0 && <Card title="Credit notes" pad={false}><ul className="divide-y text-sm">{i.creditNotes.map((c: any) => <li key={c.id} className="flex justify-between px-5 py-2.5"><span>{c.number}<div className="text-xs text-mute">{c.reason}</div></span><b>{money(c.amount, i.currency)}</b></li>)}</ul></Card>}
          {i.paymentIntents.length > 0 && <Card title="Payment attempts" pad={false}><ul className="divide-y text-xs">{i.paymentIntents.map((p: any) => <li key={p.id} className="flex justify-between px-5 py-2"><span>{p.gateway} · {date(p.createdAt, true)}{p.reference && ` · ref ${p.reference}`}</span><Badge status={p.status} /></li>)}</ul></Card>}
        </div>
      </div>
      <PayModal open={pay} onClose={() => setPay(false)} id={id} due={i.total - i.amountPaid} currency={i.currency} onDone={reload} />
      <CreditNoteModal open={cn} onClose={() => setCn(false)} id={id} max={i.total} currency={i.currency} onDone={reload} />
    </>
  );
}
function PayModal({ open, onClose, id, due, currency, onDone }: any) {
  const [v, setV] = useState({ amount: String(due / 100), gateway: "bank", reference: "" });
  return (
    <Modal open={open} onClose={onClose} title="Record payment">
      <div className="space-y-4">
        <Field label={`Amount (${currency})`}><Input type="number" step="0.01" value={v.amount} onChange={(e) => setV({ ...v, amount: e.target.value })} /></Field>
        <Field label="Method"><Select value={v.gateway} onChange={(e) => setV({ ...v, gateway: e.target.value })}>{["bank", "upi", "wire", "manual", "razorpay", "cashfree", "payu", "stripe", "paypal"].map((g) => <option key={g}>{g}</option>)}</Select></Field>
        <Field label="Reference / UTR" hint="Must be unique per method — prevents recording the same payment twice."><Input value={v.reference} onChange={(e) => setV({ ...v, reference: e.target.value })} /></Field>
        <Button onClick={() => api(`/admin/invoices/${id}/payment`, { body: { amount: Math.round(Number(v.amount) * 100), gateway: v.gateway, reference: v.reference } }).then((r) => { toast.success(r.paid ? "Invoice paid — services will be provisioned" : "Partial payment recorded"); onClose(); onDone(); }).catch((e) => toast.error(e.message))}>Record</Button>
      </div>
    </Modal>
  );
}
function CreditNoteModal({ open, onClose, id, max, currency, onDone }: any) {
  const [v, setV] = useState({ amount: "", reason: "", toCredit: true });
  return (
    <Modal open={open} onClose={onClose} title="Issue credit note">
      <div className="space-y-4">
        <Field label={`Amount (${currency}, max ${money(max, currency)})`}><Input type="number" step="0.01" value={v.amount} onChange={(e) => setV({ ...v, amount: e.target.value })} /></Field>
        <Field label="Reason"><Input value={v.reason} onChange={(e) => setV({ ...v, reason: e.target.value })} /></Field>
        <Toggle checked={v.toCredit} onChange={(x) => setV({ ...v, toCredit: x })} label="Add to customer's credit balance" />
        <Button onClick={() => api(`/admin/invoices/${id}/credit-note`, { body: { amount: Math.round(Number(v.amount) * 100), reason: v.reason, toCredit: v.toCredit } }).then(() => { toast.success("Credit note issued"); onClose(); onDone(); }).catch((e) => toast.error(e.message))}>Issue</Button>
      </div>
    </Modal>
  );
}
