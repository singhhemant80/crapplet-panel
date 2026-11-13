"use client";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useState } from "react";
import { api, date, money } from "@/lib/api";
import { Alert, Badge, Button, Card, Loading, Modal, PageHeader, Textarea, toast, useApi } from "@/components/ui";

export default function Quote() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const { data, loading, reload, error } = useApi(`/client/quotes/${id}`, [id]);
  const [busy, setBusy] = useState(false);
  const [decline, setDecline] = useState(false);
  const [reason, setReason] = useState("");
  if (error) return <Alert tone="error">This quote isn't available.</Alert>;
  if (loading || !data) return <Loading />;
  const q = data.quote;
  const expired = q.status === "EXPIRED" || (q.status === "SENT" && new Date(q.validUntil) < new Date());
  const canAnswer = q.status === "SENT" && !expired;
  const items: any[] = q.items ?? [];
  const discount = -items.filter((l) => l.unitPrice < 0).reduce((a, l) => a + l.unitPrice * l.quantity, 0);

  async function accept() {
    setBusy(true);
    try {
      const r = await api(`/client/quotes/${id}/accept`, { body: {} });
      toast.success("Quote accepted — here's your invoice");
      router.push(`/client/invoices/${r.invoiceId}`);
    } catch (e: any) {
      toast.error(e.message);
      setBusy(false);
    }
  }
  return (
    <>
      <PageHeader back="/client/quotes" title={<span className="flex flex-wrap items-center gap-x-3 gap-y-1"><span className="whitespace-nowrap">Quote {q.number}</span> <Badge status={q.status === "SENT" ? "PENDING" : q.status}>{q.status === "SENT" ? (expired ? "expired" : "awaiting you") : q.status === "INVOICED" ? "accepted" : undefined}</Badge></span>} subtitle={q.subject} />
      {canAnswer && <Alert tone="info" className="mb-4">This offer is valid until <b>{date(q.validUntil)}</b>. Accept it to get the invoice — your service is set up once it's paid.</Alert>}
      {expired && <Alert tone="warn" className="mb-4">This quote expired on {date(q.validUntil)}. Open a ticket if you'd still like it and we'll send a fresh one.</Alert>}
      {q.status === "INVOICED" && q.invoiceId && <Alert tone="success" className="mb-4">You accepted this quote{q.acceptedAt && ` on ${date(q.acceptedAt)}`}. <Link className="font-bold underline" href={`/client/invoices/${q.invoiceId}`}>View the invoice</Link></Alert>}
      {q.status === "DECLINED" && <Alert tone="warn" className="mb-4">You declined this quote{q.declinedAt && ` on ${date(q.declinedAt)}`}.</Alert>}
      <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
        <Card pad={false}>
          <div className="flex flex-wrap items-start justify-between gap-4 border-b border-line px-6 py-5">
            <div><div className="text-xs font-bold uppercase tracking-wider text-mute">From</div><b className="text-ink">{data.company?.legalName ?? data.company?.brand}</b>{data.company?.gstin && <div className="text-xs text-mute">GSTIN {data.company.gstin}</div>}</div>
            <div className="text-right text-sm"><div className="text-mute">Date <b className="text-ink">{date(q.sentAt ?? q.createdAt)}</b></div><div className="text-mute">Valid until <b className="text-ink">{date(q.validUntil)}</b></div></div>
          </div>
          <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead><tr className="bg-[#fbf9ff] text-left text-[11.5px] font-bold uppercase tracking-wider text-mute"><th className="px-4 py-2.5 sm:px-6">Item</th><th className="px-3 py-2.5 text-right">Qty</th><th className="hidden px-3 py-2.5 text-right sm:table-cell">Price</th><th className="px-4 py-2.5 text-right sm:px-6">Amount</th></tr></thead>
            <tbody>
              {items.map((l, n) => (
                <tr key={n} className="border-t border-line">
                  <td className="px-4 py-3 font-semibold text-ink sm:px-6">{l.description}{!l.taxable && <span className="ml-2 text-[11px] font-normal text-mute">no GST</span>}</td>
                  <td className="px-3 py-3 text-right text-mute">{l.quantity}</td>
                  <td className="hidden whitespace-nowrap px-3 py-3 text-right text-mute sm:table-cell">{money(l.unitPrice, q.currency)}</td>
                  <td className={"whitespace-nowrap px-4 py-3 text-right font-semibold sm:px-6 " + (l.unitPrice < 0 ? "text-emerald-700" : "")}>{money(l.unitPrice * l.quantity, q.currency)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
          <dl className="space-y-1.5 border-t border-line px-6 py-4 text-sm">
            <div className="flex justify-between"><dt className="text-mute">Subtotal</dt><dd>{money(q.subtotal, q.currency)}</dd></div>
            {discount > 0 && <div className="flex justify-between"><dt className="text-mute">Discount</dt><dd className="text-emerald-700">−{money(discount, q.currency)}</dd></div>}
            <div className="flex justify-between"><dt className="text-mute">GST (estimated)</dt><dd>{money(q.taxTotal, q.currency)}</dd></div>
            <div className="flex justify-between text-base"><dt className="font-bold">Total</dt><dd className="font-black">{money(q.total, q.currency)}</dd></div>
          </dl>
          {q.customerNotes && <div className="whitespace-pre-line border-t border-line px-6 py-4 text-sm text-slate-600">{q.customerNotes}</div>}
        </Card>
        <Card title={canAnswer ? "Your answer" : "Quote"}>
          <div className="text-3xl font-black text-ink">{money(q.total, q.currency)}</div>
          <div className="mt-1 text-xs text-mute">incl. GST · final tax is confirmed on the invoice</div>
          {canAnswer ? (
            <div className="mt-5 space-y-2">
              <Button className="w-full" icon="task_alt" loading={busy} onClick={accept}>Accept quote</Button>
              <Button className="w-full" variant="outline" onClick={() => setDecline(true)}>Decline</Button>
            </div>
          ) : q.invoiceId ? <Button className="mt-5 w-full" icon="receipt_long" href={`/client/invoices/${q.invoiceId}`}>View invoice</Button> : null}
        </Card>
      </div>
      <Modal open={decline} onClose={() => setDecline(false)} title="Decline this quote?">
        <p className="mb-3 text-sm text-mute">Let us know why (optional) — we may be able to adjust it.</p>
        <Textarea rows={3} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Over budget, need more RAM…" />
        <div className="mt-4 flex justify-end gap-2"><Button variant="outline" onClick={() => setDecline(false)}>Keep it</Button><Button variant="danger" onClick={() => api(`/client/quotes/${id}/decline`, { body: { reason: reason.trim() || undefined } }).then(() => { toast.success("Quote declined"); setDecline(false); reload(); }).catch((e) => toast.error(e.message))}>Decline quote</Button></div>
      </Modal>
    </>
  );
}
