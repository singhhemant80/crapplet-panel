"use client";
import { OsLogo } from "@/components/os-logo";
import { NodeSelect } from "@/components/admin/node-select";
import { ProvisioningTracker } from "@/components/provisioning-tracker";
import { LiveBadge } from "@/components/live-state";
import { PasswordField, passwordProblem } from "@/components/password-field";
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
    if (["ACTIVE", "SUSPENDED"].includes(data?.service?.status) && data.service.remoteId) api(`/admin/services/${id}/live`).then((r) => setLive(r.live)).catch(() => {});
    if (data?.service) setEdit({ nextDueDate: data.service.nextDueDate?.slice(0, 10) ?? "", recurringAmount: data.service.recurringAmount / 100, billingCycle: data.service.billingCycle, hostname: data.service.hostname ?? "", overrideAutoSuspend: data.service.overrideAutoSuspend, osTemplateId: data.service.osTemplateId ?? "", notes: data.service.notes ?? "", node: data.service.node ?? "", remoteId: data.service.remoteId ?? "" });
  }, [data, id]);
  if (loading || !data || !edit) return <Loading />;
  const s = data.service;
  const act = (action: string, extra: Record<string, unknown> = {}) => api(`/admin/services/${id}/action`, { body: { action, ...extra } }).then(() => { toast.success(`${action} queued`); setTimeout(reload, 3000); }).catch((e) => toast.error(e.message));
  const isVps = s.product.provisioner === "PROXMOX" || s.product.provisioner === "VIRTUALIZOR";
  return (
    <>
      <PageHeader back="/admin/services" title={<span className="flex items-center gap-3">{s.product.name} <Badge status={s.status} /></span>} subtitle={<span>{s.hostname} · <Link className="font-bold text-primary-dark" href={`/admin/clients/${s.user.id}`}>{s.user.email}</Link>{s.order && <> · order <Link className="font-bold text-primary-dark" href={`/admin/orders/${s.order.id}`}>{s.order.number}</Link></>}{s.reseller && ` · via reseller ${s.reseller.brandName}`}</span>} />
      {isVps && s.status !== "TERMINATED" && s.status !== "CANCELLED" && (["PENDING", "PROVISIONING", "FAILED"].includes(s.status) || Date.now() - new Date(s.createdAt).getTime() < 86400_000) && (
        <ProvisioningTracker path={`/admin/services/${id}/provisioning`} audience="admin" onChange={() => reload()} onRetry={() => act("create")} />
      )}
      {s.status === "FAILED" && <FailurePanel s={s} />}
      {isVps && ["TERMINATED", "CANCELLED"].includes(s.status) && <RecreatePanel s={s} onDone={reload} />}
      <Card title="Actions" className="mb-6">
        <div className="flex flex-wrap gap-2">
          {(s.status === "PENDING" || s.status === "FAILED" || s.status === "PROVISIONING") && <Button icon="rocket_launch" onClick={() => act("create")}>{s.status === "FAILED" ? "Retry provisioning" : s.status === "PROVISIONING" ? "Re-run provisioning" : "Provision now"}</Button>}
          {s.product.provisioner === "VIRTUALIZOR" && s.remoteId && ["ACTIVE", "SUSPENDED"].includes(s.status) && <Button size="sm" icon="terminal" href={`/admin/services/${id}/console`}>Console</Button>}
          {isVps && s.status === "ACTIVE" && <>
            <Button variant="outline" size="sm" icon="play_arrow" onClick={() => act("start")}>Start</Button>
            <Button variant="outline" size="sm" icon="restart_alt" onClick={() => act("reboot")}>Reboot</Button>
            <Button variant="outline" size="sm" icon="power_settings_new" onClick={() => act("shutdown")}>Shutdown</Button>
            <Button variant="outline" size="sm" icon="stop" onClick={() => act("stop")}>Power off</Button>
            <Button variant="outline" size="sm" icon="key" onClick={() => confirm("Reset password and reboot?") && act("reset_password")}>Reset password</Button>
            <Select className="h-9 w-56" defaultValue="" onChange={(e) => { if (e.target.value && confirm("Reinstall will ERASE the server. Continue?")) act("reinstall", { osTemplateId: e.target.value }); e.target.value = ""; }}><option value="">Reinstall with…</option>{s.product.osTemplates.filter((x: any) => x.osTemplate.enabled).map((x: any) => <option key={x.osTemplate.id} value={x.osTemplate.id}>{x.osTemplate.name}</option>)}</Select>
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
            <dt className="text-mute">Node / VPS id</dt><dd className="font-semibold">{s.nodeName ?? s.node ?? "—"}{s.nodeName && s.node && s.nodeName !== s.node && <span className="font-normal text-mute"> (#{s.node})</span>} / {s.remoteId ?? "—"} {s.virtType && <span className="text-mute">({s.virtType})</span>}</dd>
            <dt className="text-mute">OS</dt><dd className="flex items-center gap-2 font-semibold">{s.osTemplate && <OsLogo os={s.osTemplate} size={22} className="rounded-md" />}{s.osTemplate?.name ?? "—"}</dd>
            <dt className="text-mute">IPs</dt><dd className="space-y-1">{s.ips.map((i: any) => <div key={i.id} className="flex items-center gap-1 font-mono text-[13px]">{i.address}{i.isPrimary && <Badge>primary</Badge>}<Copy text={i.address} /><span className="text-xs text-mute">{i.subnet?.cidr} gw {i.subnet?.gateway}</span></div>)}{!s.ips.length && "—"}</dd>
            <dt className="text-mute">Live state</dt>
            <dd className="font-semibold">
              {live ? (
                live.error ? <span className="text-rose-600">{live.error}</span> : (
                  <span className="flex flex-wrap items-center gap-2">
                    <LiveBadge state={live.state} reason={live.reason} />
                    {live.reason && <span className="text-xs font-normal text-mute">{live.reason}</span>}
                    {[live.cpuPct != null && `CPU ${live.cpuPct}%`, live.memTotalMb != null && `RAM ${live.memUsedMb ?? "?"}/${live.memTotalMb} MB`, live.diskTotalGb != null && `${live.diskTotalGb} GB disk`, live.bandwidthGb != null && `BW ${live.bandwidthUsedGb ?? 0}/${live.bandwidthGb || "∞"} GB`].filter(Boolean).map((x) => <span key={x as string} className="text-xs font-normal text-slate-600">{x}</span>)}
                  </span>
                )
              ) : s.remoteId ? <LiveBadge loading /> : "—"}
            </dd>
            {s.server?.type === "VIRTUALIZOR" && s.remoteId && (
              <>
                <dt className="text-mute">Virtualizor</dt>
                <dd className="flex flex-wrap gap-2">
                  <Button size="sm" variant="outline" icon="sync" onClick={async () => { try { const r = await api(`/admin/services/${id}/virtualizor-sync`, { body: {} }); toast.success(`Synced: ${r.ips.join(", ") || "no IPs"} · ${r.state}`); reload(); api(`/admin/services/${id}/live`).then((x) => setLive(x.live)).catch(() => {}); } catch (e: any) { toast.error(e.message); } }}>Sync from Virtualizor</Button>
                  <Button size="sm" variant="outline" icon="swap_horiz" onClick={async () => { if (!confirm("Replace this VPS's IPs with free IPs from Virtualizor's pool for its node? The VPS will get new addresses — tell the customer.")) return; try { const r = await api(`/admin/services/${id}/replace-ips`, { body: {} }); toast.success(`IPs changed: ${r.before.join(", ") || "—"} → ${r.after.join(", ")}`); reload(); } catch (e: any) { toast.error(e.message); } }}>Use Virtualizor's free IPs</Button>
                </dd>
                {live && !live.error && live.ips?.length > 0 && live.ips.join(",") !== s.ips.map((i: any) => i.address).join(",") && (
                  <><dt /><dd className="text-xs font-semibold text-amber-700">Virtualizor shows {live.ips.join(", ")} — click “Sync from Virtualizor” to update the panel.</dd></>
                )}
              </>
            )}
            <dt className="text-mute">Credentials</dt><dd>{cred ? <span className="font-mono text-[13px]">{cred.username} / {cred.password} <Copy text={cred.password} /></span> : s.hasPassword ? <button className="text-sm font-bold text-primary-dark" onClick={() => api(`/admin/services/${id}/password`).then(setCred)}>Reveal (logged)</button> : "—"}</dd>
          </dl>
        </Card>
        <Card title="Billing & overrides">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Next due date"><Input type="date" value={edit.nextDueDate} onChange={(e) => setEdit({ ...edit, nextDueDate: e.target.value })} /></Field>
            <Field label={`Recurring (${s.currency ?? "INR"})`}><Input type="number" step="0.01" value={edit.recurringAmount} onChange={(e) => setEdit({ ...edit, recurringAmount: e.target.value })} /></Field>
            <Field label="Billing cycle"><Select value={edit.billingCycle} onChange={(e) => setEdit({ ...edit, billingCycle: e.target.value })}>{Object.entries(CYCLES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</Select></Field>
            <Field label="Hostname"><Input value={edit.hostname} onChange={(e) => setEdit({ ...edit, hostname: e.target.value.toLowerCase().trim() })} /></Field>
            {isVps && (
              <Field label="Operating system" hint={s.remoteId && ["ACTIVE", "SUSPENDED"].includes(s.status) ? "Built — use Reinstall above to change" : "Used on the next provisioning attempt"}>
                <Select value={edit.osTemplateId} disabled={!!s.remoteId && ["ACTIVE", "SUSPENDED"].includes(s.status)} onChange={(e) => setEdit({ ...edit, osTemplateId: e.target.value })}>
                  {!edit.osTemplateId && <option value="">Choose…</option>}
                  {s.osTemplate && !s.product.osTemplates.some((x: any) => x.osTemplate.id === s.osTemplate.id) && <option value={s.osTemplate.id}>{s.osTemplate.name} (not offered)</option>}
                  {s.product.osTemplates.filter((x: any) => x.osTemplate.enabled).map((x: any) => <option key={x.osTemplate.id} value={x.osTemplate.id}>{x.osTemplate.name}{x.osTemplate.virtualizorVirt ? ` · ${x.osTemplate.virtualizorVirt}` : ""}</option>)}
                </Select>
              </Field>
            )}
            {s.product.provisioner === "VIRTUALIZOR" ? (
              <NodeSelect serverIds={s.server ? [s.server.id] : []} value={edit.node} onChange={(v) => setEdit({ ...edit, node: v })} disabled={!!s.remoteId && ["ACTIVE", "SUSPENDED"].includes(s.status)} hint={s.remoteId ? "Where this VPS lives (change only if it was migrated in Virtualizor)" : undefined} />
            ) : (
              <Field label="Node"><Input value={edit.node} onChange={(e) => setEdit({ ...edit, node: e.target.value })} /></Field>
            )}
            <Field label="VMID / VPS id"><Input value={edit.remoteId} onChange={(e) => setEdit({ ...edit, remoteId: e.target.value })} /></Field>
            <div className="sm:col-span-2"><Toggle checked={edit.overrideAutoSuspend} onChange={(v) => setEdit({ ...edit, overrideAutoSuspend: v })} label="Exempt from automatic suspension" /></div>
            <Field label="Notes" className="sm:col-span-2"><Textarea rows={3} value={edit.notes} onChange={(e) => setEdit({ ...edit, notes: e.target.value })} /></Field>
          </div>
          <Button className="mt-4" icon="save" onClick={() => api(`/admin/services/${id}`, { method: "PUT", body: { ...edit, osTemplateId: s.remoteId && ["ACTIVE", "SUSPENDED"].includes(s.status) ? undefined : edit.osTemplateId || null, hostname: edit.hostname || undefined, nextDueDate: edit.nextDueDate || null, recurringAmount: Math.round(Number(edit.recurringAmount) * 100), node: edit.node || null, remoteId: edit.remoteId || null } }).then(() => { toast.success("Saved"); reload(); }).catch((e) => toast.error(e.message))}>Save</Button>
          <div className="mt-4 text-xs text-mute">Registered {date(s.registrationDate)} · {CYCLES[s.billingCycle]} · first payment {money(s.firstAmount, s.currency)}</div>
        </Card>
      </div>
      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        <Card title="Invoices" pad={false}><Table head={["Invoice", "Total", "Due", "Status"]}>{data.invoices.map((i: any) => <tr key={i.id}><Td><Link className="font-bold text-primary-dark" href={`/admin/invoices/${i.id}`}>{invNo(i)}</Link></Td><Td>{money(i.total, i.currency)}</Td><Td>{date(i.dueDate)}</Td><Td><Badge status={i.status} /></Td></tr>)}</Table></Card>
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

/** Why provisioning failed + the plan's setup checklist, so staff can fix it and retry. */
function FailurePanel({ s }: { s: any }) {
  const ready = useApi(`/admin/products/${s.product.id}/readiness`);
  const err = s.logs.find((l: any) => !l.success);
  const problems = (ready.data?.checks ?? []).filter((c: any) => c.status !== "ok");
  return (
    <div className="mb-5 overflow-hidden rounded-2xl border border-rose-200 bg-rose-50/70">
      <div className="flex gap-3 px-5 py-4">
        <Icon name="error" className="text-rose-600" />
        <div className="min-w-0 text-sm">
          <div className="font-extrabold text-rose-800">Provisioning failed{err ? ` · ${date(err.createdAt, true)}` : ""}</div>
          <div className="mt-0.5 break-words text-rose-800">{err?.message ?? "See the log below."}</div>
          <div className="mt-1 text-xs text-rose-700">Fix the cause, then click <b>Retry provisioning</b>. You can change the OS and node under “Billing &amp; overrides”.</div>
        </div>
      </div>
      {problems.length > 0 && (
        <ul className="divide-y divide-rose-100 border-t border-rose-100 bg-white/70">
          {problems.map((c: any) => (
            <li key={c.key} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-5 py-2.5 text-sm">
              <Icon name={c.status === "warn" ? "warning" : "cancel"} className={c.status === "warn" ? "text-amber-500" : "text-rose-600"} />
              <span className="font-semibold text-ink">{c.label}</span>
              <span className="min-w-0 flex-1 text-mute">{c.detail}</span>
              {c.fix && <a href={c.href ?? `/admin/products/${s.product.id}`} className="text-xs font-bold text-primary-dark hover:underline">{c.fix} →</a>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** A terminated/cancelled VPS can be built again for the same order (same customer, plan and billing record). */
function RecreatePanel({ s, onDone }: { s: any; onDone: () => void }) {
  const [open, setOpen] = useState(false);
  const [os, setOs] = useState<string>(s.osTemplateId ?? "");
  const [hostname, setHostname] = useState<string>(s.hostname ?? "");
  const [billing, setBilling] = useState<"keep" | "restart">("keep");
  const [pw, setPw] = useState("");
  const [busy, setBusy] = useState(false);
  const osList = s.product.osTemplates.filter((x: any) => x.osTemplate.enabled).map((x: any) => x.osTemplate);
  async function go() {
    const bad = passwordProblem(pw);
    if (bad) return toast.error(`Root password: ${bad}`);
    setBusy(true);
    try {
      await api(`/admin/services/${s.id}/recreate`, { body: { osTemplateId: os || undefined, hostname: hostname || undefined, billing, rootPassword: pw || undefined } });
      toast.success("New VPS queued — follow it in the tracker");
      setOpen(false);
      onDone();
    } catch (e: any) {
      toast.error(e.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="mb-6 rounded-2xl border border-slate-200 bg-slate-50 p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="font-extrabold text-ink">This service was {s.status === "TERMINATED" ? "terminated" : "cancelled"}{s.terminationDate ? ` on ${new Date(s.terminationDate).toLocaleDateString("en-IN", { dateStyle: "medium" })}` : ""}</div>
          <p className="text-sm text-slate-600">You can build a new VPS for the same order{s.order ? ` (${s.order.number})` : ""} — same customer, plan and billing record. The old VPS isn't brought back.</p>
        </div>
        {!open && <Button icon="add_circle" onClick={() => setOpen(true)}>Create a new VPS</Button>}
      </div>
      {open && (
        <div className="mt-4 grid gap-3 sm:grid-cols-3">
          <Field label="Operating system">
            <Select value={os} onChange={(e) => setOs(e.target.value)}>{osList.map((o: any) => <option key={o.id} value={o.id}>{o.name}</option>)}</Select>
          </Field>
          <Field label="Hostname"><Input value={hostname} onChange={(e) => setHostname(e.target.value)} placeholder="server.example.com" /></Field>
          <Field label="Billing">
            <Select value={billing} onChange={(e) => setBilling(e.target.value as "keep" | "restart")}>
              <option value="keep">Keep the current due date</option>
              <option value="restart">Restart the cycle from today</option>
            </Select>
          </Field>
          <div className="sm:col-span-3">
            <div className="mb-1.5 text-sm font-bold text-ink">Root password</div>
            <PasswordField value={pw} onChange={setPw} optionalHint="Leave empty to generate one — it's emailed to the customer" />
          </div>
          <div className="flex gap-2 sm:col-span-3">
            <Button icon="rocket_launch" loading={busy} onClick={go}>Create VPS</Button>
            <Button variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
          </div>
        </div>
      )}
    </div>
  );
}
