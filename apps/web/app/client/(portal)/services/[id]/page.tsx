"use client";
import { OsChooser } from "@/components/os-chooser";
import { OsLogo } from "@/components/os-logo";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useState } from "react";
import { api, CYCLES, date, gb, invNo, money } from "@/lib/api";
import { Alert, Badge, Button, Card, Copy, Field, Icon, Input, Loading, Modal, Select, Textarea, cx, toast, useApi } from "@/components/ui";
import { PasswordField, passwordProblem } from "@/components/password-field";
import { Sparkline } from "@/components/sparkline";
import { ProvisioningTracker } from "@/components/provisioning-tracker";
import { LiveBadge } from "@/components/live-state";

export default function ServicePage() {
  const { id } = useParams<{ id: string }>();
  const { data, loading, reload } = useApi(`/client/services/${id}`);
  const [live, setLive] = useState<any>(null);
  const [usage, setUsage] = useState<any[]>([]);
  const [cred, setCred] = useState<{ username: string; password: string } | null>(null);
  const [modal, setModal] = useState<null | "reinstall" | "cancel" | "rdns" | "password">(null);
  const [busy, setBusy] = useState<string | null>(null);

  const svc = data?.service;
  const isVps = svc && (svc.product.provisioner === "PROXMOX" || svc.product.provisioner === "VIRTUALIZOR");
  const isHosting = svc?.product.provisioner === "CPANEL";

  useEffect(() => {
    if (!svc || svc.status !== "ACTIVE" || (!isVps && !isHosting)) return;
    const tick = () => api(`/client/services/${id}/status`).then((r) => setLive(r.live)).catch(() => {});
    tick();
    if (isVps) api(`/client/services/${id}/usage?timeframe=day`).then((r) => setUsage(r.points)).catch(() => {});
    const t = setInterval(tick, isVps ? 15000 : 60000);
    return () => clearInterval(t);
  }, [svc?.status, isVps, isHosting, id]); // eslint-disable-line react-hooks/exhaustive-deps

  if (loading || !svc) return <Loading />;
  const ip = svc.ips.find((i: any) => i.isPrimary)?.address ?? svc.ips[0]?.address;
  const reseller = svc.product.type === "RESELLER_HOSTING" || live?.reseller;
  const showPassword = () => api(`/client/services/${id}/reveal-password`, { body: {} }).then(setCred).catch((e) => toast.error(e.message));

  async function act(action: string, extra: Record<string, unknown> = {}) {
    setBusy(action);
    try {
      await api(`/client/services/${id}/action`, { body: { action, ...extra } });
      toast.success(`${action.replace("_", " ")} requested — this takes a few seconds`);
      setModal(null);
      setTimeout(reload, 4000);
    } catch (e: any) {
      toast.error(e.message);
    } finally {
      setBusy(null);
    }
  }

  const running = live?.state === "running";
  const days = svc.nextDueDate ? Math.ceil((new Date(svc.nextDueDate).getTime() - Date.now()) / 86400_000) : null;
  return (
    <>
      <Link href="/client/services" className="mb-3 inline-flex items-center gap-1 text-sm font-bold text-primary-dark hover:underline"><Icon name="arrow_back" className="text-[18px]" />My services</Link>

      {/* ── header ── */}
      <section className="mb-6 overflow-hidden rounded-3xl border border-[#ece7f7] bg-white shadow-card">
        <div className="relative bg-[radial-gradient(120%_160%_at_0%_0%,#f3ecff_0%,#ffffff_55%)] p-5 sm:p-6">
          <div className="flex flex-col gap-5 lg:flex-row lg:items-center lg:justify-between">
            <div className="flex min-w-0 items-center gap-4">
              {isVps && svc.osTemplate ? <OsLogo os={svc.osTemplate} size={56} className="rounded-2xl shadow-sm" /> : (
                <span className={cx("grid h-14 w-14 shrink-0 place-items-center rounded-2xl text-white shadow-md", isHosting ? "bg-gradient-to-br from-sky-500 to-indigo-600" : "bg-gradient-to-br from-primary to-primary-dark")}>
                  <Icon name={isHosting ? "language" : isVps ? "terminal" : "widgets"} className="text-[28px]" />
                </span>
              )}
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <h1 className="truncate text-xl font-extrabold tracking-tight text-ink sm:text-2xl">{svc.product.name}</h1>
                  <Badge status={svc.status} />
                  {svc.status === "ACTIVE" && (isVps || isHosting) && <LiveBadge state={live?.state} reason={live?.reason} loading={!live} />}
                </div>
                <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-[13px] text-slate-600">
                  {svc.hostname && <span className="inline-flex items-center gap-1"><Icon name={isHosting ? "language" : "dns"} className="text-[16px] text-mute" />{isHosting ? <a href={`http://${svc.hostname}`} target="_blank" rel="noreferrer" className="font-semibold hover:text-primary-dark">{svc.hostname}</a> : svc.hostname}</span>}
                  {(ip || live?.ip) && <span className="inline-flex items-center gap-1 font-mono text-[12.5px]"><Icon name="lan" className="text-[16px] text-mute" />{ip ?? live?.ip}<Copy text={ip ?? live?.ip} /></span>}
                  <span className="inline-flex items-center gap-1"><Icon name="category" className="text-[16px] text-mute" />{isHosting ? (reseller ? "Reseller hosting (cPanel + WHM)" : "cPanel web hosting") : isVps ? `${svc.product.virtType ?? "KVM"} VPS · ${svc.product.cpuCores} vCPU · ${gb(svc.product.ramMb)}` : "Service"}</span>
                </div>
              </div>
            </div>
            <div className="flex flex-wrap gap-2">
              {isHosting && svc.status === "ACTIVE" && <>
                <Button icon="open_in_new" onClick={() => openLogin(id, "cpaneld")}>Login to cPanel</Button>
                {reseller && <Button variant="secondary" icon="admin_panel_settings" onClick={() => openLogin(id, "whostmgrd")}>Login to WHM</Button>}
                <Button variant="outline" icon="mail" onClick={() => openLogin(id, "webmaild")}>Webmail</Button>
              </>}
              {isVps && svc.status === "ACTIVE" && svc.product?.provisioner === "VIRTUALIZOR" && <Button icon="terminal" href={`/client/services/${id}/console`}>Open console</Button>}
              {svc.status === "SUSPENDED" && <Button icon="bolt" href="/client/invoices?status=UNPAID">Pay to restore</Button>}
            </div>
          </div>
          <div className="mt-5 grid grid-cols-2 gap-3 border-t border-[#efe9fb] pt-4 sm:grid-cols-4">
            <HeadStat label="Recurring" value={`${money(svc.recurringAmount, svc.currency)}`} sub={`${CYCLES[svc.billingCycle] ?? ""}${svc.currency === "INR" ? " + GST" : ""}`} />
            <HeadStat label="Next due" value={date(svc.nextDueDate)} sub={days === null ? "—" : days < 0 ? `${-days} days overdue` : days === 0 ? "Due today" : `in ${days} days`} warn={days !== null && days <= 7} />
            <HeadStat label="Registered" value={date(svc.registrationDate)} sub={`Service #${String(svc.id).slice(-6).toUpperCase()}`} />
            <HeadStat label={isHosting ? "Server" : isVps ? "Location" : "Status"} value={isHosting ? live?.server?.name ?? "—" : isVps ? svc.location ?? svc.osTemplate?.name ?? "—" : svc.status} sub={isHosting ? live?.plan ? `Package ${live.plan}` : "" : isVps ? `${svc.product.diskGb} GB NVMe` : ""} />
          </div>
        </div>
      </section>

      {(isVps || isHosting) && (["PENDING", "PROVISIONING", "FAILED"].includes(svc.status) || (svc.status === "ACTIVE" && Date.now() - new Date(svc.createdAt).getTime() < 3 * 3600_000)) && (
        <ProvisioningTracker path={`/client/services/${id}/provisioning`} audience="client" onChange={() => reload()} />
      )}
      {!isVps && !isHosting && svc.status === "PENDING" && (
        <Alert tone="warn" className="mb-5">
          This service is awaiting payment. <Link href="/client/invoices?status=UNPAID" className="font-bold underline">Pay the invoice</Link> to activate it.
        </Alert>
      )}
      {svc.status === "SUSPENDED" && (
        <Alert tone="error" className="mb-5">
          Suspended: {svc.suspendReason ?? "contact support"}. Paying overdue invoices restores the service automatically.
        </Alert>
      )}

      {isHosting && svc.status === "ACTIVE" && <HostingPanels id={id} svc={svc} live={live} cred={cred} showPassword={showPassword} onPassword={() => setModal("password")} />}

      {isVps && svc.status === "ACTIVE" && (
        <Card className="mb-6">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div>
              <div className="text-[15px] font-extrabold text-ink">Power & performance</div>
              <div className="text-xs text-mute">{live?.uptimeSec ? `Up ${Math.floor(live.uptimeSec / 86400) ? `${Math.floor(live.uptimeSec / 86400)}d ` : ""}${Math.floor((live.uptimeSec % 86400) / 3600)}h ${Math.floor((live.uptimeSec % 3600) / 60)}m` : live?.state === "locked" ? "A task is running on this server — try again in a minute" : "Live from the hypervisor"}</div>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button size="sm" variant="outline" icon="play_arrow" disabled={running} loading={busy === "start"} onClick={() => act("start")}>Start</Button>
              <Button size="sm" variant="outline" icon="restart_alt" disabled={!running} loading={busy === "reboot"} onClick={() => act("reboot")}>Reboot</Button>
              <Button size="sm" variant="outline" icon="power_settings_new" disabled={!running} loading={busy === "shutdown"} onClick={() => confirm("Shut down the server gracefully?") && act("shutdown")}>Shutdown</Button>
              <Button size="sm" variant="outline" icon="stop" disabled={!running} loading={busy === "stop"} onClick={() => confirm("Force power-off? Unsaved data may be lost.") && act("stop")}>Power off</Button>
              <Button size="sm" variant="secondary" icon="install_desktop" onClick={() => setModal("reinstall")}>Reinstall</Button>
            </div>
          </div>
          {live && !live.error && (
            <div className="mt-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
              <Meter label="CPU" value={`${live.cpuPct ?? 0}%`} sub={`${live.cpus ?? svc.product.cpuCores} vCPU`} pct={live.cpuPct ?? 0} icon="memory" />
              <Meter label="Memory" value={`${live.memUsedMb ?? 0} MB`} sub={`of ${live.memTotalMb ?? svc.product.ramMb} MB`} pct={live.memTotalMb ? ((live.memUsedMb ?? 0) / live.memTotalMb) * 100 : 0} icon="memory_alt" />
              <Meter label="Network in" value={`${live.netInMb ?? 0} MB`} sub="since boot" icon="download" />
              <Meter label="Network out" value={`${live.netOutMb ?? 0} MB`} sub="since boot" icon="upload" />
            </div>
          )}
          {usage.length > 1 && (
            <div className="mt-5 grid gap-4 md:grid-cols-2">
              <div className="rounded-xl border border-[#f1edf9] p-4">
                <div className="mb-1 text-xs font-bold text-mute">CPU — last 24 hours</div>
                <Sparkline values={usage.map((p) => p.cpu * 100)} suffix="%" />
              </div>
              <div className="rounded-xl border border-[#f1edf9] p-4">
                <div className="mb-1 text-xs font-bold text-mute">Network out — last 24 hours</div>
                <Sparkline values={usage.map((p) => p.netout / 1024)} suffix=" KB/s" />
              </div>
            </div>
          )}
        </Card>
      )}

      <div className="grid gap-6 lg:grid-cols-2 [&>*]:min-w-0">
        {!isHosting && (
        <Card title={isVps ? "Server details" : "Service details"}>
          <dl className="grid grid-cols-[130px_1fr] gap-y-3 text-sm">
            <dt className="text-mute">Hostname</dt>
            <dd className="font-semibold text-ink">{svc.hostname ?? "—"}</dd>
            <dt className="text-mute">Primary IP</dt>
            <dd className="flex items-center gap-1 font-semibold text-ink">
              {ip ?? "—"} {ip && <Copy text={ip} />}
            </dd>
            {svc.ips.length > 1 && (
              <>
                <dt className="text-mute">Other IPs</dt>
                <dd className="space-y-0.5 font-mono text-[13px]">{svc.ips.filter((i: any) => i.address !== ip).map((i: any) => <div key={i.address} className="flex items-center gap-1">{i.address}<Copy text={i.address} /></div>)}</dd>
              </>
            )}
            {svc.ipv6Address && (
              <>
                <dt className="text-mute">IPv6</dt>
                <dd className="font-semibold text-ink">{svc.ipv6Address}</dd>
              </>
            )}
            {isVps && (
              <>
                <dt className="text-mute">Operating system</dt>
                <dd className="flex items-center gap-2 font-semibold text-ink">{svc.osTemplate && <OsLogo os={svc.osTemplate} size={22} className="rounded-md" />}{svc.osTemplate?.name ?? "—"}</dd>
                <dt className="text-mute">Resources</dt>
                <dd className="font-semibold text-ink">
                  {svc.product.cpuCores} vCPU · {gb(svc.product.ramMb)} RAM · {svc.product.diskGb} GB SSD
                </dd>
                <dt className="text-mute">Login</dt>
                <dd>
                  {cred ? (
                    <div className="space-y-1 font-mono text-[13px]">
                      <div className="flex items-center gap-1">{cred.username} <Copy text={cred.username} /></div>
                      <div className="flex items-center gap-1 break-all">{cred.password} <Copy text={cred.password} /></div>
                    </div>
                  ) : svc.hasPassword ? (
                    <Button size="sm" variant="secondary" icon="visibility" onClick={showPassword}>Show password</Button>
                  ) : (
                    <span className="text-mute">Sent by email</span>
                  )}
                </dd>
              </>
            )}
          </dl>
          {isVps && svc.status === "ACTIVE" && (
            <div className="mt-4 flex flex-wrap gap-2 border-t border-line pt-4">
              <Button size="sm" variant="ghost" icon="key" onClick={() => confirm("Generate a new root/Administrator password? The server will reboot.") && act("reset_password")}>Reset password</Button>
              <Button size="sm" variant="ghost" icon="dns" onClick={() => setModal("rdns")}>Reverse DNS</Button>
            </div>
          )}
        </Card>
        )}

        <Card title="Billing">
          <dl className="grid grid-cols-[130px_1fr] gap-y-3 text-sm">
            <dt className="text-mute">Registered</dt>
            <dd className="font-semibold text-ink">{date(svc.registrationDate)}</dd>
            <dt className="text-mute">Billing cycle</dt>
            <dd className="font-semibold text-ink">{CYCLES[svc.billingCycle]}</dd>
            <dt className="text-mute">Recurring</dt>
            <dd className="font-semibold text-ink">{money(svc.recurringAmount, svc.currency)}{svc.currency === "INR" ? " + GST" : ""}</dd>
            <dt className="text-mute">Next due date</dt>
            <dd className="font-semibold text-ink">{date(svc.nextDueDate)}</dd>
          </dl>
          {data.invoices.length > 0 && (
            <ul className="mt-4 divide-y divide-[#f3effb] border-t border-line">
              {data.invoices.map((i: any) => (
                <li key={i.id}>
                  <Link href={`/client/invoices/${i.id}`} className="flex items-center justify-between py-2.5 text-sm hover:text-primary-dark">
                    <span className="font-semibold">{invNo(i)}</span>
                    <span className="flex items-center gap-3">{money(i.total, i.currency)} <Badge status={i.status} /></span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
          {svc.status !== "TERMINATED" && svc.status !== "CANCELLED" && (
            <button onClick={() => setModal("cancel")} className="mt-4 text-sm font-bold text-rose-600 hover:underline">Request cancellation</button>
          )}
        </Card>

        {data.logs.length > 0 && (
          <Card title="Recent activity" pad={false} className={isHosting ? "" : "lg:col-span-2"}>
            <ul className="divide-y divide-[#f3effb] text-sm">
              {data.logs.map((l: any, i: number) => (
                <li key={i} className="flex items-center justify-between px-5 py-2.5">
                  <span className="flex items-center gap-2 font-semibold capitalize text-ink">
                    <Icon name={l.success ? "check_circle" : "error"} className={l.success ? "text-emerald-500" : "text-rose-500"} />
                    {l.action.replace(/_/g, " ")}
                  </span>
                  <span className="text-mute">{date(l.createdAt, true)}</span>
                </li>
              ))}
            </ul>
          </Card>
        )}
      </div>

      <ReinstallModal open={modal === "reinstall"} onClose={() => setModal(null)} svc={svc} onSubmit={(os, confirmText) => act("reinstall", { osTemplateId: os, confirm: confirmText })} busy={busy === "reinstall"} />
      <CancelModal open={modal === "cancel"} onClose={() => setModal(null)} id={id} />
      <RdnsModal open={modal === "rdns"} onClose={() => setModal(null)} id={id} ips={svc.ips} />
      <HostingPasswordModal open={modal === "password"} onClose={() => setModal(null)} id={id} username={svc.username} onDone={() => setCred(null)} />
    </>
  );
}

/** Opens a one-time cPanel / WHM / webmail login (the tab is opened first so pop-up blockers allow it). */
function openLogin(id: string, service: string) {
  const w = window.open("about:blank", "_blank");
  api<{ url: string }>(`/client/services/${id}/cpanel-login`, { body: { service } })
    .then((r) => {
      if (w) w.location.href = r.url;
      else window.location.href = r.url;
    })
    .catch((e) => {
      w?.close();
      toast.error(e.message);
    });
}

function HeadStat({ label, value, sub, warn }: { label: string; value: string; sub?: string; warn?: boolean }) {
  return (
    <div className="min-w-0">
      <div className="text-[11.5px] font-bold uppercase tracking-wide text-mute">{label}</div>
      <div className="mt-0.5 truncate text-[15px] font-extrabold text-ink">{value}</div>
      {sub && <div className={cx("truncate text-xs", warn ? "font-semibold text-rose-600" : "text-mute")}>{sub}</div>}
    </div>
  );
}

function Meter({ label, value, sub, pct, icon }: { label: string; value: string; sub: string; pct?: number; icon: string }) {
  return (
    <div className="rounded-xl border border-[#f1edf9] bg-[#fcfaff] p-4">
      <div className="flex items-center justify-between text-xs font-bold text-mute">{label}<Icon name={icon} className="text-[18px] text-primary" /></div>
      <div className="mt-1 text-xl font-extrabold text-ink">{value}</div>
      <div className="text-xs text-mute">{sub}</div>
      {pct !== undefined && <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-[#ede9fe]"><div className={cx("h-full rounded-full", pct > 85 ? "bg-rose-500" : pct > 65 ? "bg-amber-400" : "bg-primary")} style={{ width: `${Math.min(100, Math.max(3, pct))}%` }} /></div>}
    </div>
  );
}

function UsageBar({ label, used, limit, icon }: { label: string; used?: number | null; limit?: number | null; icon: string }) {
  const pct = limit ? Math.min(100, Math.round(((used ?? 0) / limit) * 100)) : null;
  const fmt = (mb: number) => (mb >= 1024 ? `${(mb / 1024).toFixed(mb >= 10240 ? 0 : 1)} GB` : `${mb} MB`);
  return (
    <div className="rounded-xl border border-[#f1edf9] bg-[#fcfaff] p-4">
      <div className="flex items-center justify-between">
        <span className="flex items-center gap-2 text-[13px] font-bold text-ink"><Icon name={icon} className="text-[18px] text-primary" />{label}</span>
        <span className="text-xs font-bold text-mute">{pct !== null ? `${pct}%` : "Unlimited"}</span>
      </div>
      <div className="mt-2 text-lg font-extrabold text-ink">{fmt(used ?? 0)} <span className="text-xs font-semibold text-mute">of {limit ? fmt(limit) : "unlimited"}</span></div>
      <div className="mt-2 h-2 overflow-hidden rounded-full bg-[#ede9fe]"><div className={cx("h-full rounded-full", pct === null ? "bg-emerald-400" : pct > 90 ? "bg-rose-500" : pct > 75 ? "bg-amber-400" : "bg-gradient-to-r from-primary to-primary-dark")} style={{ width: `${pct ?? 6}%` }} /></div>
    </div>
  );
}

function HostingPanels({ id, svc, live, cred, showPassword, onPassword }: { id: string; svc: any; live: any; cred: any; showPassword: () => void; onPassword: () => void }) {
  const host = live?.server?.hostname ?? null;
  const reseller = svc.product.type === "RESELLER_HOSTING" || live?.reseller;
  const ns: string[] = live?.nameservers ?? [];
  const tiles: [string, string, string, string][] = [
    ["cpaneld", "dashboard", "cPanel", "Files, databases, SSL, backups"],
    ["webmaild", "mail", "Webmail", "Read and send email"],
    ...(reseller ? [["whostmgrd", "admin_panel_settings", "WHM", "Create accounts for your customers"] as [string, string, string, string]] : []),
  ];
  return (
    <div className="mb-6 space-y-6">
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4 [&>*]:min-w-0">
        {tiles.map(([svcName, icon, title, text]) => (
          <button key={svcName} type="button" onClick={() => openLogin(id, svcName)} className="group flex items-center gap-3 rounded-2xl border border-[#ece7f7] bg-white p-4 text-left shadow-card transition hover:-translate-y-0.5 hover:border-[#dccafb]">
            <span className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-gradient-to-br from-primary to-primary-dark text-white shadow-md"><Icon name={icon} className="text-[22px]" /></span>
            <span className="min-w-0 flex-1"><span className="block text-[14.5px] font-extrabold text-ink group-hover:text-primary-dark">{title}</span><span className="block truncate text-xs text-mute">{text}</span></span>
            <Icon name="open_in_new" className="text-[18px] text-mute group-hover:text-primary-dark" />
          </button>
        ))}
        <a href={`http://${svc.hostname}`} target="_blank" rel="noreferrer" className="group flex items-center gap-3 rounded-2xl border border-[#ece7f7] bg-white p-4 shadow-card transition hover:-translate-y-0.5 hover:border-[#dccafb]">
          <span className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-gradient-to-br from-sky-500 to-indigo-600 text-white shadow-md"><Icon name="public" className="text-[22px]" /></span>
          <span className="min-w-0 flex-1"><span className="block text-[14.5px] font-extrabold text-ink group-hover:text-primary-dark">Visit website</span><span className="block truncate text-xs text-mute">{svc.hostname}</span></span>
          <Icon name="arrow_outward" className="text-[18px] text-mute" />
        </a>
      </div>

      <div className="grid items-start gap-6 lg:grid-cols-2 [&>*]:min-w-0">
        <Card title="Usage">
          {live && !live.error && live.disk ? (
            <div className="grid gap-3 sm:grid-cols-2">
              <UsageBar label="Disk space" icon="hard_drive" used={live.disk.usedMb} limit={live.disk.limitMb} />
              <UsageBar label="Bandwidth this month" icon="swap_vert" used={live.bandwidth?.usedMb ?? 0} limit={live.bandwidth?.limitMb} />
            </div>
          ) : live?.error ? <Alert tone="warn">{live.error}</Alert> : <div className="grid gap-3 sm:grid-cols-2"><div className="h-[104px] animate-pulse rounded-xl bg-[#f6f3fd]" /><div className="h-[104px] animate-pulse rounded-xl bg-[#f6f3fd]" /></div>}
          <p className="mt-3 text-xs text-mute">Figures come straight from the cPanel server and refresh every minute.</p>
        </Card>

        <Card title="Login details">
          <dl className="grid grid-cols-[120px_1fr] gap-y-3 text-sm">
            <dt className="text-mute">cPanel address</dt>
            <dd className="flex items-center gap-1 break-all font-mono text-[13px] text-ink">{host ? <>https://{host}:2083<Copy text={`https://${host}:2083`} /></> : "—"}</dd>
            <dt className="text-mute">Username</dt>
            <dd className="flex items-center gap-1 font-mono text-[13px] font-semibold text-ink">{svc.username ?? "—"}{svc.username && <Copy text={svc.username} />}</dd>
            <dt className="text-mute">Password</dt>
            <dd className="flex flex-wrap items-center gap-2">
              {cred ? <span className="flex items-center gap-1 break-all font-mono text-[13px] text-ink">{cred.password}<Copy text={cred.password} /></span> : svc.hasPassword ? <Button size="sm" variant="secondary" icon="visibility" onClick={showPassword}>Show password</Button> : <span className="text-mute">Sent by email</span>}
              <button type="button" onClick={onPassword} className="text-xs font-bold text-primary-dark hover:underline">Change</button>
            </dd>
            <dt className="text-mute">Server IP</dt>
            <dd className="flex items-center gap-1 font-mono text-[13px] text-ink">{live?.ip ?? "—"}{live?.ip && <Copy text={live.ip} />}</dd>
            {reseller && (
              <>
                <dt className="text-mute">WHM address</dt>
                <dd className="flex items-center gap-1 break-all font-mono text-[13px] text-ink">{host ? <>https://{host}:2087<Copy text={`https://${host}:2087`} /></> : "—"}</dd>
              </>
            )}
          </dl>
        </Card>
      </div>

      <Card title="Point your domain to us">
        <div className="grid gap-5 lg:grid-cols-2">
          <div>
            <div className="text-[13px] font-bold text-ink">Option 1 — use our nameservers <span className="font-semibold text-emerald-600">(recommended)</span></div>
            <p className="mt-1 text-xs text-mute">At your domain registrar, replace the nameservers for <b>{svc.hostname}</b> with:</p>
            {ns.length ? (
              <div className="mt-3 space-y-2">
                {ns.map((n, i) => <div key={n} className="flex items-center justify-between rounded-xl border border-[#f1edf9] bg-[#fcfaff] px-3 py-2"><span className="text-xs text-mute">Nameserver {i + 1}</span><span className="flex items-center gap-1 font-mono text-[13px] font-semibold text-ink">{n}<Copy text={n} /></span></div>)}
              </div>
            ) : <p className="mt-3 rounded-xl bg-[#fcfaff] px-3 py-2 text-xs text-mute">Your nameservers are in the welcome email we sent when the account was set up.</p>}
          </div>
          <div>
            <div className="text-[13px] font-bold text-ink">Option 2 — keep your DNS, add records</div>
            <p className="mt-1 text-xs text-mute">If your DNS is elsewhere (e.g. Cloudflare), point these records to the server:</p>
            <div className="mt-3 overflow-hidden rounded-xl border border-[#f1edf9] text-[13px]">
              {[["A", "@", live?.ip ?? "server IP"], ["A", "www", live?.ip ?? "server IP"], ["A", "mail", live?.ip ?? "server IP"]].map(([t, n, v]) => (
                <div key={n} className="grid grid-cols-[48px_70px_1fr] items-center border-b border-[#f1edf9] px-3 py-2 last:border-0">
                  <span className="font-bold text-primary-dark">{t}</span><span className="font-mono text-slate-600">{n}</span><span className="flex items-center gap-1 font-mono text-ink">{v}{live?.ip && <Copy text={v} />}</span>
                </div>
              ))}
            </div>
            <p className="mt-2 text-[11.5px] text-mute">DNS changes usually take effect within a few hours (up to 24 h).</p>
          </div>
        </div>
      </Card>
    </div>
  );
}

function HostingPasswordModal({ open, onClose, id, username, onDone }: { open: boolean; onClose: () => void; id: string; username?: string | null; onDone: () => void }) {
  const [pw, setPw] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (open) setPw(""); }, [open]);
  return (
    <Modal open={open} onClose={onClose} title="Change cPanel password">
      <p className="mb-3 text-sm text-mute">Sets a new password for <b className="font-mono">{username}</b>. It's used for cPanel, FTP and the main email account, and takes effect right away.</p>
      <PasswordField value={pw} onChange={setPw} optionalHint="Click Generate for a strong random password" />
      <Button className="mt-4 w-full" icon="key" loading={busy} disabled={!pw || !!passwordProblem(pw)} onClick={async () => {
        setBusy(true);
        try { await api(`/client/services/${id}/hosting-password`, { body: { password: pw } }); toast.success("Password changed"); onDone(); onClose(); } catch (e: any) { toast.error(e.message); }
        setBusy(false);
      }}>Change password</Button>
    </Modal>
  );
}

function ReinstallModal({ open, onClose, svc, onSubmit, busy }: { open: boolean; onClose: () => void; svc: any; onSubmit: (os: string, c: string) => void; busy: boolean }) {
  const [os, setOs] = useState(svc.osTemplate?.id ?? "");
  const [c, setC] = useState("");
  return (
    <Modal open={open} onClose={onClose} title="Reinstall operating system" wide>
      <Alert tone="error" className="mb-4">
        All data on this server will be permanently erased. Your IP address stays the same; a new password will be emailed to you.
      </Alert>
      <div className="space-y-4">
        <Field label="Operating system">
          <OsChooser
            value={os}
            onChange={setOs}
            options={svc.product.osTemplates
              .map((o: any) => o.osTemplate)
              // only images available on the server this VPS lives on
              .filter((o: any) => o.enabled !== false && (!o.virtualizorServerId || !svc.serverId || o.virtualizorServerId === svc.serverId))}
          />
        </Field>
        <Field label='Type "REINSTALL" to confirm'>
          <Input value={c} onChange={(e) => setC(e.target.value)} />
        </Field>
        <Button variant="danger" className="w-full" disabled={c !== "REINSTALL"} loading={busy} onClick={() => onSubmit(os, c)}>
          Erase and reinstall
        </Button>
      </div>
    </Modal>
  );
}

function CancelModal({ open, onClose, id }: { open: boolean; onClose: () => void; id: string }) {
  const [reason, setReason] = useState("");
  const [when, setWhen] = useState("end_of_period");
  return (
    <Modal open={open} onClose={onClose} title="Request cancellation">
      <div className="space-y-4">
        <Field label="When">
          <Select value={when} onChange={(e) => setWhen(e.target.value)}>
            <option value="end_of_period">At the end of the billing period</option>
            <option value="immediate">Immediately</option>
          </Select>
        </Field>
        <Field label="Reason">
          <Textarea rows={4} value={reason} onChange={(e) => setReason(e.target.value)} />
        </Field>
        <Button
          variant="danger"
          className="w-full"
          onClick={() =>
            api(`/client/services/${id}/cancel`, { body: { reason, when } })
              .then(() => {
                toast.success("Cancellation request sent to our billing team");
                onClose();
              })
              .catch((e) => toast.error(e.message))
          }
        >
          Submit request
        </Button>
      </div>
    </Modal>
  );
}

function RdnsModal({ open, onClose, id, ips }: { open: boolean; onClose: () => void; id: string; ips: any[] }) {
  const v4 = ips.filter((i) => i.version === 4);
  const [address, setAddress] = useState(v4[0]?.address ?? "");
  const [rdns, setRdns] = useState(v4[0]?.rdns ?? "");
  return (
    <Modal open={open} onClose={onClose} title="Reverse DNS (PTR)">
      <div className="space-y-4">
        <Field label="IP address">
          <Select value={address} onChange={(e) => setAddress(e.target.value)}>
            {v4.map((i) => (
              <option key={i.address}>{i.address}</option>
            ))}
          </Select>
        </Field>
        <Field label="Hostname" hint="Must have a matching A record pointing to this IP.">
          <Input value={rdns} onChange={(e) => setRdns(e.target.value)} placeholder="mail.example.com" />
        </Field>
        <Button
          className="w-full"
          onClick={() =>
            api(`/client/services/${id}/rdns`, { body: { address, rdns } })
              .then((r) => {
                toast.success(r.note);
                onClose();
              })
              .catch((e) => toast.error(e.message))
          }
        >
          Save
        </Button>
      </div>
    </Modal>
  );
}
