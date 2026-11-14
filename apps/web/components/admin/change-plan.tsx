"use client";
/** Admin: upgrade / downgrade / change billing cycle of a service, with prorated billing. */
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { api, CYCLES, date, money } from "@/lib/api";
import { Alert, Badge, Button, Field, Icon, Input, Loading, Modal, Select, Toggle, cx, toast } from "@/components/ui";

const gb = (mb?: number | null) => (mb ? (mb >= 1024 ? `${+(mb / 1024).toFixed(1)} GB` : `${mb} MB`) : "—");
export const specLine = (s: any) => [s.cpuCores && `${s.cpuCores} vCPU`, s.ramMb && `${gb(s.ramMb)} RAM`, s.diskGb && `${s.diskGb} GB disk`].filter(Boolean).join(" · ");
const DIR: Record<string, [string, string]> = { upgrade: ["Upgrade", "bg-emerald-50 text-emerald-700 ring-emerald-200"], downgrade: ["Downgrade", "bg-amber-50 text-amber-700 ring-amber-200"], same: ["Same price", "bg-slate-100 text-slate-600 ring-slate-200"], current: ["Current plan", "bg-primary-tint text-primary-dark ring-primary/20"], other: ["Other cycle only", "bg-slate-100 text-slate-600 ring-slate-200"] };
const STATUS: Record<string, string> = { PENDING: "awaiting payment", PROVISIONING: "changing server", DONE: "done", FAILED: "server change failed", CANCELLED: "cancelled" };

export function ChangePlanButton({ serviceId, onDone, size = "sm", variant = "outline" }: { serviceId: string; onDone?: () => void; size?: "sm" | "md"; variant?: "outline" | "secondary" | "primary" }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button size={size as any} variant={variant as any} icon="swap_vert" onClick={() => setOpen(true)}>Change plan</Button>
      {open && <ChangePlanModal serviceId={serviceId} onClose={() => setOpen(false)} onDone={() => { setOpen(false); onDone?.(); }} />}
    </>
  );
}

export function ChangePlanModal({ serviceId, onClose, onDone }: { serviceId: string; onClose: () => void; onDone: () => void }) {
  const [data, setData] = useState<any>(null);
  const [pick, setPick] = useState<string>("");
  const [cycle, setCycle] = useState<string>("");
  const [onlySame, setOnlySame] = useState(true);
  const [v, setV] = useState({ billing: "invoice", override: "", applyOnServer: true, creditRefund: true, sendEmail: true });
  const [busy, setBusy] = useState(false);
  const load = () => api(`/admin/services/${serviceId}/upgrade-options`).then((d) => { setData(d); setV((x) => ({ ...x, creditRefund: d.downgradeCredit })); }).catch((e) => toast.error(e.message));
  useEffect(() => { load(); }, [serviceId]); // eslint-disable-line react-hooks/exhaustive-deps

  const plans: any[] = useMemo(() => (data?.plans ?? []).filter((p: any) => !onlySame || p.sameModule), [data, onlySame]);
  const plan = plans.find((p) => p.id === pick) ?? (data?.plans ?? []).find((p: any) => p.id === pick);
  const c = plan?.cycles.find((x: any) => x.cycle === cycle) ?? plan?.cycles[0];
  const s = data?.service;
  const overridePaise = v.override.trim() ? Math.round(Number(v.override) * 100) : null;
  // recompute with an override price (same maths as the server)
  const q = c && overridePaise != null ? (() => { const charge = c.sameCycle ? Math.round(overridePaise * (c.daysLeft / (c.periodDays || 1))) : overridePaise; return { ...c, charge, amountDue: charge - c.credit, newRecurring: overridePaise }; })() : c;
  const isCurrent = plan && s && plan.id === s.productId && c?.cycle === s.billingCycle;

  async function submit() {
    if (!plan || !c) return;
    setBusy(true);
    try {
      const r = await api(`/admin/services/${serviceId}/change-plan`, { body: { productId: plan.id, cycle: c.cycle, billing: v.billing, recurringOverride: overridePaise, applyOnServer: v.applyOnServer, creditRefund: v.creditRefund, sendEmail: v.sendEmail } });
      toast.success(r.invoiceId && !r.applied ? "Invoice created — the plan changes when it's paid" : r.upgrade.status === "PROVISIONING" ? "Plan changed — the server is being updated" : "Plan changed");
      onDone();
    } catch (e: any) {
      toast.error(e.message);
    }
    setBusy(false);
  }

  return (
    <Modal open onClose={onClose} title="Change plan" wide>
      {!data ? <Loading /> : (
        <div className="space-y-5">
          <div className="flex flex-wrap items-center gap-3 rounded-xl bg-[#fbf9ff] px-4 py-3 text-sm ring-1 ring-[#f0e6ff]">
            <Icon name="inventory_2" className="text-[22px] text-primary-dark" />
            <div className="min-w-0 flex-1"><b className="text-ink">Now: {s.productName}</b> · {CYCLES[s.billingCycle]} · {money(s.recurringAmount, s.currency)}<div className="text-xs text-mute">{specLine(s.spec) || "—"}{s.nextDueDate && ` · next due ${date(s.nextDueDate)}`}</div></div>
          </div>
          {data.pending && <PendingRow up={data.pending} onChange={() => { load(); }} />}
          {data.unpaidRenewal > 0 && <Alert tone="warn">This service has an unpaid renewal invoice at the old price. After the change, edit that invoice if the price should follow the new plan.</Alert>}

          <div>
            <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
              <span className="text-[13px] font-bold text-slate-700">New plan</span>
              <label className="flex items-center gap-2 text-xs font-semibold text-mute"><input type="checkbox" className="h-4 w-4 accent-primary" checked={onlySame} onChange={(e) => setOnlySame(e.target.checked)} />Only plans on the same module</label>
            </div>
            <div className="grid max-h-[340px] gap-2 overflow-auto pr-1 sm:grid-cols-2">
              {plans.map((p) => {
                const d = DIR[p.direction] ?? DIR.other;
                return (
                  <button key={p.id} type="button" onClick={() => { setPick(p.id); setCycle(p.cycles.find((x: any) => x.cycle === s.billingCycle)?.cycle ?? p.cycles[0].cycle); }}
                    className={cx("rounded-xl border p-3 text-left transition", pick === p.id ? "border-primary bg-primary-tint ring-2 ring-primary/20" : "border-line hover:border-primary/40")}>
                    <div className="flex items-start justify-between gap-2"><b className="text-sm text-ink">{p.name}</b><span className={cx("shrink-0 rounded-full px-2 py-0.5 text-[10.5px] font-bold ring-1", d[1])}>{d[0]}</span></div>
                    <div className="mt-0.5 text-[11.5px] text-mute">{p.group}{p.outOfStock ? " · out of stock" : ""}</div>
                    <div className="mt-1 text-xs font-semibold text-slate-600">{specLine(p.spec) || p.tagline || ""}</div>
                    <div className="mt-1 text-xs text-mute">{money((p.cycles.find((x: any) => x.cycle === s.billingCycle) ?? p.cycles[0]).price, s.currency)} / {(CYCLES[(p.cycles.find((x: any) => x.cycle === s.billingCycle) ?? p.cycles[0]).cycle] ?? "").toLowerCase()}</div>
                  </button>
                );
              })}
              {!plans.length && <p className="text-sm text-mute">No other plans have a price in {s.currency}.</p>}
            </div>
          </div>

          {plan && c && (
            <>
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Billing cycle"><Select value={c.cycle} onChange={(e) => setCycle(e.target.value)}>{plan.cycles.map((x: any) => <option key={x.cycle} value={x.cycle}>{x.label} — {money(x.price, s.currency)}</option>)}</Select></Field>
                <Field label={`Recurring price (${s.currency})`} hint={`Blank = list price ${money(c.price, s.currency)}`}><Input type="number" step="0.01" min={0} value={v.override} onChange={(e) => setV({ ...v, override: e.target.value })} placeholder={String(c.price / 100)} /></Field>
              </div>
              <div className="rounded-xl border border-line">
                <dl className="divide-y divide-line text-sm">
                  <Row l={`Unused part of the current plan (${q.daysLeft} of ${q.periodDays || 0} days)`} r={q.credit ? `−${money(q.credit, s.currency)}` : money(0, s.currency)} />
                  <Row l={q.sameCycle ? `New plan for the remaining ${q.daysLeft} days` : `New plan, ${c.label.toLowerCase()} from today`} r={money(q.charge, s.currency)} />
                  <Row l={<b>{q.amountDue < 0 ? "Refund (before tax)" : "To pay now (before tax)"}</b>} r={<b className={q.amountDue < 0 ? "text-emerald-700" : ""}>{money(Math.abs(q.amountDue), s.currency)}</b>} />
                  <Row l="Then renews at" r={`${money(q.newRecurring, s.currency)} ${c.label.toLowerCase()}${q.newNextDueDate ? ` from ${date(q.newNextDueDate)}` : ""}`} />
                </dl>
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <label className={cx("cursor-pointer rounded-xl border p-3", v.billing === "invoice" ? "border-primary bg-primary-tint" : "border-line")}>
                  <input type="radio" className="mr-2 accent-primary" checked={v.billing === "invoice"} onChange={() => setV({ ...v, billing: "invoice" })} />
                  <b className="text-sm">{q.amountDue > 0 ? "Invoice the difference" : "Apply with proration"}</b>
                  <span className="mt-0.5 block text-xs text-mute">{q.amountDue > 0 ? "The plan changes when the invoice is paid" : q.amountDue < 0 ? "Changes now; the refund can go to account credit" : "Changes now"}</span>
                </label>
                <label className={cx("cursor-pointer rounded-xl border p-3", v.billing === "free" ? "border-primary bg-primary-tint" : "border-line")}>
                  <input type="radio" className="mr-2 accent-primary" checked={v.billing === "free"} onChange={() => setV({ ...v, billing: "free" })} />
                  <b className="text-sm">Change now, no charge</b>
                  <span className="mt-0.5 block text-xs text-mute">Only the plan and the renewal price change</span>
                </label>
              </div>
              <div className="flex flex-wrap gap-x-6 gap-y-3">
                {plan.sameModule && s.provisioner !== "MANUAL" && <Toggle checked={v.applyOnServer} onChange={(x) => setV({ ...v, applyOnServer: x })} label={s.provisioner === "CPANEL" ? "Change the WHM package" : "Resize the VPS (CPU, RAM, disk grows only)"} />}
                {v.billing === "invoice" && q.amountDue < 0 && <Toggle checked={v.creditRefund} onChange={(x) => setV({ ...v, creditRefund: x })} label={`Add ${money(-q.amountDue, s.currency)} to account credit`} />}
                {v.billing === "invoice" && q.amountDue > 0 && <Toggle checked={v.sendEmail} onChange={(x) => setV({ ...v, sendEmail: x })} label="Email the invoice" />}
              </div>
              {!plan.sameModule && <Alert tone="info">This plan uses a different module ({plan.provisioner}) — only billing changes; move the account on the server yourself.</Alert>}
              <div className="flex justify-end gap-2">
                <Button variant="outline" onClick={onClose}>Close</Button>
                <Button icon="swap_vert" loading={busy} disabled={!!isCurrent && overridePaise == null || !!data.pending} onClick={submit}>{v.billing === "invoice" && q.amountDue > 0 ? `Create invoice for ${money(q.amountDue, s.currency)}` : "Change plan now"}</Button>
              </div>
            </>
          )}

          {data.history?.length > 0 && (
            <div>
              <div className="mb-2 text-[13px] font-bold text-slate-700">Plan changes</div>
              <ul className="divide-y divide-line rounded-xl border border-line text-sm">
                {data.history.map((h: any) => (
                  <li key={h.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2.5">
                    <span className="min-w-0 flex-1"><b>{h.fromName}</b> → <b>{h.toName}</b>{h.fromCycle !== h.toCycle && <span className="text-mute"> · {CYCLES[h.fromCycle]} → {CYCLES[h.toCycle]}</span>}<span className="block text-xs text-mute">{date(h.createdAt, true)}{h.byClient ? " · by customer" : ""} · {h.amountDue < 0 ? `refund ${money(-h.amountDue, h.currency)}` : money(h.amountDue, h.currency)}{h.message ? ` · ${h.message}` : ""}</span></span>
                    <Badge status={h.status === "DONE" ? "ACTIVE" : h.status === "FAILED" ? "FAILED" : h.status === "CANCELLED" ? "CANCELLED" : "PENDING"}>{STATUS[h.status] ?? h.status}</Badge>
                    {h.invoiceId && <Link className="text-xs font-bold text-primary-dark hover:underline" href={`/admin/invoices/${h.invoiceId}`}>Invoice</Link>}
                    {h.status === "FAILED" && <>
                      <Button size="sm" variant="secondary" icon="replay" onClick={() => api(`/admin/upgrades/${h.id}/retry`, { body: {} }).then(() => { toast.success("Retrying the server change"); load(); }).catch((e) => toast.error(e.message))}>Retry</Button>
                      <Button size="sm" variant="ghost" onClick={() => api(`/admin/upgrades/${h.id}/resolve`, { body: {} }).then(() => { toast.success("Marked done"); load(); }).catch((e) => toast.error(e.message))}>I fixed it</Button>
                    </>}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </Modal>
  );
}

function PendingRow({ up, onChange }: { up: any; onChange: () => void }) {
  return (
    <Alert tone={up.status === "PROVISIONING" ? "info" : "warn"}>
      {up.status === "PROVISIONING" ? "The server is being changed to the new plan." : <>A plan change is waiting for payment ({money(up.amountDue, up.currency)}). {up.invoiceId && <Link className="font-bold underline" href={`/admin/invoices/${up.invoiceId}`}>Open invoice</Link>}</>}
      {up.status === "PENDING" && <button className="ml-3 text-xs font-bold underline" onClick={() => confirm("Cancel this plan change and its invoice?") && api(`/admin/upgrades/${up.id}/cancel`, { body: {} }).then(() => { toast.success("Cancelled"); onChange(); }).catch((e) => toast.error(e.message))}>Cancel it</button>}
    </Alert>
  );
}

const Row = ({ l, r }: { l: React.ReactNode; r: React.ReactNode }) => <div className="flex items-center justify-between gap-4 px-4 py-2.5"><dt className="text-slate-600">{l}</dt><dd className="whitespace-nowrap font-semibold text-ink">{r}</dd></div>;
