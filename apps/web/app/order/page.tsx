"use client";
import { bandwidth } from "@/lib/units";
import Link from "next/link";
import { Suspense, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { CYCLE_MONTHS, gb, money } from "@/lib/api";
import { Icon, Loading, cx, useApi } from "@/components/ui";
import { OrderSteps } from "@/components/order-steps";
import { CurrencySwitch, priceRow, rowsIn, useCurrency } from "@/lib/currency";
import { CYCLES } from "@/lib/api";
import { freeDomainText } from "@/components/hosting-domain";

/** Icon for a product group, from its name. */
function groupIcon(name: string) {
  const n = name.toLowerCase();
  if (n.includes("reseller")) return "groups";
  if (n.includes("shared") || n.includes("hosting")) return "language";
  if (n.includes("windows")) return "desktop_windows";
  if (n.includes("forex")) return "candlestick_chart";
  if (n.includes("tally")) return "receipt_long";
  if (n.includes("minecraft") || n.includes("game")) return "sports_esports";
  if (n.includes("n8n")) return "account_tree";
  if (n.includes("colo")) return "dns";
  if (n.includes("dedicated")) return "storage";
  return "cloud";
}

const bw = (g?: number | null) => bandwidth(g);

/** Spec rows shown on a plan card — VPS get a hardware table, hosting its feature list. */
function specRows(p: any): [string, string, string][] {
  if (p.isHosting && !p.features.length) {
    const rows: [string, string, string][] = [];
    if (p.specs.diskGb) rows.push(["database", "SSD storage", `${p.specs.diskGb} GB`]);
    if (p.specs.bandwidthGb !== null && p.specs.bandwidthGb !== undefined) rows.push(["speed", "Bandwidth", bw(p.specs.bandwidthGb)]);
    return rows;
  }
  if (p.isVps)
    return [
      ["developer_board", "vCPU", `${p.specs.cpuCores} cores`],
      ["memory", "RAM", gb(p.specs.ramMb)],
      ["database", "NVMe SSD", `${p.specs.diskGb} GB`],
      ["speed", "Bandwidth", bw(p.specs.bandwidthGb)],
      ["public", "IPv4", p.allowIpSelection ? "Pick your own" : `${p.specs.ipv4Count ?? 1} dedicated`],
    ];
  return [];
}

/** Best saving vs paying monthly, across the plan's longer cycles. */
function bestSaving(p: any, currency: string) {
  const m = priceRow(p.pricing, "MONTHLY", currency)?.price;
  if (!m) return 0;
  let best = 0;
  for (const r of rowsIn(p.pricing, currency)) {
    const months = CYCLE_MONTHS[r.cycle] || 1;
    if (months > 1) best = Math.max(best, Math.round((1 - r.price / months / m) * 100));
  }
  return best;
}

function PlanCard({ p, currency }: { p: any; currency: string }) {
  const monthly = priceRow(p.pricing, "MONTHLY", currency);
  const first = monthly ?? rowsIn(p.pricing, currency)[0];
  const perMonth = first ? first.price / (CYCLE_MONTHS[first.cycle] || 1) : null;
  const save = bestSaving(p, currency);
  const rows = specRows(p);
  return (
    <div className={cx("relative flex w-full flex-col rounded-2xl border bg-white shadow-card transition hover:-translate-y-0.5 hover:shadow-xl", p.featured ? "border-primary ring-2 ring-primary/25" : "border-line")}>
      {p.featured && <span className="absolute -top-3 left-1/2 -translate-x-1/2 whitespace-nowrap rounded-full bg-gradient-to-r from-primary to-primary-dark px-3 py-1 text-[10.5px] font-extrabold uppercase tracking-wider text-white shadow-glow">Most popular</span>}
      <div className="p-6 pb-5">
        <h3 className="text-[17px] font-extrabold text-ink">{p.name}</h3>
        <p className="mt-1 line-clamp-2 min-h-[40px] text-[13px] leading-5 text-mute">{p.tagline}</p>
        <div className="mt-4 flex items-baseline gap-1">
          <span className="text-[34px] font-extrabold leading-none tracking-tight text-ink">{perMonth != null ? money(perMonth, currency).replace(/\.00$/, "") : "—"}</span>
          <span className="text-sm font-semibold text-mute">/mo</span>
        </div>
        <div className="mt-2 flex h-5 items-center gap-2 text-xs">
          <span className="text-mute">{currency === "INR" ? "+ GST" : "No Indian GST"}{first?.setupFee ? ` · ${money(first.setupFee, currency).replace(/\.00$/, "")} setup` : " · no setup fee"}</span>
          {save > 0 && <span className="rounded-full bg-emerald-50 px-2 py-0.5 font-bold text-emerald-700 ring-1 ring-emerald-200">Save {save}% yearly</span>}
        </div>
      </div>
      {p.isHosting && p.freeDomain && (
        <div className="mx-6 mb-4 flex items-center gap-2 rounded-lg bg-emerald-50 px-3 py-2 text-[12.5px] font-bold text-emerald-800 ring-1 ring-emerald-200">
          <Icon name="redeem" className="text-[18px] text-emerald-600" />
          <span>{freeDomainText(p.freeDomain, CYCLES)}</span>
        </div>
      )}
      <div className="mx-6 border-t border-dashed border-line" />
      {rows.length ? (
        <dl className="space-y-0 px-6 py-4 text-[13px]">
          {rows.map(([i, l, v]) => (
            <div key={l} className="flex items-center gap-2.5 py-1.5">
              <Icon name={i} className="text-[18px] text-primary" />
              <dt className="text-mute">{l}</dt>
              <dd className="ml-auto font-bold text-ink">{v}</dd>
            </div>
          ))}
        </dl>
      ) : !p.features.length ? (
        <div className="px-6 py-4 text-[13px] leading-6 text-slate-600">
          {p.description || "Full plan details, resources and add-ons are shown on the next step."}
          <ul className="mt-3 space-y-2.5 text-slate-700">
            {(p.isHosting ? ["Free SSL certificates", "cPanel control panel", "24/7 expert support"] : ["Instant setup", "24/7 expert support"]).map((f) => (
              <li key={f} className="flex items-start gap-2.5"><Icon name="check_circle" className="mt-px text-[18px] text-emerald-500" />{f}</li>
            ))}
          </ul>
        </div>
      ) : (
        <ul className="space-y-2.5 px-6 py-4 text-[13px] text-slate-700">
          {p.features.slice(0, 7).map((f: string) => (
            <li key={f} className="flex items-start gap-2.5"><Icon name="check_circle" className="mt-px text-[18px] text-emerald-500" />{f}</li>
          ))}
        </ul>
      )}
      <div className="mt-auto px-6 pb-6">
        {p.outOfStock ? (
          <span className="block rounded-xl bg-slate-100 py-3 text-center text-sm font-bold text-slate-500">Out of stock</span>
        ) : (
          <Link href={`/order/configure?product=${p.slug}`} className={cx("flex items-center justify-center gap-1.5 rounded-xl py-3 text-sm font-extrabold transition", p.featured ? "bg-gradient-to-br from-primary to-primary-dark text-white shadow-glow hover:brightness-110" : "border border-primary/30 bg-white text-primary-dark hover:bg-primary hover:text-white")}>
            {p.isVps ? "Configure & deploy" : "Order now"}<Icon name="arrow_forward" className="text-[17px]" />
          </Link>
        )}
      </div>
    </div>
  );
}

/** Side-by-side spec table for VPS groups. */
function Compare({ products, currency }: { products: any[]; currency: string }) {
  const rows: [string, (p: any) => string][] = [
    ["Price / month", (p) => { const r = priceRow(p.pricing, "MONTHLY", currency) ?? rowsIn(p.pricing, currency)[0]; return r ? money(r.price / (CYCLE_MONTHS[r.cycle] || 1), currency).replace(/\.00$/, "") : "—"; }],
    ["vCPU", (p) => `${p.specs.cpuCores}`],
    ["RAM", (p) => gb(p.specs.ramMb)],
    ["NVMe SSD", (p) => `${p.specs.diskGb} GB`],
    ["Bandwidth", (p) => bw(p.specs.bandwidthGb)],
    ["IPv4", (p) => (p.allowIpSelection ? "Choose your own" : `${p.specs.ipv4Count ?? 1}`)],
    ["Best saving", (p) => { const s = bestSaving(p, currency); return s ? `${s}% on yearly` : "—"; }],
  ];
  return (
    <div className="mt-10 overflow-hidden rounded-2xl border border-line bg-white shadow-card">
      <div className="flex items-center gap-2 border-b border-line px-6 py-4"><Icon name="table_chart" className="text-primary-dark" /><h3 className="font-extrabold text-ink">Compare plans</h3></div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[640px] text-sm">
          <thead>
            <tr className="bg-[#faf7ff] text-left">
              <th className="px-6 py-3 text-xs font-bold uppercase tracking-wider text-mute">Plan</th>
              {products.map((p) => <th key={p.id} className="px-4 py-3 text-[13px] font-extrabold text-ink">{p.name}{p.featured && <span className="ml-1.5 rounded bg-primary-soft px-1.5 py-0.5 text-[10px] font-bold uppercase text-primary-dark">Popular</span>}</th>)}
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {rows.filter(([l]) => l !== "Best saving" || products.some((p) => bestSaving(p, currency) > 0)).map(([l, f]) => (
              <tr key={l}>
                <td className="px-6 py-3 font-semibold text-mute">{l}</td>
                {products.map((p) => <td key={p.id} className={cx("px-4 py-3 font-bold text-ink", l === "Price / month" && "text-primary-dark")}>{f(p)}</td>)}
              </tr>
            ))}
            <tr>
              <td />
              {products.map((p) => (
                <td key={p.id} className="px-4 py-3">
                  {!p.outOfStock && <Link href={`/order/configure?product=${p.slug}`} className="inline-flex items-center gap-1 text-[13px] font-extrabold text-primary-dark hover:underline">Select<Icon name="chevron_right" className="text-[17px]" /></Link>}
                </td>
              ))}
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Catalog() {
  const sp = useSearchParams();
  const router = useRouter();
  const { data, loading } = useApi("/catalog/groups");
  const { currency } = useCurrency();
  const groups = (data?.groups ?? []).filter((g: any) => g.products.length);
  const [group, setGroup] = useState<string>(sp.get("group") ?? "");
  // old WHMCS links: cart.php?a=add&pid=2 (straight to the plan) and cart.php?gid=3 (a group)
  const pid = sp.get("pid");
  useEffect(() => {
    if (pid) router.replace(`/order/configure?${sp.toString()}`);
  }, [pid]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const gid = Number(sp.get("gid"));
    const byGid = gid ? groups.find((x: any) => x.legacyGid === gid) : null;
    if (byGid) setGroup(byGid.slug);
    else if ((!group || !groups.some((x: any) => x.slug === group)) && groups.length) setGroup(groups[0].slug);
  }, [groups.length]); // eslint-disable-line react-hooks/exhaustive-deps
  if (loading || !data || pid) return <Loading />;
  const g = groups.find((x: any) => x.slug === group) ?? groups[0];
  const choose = (slug: string) => {
    setGroup(slug);
    router.replace(`/order?group=${slug}`, { scroll: false });
  };
  const cols = g ? (g.products.length % 3 === 0 || g.products.length === 5 || g.products.length === 6 ? "xl:grid-cols-3" : "xl:grid-cols-4") : "";
  return (
    <div className="mx-auto max-w-[1280px] px-4 py-10 sm:px-6">
      <OrderSteps step={1} />
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-3xl font-extrabold tracking-tight text-ink sm:text-4xl">Choose your plan</h1>
          <p className="mt-2 max-w-2xl text-mute">Deployed automatically after payment from our Tier III data centre in Noida, India (Mumbai coming soon). {currency === "INR" ? "Prices exclude 18% GST — you get a GST invoice with your GSTIN." : "Prices in US dollars, no Indian GST for customers outside India."}</p>
        </div>
        <CurrencySwitch />
      </div>

      {/* category bar */}
      <div className="mt-7">
        <div className="flex gap-2 overflow-x-auto pb-0.5 [scrollbar-width:none]">
          {groups.map((x: any) => (
            <button key={x.slug} onClick={() => choose(x.slug)} className={cx("inline-flex shrink-0 items-center gap-2 whitespace-nowrap rounded-xl px-4 py-2.5 text-[13.5px] font-bold transition", g?.slug === x.slug ? "bg-primary-dark text-white shadow-glow" : "bg-white text-slate-600 ring-1 ring-line hover:text-primary-dark hover:ring-primary/40")}>
              <Icon name={groupIcon(x.name)} className="text-[18px]" />
              {x.name}
              <span className={cx("rounded-md px-1.5 text-[11px]", g?.slug === x.slug ? "bg-white/20" : "bg-slate-100 text-slate-500")}>{x.products.length}</span>
            </button>
          ))}
          <Link href="/order/domain" className="inline-flex shrink-0 items-center gap-2 whitespace-nowrap rounded-xl bg-white px-4 py-2.5 text-[13.5px] font-bold text-slate-600 ring-1 ring-line hover:text-primary-dark"><Icon name="public" className="text-[18px]" />Domains</Link>
        </div>
      </div>

      {g && (
        <section className="mt-6">
          <div className="mb-8 flex flex-wrap items-center gap-4 rounded-2xl bg-gradient-to-r from-[#2e1065] via-[#4c1d95] to-[#6d28d9] p-6 text-white shadow-card">
            <span className="grid h-12 w-12 shrink-0 place-items-center rounded-xl bg-white/15 ring-1 ring-white/20"><Icon name={groupIcon(g.name)} className="text-[26px]" /></span>
            <div className="min-w-0 flex-1">
              <h2 className="text-xl font-extrabold">{g.name}</h2>
              <p className="text-sm text-white/75">{g.headline || g.description || "Choose the plan that fits — upgrade any time."}</p>
            </div>
            <ul className="flex flex-wrap gap-x-5 gap-y-1.5 text-[12.5px] font-semibold text-white/85">
              {(g.products.every((x: any) => x.isVps)
                ? ["Instant setup", "Full root access", "DDoS protection", "NVMe SSD"]
                : g.products.every((x: any) => x.isHosting)
                  ? g.products.every((x: any) => x.type === "RESELLER_HOSTING")
                    ? ["WHM + cPanel", "Sell under your brand", "Free SSL", "24/7 support"]
                    : g.products.every((x: any) => x.type === "WORDPRESS")
                      ? ["WordPress ready", "Free SSL", "cPanel included", "24/7 support"]
                      : ["Free SSL", "cPanel included", "Your domain, set up for you", "24/7 support"]
                  : ["Fast setup", "24/7 expert support", "GST invoice"]
              ).map((t) => (
                <li key={t} className="flex items-center gap-1.5"><Icon name="verified" className="text-[16px] text-emerald-300" />{t}</li>
              ))}
            </ul>
          </div>
          {/* wrap and centre so a short last row doesn't sit off to one side */}
          <div className="flex flex-wrap justify-center gap-6 pt-2">
            {g.products.map((p: any) => (
              <div key={p.id} className={cx("flex w-full sm:w-[calc(50%-12px)] lg:w-[calc(33.333%-16px)]", cols === "xl:grid-cols-4" && "xl:w-[calc(25%-18px)]")}>
                <PlanCard p={p} currency={currency} />
              </div>
            ))}
          </div>
          {g.products.length > 1 && g.products.every((p: any) => p.isVps) && <Compare products={g.products} currency={currency} />}
        </section>
      )}

      <div className="mt-12 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {[
          ["bolt", "Instant deployment", "Your server is built the moment payment clears."],
          ["shield", "DDoS protected", "Always-on network filtering at no extra cost."],
          ["support_agent", "24/7 support", "Real engineers on tickets, any time of day."],
          ["currency_rupee", "GST invoices", "Claim input credit with your GSTIN on every bill."],
        ].map(([i, t, d]) => (
          <div key={t} className="flex gap-3 rounded-2xl border border-line bg-white p-5">
            <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-primary-soft text-primary-dark"><Icon name={i} /></span>
            <div><div className="text-sm font-extrabold text-ink">{t}</div><div className="mt-0.5 text-[12.5px] leading-5 text-mute">{d}</div></div>
          </div>
        ))}
      </div>
    </div>
  );
}

export default function OrderPage() {
  return <Suspense fallback={<Loading />}><Catalog /></Suspense>;
}
