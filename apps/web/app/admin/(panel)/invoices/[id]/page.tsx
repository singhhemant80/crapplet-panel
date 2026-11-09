"use client";
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
      <div className="grid gap-6 xl:grid-cols-[1fr_380px]">
        <Card pad={false}>
          <Table head={["Item", "SAC", "Qty", "Amount"]}>
            {i.items.map((it: any) => <tr key={it.id}><Td><div className="font-semibold">{it.description}</div>{it.periodStart && <div className="text-xs text-mute">{date(it.periodStart)} – {date(it.periodEnd)}</div>}<div className="text-[11px] text-mute">{it.type}{it.relId ? ` · ${it.relId}` : ""}</div></Td><Td>{it.hsnSac}</Td><Td>{it.quantity}</Td><Td className="text-right font-semibold">{money(it.amount)}</Td></tr>)}
          </Table>
          <div className="ml-auto max-w-xs space-y-1 p-5 text-sm">
            {[["Subtotal", i.subtotal], ["Discount", -i.discount], ["Taxable", i.taxableAmount], ["CGST", i.cgst], ["SGST", i.sgst], ["IGST", i.igst]].filter(([, v]) => v).map(([l, v]: any) => <div key={l} className="flex justify-between"><span className="text-mute">{l}</span><span>{money(v)}</span></div>)}
            <div className="flex justify-between border-t border-line pt-2 text-base font-extrabold"><span>Total</span><span>{money(i.total)}</span></div>
            <div className="flex justify-between"><span className="text-mute">Paid</span><span>{money(i.amountPaid)}</span></div>
          </div>
        </Card>
        <div className="space-y-6">
          <Card title="Customer GST">
            <div className="text-sm"><div>GSTIN: <b className="font-mono">{i.customerGstin ?? "Unregistered (B2C)"}</b></div><div>State code: {i.placeOfSupplyCode ?? "—"} · rate {i.gstRate}% · {i.taxInclusive ? "inclusive" : "exclusive"}</div></div>
          </Card>
          <Card title="Transactions" pad={false}>
            <ul className="divide-y divide-[#f3effb] text-sm">{i.transactions.map((t: any) => <li key={t.id} className="flex justify-between px-5 py-2.5"><span><b className="uppercase">{t.gateway}</b> <span className="font-mono text-xs text-mute">{t.gatewayTxnId.slice(0, 22)}</span><div className="text-xs text-mute">{date(t.createdAt, true)} · {t.type}</div></span><b>{money(t.amount)}</b></li>)}{!i.transactions.length && <li className="px-5 py-4 text-mute">None</li>}</ul>
          </Card>
          {i.creditNotes.length > 0 && <Card title="Credit notes" pad={false}><ul className="divide-y text-sm">{i.creditNotes.map((c: any) => <li key={c.id} className="flex justify-between px-5 py-2.5"><span>{c.number}<div className="text-xs text-mute">{c.reason}</div></span><b>{money(c.amount)}</b></li>)}</ul></Card>}
          {i.paymentIntents.length > 0 && <Card title="Payment attempts" pad={false}><ul className="divide-y text-xs">{i.paymentIntents.map((p: any) => <li key={p.id} className="flex justify-between px-5 py-2"><span>{p.gateway} · {date(p.createdAt, true)}{p.reference && ` · ref ${p.reference}`}</span><Badge status={p.status} /></li>)}</ul></Card>}
        </div>
      </div>
      <PayModal open={pay} onClose={() => setPay(false)} id={id} due={i.total - i.amountPaid} onDone={reload} />
      <CreditNoteModal open={cn} onClose={() => setCn(false)} id={id} max={i.total} onDone={reload} />
    </>
  );
}
function PayModal({ open, onClose, id, due, onDone }: any) {
  const [v, setV] = useState({ amount: String(due / 100), gateway: "bank", reference: "" });
  return (
    <Modal open={open} onClose={onClose} title="Record payment">
      <div className="space-y-4">
        <Field label="Amount (₹)"><Input type="number" step="0.01" value={v.amount} onChange={(e) => setV({ ...v, amount: e.target.value })} /></Field>
        <Field label="Method"><Select value={v.gateway} onChange={(e) => setV({ ...v, gateway: e.target.value })}>{["bank", "upi", "manual", "razorpay", "cashfree", "payu", "stripe"].map((g) => <option key={g}>{g}</option>)}</Select></Field>
        <Field label="Reference / UTR" hint="Must be unique per method — prevents recording the same payment twice."><Input value={v.reference} onChange={(e) => setV({ ...v, reference: e.target.value })} /></Field>
        <Button onClick={() => api(`/admin/invoices/${id}/payment`, { body: { amount: Math.round(Number(v.amount) * 100), gateway: v.gateway, reference: v.reference } }).then((r) => { toast.success(r.paid ? "Invoice paid — services will be provisioned" : "Partial payment recorded"); onClose(); onDone(); }).catch((e) => toast.error(e.message))}>Record</Button>
      </div>
    </Modal>
  );
}
function CreditNoteModal({ open, onClose, id, max, onDone }: any) {
  const [v, setV] = useState({ amount: "", reason: "", toCredit: true });
  return (
    <Modal open={open} onClose={onClose} title="Issue credit note">
      <div className="space-y-4">
        <Field label={`Amount (₹, max ${money(max)})`}><Input type="number" step="0.01" value={v.amount} onChange={(e) => setV({ ...v, amount: e.target.value })} /></Field>
        <Field label="Reason"><Input value={v.reason} onChange={(e) => setV({ ...v, reason: e.target.value })} /></Field>
        <Toggle checked={v.toCredit} onChange={(x) => setV({ ...v, toCredit: x })} label="Add to customer's credit balance" />
        <Button onClick={() => api(`/admin/invoices/${id}/credit-note`, { body: { amount: Math.round(Number(v.amount) * 100), reason: v.reason, toCredit: v.toCredit } }).then(() => { toast.success("Credit note issued"); onClose(); onDone(); }).catch((e) => toast.error(e.message))}>Issue</Button>
      </div>
    </Modal>
  );
}
