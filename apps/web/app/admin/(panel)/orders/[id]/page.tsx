"use client";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useState } from "react";
import { api, CYCLES, date, gb, money } from "@/lib/api";
import { Alert, Badge, Button, Card, Field, Icon, Input, Loading, PageHeader, Select, cx, toast, useApi } from "@/components/ui";
import { OsLogo } from "@/components/os-logo";
import { NodeSelect } from "@/components/admin/node-select";

const VPS = ["PROXMOX", "VIRTUALIZOR"];

export default function AdminOrder() {
  const { id } = useParams<{ id: string }>();
  const { data, loading, error, reload } = useApi(`/admin/orders/${id}`);
  if (error) return <Alert tone="error">{error}</Alert>;
  if (loading || !data) return <Loading />;
  const o = data.order;
  const inv = o.invoice;
  const u = o.user;
  const act = (path: string, body = {}, msg = "Done") => api(`/admin/orders/${o.id}/${path}`, { body }).then(() => { toast.success(msg); reload(); }).catch((e) => toast.error(e.message));
  const failed = o.services.filter((s: any) => s.status === "FAILED").length;

  return (
    <>
      <PageHeader
        back="/admin/orders"
        title={<span className="flex flex-wrap items-center gap-3">Order {o.number} <Badge status={o.status} /></span>}
        subtitle={<span>Placed {date(o.createdAt, true)}{o.ip && <> · from IP <span className="font-mono">{o.ip}</span></>}{o.reseller && <> · via reseller {o.reseller.brandName}</>}</span>}
        actions={
          <>
            {inv && <Button size="sm" variant="outline" icon="receipt_long" href={`/admin/invoices/${inv.id}`}>Invoice</Button>}
            {(o.status === "PENDING" || failed > 0) && (
              <Button size="sm" icon="rocket_launch" onClick={() => confirm(inv?.status !== "PAID" ? "The invoice is unpaid. Accept and provision anyway?" : "Accept and provision this order?") && act("accept", {}, "Order accepted — provisioning queued")}>
                {failed ? "Retry provisioning" : "Accept & provision"}
              </Button>
            )}
            {o.status === "PENDING" && (
              <>
                <Button size="sm" variant="outline" onClick={() => confirm("Cancel this order and release reserved IPs?") && act("cancel", {}, "Order cancelled")}>Cancel</Button>
                <Button size="sm" variant="danger" onClick={() => confirm("Mark this order as fraud?") && act("cancel", { fraud: true }, "Marked as fraud")}>Fraud</Button>
              </>
            )}
          </>
        }
      />

      {/* at-a-glance strip */}
      <div className="mb-6 grid grid-cols-2 gap-4 lg:grid-cols-4">
        {[
          ["Order total", money(o.total, o.currency), "payments"],
          ["Invoice", inv ? <Badge key="b" status={inv.status} /> : "—", "receipt_long"],
          ["Items", `${o.services.length} service${o.services.length === 1 ? "" : "s"}${o.domains.length ? ` · ${o.domains.length} domain${o.domains.length === 1 ? "" : "s"}` : ""}`, "inventory_2"],
          ["Promo code", o.promoCode ?? "—", "sell"],
        ].map(([l, v, i]: any) => (
          <div key={l} className="rounded-2xl border border-line bg-white p-4 shadow-sm">
            <div className="flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-mute"><Icon name={i} className="text-[18px] text-primary-dark" />{l}</div>
            <div className="mt-1.5 text-lg font-extrabold text-ink">{v}</div>
          </div>
        ))}
      </div>

      <div className="grid items-start gap-6 xl:grid-cols-[minmax(0,1fr)_340px]">
        <div className="space-y-5">
          {o.services.map((s: any) => <ServiceItem key={s.id} s={s} currency={o.currency} onSaved={reload} />)}
          {o.domains.length > 0 && (
            <Card title="Domains" pad={false}>
              <ul className="divide-y divide-[#f3effb]">
                {o.domains.map((d: any) => (
                  <li key={d.id} className="flex items-center justify-between px-5 py-3 text-sm">
                    <span className="flex items-center gap-3"><Icon name="language" className="text-primary-dark" /><b>{d.name}</b><span className="capitalize text-mute">{d.action} · {d.years} yr</span></span>
                    <Badge status={d.status} />
                  </li>
                ))}
              </ul>
            </Card>
          )}
          {o.notes && <Card title="Customer notes"><p className="whitespace-pre-wrap text-sm text-slate-700">{o.notes}</p></Card>}
        </div>

        <div className="space-y-5 xl:sticky xl:top-24">
          <Card title="Customer">
            <div className="flex items-center gap-3">
              <span className="grid h-11 w-11 place-items-center rounded-xl bg-primary-tint text-sm font-black text-primary-dark">{(u.firstName?.[0] ?? "") + (u.lastName?.[0] ?? "")}</span>
              <div className="min-w-0 text-sm">
                <Link href={`/admin/clients/${u.id}`} className="font-bold text-primary-dark hover:underline">{u.firstName} {u.lastName}</Link>
                <div className="truncate text-mute">{u.email}</div>
              </div>
            </div>
            <dl className="mt-4 space-y-1.5 text-sm">
              {u.profile?.companyName && <Row l="Company" v={u.profile.companyName} />}
              <Row l="Phone" v={u.phone ?? "—"} />
              <Row l="Location" v={[u.profile?.city, u.profile?.state, u.profile?.country].filter(Boolean).join(", ") || "—"} />
              <Row l="GSTIN" v={u.profile?.gstin ?? "—"} />
              <Row l="Customer since" v={date(u.createdAt)} />
              <Row l="Orders / services" v={`${u._count.orders} / ${u._count.services}`} />
            </dl>
          </Card>
          {inv && (
            <Card title="Payment">
              <dl className="space-y-1.5 text-sm">
                <Row l="Invoice" v={<Link className="font-bold text-primary-dark" href={`/admin/invoices/${inv.id}`}>{inv.number ?? inv.proformaNumber}</Link>} />
                <Row l="Status" v={<Badge status={inv.status} />} />
                <Row l="Total" v={money(inv.total, inv.currency)} />
                <Row l="Paid" v={money(inv.amountPaid, inv.currency)} />
                {inv.paidAt && <Row l="Paid on" v={date(inv.paidAt, true)} />}
              </dl>
              {inv.transactions.filter((t: any) => t.type === "PAYMENT").map((t: any) => (
                <div key={t.id} className="mt-3 rounded-xl bg-emerald-50 px-3 py-2 text-xs text-emerald-800 ring-1 ring-emerald-100">
                  <b className="uppercase">{t.gateway}</b> · {money(t.amount, t.currency)} · <span className="font-mono">{t.gatewayTxnId.slice(0, 22)}</span>
                </div>
              ))}
            </Card>
          )}
        </div>
      </div>
    </>
  );
}

function Row({ l, v }: { l: string; v: any }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <dt className="text-mute">{l}</dt>
      <dd className="text-right font-semibold text-ink">{v}</dd>
    </div>
  );
}

/** One ordered service: editable hostname + OS (until the server is built), status, last provisioning messages. */
function ServiceItem({ s, currency, onSaved }: { s: any; currency: string; onSaved: () => void }) {
  const vps = VPS.includes(s.product.provisioner);
  const built = !!s.remoteId && ["ACTIVE", "SUSPENDED"].includes(s.status);
  const [hostname, setHostname] = useState(s.hostname ?? "");
  const [os, setOs] = useState(s.osTemplateId ?? "");
  const numericNode = (v: string | null) => (v && /^\d+$/.test(v) ? v : "");
  const [node, setNode] = useState(numericNode(s.node));
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    setHostname(s.hostname ?? "");
    setOs(s.osTemplateId ?? "");
    setNode(numericNode(s.node));
  }, [s.hostname, s.osTemplateId, s.node]);
  const virtualizor = s.product.provisioner === "VIRTUALIZOR";
  const options: any[] = s.product.osTemplates;
  const chosen = options.find((t) => t.id === os) ?? (s.osTemplate?.id === os ? s.osTemplate : null);
  const osBad = vps && s.osTemplate && ((s.product.provisioner === "VIRTUALIZOR" && !s.osTemplate.virtualizorOsId) || (s.product.provisioner === "PROXMOX" && !s.osTemplate.proxmoxKvmVmid && !s.osTemplate.proxmoxLxcVolid));
  const dirty = hostname !== (s.hostname ?? "") || os !== (s.osTemplateId ?? "") || (virtualizor && node !== numericNode(s.node));
  const lastError = s.logs.find((l: any) => !l.success);

  async function save(thenProvision = false) {
    setBusy(true);
    try {
      await api(`/admin/services/${s.id}`, { method: "PUT", body: { hostname: hostname || undefined, ...(built ? {} : { osTemplateId: os || null, ...(virtualizor ? { node: node || null } : {}) }) } });
      if (thenProvision) {
        await api(`/admin/services/${s.id}/action`, { body: { action: "create" } });
        toast.success("Saved — provisioning queued");
        setTimeout(onSaved, 2500);
      } else toast.success("Saved");
      onSaved();
    } catch (e: any) {
      toast.error(e.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card
      title={
        <span className="flex flex-wrap items-center gap-2">
          {vps && chosen ? <OsLogo os={chosen} size={28} /> : <Icon name={vps ? "dns" : "cloud"} className="text-primary-dark" />}
          {s.product.name}
          <Badge status={s.status} />
        </span>
      }
      action={<Link href={`/admin/services/${s.id}`} className="inline-flex items-center gap-1 text-sm font-bold text-primary-dark hover:underline">Manage <Icon name="arrow_forward" className="text-[16px]" /></Link>}
    >
      <div className="mb-4 flex flex-wrap gap-2 text-xs font-semibold text-slate-600">
        <span className="rounded-full bg-slate-100 px-2.5 py-1">{CYCLES[s.billingCycle]} · {money(s.recurringAmount, currency)}</span>
        {vps && s.product.cpuCores && <span className="rounded-full bg-slate-100 px-2.5 py-1">{s.product.cpuCores} vCPU · {gb(s.product.ramMb)} · {s.product.diskGb} GB</span>}
        {s.server && <span className="rounded-full bg-slate-100 px-2.5 py-1">{s.server.name}</span>}
        {s.ips.map((i: any) => <span key={i.address} className="rounded-full bg-primary-tint px-2.5 py-1 font-mono text-primary-dark">{i.address}</span>)}
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Hostname" hint={built ? "Updates our records; rename inside the server too" : undefined}>
          <Input value={hostname} onChange={(e) => setHostname(e.target.value.toLowerCase().trim())} placeholder="server1.example.com" />
        </Field>
        {virtualizor && (
          <NodeSelect serverIds={s.serverId ? [s.serverId] : s.product.servers.map((x: any) => x.serverId)} value={node} onChange={setNode} disabled={built} hint={built ? `Built on node #${s.node ?? "?"}` : undefined} />
        )}
        {vps && (
          <Field label="Operating system" hint={built ? "Server is built — use Reinstall on the service page to change it" : `${options.length} templates offered for this plan`}>
            <Select value={os} disabled={built} onChange={(e) => setOs(e.target.value)}>
              {!os && <option value="">Choose…</option>}
              {s.osTemplate && !options.some((t) => t.id === s.osTemplate.id) && <option value={s.osTemplate.id}>{s.osTemplate.name} (not offered for this plan)</option>}
              {options.map((t) => <option key={t.id} value={t.id}>{t.name}{t.virtualizorVirt ? ` · ${t.virtualizorVirt}` : ""}</option>)}
            </Select>
          </Field>
        )}
      </div>

      {osBad && !dirty && (
        <Alert tone="warn" className="mt-4">
          “{s.osTemplate.name}” can't be installed by the {s.product.provisioner === "VIRTUALIZOR" ? "Virtualizor" : "Proxmox"} module (no template id). Pick another OS above and retry.
        </Alert>
      )}
      {s.status === "FAILED" && lastError && (
        <div className="mt-4 rounded-xl bg-rose-50 p-3 text-xs text-rose-800 ring-1 ring-rose-100">
          <div className="mb-0.5 font-extrabold uppercase tracking-wider">Last error · {date(lastError.createdAt, true)}</div>
          <div className="break-words">{lastError.message}</div>
          <Link href={`/admin/products/${s.product.id}`} className="mt-1 inline-block font-bold text-primary-dark hover:underline">Check the plan's setup →</Link>
        </div>
      )}

      <div className="mt-4 flex flex-wrap gap-2">
        <Button size="sm" icon="save" disabled={!dirty} loading={busy} onClick={() => save(false)}>Save changes</Button>
        {vps && ["PENDING", "FAILED"].includes(s.status) && (
          <Button size="sm" variant="secondary" icon="rocket_launch" loading={busy} onClick={() => confirm("Save and provision this server now?") && save(true)}>
            {dirty ? "Save & provision" : s.status === "FAILED" ? "Retry provisioning" : "Provision now"}
          </Button>
        )}
      </div>
      <p className={cx("mt-3 text-xs text-mute", !s.logs.length && "hidden")}>
        Latest: {s.logs[0]?.action} {s.logs[0]?.success ? "✓" : "✗"} · {s.logs[0] && date(s.logs[0].createdAt, true)}
      </p>
    </Card>
  );
}
