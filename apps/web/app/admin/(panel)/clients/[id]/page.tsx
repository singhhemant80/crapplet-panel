"use client";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useState } from "react";
import { api, date, invNo, money } from "@/lib/api";
import { Badge, Button, Card, Field, Input, Loading, Modal, PageHeader, Select, Table, Td, Textarea, cx, toast, useApi } from "@/components/ui";

export default function ClientDetail() {
  const { id } = useParams<{ id: string }>();
  const { data, loading, reload } = useApi(`/admin/clients/${id}`);
  const [tab, setTab] = useState("services");
  const [credit, setCredit] = useState(false);
  const [invoice, setInvoice] = useState(false);
  if (loading || !data) return <Loading />;
  const c = data.client;
  const p = c.profile ?? {};
  return (
    <>
      <PageHeader back="/admin/clients" title={<span className="flex items-center gap-3">{c.firstName} {c.lastName} <Badge status={c.status} /></span>} subtitle={`${c.email} · ${c.phone ?? ""} · customer since ${date(c.createdAt)}`}
        actions={<>
          <Button variant="outline" size="sm" icon="add_card" onClick={() => setCredit(true)}>Adjust credit</Button>
          <Button variant="outline" size="sm" icon="receipt" onClick={() => setInvoice(true)}>New invoice</Button>
          <Select className="h-9 w-36" value={c.status} onChange={(e) => api(`/admin/clients/${id}`, { method: "PUT", body: { status: e.target.value } }).then(() => { toast.success("Status updated"); reload(); })}><option>ACTIVE</option><option>INACTIVE</option><option>CLOSED</option></Select>
        </>} />
      <div className="mb-6 grid gap-6 lg:grid-cols-3">
        <Card title="Billing profile">
          <dl className="space-y-1.5 text-sm">
            <div className="font-bold text-ink">{p.companyName ?? `${c.firstName} ${c.lastName}`}</div>
            <div className="text-mute">{p.address1}{p.address2 ? `, ${p.address2}` : ""}</div>
            <div className="text-mute">{[p.city, p.state, p.postcode].filter(Boolean).join(", ")} · {p.country}</div>
            <div>GSTIN: <span className="font-mono">{p.gstin ?? "—"}</span> · State code {p.stateCode ?? "—"}</div>
            <div>PAN: <span className="font-mono">{p.pan ?? "—"}</span></div>
          </dl>
        </Card>
        <Card title="Account">
          <dl className="space-y-1.5 text-sm">
            <div className="flex justify-between"><span className="text-mute">Credit balance</span><b>{money(p.creditBalance)}</b></div>
            <div className="flex justify-between"><span className="text-mute">Email verified</span><b>{c.emailVerified ? "Yes" : "No"}</b></div>
            <div className="flex justify-between"><span className="text-mute">2FA</span><b>{c.totpEnabled ? "Enabled" : "Off"}</b></div>
            <div className="flex justify-between"><span className="text-mute">Reseller</span><b>{c.reseller ? `${c.reseller.brandName} (${c.reseller.status})` : "—"}</b></div>
            <div className="flex justify-between"><span className="text-mute">Affiliate</span><b>{c.affiliate?.code ?? "—"}</b></div>
          </dl>
          {c.totpEnabled && <Button size="sm" variant="ghost" className="mt-2" onClick={() => api(`/admin/clients/${id}/reset-2fa`, { body: {} }).then(() => { toast.success("2FA reset"); reload(); })}>Reset 2FA</Button>}
        </Card>
        <Card title="Staff notes">
          <Textarea rows={5} defaultValue={p.notes ?? ""} onBlur={(e) => api(`/admin/clients/${id}`, { method: "PUT", body: { notes: e.target.value } }).then(() => toast.success("Notes saved"))} placeholder="Private notes (saved on blur)" />
        </Card>
      </div>
      <div className="mb-4 flex gap-2 overflow-x-auto">
        {["services", "invoices", "transactions", "tickets", "domains", "credit", "logins"].map((t) => <button key={t} onClick={() => setTab(t)} className={cx("rounded-full px-4 py-2 text-sm font-bold capitalize", tab === t ? "bg-primary-dark text-white" : "bg-white text-slate-600 ring-1 ring-line")}>{t}</button>)}
      </div>
      <Card pad={false}>
        {tab === "services" && <Table head={["Service", "Hostname / IP", "Status", "Recurring", "Next due"]}>{data.services.map((s: any) => <tr key={s.id}><Td><Link className="font-bold text-primary-dark" href={`/admin/services/${s.id}`}>{s.product.name}</Link></Td><Td>{s.hostname}<div className="font-mono text-xs text-mute">{s.ips.map((i: any) => i.address).join(", ")}</div></Td><Td><Badge status={s.status} /></Td><Td>{money(s.recurringAmount)}</Td><Td>{date(s.nextDueDate)}</Td></tr>)}</Table>}
        {tab === "invoices" && <Table head={["Invoice", "Date", "Total", "Status"]}>{data.invoices.map((i: any) => <tr key={i.id}><Td><Link className="font-bold text-primary-dark" href={`/admin/invoices/${i.id}`}>{invNo(i)}</Link></Td><Td>{date(i.issueDate)}</Td><Td>{money(i.total)}</Td><Td><Badge status={i.status} /></Td></tr>)}</Table>}
        {tab === "transactions" && <Table head={["Date", "Gateway", "Reference", "Type", "Amount"]}>{data.transactions.map((t: any) => <tr key={t.id}><Td>{date(t.createdAt, true)}</Td><Td>{t.gateway}</Td><Td className="font-mono text-xs">{t.gatewayTxnId}</Td><Td>{t.type}</Td><Td>{money(t.amount)}</Td></tr>)}</Table>}
        {tab === "tickets" && <Table head={["Ticket", "Subject", "Department", "Status"]}>{data.tickets.map((t: any) => <tr key={t.id}><Td>#{t.number}</Td><Td><Link className="font-bold text-primary-dark" href={`/admin/tickets/${t.id}`}>{t.subject}</Link></Td><Td>{t.department.name}</Td><Td><Badge status={t.status} /></Td></tr>)}</Table>}
        {tab === "domains" && <Table head={["Domain", "Status", "Expiry"]}>{data.domains.map((d: any) => <tr key={d.id}><Td className="font-bold">{d.name}</Td><Td><Badge status={d.status} /></Td><Td>{date(d.expiryDate)}</Td></tr>)}</Table>}
        {tab === "credit" && <Table head={["Date", "Description", "Amount", "Balance"]}>{data.ledger.map((l: any) => <tr key={l.id}><Td>{date(l.createdAt, true)}</Td><Td>{l.description}</Td><Td className={l.amount < 0 ? "text-rose-600" : "text-emerald-600"}>{money(l.amount)}</Td><Td>{money(l.balanceAfter)}</Td></tr>)}</Table>}
        {tab === "logins" && <Table head={["Time", "IP", "Result"]}>{data.logins.map((l: any) => <tr key={l.id}><Td>{date(l.createdAt, true)}</Td><Td className="font-mono text-xs">{l.ip}</Td><Td>{l.success ? <Badge status="ACTIVE">ok</Badge> : <Badge status="FAILED">{l.reason}</Badge>}</Td></tr>)}</Table>}
      </Card>
      <CreditModal open={credit} onClose={() => setCredit(false)} id={id} onDone={reload} />
      <InvoiceModal open={invoice} onClose={() => setInvoice(false)} id={id} onDone={reload} />
    </>
  );
}

function CreditModal({ open, onClose, id, onDone }: any) {
  const [amount, setAmount] = useState("");
  const [description, setDescription] = useState("");
  return (
    <Modal open={open} onClose={onClose} title="Adjust credit balance">
      <div className="space-y-4">
        <Field label="Amount (₹)" hint="Use a negative number to deduct."><Input type="number" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} /></Field>
        <Field label="Reason"><Input value={description} onChange={(e) => setDescription(e.target.value)} /></Field>
        <Button onClick={() => api(`/admin/clients/${id}/credit`, { body: { amount: Math.round(Number(amount) * 100), description } }).then(() => { toast.success("Credit updated"); onClose(); onDone(); }).catch((e) => toast.error(e.message))}>Save</Button>
      </div>
    </Modal>
  );
}

function InvoiceModal({ open, onClose, id, onDone }: any) {
  const [items, setItems] = useState([{ description: "", price: "", taxable: true }]);
  const [due, setDue] = useState("");
  return (
    <Modal open={open} onClose={onClose} title="Create invoice" wide>
      <div className="space-y-3">
        {items.map((it, i) => (
          <div key={i} className="grid gap-2 sm:grid-cols-[1fr_140px_auto]">
            <Input placeholder="Description" value={it.description} onChange={(e) => setItems(items.map((x, j) => (j === i ? { ...x, description: e.target.value } : x)))} />
            <Input placeholder="₹ amount" type="number" value={it.price} onChange={(e) => setItems(items.map((x, j) => (j === i ? { ...x, price: e.target.value } : x)))} />
            <label className="flex items-center gap-1 text-xs font-semibold"><input type="checkbox" checked={it.taxable} onChange={(e) => setItems(items.map((x, j) => (j === i ? { ...x, taxable: e.target.checked } : x)))} /> GST</label>
          </div>
        ))}
        <Button size="sm" variant="ghost" icon="add" onClick={() => setItems([...items, { description: "", price: "", taxable: true }])}>Add line</Button>
        <Field label="Due date"><Input type="date" value={due} onChange={(e) => setDue(e.target.value)} /></Field>
        <Button onClick={() => api("/admin/invoices", { body: { userId: id, dueDate: due || undefined, items: items.filter((x) => x.description).map((x) => ({ description: x.description, unitPrice: Math.round(Number(x.price) * 100), taxable: x.taxable })) } }).then(() => { toast.success("Invoice created and emailed"); onClose(); onDone(); }).catch((e) => toast.error(e.message))}>Create &amp; email</Button>
      </div>
    </Modal>
  );
}
