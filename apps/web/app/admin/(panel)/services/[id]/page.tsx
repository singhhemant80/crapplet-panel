"use client";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useState } from "react";
import { api, CYCLES, date, invNo, money } from "@/lib/api";
import { Alert, Badge, Button, Card, Copy, Field, Icon, Input, Loading, PageHeader, Select, Table, Td, Textarea, Toggle, toast, useApi } from "@/components/ui";

export default function AdminService() {
  const { id } = useParams<{ id: string }>();
  const { data, loading, reload } = useApi(`/admin/services/${id}`);
  const os = useApi("/admin/os-templates");
  const [live, setLive] = useState<any>(null);
  const [cred, setCred] = useState<any>(null);
  const [edit, setEdit] = useState<any>(null);
  useEffect(() => {
    if (data?.service?.status === "ACTIVE" && data.service.remoteId) api(`/admin/services/${id}/live`).then((r) => setLive(r.live)).catch(() => {});
    if (data?.service) setEdit({ nextDueDate: data.service.nextDueDate?.slice(0, 10) ?? "", recurringAmount: data.service.recurringAmount / 100, billingCycle: data.service.billingCycle, hostname: data.service.hostname ?? "", overrideAutoSuspend: data.service.overrideAutoSuspend, notes: data.service.notes ?? "", node: data.service.node ?? "", remoteId: data.service.remoteId ?? "" });
  }, [data, id]);
  if (loading || !data || !edit) return <Loading />;
  const s = data.service;
  const act = (action: string, extra: Record<string, unknown> = {}) => api(`/admin/services/${id}/action`, { body: { action, ...extra } }).then(() => { toast.success(`${action} queued`); setTimeout(reload, 3000); }).catch((e) => toast.error(e.message));
  const isVps = s.product.provisioner === "PROXMOX" || s.product.provisioner === "VIRTUALIZOR";
  return (
    <>
      <PageHeader back="/admin/services" title={<span className="flex items-center gap-3">{s.product.name} <Badge status={s.status} /></span>} subtitle={<span>{s.hostname} · <Link className="font-bold text-primary-dark" href={`/admin/clients/${s.user.id}`}>{s.user.email}</Link>{s.reseller && ` · via reseller ${s.reseller.brandName}`}</span>} />
      {s.status === "FAILED" && <Alert tone="error" className="mb-5">Provisioning failed — see the log below, fix the cause (template, capacity, IPs) and retry.</Alert>}
      <Card title="Actions" className="mb-6">
        <div className="flex flex-wrap gap-2">
          {(s.status === "PENDING" || s.status === "FAILED" || s.status === "PROVISIONING") && <Button icon="rocket_launch" onClick={() => act("create")}>{s.status === "FAILED" ? "Retry provisioning" : "Provision now"}</Button>}
          {isVps && s.status === "ACTIVE" && <>
            <Button variant="outline" size="sm" icon="play_arrow" onClick={() => act("start")}>Start</Button>
            <Button variant="outline" size="sm" icon="restart_alt" onClick={() => act("reboot")}>Reboot</Button>
            <Button variant="outline" size="sm" icon="power_settings_new" onClick={() => act("shutdown")}>Shutdown</Button>
            <Button variant="outline" size="sm" icon="stop" onClick={() => act("stop")}>Power off</Button>
            <Button variant="outline" size="sm" icon="key" onClick={() => confirm("Reset password and reboot?") && act("reset_password")}>Reset password</Button>
            <Select className="h-9 w-56" defaultValue="" onChange={(e) => { if (e.target.value && confirm("Reinstall will ERASE the server. Continue?")) act("reinstall", { osTemplateId: e.target.value }); e.target.value = ""; }}><option value="">Reinstall with…</option>{os.data?.items?.map((o: any) => <option key={o.id} value={o.id}>{o.name}</option>)}</Select>
          </>}
          {s.status === "ACTIVE" && <Button variant="outline" size="sm" icon="pause" onClick={() => { const reason = prompt("Suspension reason", "Suspended by administrator"); if (reason) act("suspend", { reason }); }}>Suspend</Button>}
          {s.status === "SUSPENDED" && <Button variant="secondary" size="sm" icon="play_circle" onClick={() => act("unsuspend")}>Unsuspend</Button>}
          {!["TERMINATED", "CANCELLED"].includes(s.status) && <Button variant="danger" size="sm" icon="delete_forever" onClick={() => confirm("TERMINATE this service? The VM will be destroyed and IPs released.") && act("terminate")}>Terminate</Button>}
        </div>
      </Card>
      <div className="grid gap-6 lg:grid-cols-2">
        <Card title="Server">
          <dl className="grid grid-cols-[140px_1fr] gap-y-2.5 text-sm">
            <dt className="text-mute">Hypervisor</dt><dd className="font-semibold">{s.server ? `${s.server.name} (${s.server.type})` : "—"}</dd>
            <dt className="text-mute">Node / VMID</dt><dd className="font-semibold">{s.node ?? "—"} / {s.remoteId ?? "—"} {s.virtType && <span className="text-mute">({s.virtType})</span>}</dd>
            <dt className="text-mute">OS</dt><dd className="font-semibold">{s.osTemplate?.name ?? "—"}</dd>
            <dt className="text-mute">IPs</dt><dd className="space-y-1">{s.ips.map((i: any) => <div key={i.id} className="flex items-center gap-1 font-mono text-[13px]">{i.address}{i.isPrimary && <Badge>primary</Badge>}<Copy text={i.address} /><span className="text-xs text-mute">{i.subnet?.cidr} gw {i.subnet?.gateway}</span></div>)}{!s.ips.length && "—"}</dd>
            <dt className="text-mute">Live state</dt><dd className="font-semibold">{live ? (live.error ? <span className="text-rose-600">{live.error}</span> : `${live.state} · CPU ${live.cpuPct ?? "?"}% · RAM ${live.memUsedMb ?? "?"}/${live.memTotalMb ?? "?"} MB`) : "—"}</dd>
            <dt className="text-mute">Credentials</dt><dd>{cred ? <span className="font-mono text-[13px]">{cred.username} / {cred.password} <Copy text={cred.password} /></span> : s.hasPassword ? <button className="text-sm font-bold text-primary-dark" onClick={() => api(`/admin/services/${id}/password`).then(setCred)}>Reveal (logged)</button> : "—"}</dd>
          </dl>
        </Card>
        <Card title="Billing & overrides">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Next due date"><Input type="date" value={edit.nextDueDate} onChange={(e) => setEdit({ ...edit, nextDueDate: e.target.value })} /></Field>
            <Field label="Recurring (₹)"><Input type="number" step="0.01" value={edit.recurringAmount} onChange={(e) => setEdit({ ...edit, recurringAmount: e.target.value })} /></Field>
            <Field label="Billing cycle"><Select value={edit.billingCycle} onChange={(e) => setEdit({ ...edit, billingCycle: e.target.value })}>{Object.entries(CYCLES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</Select></Field>
            <Field label="Hostname"><Input value={edit.hostname} onChange={(e) => setEdit({ ...edit, hostname: e.target.value })} /></Field>
            <Field label="Node"><Input value={edit.node} onChange={(e) => setEdit({ ...edit, node: e.target.value })} /></Field>
            <Field label="VMID / VPS id"><Input value={edit.remoteId} onChange={(e) => setEdit({ ...edit, remoteId: e.target.value })} /></Field>
            <div className="sm:col-span-2"><Toggle checked={edit.overrideAutoSuspend} onChange={(v) => setEdit({ ...edit, overrideAutoSuspend: v })} label="Exempt from automatic suspension" /></div>
            <Field label="Notes" className="sm:col-span-2"><Textarea rows={3} value={edit.notes} onChange={(e) => setEdit({ ...edit, notes: e.target.value })} /></Field>
          </div>
          <Button className="mt-4" icon="save" onClick={() => api(`/admin/services/${id}`, { method: "PUT", body: { ...edit, nextDueDate: edit.nextDueDate || null, recurringAmount: Math.round(Number(edit.recurringAmount) * 100), node: edit.node || null, remoteId: edit.remoteId || null } }).then(() => { toast.success("Saved"); reload(); }).catch((e) => toast.error(e.message))}>Save</Button>
          <div className="mt-4 text-xs text-mute">Registered {date(s.registrationDate)} · {CYCLES[s.billingCycle]} · first payment {money(s.firstAmount)}</div>
        </Card>
      </div>
      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        <Card title="Invoices" pad={false}><Table head={["Invoice", "Total", "Due", "Status"]}>{data.invoices.map((i: any) => <tr key={i.id}><Td><Link className="font-bold text-primary-dark" href={`/admin/invoices/${i.id}`}>{invNo(i)}</Link></Td><Td>{money(i.total)}</Td><Td>{date(i.dueDate)}</Td><Td><Badge status={i.status} /></Td></tr>)}</Table></Card>
        <Card title="Provisioning log" pad={false}>
          <ul className="max-h-96 divide-y divide-[#f3effb] overflow-y-auto text-sm">
            {s.logs.map((l: any) => (
              <li key={l.id} className="px-5 py-2.5">
                <div className="flex items-center justify-between"><span className="flex items-center gap-2 font-bold"><Icon name={l.success ? "check_circle" : "error"} className={l.success ? "text-emerald-500" : "text-rose-500"} />{l.action}</span><span className="text-xs text-mute">{date(l.createdAt, true)}</span></div>
                {l.message && <div className="mt-0.5 break-words pl-7 text-xs text-mute">{l.message}</div>}
              </li>
            ))}
          </ul>
        </Card>
      </div>
    </>
  );
}
