"use client";
import Link from "next/link";
import { useState } from "react";
import { api, date, invNo, money } from "@/lib/api";
import { Alert, Badge, Button, Card, Empty, Field, Input, Loading, Modal, PageHeader, Pager, Select, Table, Td, Textarea, Toggle, toast, useApi } from "@/components/ui";
import { StatusTabs } from "@/components/admin/list-kit";
import { ClientPicker, CurrencySelect, dateInput, toPaise, toRupees } from "@/components/admin/billing-kit";

const ACTIONS: [string, string, string][] = [
  ["NEXT_INVOICE", "Add to the next invoice", "Rides along on their next renewal invoice (invoiced on its own after 30 days if none comes)"],
  ["NOW", "Invoice now", "Creates and emails an invoice straight away"],
  ["ON_DATE", "Invoice on a date", "Invoiced automatically on the date you pick"],
  ["RECURRING", "Recurring", "Invoiced on the date, then repeats every few months"],
];
const LABEL: Record<string, string> = { NOW: "Now", NEXT_INVOICE: "Next invoice", ON_DATE: "On date", RECURRING: "Recurring" };

export default function BillableItems() {
  const [status, setStatus] = useState("open");
  const [q, setQ] = useState("");
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  const [sel, setSel] = useState<string[]>([]);
  const [edit, setEdit] = useState<any | null>(null);
  const { data, loading, reload } = useApi(`/admin/billable-items?status=${status}&page=${page}&q=${encodeURIComponent(query)}`, [status, page, query]);
  const rows: any[] = data?.items ?? [];
  const selRows = rows.filter((r) => sel.includes(r.id));
  const oneCustomer = selRows.length > 0 && new Set(selRows.map((r) => r.userId)).size === 1;

  return (
    <>
      <PageHeader icon="playlist_add" title="Billable Items" subtitle="One-off and recurring charges that aren't products — setup work, extra IPs, consulting, hardware, overage. Bill them now, on a date, every month, or on the customer's next invoice."
        actions={<Button icon="add" onClick={() => setEdit({})}>Add billable item</Button>}
        stats={(data?.open ?? []).map((g: any) => [`Waiting to bill (${g.currency})`, money(g._sum.amount ?? 0, g.currency), `${g._count} item${g._count === 1 ? "" : "s"}`])} />
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <StatusTabs value={status} onChange={(k) => { setStatus(k); setPage(1); setSel([]); }} tabs={[{ key: "open", label: "Not yet billed", icon: "pending" }, { key: "billed", label: "Billed", icon: "task_alt", tone: "green" }, { key: "all", label: "All", icon: "list" }]} />
        <form onSubmit={(e) => { e.preventDefault(); setQuery(q); setPage(1); }} className="w-full sm:w-72"><Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search description or email" /></form>
      </div>
      {sel.length > 0 && (
        <div className="mb-3 flex flex-wrap items-center gap-2 rounded-2xl border border-primary/30 bg-white px-4 py-2.5 shadow-lg">
          <b className="text-sm">{sel.length} selected</b>
          <Button size="sm" icon="receipt_long" disabled={!oneCustomer} onClick={() => api("/admin/billable-items/invoice", { body: { ids: sel } }).then((r) => { toast.success("Invoice created and emailed"); setSel([]); reload(); window.location.href = `/admin/invoices/${r.invoiceId}`; }).catch((e) => toast.error(e.message))}>Invoice these now</Button>
          {!oneCustomer && <span className="text-xs text-mute">Pick one customer's items to invoice together</span>}
          <button className="ml-auto text-xs font-bold text-mute" onClick={() => setSel([])}>Clear</button>
        </div>
      )}
      <Card pad={false}>
        {loading ? <Loading /> : !rows.length ? <Empty icon="playlist_add" title={status === "open" ? "Nothing waiting to be billed" : "No billable items"}>Add a charge for a customer — it can be invoiced now, later, or every month.</Empty> : (
          <>
            <Table head={["", "Item", "Customer", "Amount", "When", "Status", ""]}>
              {rows.map((r) => (
                <tr key={r.id} className="hover:bg-primary-tint">
                  <Td>{!r.invoiced && <input type="checkbox" aria-label="Select" className="h-4 w-4 accent-primary" checked={sel.includes(r.id)} onChange={(e) => setSel(e.target.checked ? [...sel, r.id] : sel.filter((x) => x !== r.id))} />}</Td>
                  <Td><b className="text-ink">{r.description}</b>{r.notes && <div className="max-w-xs truncate text-xs text-mute">{r.notes}</div>}</Td>
                  <Td className="text-xs"><Link className="font-semibold text-primary-dark hover:underline" href={`/admin/clients/${r.user.id}`}>{r.user.firstName} {r.user.lastName}</Link><div className="text-mute">{r.user.email}</div></Td>
                  <Td className="whitespace-nowrap font-semibold">{money(r.amount * r.quantity, r.currency)}{r.quantity > 1 && <div className="text-xs font-normal text-mute">{r.quantity} × {money(r.amount, r.currency)}</div>}{!r.taxable && <div className="text-[11px] text-mute">no GST</div>}</Td>
                  <Td className="text-xs"><Badge status={r.invoiceAction}>{LABEL[r.invoiceAction]}</Badge>
                    <div className="mt-1 text-mute">{r.invoiceAction === "RECURRING" ? `every ${r.recurEveryMonths} mo · ${r.recurDone}${r.recurTimes ? `/${r.recurTimes}` : ""} billed${!r.invoiced && r.dueDate ? ` · next ${date(r.dueDate)}` : ""}` : r.invoiceAction === "ON_DATE" && r.dueDate ? date(r.dueDate) : ""}</div></Td>
                  <Td>{r.invoiced ? <Badge status="INVOICED">{r.invoiceAction === "RECURRING" ? "finished" : "invoiced"}</Badge> : <Badge status="PENDING">waiting</Badge>}{r.invoice && <Link className="mt-1 block text-xs font-bold text-primary-dark hover:underline" href={`/admin/invoices/${r.invoice.id}`}>{invNo(r.invoice)}</Link>}</Td>
                  <Td className="whitespace-nowrap text-right">
                    {!r.invoiced && <>
                      <Button size="sm" variant="ghost" icon="edit" onClick={() => setEdit(r)} aria-label="Edit" />
                      <Button size="sm" variant="ghost" icon={r.recurDone > 0 ? "stop_circle" : "delete"} aria-label={r.recurDone > 0 ? "Stop" : "Delete"} onClick={() => confirm(r.recurDone > 0 ? "Stop this recurring charge? Past invoices stay." : "Delete this item?") && api(`/admin/billable-items/${r.id}`, { method: "DELETE" }).then(() => { toast.success(r.recurDone > 0 ? "Stopped" : "Deleted"); reload(); }).catch((e) => toast.error(e.message))} />
                    </>}
                  </Td>
                </tr>
              ))}
            </Table>
            <Pager page={data.page} pageSize={data.pageSize} total={data.total} onPage={setPage} />
          </>
        )}
      </Card>
      {edit && <ItemModal item={edit} onClose={() => setEdit(null)} onDone={(r) => { setEdit(null); reload(); if (r?.invoiceId) toast.success("Invoice created and emailed to the customer"); }} />}
    </>
  );
}

function ItemModal({ item, onClose, onDone }: { item: any; onClose: () => void; onDone: (r: any) => void }) {
  const isNew = !item.id;
  const [client, setClient] = useState<any>(item.user ?? null);
  const [v, setV] = useState({
    description: item.description ?? "",
    amount: item.amount != null ? toRupees(item.amount) : "",
    quantity: String(item.quantity ?? 1),
    currency: item.currency ?? "INR",
    taxable: item.taxable ?? true,
    invoiceAction: item.invoiceAction ?? "NEXT_INVOICE",
    dueDate: dateInput(item.dueDate) || new Date(Date.now() + 86400_000).toISOString().slice(0, 10),
    recurEveryMonths: String(item.recurEveryMonths ?? 1),
    recurTimes: item.recurTimes ? String(item.recurTimes) : "",
    notes: item.notes ?? "",
  });
  const [busy, setBusy] = useState(false);
  const dated = v.invoiceAction === "ON_DATE" || v.invoiceAction === "RECURRING";
  async function save() {
    if (!client) return toast.error("Choose the customer");
    setBusy(true);
    const body = {
      userId: client.id,
      description: v.description,
      amount: toPaise(v.amount),
      quantity: Math.max(1, Number(v.quantity) || 1),
      currency: v.currency,
      taxable: v.taxable,
      invoiceAction: v.invoiceAction,
      dueDate: dated ? v.dueDate : null,
      recurEveryMonths: v.invoiceAction === "RECURRING" ? Number(v.recurEveryMonths) || 1 : null,
      recurTimes: v.invoiceAction === "RECURRING" && v.recurTimes ? Number(v.recurTimes) : null,
      notes: v.notes || null,
    };
    try {
      onDone(await api(isNew ? "/admin/billable-items" : `/admin/billable-items/${item.id}`, { method: isNew ? "POST" : "PUT", body }));
    } catch (e: any) {
      toast.error(e.message);
    }
    setBusy(false);
  }
  return (
    <Modal open onClose={onClose} title={isNew ? "Add billable item" : "Edit billable item"} wide>
      <div className="space-y-4">
        <Field label="Customer"><ClientPicker value={client} onChange={setClient} disabled={!isNew} /></Field>
        <Field label="Description (shown on the invoice)"><Input value={v.description} onChange={(e) => setV({ ...v, description: e.target.value })} placeholder="e.g. cPanel migration of 12 sites" /></Field>
        <div className="grid gap-4 sm:grid-cols-[1fr_100px_120px]">
          <Field label={`Price per unit (${v.currency})`} hint="Negative for a credit/discount"><Input type="number" step="0.01" value={v.amount} onChange={(e) => setV({ ...v, amount: e.target.value })} /></Field>
          <Field label="Quantity"><Input type="number" min={1} value={v.quantity} onChange={(e) => setV({ ...v, quantity: e.target.value })} /></Field>
          <Field label="Currency"><CurrencySelect value={v.currency} onChange={(c) => setV({ ...v, currency: c })} /></Field>
        </div>
        <Toggle checked={v.taxable} onChange={(x) => setV({ ...v, taxable: x })} label="Charge GST on this item" />
        <div>
          <div className="mb-2 text-[13px] font-bold text-slate-700">When should it be invoiced?</div>
          <div className="grid gap-2 sm:grid-cols-2">
            {ACTIONS.map(([k, title, text]) => (
              <button key={k} type="button" onClick={() => setV({ ...v, invoiceAction: k })} className={"rounded-xl border p-3 text-left transition " + (v.invoiceAction === k ? "border-primary bg-primary-tint ring-2 ring-primary/20" : "border-line hover:border-primary/40")}>
                <b className="text-sm text-ink">{title}</b><span className="mt-0.5 block text-[11.5px] leading-snug text-mute">{text}</span>
              </button>
            ))}
          </div>
        </div>
        {dated && (
          <div className="grid gap-4 sm:grid-cols-3">
            <Field label={v.invoiceAction === "RECURRING" ? "First invoice on" : "Invoice on"}><Input type="date" value={v.dueDate} onChange={(e) => setV({ ...v, dueDate: e.target.value })} /></Field>
            {v.invoiceAction === "RECURRING" && <>
              <Field label="Repeat every"><Select value={v.recurEveryMonths} onChange={(e) => setV({ ...v, recurEveryMonths: e.target.value })}>{[[1, "Month"], [3, "3 months"], [6, "6 months"], [12, "Year"]].map(([n, l]) => <option key={n} value={n}>{l}</option>)}</Select></Field>
              <Field label="Number of times" hint="Blank = until you stop it"><Input type="number" min={1} value={v.recurTimes} onChange={(e) => setV({ ...v, recurTimes: e.target.value })} /></Field>
            </>}
          </div>
        )}
        <Field label="Internal notes"><Textarea rows={2} value={v.notes} onChange={(e) => setV({ ...v, notes: e.target.value })} /></Field>
        {v.invoiceAction === "NOW" && <Alert tone="info">An invoice for {money(toPaise(v.amount) * Math.max(1, Number(v.quantity) || 1), v.currency)} (+ GST if applicable) will be created and emailed now.</Alert>}
        <div className="flex justify-end gap-2"><Button variant="outline" onClick={onClose}>Cancel</Button><Button icon="save" loading={busy} onClick={save} disabled={!v.description.trim() || !v.amount}>{v.invoiceAction === "NOW" ? "Save & invoice now" : "Save"}</Button></div>
      </div>
    </Modal>
  );
}
