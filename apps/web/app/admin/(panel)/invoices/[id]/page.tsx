"use client";
import { InvoiceSheet } from "@/components/invoice-sheet";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useState } from "react";
import { api, date, money } from "@/lib/api";
import { Alert, Badge, Button, Card, Field, Icon, Input, Loading, Modal, PageHeader, Select, Table, Td, Toggle, toast, useApi } from "@/components/ui";

export default function AdminInvoice() {
  const { id } = useParams<{ id: string }>();
  const { data, loading, reload } = useApi(`/admin/invoices/${id}`);
  const [pay, setPay] = useState(false);
  const [cn, setCn] = useState(false);
  const [refund, setRefund] = useState(false);
  if (loading || !data) return <Loading />;
  const i = data.invoice;
  return (
    <>
      <PageHeader icon="receipt_long"
        stats={[
          ["Total", money(i.total, i.currency)],
          ["Paid", money(i.amountPaid ?? 0, i.currency)],
          ["Balance due", money(Math.max(0, i.total - (i.amountPaid ?? 0)), i.currency)],
          ["Issued", date(i.createdAt)],
          ["Due date", i.dueDate ? date(i.dueDate) : "—"],
          ["Customer", `${i.user.firstName ?? ""} ${i.user.lastName ?? ""}`.trim() || i.user.email, i.user.email],
        ]}
        back="/admin/invoices" title={<span className="flex items-center gap-3">{data.label} <Badge status={i.status} /></span>} subtitle={<span><Link className="font-bold text-primary-dark" href={`/admin/clients/${i.user.id}`}>{i.user.firstName} {i.user.lastName}</Link> · proforma {i.proformaNumber} · place of supply {i.placeOfSupply ?? "—"}</span>}
        actions={<>
          <Button variant="outline" size="sm" icon="picture_as_pdf" onClick={() => window.open(`/api/admin/invoices/${id}/pdf`, "_blank")}>PDF</Button>
          {i.status === "UNPAID" && <>
            <Button size="sm" icon="add_card" onClick={() => setPay(true)}>Record payment</Button>
            <Button size="sm" variant="outline" icon="mail" onClick={() => api(`/admin/invoices/${id}/remind`, { body: {} }).then(() => toast.success("Reminder sent"))}>Send reminder</Button>
            <Button size="sm" variant="danger" onClick={() => confirm("Cancel invoice? Pending order services and IP holds will be released.") && api(`/admin/invoices/${id}/cancel`, { body: {} }).then(() => { toast.success("Cancelled"); reload(); }).catch((e) => toast.error(e.message))}>Cancel</Button>
          </>}
          {i.status === "PAID" && i.amountPaid > 0 && <Button size="sm" variant="danger" icon="currency_exchange" onClick={() => setRefund(true)}>Refund</Button>}
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
      <RefundModal open={refund} onClose={() => setRefund(false)} id={id} onDone={reload} />
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

const METHODS = [
  { k: "gateway", icon: "credit_card", title: "Original payment method", text: "Back to the customer's card / UPI / bank through the gateway — no need to open the gateway dashboard" },
  { k: "wallet", icon: "account_balance_wallet", title: "Customer wallet", text: "Added to their account credit instantly — used automatically on future invoices" },
  { k: "manual", icon: "receipt_long", title: "Already refunded outside", text: "You paid it back yourself (NEFT, cash…) — this only records it" },
] as const;

/** Refund: choose wallet or the original gateway; amounts are limited to what each route can return. */
function RefundModal({ open, onClose, id, onDone }: { open: boolean; onClose: () => void; id: string; onDone: () => void }) {
  const { data, reload } = useApi(open ? `/admin/invoices/${id}/refund-options` : null, [open]);
  const [method, setMethod] = useState<"gateway" | "wallet" | "manual">("gateway");
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const cur = data?.currency ?? "INR";
  const max: number = data?.max?.[method] ?? 0;
  useEffect(() => {
    if (!data) return;
    const m = data.max.gateway > 0 ? "gateway" : "wallet";
    setMethod(m);
    setAmount(String(data.max[m] / 100));
    setReason("");
  }, [data]);
  const value = Math.round(Number(amount) * 100);
  return (
    <Modal open={open} onClose={onClose} title="Refund invoice" wide>
      {!data ? <Loading /> : data.max.wallet === 0 ? <p className="text-sm text-mute">Everything on this invoice has already been refunded.</p> : (
        <div className="space-y-5">
          <div>
            <div className="mb-2 text-[13px] font-bold text-slate-700">Where should the money go?</div>
            <div className="grid gap-2 sm:grid-cols-3">
              {METHODS.map((m) => {
                const can = (data.max[m.k] ?? 0) > 0;
                return (
                  <button key={m.k} type="button" disabled={!can} onClick={() => { setMethod(m.k); setAmount(String(Math.min(data.max[m.k], value || data.max[m.k]) / 100)); }}
                    className={"flex flex-col gap-1 rounded-xl border p-3 text-left transition disabled:cursor-not-allowed disabled:opacity-45 " + (method === m.k ? "border-primary bg-primary-tint ring-2 ring-primary/20" : "border-line hover:border-primary/40")}>
                    <span className="flex items-center gap-2 text-sm font-bold text-ink"><Icon name={m.icon} className="text-[19px] text-primary-dark" />{m.title}</span>
                    <span className="text-[11.5px] leading-snug text-mute">{m.text}</span>
                    <span className="mt-1 text-xs font-bold text-primary-dark">up to {money(data.max[m.k] ?? 0, cur)}</span>
                  </button>
                );
              })}
            </div>
          </div>
          <div className="overflow-hidden rounded-xl border border-line">
            <div className="bg-[#fbf9ff] px-4 py-2 text-[11px] font-bold uppercase tracking-wider text-mute">Payments on this invoice</div>
            {data.payments.map((p: any) => (
              <div key={p.id} className="flex flex-wrap items-center justify-between gap-2 border-t border-line px-4 py-2.5 text-sm">
                <span className="min-w-0"><b className="uppercase">{p.gateway === "credit" ? "Account credit" : p.gateway}</b> <span className="font-mono text-xs text-mute">{p.reference.slice(0, 26)}</span>{p.gatewayNote && <span className="block text-[11.5px] text-mute">{p.gatewayNote}</span>}</span>
                <span className="text-right text-xs"><b className="text-sm text-ink">{money(p.amount, cur)}</b>{p.refunded > 0 && <span className="block text-sky-700">{money(p.refunded, cur)} refunded</span>}</span>
              </div>
            ))}
          </div>
          <div className="grid gap-4 sm:grid-cols-[200px_1fr]">
            <Field label={`Amount (${cur})`} hint={`Max ${money(max, cur)}`}>
              <Input type="number" step="0.01" min={0} value={amount} onChange={(e) => setAmount(e.target.value)} />
            </Field>
            <Field label="Reason (on the credit note)"><Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Service cancelled within 7 days" /></Field>
          </div>
          {method === "gateway" && <Alert tone="info">The refund is sent to {[...new Set(data.payments.filter((p: any) => p.viaGateway).map((p: any) => p.gateway))].join(" / ")} now. Banks usually credit the customer in 5–7 working days. A GST credit note is issued automatically.</Alert>}
          <Button variant="danger" icon="currency_exchange" loading={busy} disabled={!value || value > max || reason.trim().length < 3}
            onClick={async () => {
              if (!confirm(`Refund ${money(value, cur)} ${method === "gateway" ? "through the payment gateway" : method === "wallet" ? "to the customer's wallet" : "(record a manual refund)"}?`)) return;
              setBusy(true);
              try {
                const r = await api(`/admin/invoices/${id}/refund`, { body: { amount: value, method, reason } });
                toast.success(`Refunded ${money(r.refunded, cur)}${method === "gateway" ? ` — ${r.parts.map((x: any) => `${x.gateway} ${x.refundId}`).join(", ")}` : ""}`);
                onClose();
                onDone();
              } catch (e: any) {
                toast.error(e.message);
                reload();
              }
              setBusy(false);
            }}>
            Refund {value ? money(value, cur) : ""}
          </Button>
        </div>
      )}
    </Modal>
  );
}
