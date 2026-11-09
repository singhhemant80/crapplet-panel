"use client";
import { useState } from "react";
import { api, date, money } from "@/lib/api";
import { Badge, Button, Card, Field, Input, Loading, Modal, PageHeader, Pager, Select, Table, Td, cx, toast, useApi } from "@/components/ui";
import { ResourceManager } from "@/components/admin/resource";

export default function Domains() {
  const [tab, setTab] = useState<"domains" | "pricing">("domains");
  return (
    <>
      <div className="mb-4 flex gap-2">{(["domains", "pricing"] as const).map((t) => <button key={t} onClick={() => setTab(t)} className={cx("rounded-full px-4 py-2 text-sm font-bold capitalize", tab === t ? "bg-primary-dark text-white" : "bg-white text-slate-600 ring-1 ring-line")}>{t === "pricing" ? "TLD pricing" : "Domains"}</button>)}</div>
      {tab === "domains" ? <DomainList /> : (
        <ResourceManager title="TLD pricing" subtitle="Per-year prices. Registrar 'manual' = staff completes registration at your registrar." endpoint="/admin/domain-pricing" idKey="tld"
          fields={[{ key: "tld", label: "TLD", required: true, placeholder: ".in" }, { key: "register", label: "Register / yr", type: "money" }, { key: "transfer", label: "Transfer", type: "money" }, { key: "renew", label: "Renew / yr", type: "money" }, { key: "usdRegister", label: "Register / yr", type: "money", currency: "USD", json: { column: "prices", path: ["USD", "register"] }, hint: "Blank = auto-convert from INR" }, { key: "usdTransfer", label: "Transfer", type: "money", currency: "USD", json: { column: "prices", path: ["USD", "transfer"] } }, { key: "usdRenew", label: "Renew / yr", type: "money", currency: "USD", json: { column: "prices", path: ["USD", "renew"] } }, { key: "registrar", label: "Registrar module", default: "manual" }, { key: "enabled", label: "Enabled", type: "bool", default: true }]}
          columns={[{ label: "TLD", render: (r) => <b>{r.tld}</b> }, { label: "Register", render: (r) => money(r.register) }, { label: "Transfer", render: (r) => money(r.transfer) }, { label: "Renew", render: (r) => money(r.renew) }, { label: "USD reg.", render: (r) => (r.prices?.USD?.register !== undefined ? money(r.prices.USD.register, "USD") : <span className="text-xs text-mute">auto</span>) }, { label: "Registrar", render: (r) => r.registrar }]} />
      )}
    </>
  );
}

function DomainList() {
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState("");
  const { data, loading, reload } = useApi(`/admin/domains?page=${page}&status=${status}`, [page, status]);
  const [edit, setEdit] = useState<any>(null);
  return (
    <>
      <PageHeader title="Domains" actions={<Select className="w-48" value={status} onChange={(e) => setStatus(e.target.value)}><option value="">All</option>{["PENDING", "PENDING_TRANSFER", "ACTIVE", "EXPIRED", "CANCELLED"].map((s) => <option key={s}>{s}</option>)}</Select>} />
      <Card pad={false}>
        {loading ? <Loading /> : (
          <>
            <Table head={["Domain", "Customer", "Action", "Status", "Expiry", "Renewal", ""]}>
              {data.domains.map((d: any) => <tr key={d.id}><Td className="font-bold">{d.name}</Td><Td className="text-xs">{d.user.email}</Td><Td className="capitalize">{d.action}{d.hasEpp && " (EPP)"}</Td><Td><Badge status={d.status} /></Td><Td>{date(d.expiryDate)}</Td><Td>{money(d.recurringAmount, d.currency)}</Td><Td className="text-right"><button className="text-sm font-bold text-primary-dark" onClick={() => setEdit({ ...d, expiryDate: d.expiryDate?.slice(0, 10) ?? "", registrationDate: d.registrationDate?.slice(0, 10) ?? "" })}>Manage</button></Td></tr>)}
            </Table>
            <Pager page={data.page} pageSize={data.pageSize} total={data.total} onPage={setPage} />
          </>
        )}
      </Card>
      <Modal open={!!edit} onClose={() => setEdit(null)} title={edit?.name}>
        {edit && <div className="space-y-4">
          <Field label="Status"><Select value={edit.status} onChange={(e) => setEdit({ ...edit, status: e.target.value })}>{["PENDING", "PENDING_TRANSFER", "ACTIVE", "EXPIRED", "CANCELLED", "TRANSFERRED_AWAY"].map((s) => <option key={s}>{s}</option>)}</Select></Field>
          <Field label="Registration date"><Input type="date" value={edit.registrationDate} onChange={(e) => setEdit({ ...edit, registrationDate: e.target.value })} /></Field>
          <Field label="Expiry date"><Input type="date" value={edit.expiryDate} onChange={(e) => setEdit({ ...edit, expiryDate: e.target.value })} /></Field>
          <Field label="Registrar"><Input value={edit.registrar} onChange={(e) => setEdit({ ...edit, registrar: e.target.value })} /></Field>
          <Button onClick={() => api(`/admin/domains/${edit.id}`, { method: "PUT", body: { status: edit.status, registrar: edit.registrar, registrationDate: edit.registrationDate || null, expiryDate: edit.expiryDate || null } }).then(() => { toast.success("Saved"); setEdit(null); reload(); }).catch((e) => toast.error(e.message))}>Save</Button>
        </div>}
      </Modal>
    </>
  );
}
