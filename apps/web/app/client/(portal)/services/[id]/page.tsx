"use client";
import { OsChooser } from "@/components/os-chooser";
import { OsLogo } from "@/components/os-logo";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useState } from "react";
import { api, CYCLES, date, gb, invNo, money } from "@/lib/api";
import { Alert, Badge, Button, Card, Copy, Field, Icon, Input, Loading, Modal, PageHeader, Select, Textarea, toast, useApi } from "@/components/ui";
import { Sparkline } from "@/components/sparkline";
import { ProvisioningTracker } from "@/components/provisioning-tracker";
import { LiveBadge } from "@/components/live-state";

export default function ServicePage() {
  const { id } = useParams<{ id: string }>();
  const { data, loading, reload } = useApi(`/client/services/${id}`);
  const [live, setLive] = useState<any>(null);
  const [usage, setUsage] = useState<any[]>([]);
  const [cred, setCred] = useState<{ username: string; password: string } | null>(null);
  const [modal, setModal] = useState<null | "reinstall" | "cancel" | "rdns">(null);
  const [busy, setBusy] = useState<string | null>(null);

  const svc = data?.service;
  const isVps = svc && (svc.product.provisioner === "PROXMOX" || svc.product.provisioner === "VIRTUALIZOR");

  useEffect(() => {
    if (!svc || svc.status !== "ACTIVE" || !isVps) return;
    const tick = () => api(`/client/services/${id}/status`).then((r) => setLive(r.live)).catch(() => {});
    tick();
    api(`/client/services/${id}/usage?timeframe=day`).then((r) => setUsage(r.points)).catch(() => {});
    const t = setInterval(tick, 15000);
    return () => clearInterval(t);
  }, [svc?.status, isVps, id]); // eslint-disable-line react-hooks/exhaustive-deps

  if (loading || !svc) return <Loading />;
  const ip = svc.ips.find((i: any) => i.isPrimary)?.address ?? svc.ips[0]?.address;

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
  return (
    <>
      <PageHeader
        back="/client/services"
        title={
          <span className="flex flex-wrap items-center gap-3">
            {svc.product.name} <Badge status={svc.status} />
          </span>
        }
        subtitle={svc.hostname ?? undefined}
      />

      {isVps && (["PENDING", "PROVISIONING", "FAILED"].includes(svc.status) || (svc.status === "ACTIVE" && Date.now() - new Date(svc.createdAt).getTime() < 3 * 3600_000)) && (
        <ProvisioningTracker path={`/client/services/${id}/provisioning`} audience="client" onChange={() => reload()} />
      )}
      {!isVps && svc.status === "PENDING" && (
        <Alert tone="warn" className="mb-5">
          This service is awaiting payment. <Link href="/client/invoices?status=UNPAID" className="font-bold underline">Pay the invoice</Link> to activate it.
        </Alert>
      )}
      {svc.status === "SUSPENDED" && (
        <Alert tone="error" className="mb-5">
          Suspended: {svc.suspendReason ?? "contact support"}. Paying overdue invoices restores the service automatically.
        </Alert>
      )}

      {isVps && svc.status === "ACTIVE" && (
        <Card className="mb-6">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div className="flex items-center gap-3">
              <div>
                <div className="flex items-center gap-2"><LiveBadge state={live?.state} reason={live?.reason} loading={!live} className="text-[13px]" />{live?.state === "locked" && <span className="text-xs text-mute">A task is running on this server — try again in a minute</span>}</div>
                {live?.uptimeSec ? <div className="text-xs text-mute">Up {Math.floor(live.uptimeSec / 3600)}h {Math.floor((live.uptimeSec % 3600) / 60)}m</div> : null}
              </div>
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
            <div className="mt-5 grid gap-3 sm:grid-cols-4">
              {[
                ["CPU", `${live.cpuPct ?? 0}%`, `${live.cpus ?? svc.product.cpuCores} vCPU`],
                ["Memory", `${live.memUsedMb ?? 0} MB`, `of ${live.memTotalMb ?? svc.product.ramMb} MB`],
                ["Network in", `${live.netInMb ?? 0} MB`, "since boot"],
                ["Network out", `${live.netOutMb ?? 0} MB`, "since boot"],
              ].map(([l, v, h]) => (
                <div key={l} className="rounded-xl bg-[#fbf9ff] p-3.5">
                  <div className="text-xs font-semibold text-mute">{l}</div>
                  <div className="text-lg font-extrabold text-ink">{v}</div>
                  <div className="text-xs text-mute">{h}</div>
                </div>
              ))}
            </div>
          )}
          {usage.length > 1 && (
            <div className="mt-5 grid gap-4 md:grid-cols-2">
              <div>
                <div className="mb-1 text-xs font-bold text-mute">CPU — last 24 hours</div>
                <Sparkline values={usage.map((p) => p.cpu * 100)} suffix="%" />
              </div>
              <div>
                <div className="mb-1 text-xs font-bold text-mute">Network out — last 24 hours</div>
                <Sparkline values={usage.map((p) => p.netout / 1024)} suffix=" KB/s" />
              </div>
            </div>
          )}
        </Card>
      )}

      <div className="grid gap-6 lg:grid-cols-2">
        <Card title="Server details">
          <dl className="grid grid-cols-[130px_1fr] gap-y-3 text-sm">
            <dt className="text-mute">Hostname</dt>
            <dd className="font-semibold text-ink">{svc.hostname ?? "—"}</dd>
            <dt className="text-mute">Primary IP</dt>
            <dd className="flex items-center gap-1 font-semibold text-ink">
              {ip ?? "—"} {ip && <Copy text={ip} />}
            </dd>
            {svc.ipv6Address && (
              <>
                <dt className="text-mute">IPv6</dt>
                <dd className="font-semibold text-ink">{svc.ipv6Address}</dd>
              </>
            )}
            <dt className="text-mute">Operating system</dt>
            <dd className="flex items-center justify-end gap-2 font-semibold text-ink">{svc.osTemplate && <OsLogo os={svc.osTemplate} size={22} className="rounded-md" />}{svc.osTemplate?.name ?? "—"}</dd>
            {isVps && (
              <>
                <dt className="text-mute">Resources</dt>
                <dd className="font-semibold text-ink">
                  {svc.product.cpuCores} vCPU · {gb(svc.product.ramMb)} RAM · {svc.product.diskGb} GB SSD
                </dd>
                <dt className="text-mute">Login</dt>
                <dd>
                  {cred ? (
                    <div className="space-y-1 font-mono text-[13px]">
                      <div className="flex items-center gap-1">
                        {cred.username} <Copy text={cred.username} />
                      </div>
                      <div className="flex items-center gap-1 break-all">
                        {cred.password} <Copy text={cred.password} />
                      </div>
                    </div>
                  ) : svc.hasPassword ? (
                    <Button size="sm" variant="secondary" icon="visibility" onClick={() => api(`/client/services/${id}/reveal-password`, { body: {} }).then(setCred).catch((e) => toast.error(e.message))}>
                      Show password
                    </Button>
                  ) : (
                    <span className="text-mute">Sent by email</span>
                  )}
                </dd>
              </>
            )}
          </dl>
          {isVps && svc.status === "ACTIVE" && (
            <div className="mt-4 flex flex-wrap gap-2 border-t border-line pt-4">
              <Button size="sm" variant="ghost" icon="key" onClick={() => confirm("Generate a new root/Administrator password? The server will reboot.") && act("reset_password")}>
                Reset password
              </Button>
              <Button size="sm" variant="ghost" icon="dns" onClick={() => setModal("rdns")}>
                Reverse DNS
              </Button>
            </div>
          )}
        </Card>

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
                    <span className="flex items-center gap-3">
                      {money(i.total, i.currency)} <Badge status={i.status} />
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
          {svc.status !== "TERMINATED" && svc.status !== "CANCELLED" && (
            <button onClick={() => setModal("cancel")} className="mt-4 text-sm font-bold text-rose-600 hover:underline">
              Request cancellation
            </button>
          )}
        </Card>
      </div>

      {data.logs.length > 0 && (
        <Card title="Recent activity" className="mt-6" pad={false}>
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

      <ReinstallModal open={modal === "reinstall"} onClose={() => setModal(null)} svc={svc} onSubmit={(os, confirmText) => act("reinstall", { osTemplateId: os, confirm: confirmText })} busy={busy === "reinstall"} />
      <CancelModal open={modal === "cancel"} onClose={() => setModal(null)} id={id} />
      <RdnsModal open={modal === "rdns"} onClose={() => setModal(null)} id={id} ips={svc.ips} />
    </>
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
