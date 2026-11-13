"use client";
import { InvoiceSheet } from "@/components/invoice-sheet";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { LineEditor, dateInput, linesFromApi, linesToApi, type Line } from "@/components/admin/billing-kit";
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { api, date, money } from "@/lib/api";
import { Alert, Badge, Button, Card, Field, Icon, Input, Loading, Modal, PageHeader, Select, Textarea, Toggle, cx, toast, useApi } from "@/components/ui";

export default function AdminInvoice() {
  const { id } = useParams<{ id: string }>();
  const { data, loading, reload } = useApi(`/admin/invoices/${id}`);
  const [pay, setPay] = useState(false);
  const [cn, setCn] = useState(false);
  const [refund, setRefund] = useState(false);
  const [edit, setEdit] = useState(false);
  const [split, setSplit] = useState(false);
  const [mail, setMail] = useState(false);
  const router = useRouter();
  if (loading || !data) return <Loading />;
  const i = data.invoice;
  const editable = i.status === "UNPAID" || i.status === "DRAFT";
  const movable = editable && !(i.amountPaid > 0) && !i.number && !i.isWalletTopup;
  const run = (path: string, body: unknown, ok: string, after?: (r: any) => void, method?: string) =>
    api(path, { body, method }).then((r) => { toast.success(ok); after ? after(r) : reload(); }).catch((e) => toast.error(e.message));
  const more: [string, string, () => void, boolean?][] = [
    ...(editable ? ([["Apply account credit", "account_balance_wallet", () => run(`/admin/invoices/${id}/apply-credit`, {}, "Credit applied")]] as any) : []),
    ["Duplicate as draft", "content_copy", () => run(`/admin/invoices/${id}/duplicate`, {}, "Copy created as a draft", (r) => router.push(`/admin/invoices/${r.id}`))],
    ...(movable && i.items.length > 1 ? ([["Split into two invoices", "call_split", () => setSplit(true)]] as any) : []),
    ...(i.status === "UNPAID" || i.status === "PAID" ? ([["Email the customer…", "forward_to_inbox", () => setMail(true)]] as any) : []),
    ...(i.status === "UNPAID" && movable ? ([["Move back to draft", "edit_note", () => run(`/admin/invoices/${id}/status`, { status: "DRAFT" }, "Moved to draft — hidden from the customer")]] as any) : []),
    ...(i.status === "CANCELLED" && !i.number && !i.transactions.length ? ([["Reopen as unpaid", "replay", () => run(`/admin/invoices/${id}/status`, { status: "UNPAID", sendEmail: false }, "Reopened")]] as any) : []),
    ...(movable && !i.order ? ([["Delete invoice", "delete", () => confirm("Delete this invoice permanently? This can't be undone.") && run(`/admin/invoices/${id}`, undefined, "Invoice deleted", () => router.push("/admin/invoices"), "DELETE"), true]] as any) : []),
  ];
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
          {editable && <Button size="sm" variant="secondary" icon="edit" onClick={() => setEdit(true)}>Edit invoice</Button>}
          {i.status === "DRAFT" && <>
            <Button size="sm" icon="send" onClick={() => run(`/admin/invoices/${id}/status`, { status: "UNPAID", sendEmail: true }, "Invoice issued and emailed")}>Issue &amp; send</Button>
            <Button size="sm" variant="outline" onClick={() => run(`/admin/invoices/${id}/status`, { status: "UNPAID", sendEmail: false }, "Invoice issued")}>Issue without email</Button>
          </>}
          {i.status === "UNPAID" && <>
            <Button size="sm" icon="add_card" onClick={() => setPay(true)}>Record payment</Button>
            <Button size="sm" variant="outline" icon="mail" onClick={() => api(`/admin/invoices/${id}/remind`, { body: {} }).then(() => toast.success("Reminder sent"))}>Send reminder</Button>
            <Button size="sm" variant="outline" icon="chat" onClick={() => api(`/admin/invoices/${id}/whatsapp`, { body: {} }).then(() => toast.success("WhatsApp reminder queued")).catch((e) => toast.error(e.message))}>WhatsApp reminder</Button>
            <Button size="sm" variant="danger" onClick={() => confirm("Cancel invoice? Pending order services and IP holds will be released.") && api(`/admin/invoices/${id}/cancel`, { body: {} }).then(() => { toast.success("Cancelled"); reload(); }).catch((e) => toast.error(e.message))}>Cancel</Button>
          </>}
          {i.status === "PAID" && i.amountPaid > 0 && <Button size="sm" variant="danger" icon="currency_exchange" onClick={() => setRefund(true)}>Refund</Button>}
          {i.status === "PAID" && <Button size="sm" variant="outline" icon="undo" onClick={() => setCn(true)}>Credit note</Button>}
          <MoreMenu items={more} />
        </>} />
      {i.status === "DRAFT" && <Alert tone="warn" className="mb-4">This invoice is a <b>draft</b> — the customer can't see it yet. Edit it as needed, then <b>Issue &amp; send</b>.</Alert>}
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
      {edit && <EditModal inv={i} onClose={() => setEdit(false)} onDone={() => { setEdit(false); reload(); }} />}
      {split && <SplitModal inv={i} onClose={() => setSplit(false)} onDone={(nid) => { setSplit(false); toast.success("Split — opening the new invoice"); router.push(`/admin/invoices/${nid}`); }} />}
      <EmailModal open={mail} onClose={() => setMail(false)} id={id} status={i.status} />
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

function MoreMenu({ items }: { items: [string, string, () => void, boolean?][] }) {
  const [pos, setPos] = useState<{ top: number; right: number } | null>(null);
  return (
    <>
      <Button size="sm" variant="outline" icon="more_horiz" aria-haspopup="menu" aria-expanded={!!pos}
        onClick={(e) => { const r = (e.currentTarget as HTMLElement).getBoundingClientRect(); setPos(pos ? null : { top: r.bottom + 6, right: Math.max(8, window.innerWidth - r.right) }); }}>More</Button>
      {pos && typeof document !== "undefined" && createPortal(
        <>
          <div className="fixed inset-0 z-[90]" onClick={() => setPos(null)} />
          <div role="menu" style={{ top: pos.top, right: pos.right }} className="fixed z-[95] w-60 overflow-hidden rounded-xl border border-line bg-white py-1 shadow-xl">
            {items.map(([label, icon, fn, danger]) => (
              <button key={label} role="menuitem" type="button" onClick={() => { setPos(null); fn(); }} className={cx("flex w-full items-center gap-2.5 px-3.5 py-2.5 text-left text-sm font-semibold hover:bg-primary-tint", danger ? "text-rose-600" : "text-slate-700")}>
                <Icon name={icon} className="text-[19px]" />{label}
              </button>
            ))}
          </div>
        </>,
        document.body,
      )}
    </>
  );
}

/** Edit lines, dates, notes and the customer's GSTIN on an unpaid / draft invoice. */
function EditModal({ inv, onClose, onDone }: { inv: any; onClose: () => void; onDone: () => void }) {
  const [lines, setLines] = useState<Line[]>(() => linesFromApi(inv.items));
  const [v, setV] = useState({ issueDate: dateInput(inv.issueDate), dueDate: dateInput(inv.dueDate), notes: inv.notes ?? "", customerGstin: inv.customerGstin ?? "" });
  const [busy, setBusy] = useState(false);
  const linked = inv.items.filter((x: any) => x.relId && ["SERVICE", "ADDON", "DOMAIN"].includes(x.type)).map((x: any) => x.id);
  async function save() {
    setBusy(true);
    try {
      const r = await api(`/admin/invoices/${inv.id}`, { method: "PUT", body: { items: linesToApi(lines), issueDate: v.issueDate || undefined, dueDate: v.dueDate || undefined, notes: v.notes, customerGstin: v.customerGstin } });
      toast.success(r.paid ? "Saved — the new total is already covered, so it's marked paid" : "Invoice updated");
      onDone();
    } catch (e: any) {
      toast.error(e.message);
    }
    setBusy(false);
  }
  return (
    <Modal open onClose={onClose} title={`Edit invoice ${inv.number ?? inv.proformaNumber}`} wide>
      <div className="space-y-4">
        <LineEditor lines={lines} onChange={setLines} currency={inv.currency} />
        {lines.some((l) => linked.includes(l.id)) && <p className="text-xs text-mute"><Icon name="link" className="mr-1 align-[-3px] text-[15px]" />Lines for services, addons and domains stay linked — paying the invoice still renews them. Removing one means it won't be renewed by this invoice.</p>}
        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="Invoice date"><Input type="date" value={v.issueDate} onChange={(e) => setV({ ...v, issueDate: e.target.value })} /></Field>
          <Field label="Due date"><Input type="date" value={v.dueDate} onChange={(e) => setV({ ...v, dueDate: e.target.value })} /></Field>
          <Field label="Customer GSTIN" hint="Blank = unregistered"><Input value={v.customerGstin} onChange={(e) => setV({ ...v, customerGstin: e.target.value.toUpperCase() })} placeholder="09ABCDE1234F1Z5" /></Field>
        </div>
        <Field label="Notes on the invoice"><Textarea rows={3} value={v.notes} onChange={(e) => setV({ ...v, notes: e.target.value })} /></Field>
        {inv.amountPaid > 0 && <Alert tone="info">{money(inv.amountPaid, inv.currency)} is already paid on this invoice — the new total can't go below that.</Alert>}
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button icon="save" loading={busy} onClick={save} disabled={!lines.some((l) => l.description.trim())}>Save changes</Button>
        </div>
        <p className="text-xs text-mute">GST, totals and place of supply are recalculated when you save.</p>
      </div>
    </Modal>
  );
}

function SplitModal({ inv, onClose, onDone }: { inv: any; onClose: () => void; onDone: (id: string) => void }) {
  const [pick, setPick] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  return (
    <Modal open onClose={onClose} title="Split invoice">
      <p className="mb-3 text-sm text-mute">Tick the lines to move to a new invoice. The rest stay here; totals and GST are recalculated on both.</p>
      <ul className="divide-y divide-line rounded-xl border border-line">
        {inv.items.map((x: any) => (
          <li key={x.id}><label className="flex cursor-pointer items-center gap-3 px-3 py-2.5 text-sm">
            <input type="checkbox" className="h-4 w-4 accent-primary" checked={pick.includes(x.id)} onChange={(e) => setPick(e.target.checked ? [...pick, x.id] : pick.filter((p) => p !== x.id))} />
            <span className="min-w-0 flex-1 truncate">{x.description}</span><b>{money(x.amount, inv.currency)}</b>
          </label></li>
        ))}
      </ul>
      <div className="mt-4 flex justify-end">
        <Button icon="call_split" loading={busy} disabled={!pick.length || pick.length === inv.items.length} onClick={async () => {
          setBusy(true);
          try { onDone((await api(`/admin/invoices/${inv.id}/split`, { body: { itemIds: pick } })).id); } catch (e: any) { toast.error(e.message); }
          setBusy(false);
        }}>Move {pick.length || ""} line{pick.length === 1 ? "" : "s"} to a new invoice</Button>
      </div>
    </Modal>
  );
}

const TEMPLATES = [
  ["created", "Invoice created", "The invoice with a pay-now link"],
  ["reminder", "Payment reminder", "A friendly reminder before or on the due date"],
  ["overdue", "Overdue notice", "The invoice is past due"],
  ["paid", "Payment confirmation", "Receipt for a paid invoice"],
] as const;
function EmailModal({ open, onClose, id, status }: { open: boolean; onClose: () => void; id: string; status: string }) {
  const [t, setT] = useState<string>(status === "PAID" ? "paid" : "created");
  return (
    <Modal open={open} onClose={onClose} title="Email the customer">
      <div className="space-y-2">
        {TEMPLATES.map(([k, title, text]) => (
          <label key={k} className={cx("flex cursor-pointer items-start gap-3 rounded-xl border p-3", t === k ? "border-primary bg-primary-tint" : "border-line")}>
            <input type="radio" className="mt-1 accent-primary" checked={t === k} onChange={() => setT(k)} />
            <span><b className="text-sm">{title}</b><span className="block text-xs text-mute">{text}</span></span>
          </label>
        ))}
      </div>
      <div className="mt-4 flex justify-end"><Button icon="send" onClick={() => api(`/admin/invoices/${id}/email`, { body: { template: t } }).then(() => { toast.success("Email queued"); onClose(); }).catch((e) => toast.error(e.message))}>Send email</Button></div>
    </Modal>
  );
}
