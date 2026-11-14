"use client";
import { ChangePlanButton } from "@/components/admin/change-plan";
import { ProvisioningTracker } from "@/components/provisioning-tracker";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useState } from "react";
import { api, CYCLES, date, gb, money } from "@/lib/api";
import { Alert, Badge, Button, Card, Field, Icon, Input, Loading, PageHeader, Select, cx, toast, useApi } from "@/components/ui";
import { OsLogo } from "@/components/os-logo";
import { NodeSelect } from "@/components/admin/node-select";
import { Ago, Avatar, initialsOf, planIcon } from "@/components/admin/list-kit";

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
        icon="shopping_bag"
        stats={[
          ["Customer", <Link key="c" href={`/admin/clients/${u.id}`} className="hover:underline">{[u.firstName, u.lastName].filter(Boolean).join(" ") || u.email}</Link>, u.email],
          ["Order total", money(o.total, o.currency), o.currency === "INR" ? "incl. GST" : undefined],
          ["Items", `${o.services.length} service${o.services.length === 1 ? "" : "s"}${o.domains?.length ? ` · ${o.domains.length} domain${o.domains.length === 1 ? "" : "s"}` : ""}`],
          ["Invoice", inv ? <Badge key="i" status={inv.status} /> : "—", inv?.dueDate ? `due ${date(inv.dueDate)}` : undefined],
          ["Promo code", o.promoCode ?? "—"],
          ["Placed", date(o.createdAt), o.ip ?? undefined],
        ]}
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
          </>
        }
      />

      <OrderStatusPanel o={o} onDone={reload} />

      <div className="grid items-start gap-6 xl:grid-cols-[minmax(0,1fr)_340px]">
        <div className="space-y-5">
          {o.services.map((s: any) => <ServiceItem key={s.id} s={s} currency={o.currency} onSaved={reload} />)}
          {o.domains.length > 0 && (
            <Card title="Domains" pad={false}>
              <ul className="divide-y divide-[#f3effb]">
                {o.domains.map((d: any) => (
                  <li key={d.id} className="flex items-center justify-between px-5 py-3 text-sm">
                    <span className="flex min-w-0 items-center gap-3"><Icon name={d.action === "transfer" ? "swap_horiz" : "public"} className="text-primary-dark" /><b className="truncate">{d.name}</b><span className="capitalize text-mute">{d.action} · {d.years} yr</span></span>
                    <Badge status={d.status} />
                  </li>
                ))}
              </ul>
            </Card>
          )}
          {o.notes && <Card title="Customer notes"><p className="whitespace-pre-wrap text-sm text-slate-700">{o.notes}</p></Card>}
          <Timeline o={o} history={data.history ?? []} />
        </div>

        <div className="space-y-5 xl:sticky xl:top-24">
          <CustomerCard u={u} orderId={o.id} />
          {inv && <SummaryCard inv={inv} promo={o.promoCode} />}
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
          {vps && chosen ? <OsLogo os={chosen} size={28} /> : <span className="grid h-8 w-8 place-items-center rounded-lg bg-primary-soft text-primary-dark"><Icon name={planIcon(s.product.type, s.product.provisioner)} className="text-[19px]" /></span>}
          {s.product.name}
          <Badge status={s.status} />
          {vps && ["TERMINATED", "CANCELLED"].includes(s.status) && <Link href={`/admin/services/${s.id}`} className="text-xs font-bold text-primary-dark hover:underline">Create a new VPS →</Link>}
        </span>
      }
      action={<span className="flex items-center gap-3">{["ACTIVE", "SUSPENDED"].includes(s.status) && <ChangePlanButton serviceId={s.id} onDone={onSaved} />}<Link href={`/admin/services/${s.id}`} className="inline-flex items-center gap-1 text-sm font-bold text-primary-dark hover:underline">Manage <Icon name="arrow_forward" className="text-[16px]" /></Link></span>}
    >
      {vps && ["PENDING", "PROVISIONING", "FAILED"].includes(s.status) && (
        <div className="mb-4 rounded-xl bg-[#fbf9ff] px-3 py-2.5 ring-1 ring-[#f0e6ff]">
          <ProvisioningTracker path={`/admin/services/${s.id}/provisioning`} audience="admin" compact onChange={onSaved} />
        </div>
      )}
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

const FLOW = ["PENDING", "ACTIVE", "SUSPENDED", "TERMINATED"] as const;
const STATUS_TEXT: Record<string, string> = {
  PENDING: "Waiting for payment or setup — becomes Active once every service is delivered.",
  ACTIVE: "Services delivered and running.",
  SUSPENDED: "All running services are suspended.",
  TERMINATED: "All services have been terminated.",
  CANCELLED: "Cancelled before delivery.",
  FRAUD: "Marked as fraud.",
};

/** Order lifecycle: where the order is, why, and actions that apply to all its services. */
function OrderStatusPanel({ o, onDone }: { o: any; onDone: () => void }) {
  const [busy, setBusy] = useState<string | null>(null);
  const svc = o.services as any[];
  const count = (st: string[]) => svc.filter((s) => st.includes(s.status)).length;
  const pending = count(["PENDING", "PROVISIONING", "FAILED"]);
  const active = count(["ACTIVE"]);
  const suspended = count(["SUSPENDED"]);
  const delivered = active + suspended;
  const run = async (body: Record<string, unknown>, msg: string) => {
    setBusy(String(body.action));
    try {
      const r = await api(`/admin/orders/${o.id}/status`, { body });
      toast.success(`${msg}${r.queued ? ` — ${r.queued} service action${r.queued > 1 ? "s" : ""} queued` : ""}`);
      setTimeout(onDone, r.queued ? 2500 : 0);
      if (r.queued) setTimeout(onDone, 8000);
    } catch (e: any) {
      toast.error(e.message);
    }
    setBusy(null);
  };
  const step = FLOW.indexOf(o.status);
  return (
    <Card className="mb-6">
      <div className="flex flex-col gap-5 lg:flex-row lg:items-start lg:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[15px] font-extrabold text-ink">Order status</span>
            <Badge status={o.status} />
            {o.statusLocked && <span className="rounded-full bg-amber-50 px-2 py-0.5 text-[11px] font-bold text-amber-700 ring-1 ring-amber-200">Set by hand — not following the services</span>}
          </div>
          <p className="mt-1 text-sm text-mute">{STATUS_TEXT[o.status] ?? ""} {!o.statusLocked && "It updates automatically as the services change."}</p>
          {/* lifecycle */}
          {!["CANCELLED", "FRAUD"].includes(o.status) && (
            <div className="mt-4 flex items-center">
              {FLOW.map((f, i) => (
                <div key={f} className="flex items-center">
                  <div className="flex flex-col items-center gap-1">
                    <span className={cx("grid h-7 w-7 place-items-center rounded-full text-[12px] font-bold", i === step ? "bg-primary-dark text-white ring-4 ring-primary/15" : i < step ? "bg-emerald-500 text-white" : "bg-slate-100 text-slate-400")}>{i < step ? <Icon name="check" className="text-[15px]" /> : i + 1}</span>
                    <span className={cx("text-[11px] font-bold", i === step ? "text-ink" : "text-mute")}>{f[0] + f.slice(1).toLowerCase()}</span>
                  </div>
                  {i < FLOW.length - 1 && <span className={cx("mx-1.5 mb-5 h-0.5 w-8 sm:w-14", i < step ? "bg-emerald-400" : "bg-slate-200")} />}
                </div>
              ))}
            </div>
          )}
          <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-mute">
            <span><b className="text-ink">{active}</b> active</span>
            <span><b className="text-ink">{pending}</b> not delivered</span>
            <span><b className="text-ink">{suspended}</b> suspended</span>
            <span><b className="text-ink">{count(["TERMINATED"])}</b> terminated</span>
            <span><b className="text-ink">{count(["CANCELLED"])}</b> cancelled</span>
          </div>
        </div>
        <div className="flex shrink-0 flex-col gap-3 lg:items-end">
          <div className="flex flex-wrap gap-2 lg:justify-end">
            <Button size="sm" icon="play_circle" loading={busy === "activate"} disabled={!pending && !suspended} onClick={() => confirm(pending ? (o.invoice && o.invoice.status !== "PAID" ? "The invoice is unpaid. Set up the services anyway?" : "Set up the services that aren't delivered yet?") + (suspended ? " Suspended services are unsuspended too." : "") : "Unsuspend all suspended services?") && run({ action: "activate" }, "Activation started")}>{pending ? "Activate / provision" : "Unsuspend"}</Button>
            <Button size="sm" variant="outline" icon="pause_circle" loading={busy === "suspend"} disabled={!active} onClick={() => { const reason = prompt("Suspension reason (the customer sees this)", "Suspended by administrator"); if (reason) run({ action: "suspend", reason }, "Suspension started"); }}>Suspend</Button>
            <Button size="sm" variant="danger" icon="delete_forever" loading={busy === "terminate"} disabled={!delivered && !pending} onClick={() => confirm(`TERMINATE order ${o.number}? ${delivered ? `${delivered} delivered service${delivered > 1 ? "s are" : " is"} destroyed (data deleted). ` : ""}${pending ? "Undelivered services are cancelled. " : ""}An unpaid invoice is cancelled.`) && run({ action: "terminate" }, "Termination started")}>Terminate</Button>
            <Button size="sm" variant="outline" icon="cancel" loading={busy === "cancel"} disabled={["CANCELLED", "TERMINATED"].includes(o.status) && !pending} onClick={() => {
              if (delivered) {
                const both = confirm(`${delivered} service${delivered > 1 ? "s are" : " is"} already delivered.\n\nOK = cancel the order AND terminate the delivered services\nCancel = only cancel what isn't delivered yet`);
                run({ action: "cancel", terminateDelivered: both }, "Order cancelled");
              } else if (confirm("Cancel this order? Undelivered services and the unpaid invoice are cancelled and reserved IPs released.")) run({ action: "cancel" }, "Order cancelled");
            }}>Cancel order</Button>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-xs font-semibold text-mute">Status label</span>
            <Select className="h-9 w-56" value={o.statusLocked || o.status === "FRAUD" ? o.status : "AUTO"} onChange={(e) => { const v = e.target.value; if (v === "FRAUD" && !confirm("Mark this order as fraud?")) return; run({ action: "set", status: v }, v === "AUTO" ? "Status follows the services again" : `Status set to ${v.toLowerCase()}`); }}>
              <option value="AUTO">Automatic (follows services)</option>
              <option value="PENDING">Pending</option>
              <option value="ACTIVE">Active</option>
              <option value="SUSPENDED">Suspended</option>
              <option value="TERMINATED">Terminated</option>
              <option value="CANCELLED">Cancelled</option>
              <option value="FRAUD">Fraud</option>
            </Select>
          </div>
        </div>
      </div>
    </Card>
  );
}

/** Who ordered: avatar, contact, and shortcuts to their other records. */
function CustomerCard({ u, orderId }: { u: any; orderId: string }) {
  const name = [u.firstName, u.lastName].filter(Boolean).join(" ") || u.email;
  return (
    <section className="overflow-hidden rounded-2xl border border-line bg-white shadow-card">
      <div className="flex items-center gap-3 border-b border-line bg-gradient-to-br from-[#faf7ff] to-white p-5">
        <Avatar name={initialsOf(u.firstName, u.lastName, u.email)} seed={u.id} size={48} />
        <div className="min-w-0">
          <Link href={`/admin/clients/${u.id}`} className="block truncate text-[15px] font-extrabold text-ink hover:text-primary-dark">{name}</Link>
          {u.profile?.companyName && <div className="truncate text-[12.5px] font-semibold text-slate-600">{u.profile.companyName}</div>}
          <div className="text-[12px] text-mute">Customer since {date(u.createdAt)}</div>
        </div>
      </div>
      <dl className="space-y-2 p-5 text-[13px]">
        <div className="flex items-center gap-2.5"><Icon name="mail" className="text-[18px] text-mute" /><a href={`mailto:${u.email}`} className="min-w-0 truncate font-semibold text-ink hover:text-primary-dark">{u.email}</a></div>
        <div className="flex items-center gap-2.5"><Icon name="call" className="text-[18px] text-mute" />{u.phone ? <a href={`tel:${u.phone}`} className="font-semibold text-ink hover:text-primary-dark">{u.phone}</a> : <span className="text-mute">No phone</span>}</div>
        <div className="flex items-center gap-2.5"><Icon name="location_on" className="text-[18px] text-mute" /><span className="min-w-0 truncate font-semibold text-ink">{[u.profile?.city, u.profile?.state, u.profile?.country].filter(Boolean).join(", ") || "—"}</span></div>
        <div className="flex items-center gap-2.5"><Icon name="receipt" className="text-[18px] text-mute" /><span className="font-mono text-[12.5px] font-semibold text-ink">{u.profile?.gstin || <span className="font-sans text-mute">No GSTIN</span>}</span></div>
      </dl>
      <div className="grid grid-cols-3 border-t border-line text-center text-[12px] font-bold">
        <Link href={`/admin/clients/${u.id}`} className="flex flex-col items-center gap-0.5 py-3 text-primary-dark hover:bg-primary-tint"><Icon name="person" className="text-[19px]" />Profile</Link>
        <Link href={`/admin/orders?q=${encodeURIComponent(u.email)}`} className="flex flex-col items-center gap-0.5 border-x border-line py-3 text-primary-dark hover:bg-primary-tint"><Icon name="shopping_bag" className="text-[19px]" />{u._count.orders} orders</Link>
        <Link href={`/admin/clients/${u.id}?tab=services`} className="flex flex-col items-center gap-0.5 py-3 text-primary-dark hover:bg-primary-tint"><Icon name="dns" className="text-[19px]" />{u._count.services} services</Link>
      </div>
    </section>
  );
}

/** The order's invoice lines, GST and what's been paid — like WHMCS's order summary. */
function SummaryCard({ inv, promo }: { inv: any; promo?: string | null }) {
  const cm = (v: number) => money(v, inv.currency);
  const due = Math.max(0, inv.total - inv.amountPaid);
  const pays = inv.transactions.filter((t: any) => t.type === "PAYMENT" || t.type === "REFUND");
  return (
    <section className="overflow-hidden rounded-2xl border border-line bg-white shadow-card">
      <header className="flex items-center justify-between gap-3 border-b border-line px-5 py-4">
        <div className="min-w-0">
          <div className="text-[15px] font-extrabold text-ink">Order summary</div>
          <Link href={`/admin/invoices/${inv.id}`} className="font-mono text-[12px] font-bold text-primary-dark hover:underline">{inv.number ?? inv.proformaNumber}</Link>
        </div>
        <Badge status={inv.status} />
      </header>
      <ul className="divide-y divide-[#f3effb] px-5">
        {inv.items.map((it: any) => (
          <li key={it.id} className="flex justify-between gap-3 py-2.5 text-[13px]">
            <span className="min-w-0 text-slate-700">{it.description}{it.quantity > 1 && <span className="text-mute"> × {it.quantity}</span>}</span>
            <span className={cx("shrink-0 font-semibold tabular-nums", it.amount < 0 ? "text-emerald-600" : it.amount === 0 ? "text-emerald-600" : "text-ink")}>{it.amount === 0 ? "FREE" : cm(it.amount)}</span>
          </li>
        ))}
      </ul>
      <dl className="space-y-1.5 border-t border-dashed border-line px-5 py-3 text-[13px]">
        <div className="flex justify-between"><dt className="text-mute">Subtotal</dt><dd className="font-semibold tabular-nums">{cm(inv.subtotal)}</dd></div>
        {inv.discount > 0 && <div className="flex justify-between"><dt className="text-mute">Discount{promo ? ` (${promo})` : ""}</dt><dd className="font-semibold tabular-nums text-emerald-600">−{cm(inv.discount)}</dd></div>}
        {inv.cgst > 0 && <div className="flex justify-between"><dt className="text-mute">CGST 9%</dt><dd className="tabular-nums">{cm(inv.cgst)}</dd></div>}
        {inv.sgst > 0 && <div className="flex justify-between"><dt className="text-mute">SGST 9%</dt><dd className="tabular-nums">{cm(inv.sgst)}</dd></div>}
        {inv.igst > 0 && <div className="flex justify-between"><dt className="text-mute">IGST 18%</dt><dd className="tabular-nums">{cm(inv.igst)}</dd></div>}
      </dl>
      <div className="mx-5 mb-4 flex items-end justify-between rounded-xl bg-[#faf7ff] px-4 py-3 ring-1 ring-[#ede4ff]">
        <div><div className="text-[11px] font-bold uppercase tracking-wider text-mute">Total</div><div className="text-[12px] text-mute">{due ? <span className="font-bold text-amber-700">{cm(due)} still due</span> : `paid ${inv.paidAt ? date(inv.paidAt) : ""}`}</div></div>
        <div className="text-xl font-extrabold tabular-nums text-primary-dark">{cm(inv.total)}</div>
      </div>
      {pays.length > 0 && (
        <ul className="space-y-2 border-t border-line px-5 py-4">
          {pays.map((t: any) => (
            <li key={t.id} className={cx("flex items-center gap-2.5 rounded-xl px-3 py-2 text-[12px] ring-1", t.type === "REFUND" ? "bg-sky-50 text-sky-800 ring-sky-100" : "bg-emerald-50 text-emerald-800 ring-emerald-100")}>
              <Icon name={t.type === "REFUND" ? "undo" : "check_circle"} className="text-[18px]" />
              <span className="min-w-0 flex-1"><b className="uppercase">{t.gateway}</b> · <span className="font-mono">{String(t.gatewayTxnId ?? "").slice(0, 18)}</span><span className="block opacity-75"><Ago at={t.createdAt} /></span></span>
              <b className="shrink-0 tabular-nums">{t.type === "REFUND" ? "−" : ""}{money(Math.abs(t.amount), t.currency)}</b>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

const ACT_LABEL: Record<string, [string, string]> = {
  "order.accepted": ["Order accepted", "task_alt"],
  "order.cancelled": ["Order cancelled", "cancel"],
  "order.fraud": ["Marked as fraud", "gpp_bad"],
  "order.status_set": ["Status changed by hand", "edit"],
  "order.activate": ["Activation started", "play_circle"],
  "order.suspend": ["Suspension started", "pause_circle"],
  "order.terminate": ["Termination started", "delete_forever"],
  "order.cancel": ["Order cancelled", "cancel"],
  "order.created_by_staff": ["Order created by staff", "add_shopping_cart"],
};
const PROV_LABEL: Record<string, string> = { create: "set up", suspend: "suspended", unsuspend: "unsuspended", terminate: "terminated" };

/** Everything that happened to the order, newest first. */
function Timeline({ o, history }: { o: any; history: any[] }) {
  const inv = o.invoice;
  const svcName = (id: string) => { const s = o.services.find((x: any) => x.id === id); return s ? `${s.product.name}${s.hostname ? ` (${s.hostname})` : ""}` : "Service"; };
  type Ev = { at: string; icon: string; tone: "purple" | "green" | "rose" | "slate" | "amber" | "sky"; title: string; sub?: string };
  const ev: Ev[] = [{ at: o.createdAt, icon: "shopping_bag", tone: "purple", title: "Order placed", sub: [o.ip && `from ${o.ip}`, o.reseller?.brandName && `via ${o.reseller.brandName}`].filter(Boolean).join(" · ") || undefined }];
  if (inv) ev.push({ at: inv.createdAt, icon: "receipt_long", tone: "slate", title: `Invoice ${inv.number ?? inv.proformaNumber} created`, sub: money(inv.total, inv.currency) });
  if (inv?.paidAt && !(inv.transactions ?? []).some((t: any) => t.type === "PAYMENT")) ev.push({ at: inv.paidAt, icon: "payments", tone: "green", title: "Invoice paid", sub: inv.creditApplied ? `${money(inv.creditApplied, inv.currency)} from account credit` : undefined });
  for (const t of inv?.transactions ?? []) {
    if (t.type === "PAYMENT") ev.push({ at: t.createdAt, icon: "payments", tone: "green", title: `Payment received · ${money(t.amount, t.currency)}`, sub: t.gateway });
    if (t.type === "REFUND") ev.push({ at: t.createdAt, icon: "undo", tone: "sky", title: `Refund · ${money(Math.abs(t.amount), t.currency)}`, sub: t.gateway });
  }
  for (const h of history) {
    if (h.kind === "provision") ev.push({ at: h.at, icon: h.success ? (h.action === "create" ? "rocket_launch" : "settings") : "error", tone: h.success ? (h.action === "terminate" ? "rose" : h.action === "suspend" ? "amber" : "green") : "rose", title: `${svcName(h.serviceId)} ${h.success ? PROV_LABEL[h.action] ?? h.action : `— ${h.action} failed`}`, sub: h.success ? undefined : String(h.message ?? "").slice(0, 140) });
    else if (h.entity === "order" && ACT_LABEL[h.action]) ev.push({ at: h.at, icon: ACT_LABEL[h.action][1], tone: h.action.includes("fraud") || h.action.includes("cancel") || h.action.includes("terminate") ? "rose" : "purple", title: ACT_LABEL[h.action][0], sub: h.by ? `by ${h.by}` : undefined });
  }
  ev.sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime());
  const TONE = { purple: "bg-primary-soft text-primary-dark", green: "bg-emerald-50 text-emerald-600", rose: "bg-rose-50 text-rose-600", slate: "bg-slate-100 text-slate-500", amber: "bg-amber-50 text-amber-600", sky: "bg-sky-50 text-sky-600" };
  return (
    <Card title={<span className="inline-flex items-center gap-2"><Icon name="history" className="text-[20px] text-primary" />Timeline</span>}>
      <ol className="relative">
        {ev.slice(0, 25).map((e, i) => (
          <li key={i} className="relative flex gap-3 pb-5 last:pb-0">
            {i < Math.min(ev.length, 25) - 1 && <span className="absolute left-[15px] top-8 h-[calc(100%-28px)] w-px bg-line" />}
            <span className={cx("relative grid h-8 w-8 shrink-0 place-items-center rounded-full", TONE[e.tone])}><Icon name={e.icon} className="text-[17px]" /></span>
            <div className="min-w-0 flex-1 pt-1">
              <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                <span className="text-[13.5px] font-bold text-ink">{e.title}</span>
                <Ago at={e.at} className="shrink-0 text-[12px] text-mute" />
              </div>
              {e.sub && <div className="break-words text-[12.5px] text-mute">{e.sub}</div>}
            </div>
          </li>
        ))}
      </ol>
    </Card>
  );
}
