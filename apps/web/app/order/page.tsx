"use client";
import Link from "next/link";
import { Suspense, useState } from "react";
import { useSearchParams } from "next/navigation";
import { gb, money } from "@/lib/api";
import { Icon, Loading, cx, useApi } from "@/components/ui";
import { OrderSteps } from "@/components/order-steps";
import { CurrencySwitch, priceRow, rowsIn, useCurrency } from "@/lib/currency";

function Catalog() {
  const sp = useSearchParams();
  const { data, loading } = useApi("/catalog/groups");
  const [group, setGroup] = useState<string>(sp.get("group") ?? "");
  const { currency } = useCurrency();
  if (loading || !data) return <Loading />;
  const groups = data.groups.filter((g: any) => g.products.length);
  const shown = groups.filter((g: any) => !group || g.slug === group);
  return (
    <div className="mx-auto max-w-[1280px] px-4 py-10 sm:px-6">
      <OrderSteps step={1} />
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-3xl font-extrabold tracking-tight text-ink sm:text-4xl">Choose your plan</h1>
          <p className="mt-2 text-mute">
            {currency === "INR" ? "All prices exclude 18% GST." : "Prices in US dollars. No Indian GST for customers outside India."} VPS plans let you pick your own IPv4 address.
          </p>
        </div>
        <CurrencySwitch />
      </div>
      <div className="my-6 flex gap-2 overflow-x-auto pb-1">
        <button onClick={() => setGroup("")} className={cx("whitespace-nowrap rounded-full px-4 py-2 text-sm font-bold", !group ? "bg-primary-dark text-white" : "bg-white text-slate-600 ring-1 ring-line")}>All</button>
        {groups.map((g: any) => (
          <button key={g.slug} onClick={() => setGroup(g.slug)} className={cx("whitespace-nowrap rounded-full px-4 py-2 text-sm font-bold", group === g.slug ? "bg-primary-dark text-white" : "bg-white text-slate-600 ring-1 ring-line")}>{g.name}</button>
        ))}
        <Link href="/order/domain" className="whitespace-nowrap rounded-full bg-white px-4 py-2 text-sm font-bold text-slate-600 ring-1 ring-line">Domains</Link>
      </div>
      {shown.map((g: any) => (
        <section key={g.slug} className="mb-12">
          <div className="mb-4 flex items-end justify-between">
            <div>
              <h2 className="text-xl font-extrabold text-ink">{g.name}</h2>
              {g.headline && <p className="text-sm text-mute">{g.headline}</p>}
            </div>
          </div>
          <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {g.products.map((p: any) => {
              const monthly = priceRow(p.pricing, "MONTHLY", currency) ?? rowsIn(p.pricing, currency)[0];
              return (
                <div key={p.id} className={cx("relative flex flex-col rounded-2xl border bg-white p-6 shadow-card transition hover:-translate-y-1", p.featured ? "border-primary ring-2 ring-primary/20" : "border-line")}>
                  {p.featured && <span className="absolute -top-3 left-6 rounded-full bg-gradient-to-r from-primary to-primary-dark px-3 py-1 text-[11px] font-extrabold uppercase tracking-wider text-white">Most popular</span>}
                  <h3 className="text-lg font-extrabold text-ink">{p.name}</h3>
                  <p className="mt-1 min-h-[40px] text-sm text-mute">{p.tagline}</p>
                  <div className="mt-4 flex items-baseline gap-1">
                    <span className="text-3xl font-extrabold tracking-tight text-ink">{monthly ? money(monthly.price, currency).replace(/\.00$/, "") : "—"}</span>
                    <span className="text-sm font-semibold text-mute">/mo</span>
                  </div>
                  {p.isVps ? (
                    <ul className="mt-4 space-y-2 text-sm text-slate-700">
                      {[["developer_board", `${p.specs.cpuCores} vCPU`], ["memory", `${gb(p.specs.ramMb)} RAM`], ["database", `${p.specs.diskGb} GB SSD`], ["speed", p.specs.bandwidthGb ? `${p.specs.bandwidthGb >= 1024 ? p.specs.bandwidthGb / 1024 + " TB" : p.specs.bandwidthGb + " GB"} bandwidth` : "Unmetered bandwidth"], ["public", p.allowIpSelection ? "Choose your IPv4" : "Dedicated IPv4"]].map(([i, t]) => (
                        <li key={t} className="flex items-center gap-2"><Icon name={i} className="text-[19px] text-primary" />{t}</li>
                      ))}
                    </ul>
                  ) : (
                    <ul className="mt-4 space-y-2 text-sm text-slate-700">
                      {p.features.slice(0, 6).map((f: string) => <li key={f} className="flex items-center gap-2"><Icon name="check_circle" className="text-[19px] text-primary" />{f}</li>)}
                    </ul>
                  )}
                  <div className="mt-auto pt-6">
                    {p.outOfStock ? (
                      <span className="block rounded-xl bg-slate-100 py-3 text-center text-sm font-bold text-slate-500">Out of stock</span>
                    ) : (
                      <Link href={`/order/configure?product=${p.slug}`} className={cx("block rounded-xl py-3 text-center text-sm font-extrabold transition", p.featured ? "bg-gradient-to-br from-primary to-primary-dark text-white shadow-glow" : "bg-primary-soft text-primary-dark hover:bg-primary hover:text-white")}>
                        {p.isVps ? "Configure & deploy" : "Order now"}
                      </Link>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      ))}
    </div>
  );
}
export default function OrderPage() {
  return <Suspense><Catalog /></Suspense>;
}
