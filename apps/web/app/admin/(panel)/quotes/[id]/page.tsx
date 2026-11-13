"use client";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { api, date, invNo, money } from "@/lib/api";
import { Alert, Badge, Button, Card, Field, Input, Loading, PageHeader, Textarea, toast, useApi } from "@/components/ui";
import { ClientPicker, CurrencySelect, LineEditor, dateInput, linesFromApi, linesToApi, linesTotal, newLine, type Line } from "@/components/admin/billing-kit";

export default function QuoteEditor() {
  const { id } = useParams<{ id: string }>();
  const isNew = id === "new";
  const router = useRouter();
  const { data, loading, reload } = useApi(isNew ? null : `/admin/quotes/${id}`, [id]);
  const [client, setClient] = useState<any>(null);
  const [lines, setLines] = useState<Line[]>([newLine()]);
  const [v, setV] = useState({ subject: "", currency: "INR", validUntil: new Date(Date.now() + 15 * 86400_000).toISOString().slice(0, 10), customerNotes: "", adminNotes: "" });
  const [busy, setBusy] = useState<string | null>(null);
  const q = data?.quote;

  useEffect(() => {
    if (!q) return;
    setClient(q.user);
    setLines(linesFromApi(q.items));
    setV({ subject: q.subject, currency: q.currency, validUntil: dateInput(q.validUntil), customerNotes: q.customerNotes ?? "", adminNotes: q.adminNotes ?? "" });
  }, [q]);

  if (!isNew && (loading || !q)) return <Loading />;
  const locked = q && ["INVOICED", "ACCEPTED"].includes(q.status);

  async function save(send: boolean) {
    if (!client) return toast.error("Choose the customer");
    const items = linesToApi(lines, false).map(({ hsnSac, ...x }: any) => x);
    if (!items.length) return toast.error("Add at least one line");
    setBusy(send ? "send" : "save");
    try {
      const r = await api(isNew ? "/admin/quotes" : `/admin/quotes/${id}`, { method: isNew ? "POST" : "PUT", body: { userId: client.id, ...v, items, send } });
      toast.success(send ? `Quote ${r.quote.number} emailed to the customer` : "Quote saved");
      if (isNew) router.replace(`/admin/quotes/${r.quote.id}`);
      else reload();
    } catch (e: any) {
      toast.error(e.message);
    }
    setBusy(null);
  }
  const act = (path: string, body: unknown, ok: string, after?: (r: any) => void, method?: string) =>
    api(path, { body, method }).then((r) => { toast.success(ok); after ? after(r) : reload(); }).catch((e) => toast.error(e.message));

  return (
    <>
      <PageHeader icon="request_quote" back="/admin/quotes"
        title={isNew ? "New quote" : <span className="flex items-center gap-3">{q.number} <Badge status={q.status}>{q.status === "INVOICED" ? "accepted" : undefined}</Badge></span>}
        subtitle={isNew ? "Price a custom deal. Sending emails the customer a link to view and accept it." : <>{q.subject} · created {date(q.createdAt)}{q.sentAt && ` · sent ${date(q.sentAt)}`}</>}
        actions={!isNew && <>
          {data.invoice && <Button size="sm" icon="receipt_long" href={`/admin/invoices/${data.invoice.id}`}>Invoice {invNo(data.invoice)}</Button>}
          {!locked && q.status !== "DECLINED" && <Button size="sm" variant="secondary" icon="task_alt" onClick={() => confirm("Mark accepted on the customer's behalf? An invoice is created and emailed.") && act(`/admin/quotes/${id}/accept`, {}, "Accepted — invoice created", (r) => router.push(`/admin/invoices/${r.invoiceId}`))}>Accept → invoice</Button>}
          {!locked && q.status === "SENT" && <Button size="sm" variant="outline" icon="thumb_down" onClick={() => act(`/admin/quotes/${id}/status`, { status: "DECLINED" }, "Marked declined")}>Mark declined</Button>}
          {q.status === "DECLINED" && <Button size="sm" variant="outline" icon="replay" onClick={() => act(`/admin/quotes/${id}/status`, { status: "DRAFT" }, "Reopened as draft")}>Reopen</Button>}
          <Button size="sm" variant="outline" icon="content_copy" onClick={() => act(`/admin/quotes/${id}/duplicate`, {}, "Copied", (r) => router.push(`/admin/quotes/${r.quote.id}`))}>Duplicate</Button>
          {q.status !== "INVOICED" && <Button size="sm" variant="ghost" icon="delete" onClick={() => confirm("Delete this quote?") && act(`/admin/quotes/${id}`, undefined, "Deleted", () => router.push("/admin/quotes"), "DELETE")}>Delete</Button>}
        </>} />
      {locked && <Alert tone="success" className="mb-4">The customer accepted this quote{q.acceptedAt && ` on ${date(q.acceptedAt)}`} and it became an invoice — it can't be changed now. Edit the invoice if needed.</Alert>}
      {q?.status === "EXPIRED" && <Alert tone="warn" className="mb-4">This quote expired on {date(q.validUntil)}. Move the date forward and send it again if the offer still stands.</Alert>}
      <div className="grid items-start gap-6 xl:grid-cols-[minmax(0,1fr)_320px]">
        <Card title="Quote">
          <fieldset disabled={!!locked} className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-[1fr_120px_170px]">
              <Field label="Customer"><ClientPicker value={client} onChange={setClient} disabled={!isNew} /></Field>
              <Field label="Currency"><CurrencySelect value={v.currency} onChange={(c) => setV({ ...v, currency: c })} /></Field>
              <Field label="Valid until"><Input type="date" value={v.validUntil} onChange={(e) => setV({ ...v, validUntil: e.target.value })} /></Field>
            </div>
            <Field label="Subject"><Input value={v.subject} onChange={(e) => setV({ ...v, subject: e.target.value })} placeholder="e.g. Dedicated server — 2× Xeon, 128 GB RAM, 12 months" /></Field>
            <LineEditor lines={lines} onChange={setLines} currency={v.currency} hsn={false} />
            <Field label="Message to the customer" hint="Shown on the quote and in the email"><Textarea rows={3} value={v.customerNotes} onChange={(e) => setV({ ...v, customerNotes: e.target.value })} placeholder="Terms, delivery time, what's included…" /></Field>
            <Field label="Internal notes" hint="Staff only"><Textarea rows={2} value={v.adminNotes} onChange={(e) => setV({ ...v, adminNotes: e.target.value })} /></Field>
          </fieldset>
          {!locked && (
            <div className="mt-5 flex flex-wrap justify-end gap-2">
              <Button variant="outline" icon="save" loading={busy === "save"} disabled={!!busy || v.subject.trim().length < 2} onClick={() => save(false)}>{isNew ? "Save draft" : "Save"}</Button>
              <Button icon="send" loading={busy === "send"} disabled={!!busy || v.subject.trim().length < 2} onClick={() => save(true)}>{q?.sentAt ? "Save & re-send" : "Save & send to customer"}</Button>
            </div>
          )}
        </Card>
        <div className="space-y-6">
          <Card title="Summary">
            <dl className="space-y-2 text-sm">
              <div className="flex justify-between"><dt className="text-mute">Lines before tax</dt><dd className="font-semibold">{money(linesTotal(lines), v.currency)}</dd></div>
              {data?.breakdown && <>
                {data.breakdown.discount > 0 && <div className="flex justify-between"><dt className="text-mute">Discount</dt><dd className="font-semibold text-emerald-700">−{money(data.breakdown.discount, v.currency)}</dd></div>}
                <div className="flex justify-between"><dt className="text-mute">GST (saved)</dt><dd className="font-semibold">{money(data.breakdown.taxTotal, v.currency)}</dd></div>
                <div className="flex justify-between border-t border-line pt-2 text-base"><dt className="font-bold">Total (saved)</dt><dd className="font-black">{money(q.total, q.currency)}</dd></div>
              </>}
            </dl>
            <p className="mt-3 text-xs text-mute">GST is worked out from the customer's billing details when you save; the invoice recalculates it on acceptance.</p>
          </Card>
          {q && (
            <Card title="Timeline">
              <ul className="space-y-2 text-sm">
                <li className="flex justify-between"><span className="text-mute">Created</span><span>{date(q.createdAt, true)}</span></li>
                {q.sentAt && <li className="flex justify-between"><span className="text-mute">Sent</span><span>{date(q.sentAt, true)}</span></li>}
                {q.acceptedAt && <li className="flex justify-between"><span className="text-mute">Accepted</span><span>{date(q.acceptedAt, true)}</span></li>}
                {q.declinedAt && <li className="flex justify-between"><span className="text-mute">Declined</span><span>{date(q.declinedAt, true)}</span></li>}
              </ul>
              <Link href={`/admin/clients/${q.user.id}`} className="mt-4 block text-sm font-bold text-primary-dark hover:underline">{q.user.firstName} {q.user.lastName} →</Link>
            </Card>
          )}
        </div>
      </div>
    </>
  );
}
