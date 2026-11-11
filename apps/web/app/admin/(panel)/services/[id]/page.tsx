"use client";
import { ResetPasswordModal } from "@/components/reset-password-modal";
import { OsLogo } from "@/components/os-logo";
import { NodeSelect } from "@/components/admin/node-select";
import { ProvisioningTracker } from "@/components/provisioning-tracker";
import { LiveBadge } from "@/components/live-state";
import { PasswordField, generatePassword, passwordProblem } from "@/components/password-field";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useState } from "react";
import { api, CYCLES, date, invNo, money } from "@/lib/api";
import { Alert, Badge, Button, Card, Copy, Field, Icon, Input, Loading, Modal, Select, Table, Td, Textarea, Toggle, cx, toast, useApi } from "@/components/ui";

export default function AdminService() {
  const { id } = useParams<{ id: string }>();
  const { data, loading, reload } = useApi(`/admin/services/${id}`);
  const os = useApi("/admin/os-templates");
  const [live, setLive] = useState<any>(null);
  const [resetPw, setResetPw] = useState(false);
  const [edit, setEdit] = useState<any>(null);
  useEffect(() => {
    if (["ACTIVE", "SUSPENDED"].includes(data?.service?.status) && data.service.remoteId) api(`/admin/services/${id}/live`).then((r) => setLive(r.live)).catch(() => {});
    if (data?.service) setEdit({ nextDueDate: data.service.nextDueDate?.slice(0, 10) ?? "", recurringAmount: data.service.recurringAmount / 100, billingCycle: data.service.billingCycle, hostname: data.service.hostname ?? "", overrideAutoSuspend: data.service.overrideAutoSuspend, osTemplateId: data.service.osTemplateId ?? "", notes: data.service.notes ?? "", node: data.service.node ?? "", remoteId: data.service.remoteId ?? "" });
  }, [data, id]);
  if (loading || !data || !edit) return <Loading />;
  const s = data.service;
  const act = (action: string, extra: Record<string, unknown> = {}) => api(`/admin/services/${id}/action`, { body: { action, ...extra } }).then(() => { toast.success(`${action} queued`); setTimeout(reload, 3000); }).catch((e) => toast.error(e.message));
  const isVps = s.product.provisioner === "PROXMOX" || s.product.provisioner === "VIRTUALIZOR";
  const isHosting = s.product.provisioner === "CPANEL";
  const ended = ["TERMINATED", "CANCELLED"].includes(s.status);
  const primary = s.ips.find((i: any) => i.isPrimary) ?? s.ips[0];
  const days = s.nextDueDate ? Math.ceil((new Date(s.nextDueDate).getTime() - Date.now()) / 86400_000) : null;
  const ok = live && !live.error;
  const running = ok && live.state === "running";
  const custName = [s.user.firstName, s.user.lastName].filter(Boolean).join(" ") || s.user.email;
  const refreshLive = () => api(`/admin/services/${id}/live`).then((x) => setLive(x.live)).catch(() => {});
  const P = s.product;
  const facts: [string, React.ReactNode, string?][] = [
    ["Purchased", date(s.registrationDate), s.order ? `order ${s.order.number}` : undefined],
    ["Next due", s.nextDueDate ? date(s.nextDueDate) : "—", days == null ? undefined : days < 0 ? `${-days} days overdue` : days === 0 ? "due today" : `in ${days} days`],
    ["Billing cycle", CYCLES[s.billingCycle] ?? s.billingCycle],
    ["Recurring", money(s.recurringAmount, s.currency), s.currency === "INR" ? "+ GST" : undefined],
    ["First payment", money(s.firstAmount, s.currency)],
    ["Service age", (() => { const d = Math.max(0, Math.floor((Date.now() - new Date(s.registrationDate).getTime()) / 86400_000)); return `${d} day${d === 1 ? "" : "s"}`; })(), s.terminationDate ? `ended ${date(s.terminationDate)}` : undefined],
  ];
  return (
    <>
      <Link href="/admin/services" className="mb-3 inline-flex items-center gap-1 text-sm font-bold text-primary-dark hover:underline"><Icon name="arrow_back" className="text-[18px]" />All services</Link>

      {/* ── header ── */}
      <section className="mb-6 overflow-hidden rounded-2xl border border-line bg-white shadow-card">
        <div className="relative bg-gradient-to-br from-[#1e0b4b] via-[#3b0f7a] to-[#6d28d9] px-6 py-6 text-white">
          <div className="pointer-events-none absolute inset-0 opacity-[0.07] [background-image:linear-gradient(white_1px,transparent_1px),linear-gradient(90deg,white_1px,transparent_1px)] [background-size:28px_28px]" />
          <div className="relative flex flex-wrap items-start gap-5">
            <span className="grid h-16 w-16 shrink-0 place-items-center rounded-2xl bg-white shadow-lg">
              {s.osTemplate ? <OsLogo os={s.osTemplate} size={40} /> : <Icon name={isHosting ? "language" : "dns"} className="text-[32px] text-primary-dark" />}
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2.5">
                <h1 className="text-2xl font-extrabold tracking-tight">{s.hostname || P.name}</h1>
                <span className="rounded-lg bg-white/95 px-1 py-0.5"><Badge status={s.status} /></span>
                {s.overrideAutoSuspend && <span className="rounded-md bg-amber-400/20 px-2 py-0.5 text-[11px] font-bold text-amber-200 ring-1 ring-amber-300/40">Auto-suspend off</span>}
              </div>
              <div className="mt-1 text-sm text-white/75">{P.name}{P.group?.name ? ` · ${P.group.name}` : ""}{s.reseller ? ` · via reseller ${s.reseller.brandName}` : ""}</div>
              <div className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-2 text-[13px]">
                {primary && <span className="inline-flex items-center gap-1.5 rounded-lg bg-white/10 px-2.5 py-1 font-mono font-semibold ring-1 ring-white/15"><Icon name="lan" className="text-[16px] text-white/70" />{primary.address}<span className="[&_button]:text-white/80"><Copy text={primary.address} /></span></span>}
                <Link href={`/admin/clients/${s.user.id}`} className="inline-flex items-center gap-1.5 font-semibold hover:underline"><Icon name="person" className="text-[16px] text-white/70" />{custName}</Link>
                {s.order && <Link href={`/admin/orders/${s.order.id}`} className="inline-flex items-center gap-1.5 font-semibold hover:underline"><Icon name="shopping_bag" className="text-[16px] text-white/70" />{s.order.number}</Link>}
                {s.server && <span className="inline-flex items-center gap-1.5 text-white/80"><Icon name="dns" className="text-[16px] text-white/60" />{s.server.name}{s.nodeName || s.node ? ` · ${s.nodeName ?? s.node}` : ""}{s.remoteId ? ` · #${s.remoteId}` : ""}</span>}
              </div>
            </div>
            <div className="flex flex-col items-end gap-2">
              {s.remoteId && !ended && (live ? (live.error ? <span className="rounded-lg bg-rose-500/20 px-2.5 py-1 text-xs font-bold text-rose-100 ring-1 ring-rose-300/40">{live.error}</span> : <span className="rounded-lg bg-white/95 px-1.5 py-1"><LiveBadge state={live.state} reason={live.reason} /></span>) : <span className="rounded-lg bg-white/95 px-1.5 py-1"><LiveBadge loading /></span>)}
              {ok && live.uptimeSec > 0 && <span className="text-xs text-white/70">Up {uptime(live.uptimeSec)}</span>}
              {s.product.provisioner === "VIRTUALIZOR" && s.remoteId && ["ACTIVE", "SUSPENDED"].includes(s.status) && <Link href={`/admin/services/${id}/console`} className="inline-flex h-9 items-center gap-1.5 rounded-xl bg-white px-3.5 text-[13px] font-extrabold text-primary-dark shadow-lg transition hover:bg-primary-soft"><Icon name="terminal" className="text-[18px]" />Open console</Link>}
            </div>
          </div>
        </div>
        <dl className="grid grid-cols-2 divide-line sm:grid-cols-3 xl:grid-cols-6 xl:divide-x">
          {facts.map(([l, v, sub]) => (
            <div key={l} className="border-b border-line px-5 py-4 xl:border-b-0">
              <dt className="text-[11px] font-bold uppercase tracking-wider text-mute">{l}</dt>
              <dd className="mt-1 text-[15px] font-extrabold text-ink">{v}</dd>
              {sub && <dd className={cx("text-xs", l === "Next due" && days != null && days < 0 ? "font-bold text-rose-600" : l === "Next due" && days != null && days <= 7 ? "font-bold text-amber-600" : "text-mute")}>{sub}</dd>}
            </div>
          ))}
        </dl>
      </section>

      {(isVps || isHosting) && !ended && (["PENDING", "PROVISIONING", "FAILED"].includes(s.status) || Date.now() - new Date(s.createdAt).getTime() < 86400_000) && (
        <ProvisioningTracker path={`/admin/services/${id}/provisioning`} audience="admin" onChange={() => reload()} onRetry={() => act("create")} />
      )}
      {s.status === "FAILED" && <FailurePanel s={s} />}
      {s.status === "SUSPENDED" && <Alert tone="warn" className="mb-6"><b>Suspended</b>{s.suspendReason ? ` — ${s.suspendReason}` : ""}</Alert>}
      {isVps && ended && <RecreatePanel s={s} onDone={reload} />}

      {/* ── actions ── */}
      {!ended && (
        <section className="mb-6 rounded-2xl border border-line bg-white p-4 shadow-card">
          <div className="flex flex-wrap items-end gap-x-6 gap-y-4">
            {(s.status === "PENDING" || s.status === "FAILED" || s.status === "PROVISIONING") && (
              <Group label="Provisioning"><Button size="sm" icon="rocket_launch" onClick={() => act("create")}>{s.status === "FAILED" ? "Retry provisioning" : s.status === "PROVISIONING" ? "Re-run provisioning" : "Provision now"}</Button></Group>
            )}
            {isVps && s.status === "ACTIVE" && (
              <>
                <Group label="Power">
                  <div className="flex max-w-full flex-wrap overflow-hidden rounded-xl border border-line">
                    {([["play_arrow", "Start", () => act("start"), running], ["restart_alt", "Reboot", () => act("reboot")], ["power_settings_new", "Shutdown", () => act("shutdown")], ["stop", "Power off", () => act("stop")], ["bolt", "Hard reset", () => confirm("Hard reset: cut the power and start the server again? Unsaved data is lost.") && act("hard_reset")]] as [string, string, () => void, boolean?][]).map(([i, l, f, dis], n) => (
                      <button key={l} disabled={dis} onClick={f} className={cx("inline-flex h-9 items-center gap-1.5 px-3.5 text-[13px] font-bold text-slate-700 transition hover:bg-primary-tint hover:text-primary-dark disabled:opacity-40 disabled:hover:bg-transparent", n > 0 && "border-l border-line")}>
                        <Icon name={i} className="text-[18px]" />{l}
                      </button>
                    ))}
                  </div>
                </Group>
                <Group label="Access">
                  <Button variant="outline" size="sm" icon="key" onClick={() => setResetPw(true)}>Reset password</Button>
                  <ResetPasswordModal open={resetPw} onClose={() => setResetPw(false)} windows={/windows/i.test(s.osTemplate?.family ?? s.osTemplate?.name ?? "")} onSubmit={(password) => { setResetPw(false); act("reset_password", password ? { password } : {}); }} />
                </Group>
                <Group label="Reinstall OS">
                  <div className="w-56"><Select className="h-9" defaultValue="" onChange={(e) => { if (e.target.value && confirm("Reinstall will ERASE the server. Continue?")) act("reinstall", { osTemplateId: e.target.value }); e.target.value = ""; }}><option value="">Choose an OS…</option>{P.osTemplates.filter((x: any) => x.osTemplate.enabled).map((x: any) => <option key={x.osTemplate.id} value={x.osTemplate.id}>{x.osTemplate.name}</option>)}</Select></div>
                </Group>
              </>
            )}
            {isHosting && s.remoteId && s.status === "ACTIVE" && <Group label="Hosting"><HostingActions s={s} onDone={reload} /></Group>}
            <div className="ml-auto">
              <Group label="Account">
                {s.status === "ACTIVE" && <Button variant="outline" size="sm" icon="pause" onClick={() => { const reason = prompt("Suspension reason", "Suspended by administrator"); if (reason) act("suspend", { reason }); }}>Suspend</Button>}
                {s.status === "SUSPENDED" && <Button variant="secondary" size="sm" icon="play_circle" onClick={() => act("unsuspend")}>Unsuspend</Button>}
                <Button variant="danger" size="sm" icon="delete_forever" onClick={() => confirm(isHosting ? `TERMINATE this hosting account? The cPanel account ${s.username ?? ""} and all its files, email and databases are deleted on the server.` : "TERMINATE this service? The VM will be destroyed and IPs released.") && act("terminate")}>Terminate</Button>
              </Group>
            </div>
          </div>
        </section>
      )}

      {/* ── live usage ── */}
      {isVps && s.remoteId && !ended && (
        <section className="mb-6 rounded-2xl border border-line bg-white shadow-card">
          <header className="flex items-center justify-between gap-3 border-b border-line px-5 py-4">
            <div><h3 className="text-[15px] font-extrabold text-ink">Resource usage</h3><p className="text-xs text-mute">Live from the hypervisor</p></div>
            <Button size="sm" variant="ghost" icon="refresh" onClick={() => { setLive(null); refreshLive(); }}>Refresh</Button>
          </header>
          {!live ? <div className="grid gap-4 p-5 sm:grid-cols-2 xl:grid-cols-4">{[0, 1, 2, 3].map((i) => <div key={i} className="h-24 animate-pulse rounded-xl bg-slate-100" />)}</div> : live.error ? <div className="p-5"><Alert tone="error">{live.error}</Alert></div> : (
            <div className="grid gap-4 p-5 sm:grid-cols-2 xl:grid-cols-4">
              <Meter icon="developer_board" label="CPU" value={`${fmt(live.cpuPct ?? 0)}%`} sub={`${P.cpuCores ?? live.cpus ?? "?"} vCPU${live.cpuLimitMhz ? ` · ${fmt(live.cpuLimitMhz)} MHz` : ""}`} pct={live.cpuPct} />
              <Meter icon="memory" label="Memory" value={live.memUsedMb != null ? mb(live.memUsedMb) : "—"} sub={`of ${live.memTotalMb ? mb(live.memTotalMb) : P.ramMb ? mb(P.ramMb) : "?"}`} pct={live.memTotalMb ? (live.memUsedMb / live.memTotalMb) * 100 : null} />
              <Meter icon="database" label="Disk" value={live.diskUsedGb != null ? `${fmt(live.diskUsedGb)} GB` : `${live.diskTotalGb ?? P.diskGb ?? "?"} GB`} sub={live.diskUsedGb != null ? `of ${live.diskTotalGb ?? P.diskGb} GB` : "allocated"} pct={live.diskUsedGb != null && live.diskTotalGb ? (live.diskUsedGb / live.diskTotalGb) * 100 : null} />
              <Meter icon="data_usage" label="Bandwidth this month" value={`${fmt(live.bandwidthUsedGb ?? 0)} GB`} sub={live.bandwidthGb ? `of ${fmt(live.bandwidthGb)} GB` : "unmetered"} pct={live.bandwidthGb ? ((live.bandwidthUsedGb ?? 0) / live.bandwidthGb) * 100 : null} />
              <Meter icon="download" label="Download" value={live.netInBps != null ? speed(live.netInBps) : live.netInMb != null ? mb(live.netInMb) : "—"} sub={live.netInBps != null ? "current speed" : "since boot"} />
              <Meter icon="upload" label="Upload" value={live.netOutBps != null ? speed(live.netOutBps) : live.netOutMb != null ? mb(live.netOutMb) : "—"} sub={live.netOutBps != null ? "current speed" : "since boot"} />
              <Meter icon="schedule" label="Uptime" value={live.uptimeSec ? uptime(live.uptimeSec) : running ? "—" : "Stopped"} sub={running ? "since last boot" : live.state ?? ""} />
              <Meter icon="lan" label="IP addresses" value={`${s.ips.length} IPv4${s.ipv6Address ? " + IPv6" : ""}`} sub={`plan includes ${P.ipv4Count || 1}`} />
            </div>
          )}
        </section>
      )}

      <div className="grid items-start gap-6 xl:grid-cols-[1fr_400px] [&>*]:min-w-0">
        <div className="space-y-6">
          {isHosting ? <HostingCard s={s} live={live} id={id} /> : (
            <Card title="Server details">
              <div className="grid gap-x-8 md:grid-cols-2">
                <Rows rows={[
                  ["Hypervisor", s.server ? `${s.server.name} (${s.server.type})` : "—"],
                  ["Node", <>{s.nodeName ?? s.node ?? "—"}{s.nodeName && s.node && s.nodeName !== s.node && <span className="font-normal text-mute"> (#{s.node})</span>}</>],
                  ["VPS id", s.remoteId ?? "—"],
                  ["Virtualization", s.virtType ?? P.virtType ?? "—"],
                  ["Operating system", <span className="flex items-center gap-2">{s.osTemplate && <OsLogo os={s.osTemplate} size={20} className="rounded" />}{s.osTemplate?.name ?? "—"}</span>],
                  ["Hostname", s.hostname ?? "—"],
                ]} />
                <Rows rows={[
                  ["vCPU", P.cpuCores ? `${P.cpuCores} cores` : "—"],
                  ["Memory", P.ramMb ? mb(P.ramMb) : "—"],
                  ["Disk", P.diskGb ? `${P.diskGb} GB SSD` : "—"],
                  ["Bandwidth", P.bandwidthGb ? `${fmt(P.bandwidthGb)} GB / month` : "Unmetered"],
                  ["IPv4 included", `${P.ipv4Count || 1}`],
                  ["IPv6", s.ipv6Address ? <span className="font-mono text-[12.5px]">{s.ipv6Address}</span> : "—"],
                ]} />
              </div>
              <div className="mt-5 border-t border-line pt-4">
                <div className="mb-2 text-[11px] font-bold uppercase tracking-wider text-mute">IP addresses</div>
                {s.ips.length ? (
                  <div className="overflow-x-auto rounded-xl border border-line">
                    <table className="w-full min-w-[520px] text-[13px]">
                      <thead className="bg-[#faf7ff] text-left text-[11px] font-bold uppercase tracking-wider text-mute"><tr><th className="px-3 py-2">Address</th><th className="px-3 py-2">Subnet</th><th className="px-3 py-2">Gateway</th><th className="px-3 py-2">Reverse DNS</th></tr></thead>
                      <tbody className="divide-y divide-line">
                        {s.ips.map((i: any) => (
                          <tr key={i.id}>
                            <td className="px-3 py-2"><span className="flex items-center gap-1 font-mono font-semibold text-ink">{i.address}<Copy text={i.address} />{i.isPrimary && <span className="rounded bg-primary-soft px-1.5 text-[10px] font-bold uppercase text-primary-dark">Primary</span>}</span></td>
                            <td className="px-3 py-2 font-mono text-slate-600">{i.subnet?.cidr ?? "—"}</td>
                            <td className="px-3 py-2 font-mono text-slate-600">{i.subnet?.gateway ?? "—"}</td>
                            <td className="px-3 py-2 text-slate-600">{i.rdns || "—"}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : <p className="text-sm text-mute">No IP assigned.</p>}
                {ok && live.ips?.length > 0 && live.ips.join(",") !== s.ips.map((i: any) => i.address).join(",") && <p className="mt-2 text-xs font-semibold text-amber-700">Virtualizor shows {live.ips.join(", ")} — click “Sync from Virtualizor” to update the panel.</p>}
              </div>
              {(s.hasPassword || s.username) && (
                <div className="mt-5 border-t border-line pt-4">
                  <div className="mb-2 text-[11px] font-bold uppercase tracking-wider text-mute">Login credentials</div>
                  <Credentials id={id} username={s.username} hasPassword={s.hasPassword} />
                </div>
              )}
              {s.server?.type === "VIRTUALIZOR" && s.remoteId && (
                <div className="mt-5 flex flex-wrap gap-2 border-t border-line pt-4">
                  <Button size="sm" variant="outline" icon="sync" onClick={async () => { try { const r = await api(`/admin/services/${id}/virtualizor-sync`, { body: {} }); toast.success(`Synced: ${r.ips.join(", ") || "no IPs"} · ${r.state}`); reload(); refreshLive(); } catch (e: any) { toast.error(e.message); } }}>Sync from Virtualizor</Button>
                  <Button size="sm" variant="outline" icon="swap_horiz" onClick={async () => { if (!confirm("Replace this VPS's IPs with free IPs from Virtualizor's pool for its node? The VPS will get new addresses — tell the customer.")) return; try { const r = await api(`/admin/services/${id}/replace-ips`, { body: {} }); toast.success(`IPs changed: ${r.before.join(", ") || "—"} → ${r.after.join(", ")}`); reload(); } catch (e: any) { toast.error(e.message); } }}>Use Virtualizor's free IPs</Button>
                </div>
              )}
            </Card>
          )}

          {(P.features?.length > 0 || s.addons.length > 0 || Object.keys(s.config ?? {}).filter((k) => !/ip|password/i.test(k)).length > 0) && (
            <Card title="Plan features & add-ons">
              {P.features?.length > 0 && (
                <ul className="grid gap-x-6 gap-y-2 text-[13px] text-slate-700 sm:grid-cols-2">
                  {P.features.map((f: string) => <li key={f} className="flex items-start gap-2"><Icon name="check_circle" className="mt-px text-[17px] text-emerald-500" />{f}</li>)}
                </ul>
              )}
              {s.addons.length > 0 && (
                <div className={cx(P.features?.length > 0 && "mt-4 border-t border-line pt-4")}>
                  <div className="mb-2 text-[11px] font-bold uppercase tracking-wider text-mute">Add-ons</div>
                  <ul className="space-y-1.5 text-[13px]">{s.addons.map((a: any) => <li key={a.id} className="flex justify-between"><span className="font-semibold text-ink">{a.addon.name} <Badge status={a.status} /></span><span className="text-mute">{money(a.recurringAmount, s.currency)}/cycle</span></li>)}</ul>
                </div>
              )}
              {Object.entries(s.config ?? {}).filter(([k, v]) => !/ip|password/i.test(k) && v !== null && v !== "" && typeof v !== "object").length > 0 && (
                <div className="mt-4 border-t border-line pt-4">
                  <div className="mb-2 text-[11px] font-bold uppercase tracking-wider text-mute">Configurable options</div>
                  <Rows rows={Object.entries(s.config).filter(([k, v]) => !/ip|password/i.test(k) && v !== null && v !== "" && typeof v !== "object").map(([k, v]) => [k, String(v)])} />
                </div>
              )}
            </Card>
          )}

          <Card title={`Invoices (${data.invoices.length})`} pad={false}>
            {data.invoices.length ? (
              <Table head={["Invoice", "Created", "Due", "Paid", "Total", "Status"]}>
                {data.invoices.map((i: any) => <tr key={i.id}><Td><Link className="font-bold text-primary-dark" href={`/admin/invoices/${i.id}`}>{invNo(i)}</Link></Td><Td>{date(i.createdAt)}</Td><Td>{date(i.dueDate)}</Td><Td>{i.paidAt ? date(i.paidAt) : "—"}</Td><Td className="font-semibold">{money(i.total, i.currency)}</Td><Td><Badge status={i.status} /></Td></tr>)}
              </Table>
            ) : <p className="p-5 text-sm text-mute">No invoices yet.</p>}
          </Card>

          <Card title="Activity log" pad={false}>
            <ul className="max-h-96 divide-y divide-[#f3effb] overflow-y-auto text-sm">
              {s.logs.map((l: any) => (
                <li key={l.id} className="flex gap-3 px-5 py-2.5">
                  <Icon name={l.success ? "check_circle" : "error"} className={cx("mt-0.5 text-[19px]", l.success ? "text-emerald-500" : "text-rose-500")} />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center justify-between gap-3"><span className="font-bold capitalize text-ink">{l.action.replace(/_/g, " ")}</span><span className="shrink-0 text-xs text-mute">{date(l.createdAt, true)}</span></div>
                    {l.message && <div className="mt-0.5 break-words text-xs text-mute">{l.message}</div>}
                  </div>
                </li>
              ))}
              {!s.logs.length && <li className="px-5 py-4 text-mute">Nothing yet.</li>}
            </ul>
          </Card>
        </div>

        <div className="space-y-6">
          <Card title="Customer" action={<Link href={`/admin/clients/${s.user.id}`} className="text-[13px] font-bold text-primary-dark hover:underline">Open profile</Link>}>
            <div className="mb-4 flex items-center gap-3">
              <span className="grid h-11 w-11 place-items-center rounded-full bg-gradient-to-br from-primary to-primary-dark text-sm font-extrabold text-white">{custName.split(" ").map((x: string) => x[0]).slice(0, 2).join("").toUpperCase()}</span>
              <div className="min-w-0"><div className="truncate font-extrabold text-ink">{custName}</div>{s.user.profile?.companyName && <div className="truncate text-xs text-mute">{s.user.profile.companyName}</div>}</div>
            </div>
            <Rows rows={[
              ["Email", <span className="flex items-center gap-1 break-all">{s.user.email}<Copy text={s.user.email} /></span>],
              ["Mobile", s.user.phone ? <span className="flex items-center gap-1">{s.user.phone}<Copy text={s.user.phone} /></span> : "—"],
              ["GSTIN", s.user.profile?.gstin ?? "—"],
              ["Location", [s.user.profile?.city, s.user.profile?.state, s.user.profile?.country].filter(Boolean).join(", ") || "—"],
              ["Client since", date(s.user.createdAt)],
              ["Wallet credit", money(s.user.profile?.creditBalance ?? 0, s.user.profile?.currency ?? "INR")],
            ]} />
          </Card>

          <Card title="Billing & overrides">
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-1 2xl:grid-cols-2">
              <Field label="Next due date"><Input type="date" value={edit.nextDueDate} onChange={(e) => setEdit({ ...edit, nextDueDate: e.target.value })} /></Field>
              <Field label={`Recurring (${s.currency ?? "INR"})`}><Input type="number" step="0.01" value={edit.recurringAmount} onChange={(e) => setEdit({ ...edit, recurringAmount: e.target.value })} /></Field>
              <Field label="Billing cycle"><Select value={edit.billingCycle} onChange={(e) => setEdit({ ...edit, billingCycle: e.target.value })}>{Object.entries(CYCLES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</Select></Field>
              <Field label="Hostname"><Input value={edit.hostname} onChange={(e) => setEdit({ ...edit, hostname: e.target.value.toLowerCase().trim() })} /></Field>
              {isVps && (
                <Field label="Operating system" hint={s.remoteId && ["ACTIVE", "SUSPENDED"].includes(s.status) ? "Built — use Reinstall to change" : "Used on the next provisioning attempt"}>
                  <Select value={edit.osTemplateId} disabled={!!s.remoteId && ["ACTIVE", "SUSPENDED"].includes(s.status)} onChange={(e) => setEdit({ ...edit, osTemplateId: e.target.value })}>
                    {!edit.osTemplateId && <option value="">Choose…</option>}
                    {s.osTemplate && !P.osTemplates.some((x: any) => x.osTemplate.id === s.osTemplate.id) && <option value={s.osTemplate.id}>{s.osTemplate.name} (not offered)</option>}
                    {P.osTemplates.filter((x: any) => x.osTemplate.enabled).map((x: any) => <option key={x.osTemplate.id} value={x.osTemplate.id}>{x.osTemplate.name}{x.osTemplate.virtualizorVirt ? ` · ${x.osTemplate.virtualizorVirt}` : ""}</option>)}
                  </Select>
                </Field>
              )}
              {P.provisioner === "VIRTUALIZOR" ? (
                <NodeSelect serverIds={s.server ? [s.server.id] : []} value={edit.node} onChange={(v) => setEdit({ ...edit, node: v })} disabled={!!s.remoteId && ["ACTIVE", "SUSPENDED"].includes(s.status)} hint={s.remoteId ? "Change only if it was migrated in Virtualizor" : undefined} />
              ) : (
                <Field label="Node"><Input value={edit.node} onChange={(e) => setEdit({ ...edit, node: e.target.value })} /></Field>
              )}
              <Field label="VMID / VPS id"><Input value={edit.remoteId} onChange={(e) => setEdit({ ...edit, remoteId: e.target.value })} /></Field>
              <div className="sm:col-span-2 xl:col-span-1 2xl:col-span-2"><Toggle checked={edit.overrideAutoSuspend} onChange={(v) => setEdit({ ...edit, overrideAutoSuspend: v })} label="Exempt from automatic suspension" /></div>
              <Field label="Staff notes" className="sm:col-span-2 xl:col-span-1 2xl:col-span-2"><Textarea rows={3} value={edit.notes} onChange={(e) => setEdit({ ...edit, notes: e.target.value })} /></Field>
            </div>
            <Button className="mt-4 w-full" icon="save" onClick={() => api(`/admin/services/${id}`, { method: "PUT", body: { ...edit, osTemplateId: s.remoteId && ["ACTIVE", "SUSPENDED"].includes(s.status) ? undefined : edit.osTemplateId || null, hostname: edit.hostname || undefined, nextDueDate: edit.nextDueDate || null, recurringAmount: Math.round(Number(edit.recurringAmount) * 100), node: edit.node || null, remoteId: edit.remoteId || null } }).then(() => { toast.success("Saved"); reload(); }).catch((e) => toast.error(e.message))}>Save changes</Button>
          </Card>

          <Card title="Support tickets" action={<Link href={`/admin/tickets?userId=${s.user.id}`} className="text-[13px] font-bold text-primary-dark hover:underline">All tickets</Link>} pad={false}>
            {s.tickets?.length ? (
              <ul className="divide-y divide-line">
                {s.tickets.map((t: any) => (
                  <li key={t.id}><Link href={`/admin/tickets/${t.id}`} className="flex items-center gap-3 px-5 py-3 hover:bg-primary-tint">
                    <Icon name={/cancel/i.test(t.subject) ? "cancel" : "support_agent"} className={cx("text-[20px]", /cancel/i.test(t.subject) ? "text-rose-500" : "text-primary")} />
                    <span className="min-w-0 flex-1"><span className="block truncate text-[13px] font-bold text-ink">#{t.number} {t.subject}</span><span className="text-xs text-mute">{date(t.createdAt)}</span></span>
                    <Badge status={t.status} />
                  </Link></li>
                ))}
              </ul>
            ) : <p className="p-5 text-sm text-mute">No tickets about this service.</p>}
          </Card>
        </div>
      </div>
    </>
  );
}

function Group({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="mb-1.5 text-[10.5px] font-bold uppercase tracking-wider text-mute">{label}</div>
      <div className="flex flex-wrap items-center gap-2">{children}</div>
    </div>
  );
}

function Rows({ rows }: { rows: [string, React.ReactNode][] }) {
  return (
    <dl className="divide-y divide-line text-[13px]">
      {rows.map(([l, v]) => (
        <div key={l} className="flex items-start justify-between gap-4 py-2.5">
          <dt className="shrink-0 text-mute">{l}</dt>
          <dd className="min-w-0 text-right font-semibold text-ink">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

function Meter({ icon, label, value, sub, pct }: { icon: string; label: string; value: string; sub?: string; pct?: number | null }) {
  const p = pct == null || isNaN(pct) ? null : Math.max(0, Math.min(100, pct));
  return (
    <div className="rounded-xl border border-line p-4">
      <div className="flex items-center justify-between text-[12px] font-bold text-mute">{label}<Icon name={icon} className="text-[19px] text-primary" /></div>
      <div className="mt-1.5 text-xl font-extrabold tracking-tight text-ink">{value}</div>
      <div className="text-xs text-mute">{sub}</div>
      {p != null && <div className="mt-2.5 h-1.5 overflow-hidden rounded-full bg-slate-100"><div className={cx("h-full rounded-full", p > 90 ? "bg-rose-500" : p > 70 ? "bg-amber-500" : "bg-gradient-to-r from-primary to-primary-dark")} style={{ width: `${Math.max(2, p)}%` }} /></div>}
    </div>
  );
}

const fmt = (n: number) => (Math.round(n * 10) / 10).toLocaleString("en-IN");
const mb = (v: number) => (v >= 1024 ? `${fmt(v / 1024)} GB` : `${Math.round(v)} MB`);
function speed(bps: number) {
  const b = bps * 8;
  return b >= 1e9 ? `${fmt(b / 1e9)} Gbps` : b >= 1e6 ? `${fmt(b / 1e6)} Mbps` : b >= 1e3 ? `${fmt(b / 1e3)} Kbps` : `${Math.round(b)} bps`;
}
function uptime(sec: number) {
  const d = Math.floor(sec / 86400), h = Math.floor((sec % 86400) / 3600), m = Math.floor((sec % 3600) / 60);
  return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m`;
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

/** Username + root password, masked with show/hide and copy buttons. */
function Credentials({ id, username, hasPassword }: { id: string; username?: string | null; hasPassword?: boolean }) {
  const [cred, setCred] = useState<{ username: string | null; password: string | null } | null>(null);
  const [show, setShow] = useState(false);
  const [err, setErr] = useState("");
  useEffect(() => {
    if (!hasPassword) return;
    api<{ username: string | null; password: string | null }>(`/admin/services/${id}/password`).then(setCred).catch((e) => setErr(e.message));
  }, [id, hasPassword]);
  const user = cred?.username ?? username ?? "root";
  const pw = cred?.password ?? null;
  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-1.5">
        <span className="w-20 text-xs text-mute">Username</span>
        <span className="font-mono text-[13px] font-semibold text-ink">{user}</span>
        <Copy text={user} />
      </div>
      <div className="flex items-center gap-1.5">
        <span className="w-20 text-xs text-mute">Password</span>
        {hasPassword ? (
          pw ? (
            <>
              <span className="select-all font-mono text-[13px] font-semibold text-ink">{show ? pw : "•".repeat(Math.min(pw.length, 14))}</span>
              <button type="button" title={show ? "Hide" : "Show"} className="inline-grid h-7 w-7 place-items-center rounded-lg text-slate-500 hover:bg-primary-soft hover:text-primary-dark" onClick={() => setShow(!show)}>
                <Icon name={show ? "visibility_off" : "visibility"} className="text-[16px]" />
              </button>
              <Copy text={pw} />
            </>
          ) : (
            <span className="text-xs text-mute">{err || "Loading…"}</span>
          )
        ) : (
          <span className="text-xs text-mute">Not stored</span>
        )}
      </div>
    </div>
  );
}

/** Opens a one-time cPanel / WHM / webmail login in a new tab (the tab is opened first so pop-up blockers allow it). */
function openLogin(path: string, service: string) {
  const w = window.open("about:blank", "_blank");
  api<{ url: string }>(path, { body: { service } })
    .then((r) => {
      if (w) w.location.href = r.url;
      else window.location.href = r.url;
    })
    .catch((e) => {
      w?.close();
      toast.error(e.message);
    });
}

function HostingActions({ s, onDone }: { s: any; onDone: () => void }) {
  const reseller = s.product.type === "RESELLER_HOSTING" || s.product.moduleConfig?.cpanel?.reseller;
  const [pw, setPw] = useState<string | null>(null);
  const [pkgs, setPkgs] = useState<string[] | null>(null);
  const loadPkgs = () => s.server && api(`/admin/servers/${s.server.id}/cpanel-packages`).then((r) => setPkgs(r.packages.map((x: any) => x.name))).catch((e) => toast.error(e.message));
  return (
    <>
      <Button size="sm" icon="open_in_new" onClick={() => openLogin(`/admin/services/${s.id}/cpanel-login`, "cpaneld")}>Login to cPanel</Button>
      {reseller && <Button size="sm" variant="secondary" icon="admin_panel_settings" onClick={() => openLogin(`/admin/services/${s.id}/cpanel-login`, "whostmgrd")}>Login to WHM</Button>}
      <Button variant="outline" size="sm" icon="mail" onClick={() => openLogin(`/admin/services/${s.id}/cpanel-login`, "webmaild")}>Webmail</Button>
      <Button variant="outline" size="sm" icon="key" onClick={() => setPw(generatePassword())}>Change password</Button>
      {pkgs ? (
        <Select className="h-9 w-56" defaultValue="" onChange={(e) => { const v = e.target.value; e.target.value = ""; if (v && confirm(`Change the WHM package to ${v}?`)) api(`/admin/services/${s.id}/action`, { body: { action: "change_package", package: v } }).then(() => { toast.success("Package change queued"); setTimeout(onDone, 2500); }).catch((er) => toast.error(er.message)); }}>
          <option value="">Change package to…</option>
          {pkgs.map((x) => <option key={x}>{x}</option>)}
        </Select>
      ) : <Button variant="outline" size="sm" icon="swap_vert" onClick={loadPkgs}>Change package</Button>}
      <Modal open={pw !== null} onClose={() => setPw(null)} title="Change cPanel password">
        <p className="mb-3 text-sm text-mute">Changes the password for <b className="font-mono">{s.username}</b> on the server right away. The customer isn't emailed — share it with them if needed.</p>
        <PasswordField value={pw ?? ""} onChange={setPw} optionalHint="" />
        <Button className="mt-4" icon="save" disabled={!pw || !!passwordProblem(pw)} onClick={() => api(`/admin/services/${s.id}/hosting-password`, { body: { password: pw } }).then(() => { toast.success("Password changed"); setPw(null); onDone(); }).catch((e) => toast.error(e.message))}>Set password</Button>
      </Modal>
    </>
  );
}

function Usage({ label, used, limit }: { label: string; used?: number | null; limit?: number | null }) {
  const pct = limit ? Math.min(100, Math.round(((used ?? 0) / limit) * 100)) : null;
  const fmt = (mb: number) => (mb >= 1024 ? `${(mb / 1024).toFixed(mb >= 10240 ? 0 : 1)} GB` : `${mb} MB`);
  return (
    <div>
      <div className="flex justify-between text-xs"><span className="font-semibold text-slate-700">{label}</span><span className="text-mute">{fmt(used ?? 0)} of {limit ? fmt(limit) : "unlimited"}{pct !== null ? ` · ${pct}%` : ""}</span></div>
      <div className="mt-1 h-2 overflow-hidden rounded-full bg-slate-100"><div className={cx("h-full rounded-full", pct === null ? "bg-emerald-400" : pct > 90 ? "bg-rose-500" : pct > 75 ? "bg-amber-400" : "bg-primary")} style={{ width: `${pct ?? 8}%` }} /></div>
    </div>
  );
}

function HostingCard({ s, live, id }: { s: any; live: any; id: string }) {
  const reseller = s.product.type === "RESELLER_HOSTING" || s.product.moduleConfig?.cpanel?.reseller;
  return (
    <Card title={reseller ? "Reseller hosting account" : "Hosting account"}>
      <dl className="grid grid-cols-[140px_1fr] gap-y-2.5 text-sm">
        <dt className="text-mute">Domain</dt><dd className="font-semibold">{s.hostname ? <a className="text-primary-dark hover:underline" href={`http://${s.hostname}`} target="_blank" rel="noreferrer">{s.hostname}</a> : "—"}</dd>
        <dt className="text-mute">cPanel server</dt><dd className="font-semibold">{s.server ? `${s.server.name} (${s.server.hostname})` : "—"}</dd>
        <dt className="text-mute">Package</dt><dd className="font-semibold">{live?.plan ?? s.product.moduleConfig?.cpanel?.package ?? "—"}{reseller && <span className="ml-2"><Badge>reseller</Badge></span>}</dd>
        <dt className="text-mute">IP address</dt><dd className="font-mono text-[13px]">{live?.ip ?? "—"}</dd>
        <dt className="text-mute">Status on server</dt>
        <dd>{live ? (live.error ? <span className="text-rose-600">{live.error}</span> : <span className="flex flex-wrap items-center gap-2"><LiveBadge state={live.state === "running" ? "running" : live.state} reason={live.reason} />{live.reason && <span className="text-xs text-mute">{live.reason}</span>}</span>) : s.remoteId ? <LiveBadge loading /> : "—"}</dd>
        {live && !live.error && live.disk && (
          <>
            <dt className="text-mute">Usage</dt>
            <dd className="space-y-2.5">
              <Usage label="Disk" used={live.disk.usedMb} limit={live.disk.limitMb} />
              {live.bandwidth && <Usage label="Bandwidth (this month)" used={live.bandwidth.usedMb} limit={live.bandwidth.limitMb} />}
            </dd>
          </>
        )}
        <dt className="text-mute">Nameservers</dt><dd className="font-mono text-[13px]">{s.server?.nameservers?.length ? s.server.nameservers.join(", ") : <span className="font-sans text-mute">Not set on the server</span>}</dd>
        <dt className="text-mute">Credentials</dt><dd>{s.hasPassword || s.username ? <Credentials id={id} username={s.username} hasPassword={s.hasPassword} /> : "—"}</dd>
      </dl>
    </Card>
  );
}
