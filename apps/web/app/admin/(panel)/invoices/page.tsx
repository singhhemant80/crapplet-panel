"use client";
import Link from "next/link";
import { InvoiceFor } from "@/components/invoice-for";
import { Suspense, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { api, date, invNo, money } from "@/lib/api";
import { Badge, Button, Card, Field, Input, Loading, Modal, PageHeader, Pager, Select, Table, Td, Textarea, Toggle, cx, toast, useApi } from "@/components/ui";
import { ClientPicker, CurrencySelect, LineEditor, newLine, linesToApi, type Line } from "@/components/admin/billing-kit";

const BULK: [string, string, string, boolean?][] = [
  ["mark_paid", "Mark paid", "price_check", true],
  ["send", "Send invoice email", "send"],
  ["remind", "Send reminder", "notifications"],
  ["apply_credit", "Apply credit", "account_balance_wallet"],
  ["issue", "Issue drafts", "task_alt"],
  ["cancel", "Cancel", "block", true],
  ["delete", "Delete", "delete", true],
];

function Invoices() {
  const sp = useSearchParams();
  const [status, setStatus] = useState(sp.get("status") ?? "");
  const [overdue, setOverdue] = useState("");
  const [q, setQ] = useState("");
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  const [sel, setSel] = useState<string[]>([]);
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState(false);
  const router = useRouter();
  const { data, loading, reload } = useApi(`/admin/invoices?page=${page}&status=${status}&overdue=${overdue}&q=${encodeURIComponent(query)}`, [page, status, overdue, query]);
  return (
    <>
      <PageHeader title="Invoices" actions={<Button icon="add" onClick={() => setCreating(true)}>New invoice</Button>} />
      <div className="mb-4 grid gap-3 sm:grid-cols-[1fr_180px_180px]">
        <form onSubmit={(e) => { e.preventDefault(); setQuery(q); setPage(1); }}><Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Invoice number or customer email" /></form>
        <Select value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }}><option value="">All statuses</option>{["DRAFT", "UNPAID", "PAID", "CANCELLED", "REFUNDED"].map((s) => <option key={s}>{s}</option>)}</Select>
        <Select value={overdue} onChange={(e) => { setOverdue(e.target.value); setPage(1); }}><option value="">Any due date</option><option value="1">Overdue only</option></Select>
      </div>
      {(data?.sumsByCurrency ?? []).map((g: any) => (
        <div key={g.currency} className="mb-2 flex flex-wrap gap-6 text-sm text-mute">
          <span className="font-extrabold text-ink">{g.currency}</span>
          <span>Total <b className="text-ink">{money(g.total, g.currency)}</b></span>
          <span>Collected <b className="text-ink">{money(g.amountPaid, g.currency)}</b></span>
          {g.taxTotal > 0 && <span>GST <b className="text-ink">{money(g.taxTotal, g.currency)}</b></span>}
        </div>
      ))}
      {sel.length > 0 && (
        <div className="sticky top-2 z-20 mb-3 flex flex-wrap items-center gap-2 rounded-2xl border border-primary/30 bg-white/95 px-4 py-2.5 shadow-lg backdrop-blur">
          <b className="mr-1 text-sm">{sel.length} selected</b>
          {BULK.map(([k, label, icon, danger]) => <Button key={k} size="sm" variant={danger ? "outline" : "secondary"} icon={icon} disabled={busy} onClick={() => bulk(k, label, danger)}>{label}</Button>)}
          {sel.length > 1 && <Button size="sm" variant="secondary" icon="merge" disabled={busy} onClick={merge}>Merge</Button>}
          <button className="ml-auto text-xs font-bold text-mute hover:text-ink" onClick={() => setSel([])}>Clear</button>
        </div>
      )}
      <Card pad={false}>
        {loading ? <Loading /> : (
          <>
            <Table head={[<input key="all" type="checkbox" aria-label="Select all" className="h-4 w-4 accent-primary" checked={data.invoices.length > 0 && data.invoices.every((i: any) => sel.includes(i.id))} onChange={(e) => setSel(e.target.checked ? [...new Set([...sel, ...data.invoices.map((i: any) => i.id)])] : sel.filter((x) => !data.invoices.some((i: any) => i.id === x)))} />, "Invoice", "Customer", "For", "Issued", "Due", "Total", "GST", "Status"]}>
              {data.invoices.map((i: any) => (
                <tr key={i.id} className={sel.includes(i.id) ? "bg-primary-tint/70" : "hover:bg-primary-tint"}>
                  <Td><input type="checkbox" aria-label={`Select ${invNo(i)}`} className="h-4 w-4 accent-primary" checked={sel.includes(i.id)} onChange={(e) => setSel(e.target.checked ? [...sel, i.id] : sel.filter((x) => x !== i.id))} /></Td>
                  <Td className="whitespace-nowrap"><Link href={`/admin/invoices/${i.id}`} className="font-bold text-ink hover:text-primary-dark">{invNo(i)}</Link></Td>
                  <Td className="text-xs"><div className="max-w-[200px] truncate">{i.user.firstName} {i.user.lastName}</div><div className="max-w-[200px] truncate text-mute">{i.user.email}</div></Td>
                  <Td><InvoiceFor inv={i} audience="admin" /></Td>
                  <Td className="whitespace-nowrap text-mute">{date(i.issueDate)}</Td>
                  <Td className={cx("whitespace-nowrap", i.status === "UNPAID" && new Date(i.dueDate) < new Date() ? "font-bold text-rose-600" : "text-mute")}>{date(i.dueDate)}</Td>
                  <Td className="whitespace-nowrap font-semibold">{money(i.total, i.currency)}</Td>
                  <Td className="whitespace-nowrap text-xs text-mute">{money(i.taxTotal, i.currency)}</Td>
                  <Td><Badge status={i.status} /></Td>
                </tr>
              ))}
            </Table>
            <Pager page={data.page} pageSize={data.pageSize} total={data.total} onPage={setPage} />
          </>
        )}
      </Card>
      {creating && <NewInvoice onClose={() => setCreating(false)} onDone={(id) => router.push(`/admin/invoices/${id}`)} />}
    </>
  );

  async function bulk(action: string, label: string, danger?: boolean) {
    let reference: string | undefined;
    if (action === "mark_paid") {
      const r = prompt(`Mark ${sel.length} invoice(s) paid in full.\nPayment reference (bank UTR / note):`, "");
      if (r === null) return;
      reference = r.trim() || undefined;
    } else if (danger && !confirm(`${label} ${sel.length} invoice(s)?`)) return;
    setBusy(true);
    try {
      const r = await api("/admin/invoices/bulk", { body: { ids: sel, action, reference } });
      if (r.failed?.length) toast.error(`${r.ok} done, ${r.failed.length} skipped: ${r.failed[0].error}`);
      else toast.success(`${label}: ${r.ok} done`);
      setSel([]);
      reload();
    } catch (e: any) {
      toast.error(e.message);
    }
    setBusy(false);
  }
  async function merge() {
    if (!confirm(`Merge ${sel.length} invoices into one? The lines move to the earliest-due invoice and the others are removed.`)) return;
    setBusy(true);
    try {
      const r = await api("/admin/invoices/merge", { body: { ids: sel } });
      toast.success("Merged");
      router.push(`/admin/invoices/${r.id}`);
    } catch (e: any) {
      toast.error(e.message);
    }
    setBusy(false);
  }
}

function NewInvoice({ onClose, onDone }: { onClose: () => void; onDone: (id: string) => void }) {
  const [client, setClient] = useState<any>(null);
  const [lines, setLines] = useState<Line[]>([newLine()]);
  const [v, setV] = useState({ currency: "INR", dueDate: new Date(Date.now() + 7 * 86400_000).toISOString().slice(0, 10), notes: "", draft: false, sendEmail: true });
  const [busy, setBusy] = useState(false);
  async function save() {
    if (!client) return toast.error("Choose the customer");
    const items = linesToApi(lines, false);
    if (!items.length) return toast.error("Add at least one line");
    setBusy(true);
    try {
      const r = await api("/admin/invoices", { body: { userId: client.id, currency: v.currency, dueDate: v.dueDate || undefined, notes: v.notes || undefined, draft: v.draft, sendEmail: v.sendEmail && !v.draft, items } });
      toast.success(v.draft ? "Draft saved" : "Invoice created");
      onDone(r.id);
    } catch (e: any) {
      toast.error(e.message);
    }
    setBusy(false);
  }
  return (
    <Modal open onClose={onClose} title="New invoice" wide>
      <div className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-[1fr_120px_170px]">
          <Field label="Customer"><ClientPicker value={client} onChange={setClient} /></Field>
          <Field label="Currency"><CurrencySelect value={v.currency} onChange={(c) => setV({ ...v, currency: c })} /></Field>
          <Field label="Due date"><Input type="date" value={v.dueDate} onChange={(e) => setV({ ...v, dueDate: e.target.value })} /></Field>
        </div>
        <LineEditor lines={lines} onChange={setLines} currency={v.currency} />
        <Field label="Notes (shown on the invoice)"><Textarea rows={2} value={v.notes} onChange={(e) => setV({ ...v, notes: e.target.value })} /></Field>
        <div className="flex flex-wrap gap-6">
          <Toggle checked={v.draft} onChange={(x) => setV({ ...v, draft: x })} label="Save as draft (customer can't see it yet)" />
          {!v.draft && <Toggle checked={v.sendEmail} onChange={(x) => setV({ ...v, sendEmail: x })} label="Email it to the customer" />}
        </div>
        <div className="flex justify-end gap-2"><Button variant="outline" onClick={onClose}>Cancel</Button><Button icon="receipt_long" loading={busy} onClick={save}>{v.draft ? "Save draft" : "Create invoice"}</Button></div>
      </div>
    </Modal>
  );
}
export default function Page() { return <Suspense><Invoices /></Suspense>; }
