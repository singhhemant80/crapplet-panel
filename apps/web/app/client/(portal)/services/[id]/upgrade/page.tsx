"use client";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { api, CYCLES, date, money } from "@/lib/api";
import { Alert, Button, Card, Icon, Loading, PageHeader, Select, cx, toast, useApi } from "@/components/ui";

const gb = (mb?: number | null) => (mb ? (mb >= 1024 ? `${+(mb / 1024).toFixed(1)} GB` : `${mb} MB`) : null);

/** One spec with the change against the current plan. */
function Spec({ label, now, next, unit = "" }: { label: string; now?: number | null; next?: number | null; unit?: string }) {
  if (!next) return null;
  const up = now != null && next > now;
  const down = now != null && next < now;
  const show = (n: number) => (unit === "RAM" ? gb(n) : `${n}${unit}`);
  return (
    <li className="flex items-center justify-between gap-2 text-[13px]">
      <span className="text-mute">{label}</span>
      <span className={cx("font-bold", up ? "text-emerald-700" : down ? "text-amber-700" : "text-ink")}>{show(next)}{up && <Icon name="arrow_upward" className="ml-0.5 align-[-3px] text-[15px]" />}{down && <Icon name="arrow_downward" className="ml-0.5 align-[-3px] text-[15px]" />}</span>
    </li>
  );
}

export default function UpgradePage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const { data, loading, reload } = useApi(`/client/services/${id}/upgrade-options`, [id]);
  const [pick, setPick] = useState("");
  const [cycle, setCycle] = useState("");
  const [busy, setBusy] = useState(false);
  const plans: any[] = useMemo(() => {
    const order: Record<string, number> = { current: 0, upgrade: 1, same: 2, downgrade: 3, other: 4 };
    return [...(data?.plans ?? [])].sort((a, b) => (order[a.direction] - order[b.direction]) || ((a.cycles[0]?.price ?? 0) - (b.cycles[0]?.price ?? 0)));
  }, [data]);
  if (loading || !data) return <Loading />;
  const s = data.service;
  const plan = plans.find((p) => p.id === pick);
  const c = plan ? plan.cycles.find((x: any) => x.cycle === cycle) ?? plan.cycles[0] : null;
  const isCurrent = plan && c && plan.id === s.productId && c.cycle === s.billingCycle;

  async function confirmChange() {
    if (!plan || !c) return;
    setBusy(true);
    try {
      const r = await api(`/client/services/${id}/upgrade`, { body: { productId: plan.id, cycle: c.cycle } });
      if (r.invoiceId && !r.applied) {
        toast.success("Invoice created — your plan changes as soon as it's paid");
        router.push(`/client/invoices/${r.invoiceId}`);
      } else {
        toast.success(r.amountDue < 0 && data.downgradeCredit ? "Plan changed — the unused amount was added to your credit" : "Plan changed");
        router.push(`/client/services/${id}`);
      }
    } catch (e: any) {
      toast.error(e.message);
      setBusy(false);
    }
  }

  return (
    <>
      <PageHeader back={`/client/services/${id}`} icon="swap_vert" title="Upgrade or downgrade" subtitle={`Currently ${s.productName} · ${money(s.recurringAmount, s.currency)} ${(CYCLES[s.billingCycle] ?? "").toLowerCase()}${s.nextDueDate ? ` · paid until ${date(s.nextDueDate)}` : ""}`} />
      {data.blocked && <Alert tone="warn" className="mb-5">{data.blocked} {/renewal invoice/.test(data.blocked) && <Link className="font-bold underline" href="/client/invoices?status=UNPAID">View unpaid invoices</Link>}</Alert>}
      {data.pending && (
        <Alert tone="info" className="mb-5">
          {data.pending.status === "PROVISIONING" ? "Your server is being moved to the new plan — this takes a minute or two." : <>A plan change is waiting for payment. <Link className="font-bold underline" href={`/client/invoices/${data.pending.invoiceId}`}>Pay {money(data.pending.amountDue, data.pending.currency)} + tax</Link>
            <button className="ml-3 font-bold underline" onClick={() => api(`/client/upgrades/${data.pending.id}/cancel`, { body: {} }).then(() => { toast.success("Cancelled"); reload(); }).catch((e) => toast.error(e.message))}>Cancel it</button></>}
        </Alert>
      )}
      {!data.blocked && !data.pending && !plans.some((p) => p.direction !== "current") && plans.every((p) => p.cycles.length <= 1) && (
        <Alert tone="info" className="mb-5">There are no other plans you can switch to from here. Need more resources? <Link className="font-bold underline" href="/client/tickets/new">Open a ticket</Link> and we'll move you.</Alert>
      )}
      {!data.blocked && !data.pending && (
        <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_340px]">
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {plans.map((p) => {
              const price = (p.cycles.find((x: any) => x.cycle === s.billingCycle) ?? p.cycles[0]);
              const current = p.direction === "current";
              return (
                <button key={p.id} type="button" onClick={() => { if (window.innerWidth < 1024) setTimeout(() => document.getElementById("upgrade-summary")?.scrollIntoView({ behavior: "smooth", block: "start" }), 50); setPick(p.id); setCycle(price.cycle === s.billingCycle && current ? (p.cycles.find((x: any) => x.cycle !== s.billingCycle)?.cycle ?? price.cycle) : price.cycle); }}
                  className={cx("relative rounded-2xl border bg-white p-5 text-left shadow-card transition", pick === p.id ? "border-primary ring-2 ring-primary/25" : "border-line hover:border-primary/40")}>
                  <span className={cx("absolute right-4 top-4 rounded-full px-2 py-0.5 text-[10.5px] font-bold uppercase tracking-wide", current ? "bg-primary-tint text-primary-dark" : p.direction === "upgrade" ? "bg-emerald-50 text-emerald-700" : p.direction === "downgrade" ? "bg-amber-50 text-amber-700" : "bg-slate-100 text-slate-600")}>{current ? "Your plan" : p.direction === "upgrade" ? "Upgrade" : p.direction === "downgrade" ? "Downgrade" : "Plan"}</span>
                  <div className="pr-20 text-base font-extrabold text-ink">{p.name}</div>
                  {p.tagline && <div className="mt-0.5 text-xs text-mute">{p.tagline}</div>}
                  <div className="mt-3 text-2xl font-black text-ink">{money(price.price, s.currency)}<span className="text-xs font-semibold text-mute"> / {(CYCLES[price.cycle] ?? "").toLowerCase()}</span></div>
                  <ul className="mt-3 space-y-1.5 border-t border-line pt-3">
                    <Spec label="vCPU" now={s.spec.cpuCores} next={p.spec.cpuCores} />
                    <Spec label="RAM" now={s.spec.ramMb} next={p.spec.ramMb} unit="RAM" />
                    <Spec label="Disk" now={s.spec.diskGb} next={p.spec.diskGb} unit=" GB" />
                  </ul>
                  {p.outOfStock && !current && <div className="mt-2 text-xs font-bold text-rose-600">Out of stock</div>}
                </button>
              );
            })}
          </div>

          <div id="upgrade-summary" className="scroll-mt-4 lg:sticky lg:top-4">
          <Card title="Summary">
            {!plan || !c ? <p className="text-sm text-mute">Choose a plan to see what you'd pay. You only pay the difference for the days left in your current period.</p> : (
              <div className="space-y-4">
                <div><div className="text-xs font-bold uppercase tracking-wider text-mute">New plan</div><div className="text-lg font-extrabold text-ink">{plan.name}</div></div>
                {plan.cycles.length > 1 && <Select value={c.cycle} onChange={(e) => setCycle(e.target.value)} aria-label="Billing cycle">{plan.cycles.map((x: any) => <option key={x.cycle} value={x.cycle}>{x.label} — {money(x.price, s.currency)}</option>)}</Select>}
                <dl className="space-y-2 text-sm">
                  {c.credit > 0 && <div className="flex justify-between gap-3"><dt className="text-mute">Unused time on {s.productName} ({c.daysLeft} days)</dt><dd className="whitespace-nowrap font-semibold text-emerald-700">−{money(c.credit, s.currency)}</dd></div>}
                  <div className="flex justify-between gap-3"><dt className="text-mute">{c.sameCycle ? `${plan.name} for ${c.daysLeft} days` : `${plan.name}, ${c.label.toLowerCase()}`}</dt><dd className="whitespace-nowrap font-semibold">{money(c.charge, s.currency)}</dd></div>
                  <div className="flex justify-between gap-3 border-t border-line pt-2 text-base"><dt className="font-bold">{c.amountDue < 0 ? "Credit to you" : "Pay now"}</dt><dd className={cx("font-black", c.amountDue < 0 && "text-emerald-700")}>{money(Math.abs(c.amountDue), s.currency)}{c.amountDue > 0 && <span className="text-xs font-semibold text-mute"> + GST</span>}</dd></div>
                </dl>
                <p className="text-xs text-mute">Then {money(c.price, s.currency)} {c.label.toLowerCase()}{c.newNextDueDate ? `, next due ${date(c.newNextDueDate)}` : ""}.{c.amountDue < 0 && !data.downgradeCredit ? " The unused amount isn't refunded." : ""}</p>
                {plan.outOfStock && plan.direction !== "current" ? <Alert tone="warn">This plan is out of stock right now.</Alert> : (
                  <Button className="w-full" icon={c.amountDue > 0 ? "shopping_cart_checkout" : "swap_vert"} loading={busy} disabled={!!isCurrent} onClick={confirmChange}>{isCurrent ? "This is your plan" : c.amountDue > 0 ? "Continue to payment" : "Change plan now"}</Button>
                )}
                {s.spec.diskGb && plan.spec.diskGb && plan.spec.diskGb < s.spec.diskGb && <p className="text-xs text-amber-700">Your disk stays at {s.spec.diskGb} GB — disks are never shrunk, so no data is lost.</p>}
              </div>
            )}
          </Card>
          </div>
        </div>
      )}
    </>
  );
}
