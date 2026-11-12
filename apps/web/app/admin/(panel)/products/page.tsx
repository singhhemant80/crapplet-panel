"use client";
import Link from "next/link";
import { useMemo, useState } from "react";
import { api, gb, money } from "@/lib/api";
import { Badge, Button, Empty, Icon, Loading, PageHeader, cx, toast, useApi } from "@/components/ui";
import { ListShell, SearchBox, StatusTabs, planIcon, type Tab } from "@/components/admin/list-kit";
import { WEBSITE_PAGE } from "@/lib/website-pages";



const TABS: Tab[] = [
  { key: "", label: "All plans" },
  { key: "live", label: "On website", tone: "green" },
  { key: "hidden", label: "Hidden", tone: "slate" },
  { key: "oos", label: "Out of stock", tone: "amber" },
  { key: "disabled", label: "Disabled", tone: "rose" },
];
const isLive = (p: any) => p.enabled && !p.hidden;
const isOos = (p: any) => p.outOfStock || (p.stockControl && p.stockQty <= 0);
const MATCH: Record<string, (p: any) => boolean> = { live: isLive, hidden: (p) => p.enabled && p.hidden, oos: isOos, disabled: (p) => !p.enabled };

export default function Products() {
  const { data, loading, reload } = useApi("/admin/products");
  const [tab, setTab] = useState("");
  const [q, setQ] = useState("");
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState<string | null>(null);
  // optimistic overrides while a change is saving
  const [patch, setPatch] = useState<Record<string, any>>({});

  const all: any[] = useMemo(() => (data?.products ?? []).map((p: any) => ({ ...p, ...patch[p.id] })), [data, patch]);
  const counts = useMemo(() => ({ all: all.length, live: all.filter(isLive).length, hidden: all.filter(MATCH.hidden).length, oos: all.filter(isOos).length, disabled: all.filter(MATCH.disabled).length }), [all]);
  const shown = all.filter((p) => (!tab || MATCH[tab](p)) && (!q || `${p.name} ${p.slug} ${p.legacyPid ?? ""} ${p.group.name}`.toLowerCase().includes(q.toLowerCase())));
  const groups: [string, any[]][] = [];
  for (const p of shown) {
    const g = groups.find(([n]) => n === p.group.name);
    if (g) g[1].push(p);
    else groups.push([p.group.name, [p]]);
  }

  async function apply(ids: string[], action: string, label: string) {
    const optimistic: Record<string, any> = { show: { hidden: false, enabled: true }, hide: { hidden: true }, out_of_stock: { outOfStock: true }, in_stock: { outOfStock: false }, enable: { enabled: true }, disable: { enabled: false } }[action] ?? {};
    setPatch((x) => ({ ...x, ...Object.fromEntries(ids.map((id) => [id, { ...x[id], ...optimistic }])) }));
    setBusy(action);
    try {
      const r = await api("/admin/products/bulk", { body: { ids, action } });
      toast.success(`${r.updated} plan${r.updated === 1 ? "" : "s"} ${label}`);
      await reload();
      setPatch({});
      if (ids.length > 1) setSel(new Set());
    } catch (e: any) {
      toast.error(e.message);
      setPatch({});
    } finally {
      setBusy(null);
    }
  }
  const toggle = (id: string) => setSel((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const toggleMany = (ids: string[], on: boolean) => setSel((s) => { const n = new Set(s); ids.forEach((id) => (on ? n.add(id) : n.delete(id))); return n; });
  const ids = [...sel];

  return (
    <>
      <PageHeader
        title="Products"
        subtitle="Every plan, grouped as on the order page. Switch plans on or off the website and in or out of stock right here — one at a time or many at once."
        actions={<Button href="/admin/products/new" icon="add">New product</Button>}
        stats={data ? [
          ["Plans", String(counts.all), `${data.products.reduce((a: number, p: any) => a + p._count.services, 0)} services`],
          ["On website", String(counts.live), "visible & orderable"],
          ["Hidden", String(counts.hidden + counts.disabled), `${counts.disabled} disabled`],
          ["Out of stock", <span key="o" className={counts.oos ? "text-amber-600" : ""}>{counts.oos}</span>, "shown, can't be ordered"],
        ] : undefined}
      />

      <ListShell
        toolbar={
          <>
            <StatusTabs tabs={TABS} value={tab} onChange={setTab} counts={counts} />
            <SearchBox value={q} onSearch={setQ} placeholder="Search plan name, slug, WHMCS pid or group…" />
          </>
        }
      >
        {loading && !data ? <Loading /> : !groups.length ? (
          <Empty icon="inventory_2" title="No plans match"><p className="text-sm text-mute">Try another tab or search.</p></Empty>
        ) : (
          <div className="divide-y-8 divide-[#f6f3fc]">
            {groups.map(([g, list]) => {
              const gIds = list.map((p) => p.id);
              const all = gIds.every((id) => sel.has(id));
              const page = WEBSITE_PAGE[list[0].type];
              return (
                <section key={g}>
                  <header className="flex flex-wrap items-center gap-3 bg-[#fbf9ff] px-4 py-2.5 sm:px-5">
                    <input type="checkbox" aria-label={`Select all in ${g}`} checked={all} onChange={(e) => toggleMany(gIds, e.target.checked)} className="h-4 w-4 accent-[#7c3aed]" />
                    <span className="text-[13.5px] font-extrabold text-ink">{g}</span>
                    <span className="text-[12px] text-mute">{list.length} plan{list.length === 1 ? "" : "s"}</span>
                    {page && <a href={page} target="_blank" rel="noreferrer" className="ml-auto inline-flex items-center gap-1 text-[12px] font-bold text-primary-dark hover:underline"><Icon name="open_in_new" className="text-[15px]" />{page.slice(1)}</a>}
                  </header>
                  <ul className="divide-y divide-line">
                    {list.map((p) => (
                      <Row key={p.id} p={p} checked={sel.has(p.id)} onCheck={() => toggle(p.id)} apply={apply} />
                    ))}
                  </ul>
                </section>
              );
            })}
          </div>
        )}
      </ListShell>

      {ids.length > 0 && (
        <div className="fixed inset-x-3 bottom-3 z-40 mx-auto flex max-w-4xl flex-wrap items-center gap-2 rounded-2xl bg-[#1d1033] p-2.5 pl-4 text-white shadow-2xl ring-1 ring-white/10 sm:bottom-5">
          <span className="mr-1 text-[13.5px] font-extrabold">{ids.length} selected</span>
          <button onClick={() => setSel(new Set())} className="mr-auto text-[12px] font-bold text-violet-200 hover:text-white">Clear</button>
          <BulkBtn icon="visibility" onClick={() => apply(ids, "show", "shown on the website")} busy={busy === "show"}>Show</BulkBtn>
          <BulkBtn icon="visibility_off" onClick={() => apply(ids, "hide", "hidden")} busy={busy === "hide"}>Hide</BulkBtn>
          <BulkBtn icon="inventory_2" onClick={() => apply(ids, "out_of_stock", "marked out of stock")} busy={busy === "out_of_stock"} tone="amber">Out of stock</BulkBtn>
          <BulkBtn icon="check_circle" onClick={() => apply(ids, "in_stock", "back in stock")} busy={busy === "in_stock"} tone="green">In stock</BulkBtn>
        </div>
      )}
    </>
  );
}

function BulkBtn({ icon, children, onClick, busy, tone }: { icon: string; children: React.ReactNode; onClick: () => void; busy: boolean; tone?: "amber" | "green" }) {
  return (
    <button onClick={onClick} disabled={busy} className={cx("inline-flex h-9 items-center gap-1.5 rounded-xl px-3 text-[13px] font-bold transition disabled:opacity-60", tone === "amber" ? "bg-amber-400 text-amber-950 hover:bg-amber-300" : tone === "green" ? "bg-emerald-400 text-emerald-950 hover:bg-emerald-300" : "bg-white/10 hover:bg-white/20")}>
      <Icon name={busy ? "progress_activity" : icon} className={cx("text-[18px]", busy && "animate-spin")} />
      {children}
    </button>
  );
}

/** Labeled on/off switch used for the Website and Stock columns. */
function Switch({ on, onChange, onLabel, offLabel, tone, disabled, title }: { on: boolean; onChange: (v: boolean) => void; onLabel: string; offLabel: string; tone: "green" | "amber"; disabled?: boolean; title: string }) {
  return (
    <button
      role="switch"
      aria-checked={on}
      aria-label={title}
      title={title}
      disabled={disabled}
      onClick={() => onChange(!on)}
      className={cx("inline-flex items-center gap-2 rounded-full py-1 pl-1 pr-2.5 text-[12px] font-bold ring-1 transition disabled:cursor-not-allowed disabled:opacity-50", on ? (tone === "green" ? "bg-emerald-50 text-emerald-700 ring-emerald-200" : "bg-amber-50 text-amber-700 ring-amber-200") : "bg-slate-50 text-slate-500 ring-slate-200")}
    >
      <span className={cx("relative h-[18px] w-8 rounded-full transition", on ? (tone === "green" ? "bg-emerald-500" : "bg-amber-500") : "bg-slate-300")}>
        <span className={cx("absolute top-[2px] h-[14px] w-[14px] rounded-full bg-white shadow transition-all", on ? "left-[16px]" : "left-[2px]")} />
      </span>
      {on ? onLabel : offLabel}
    </button>
  );
}

function Row({ p, checked, onCheck, apply }: { p: any; checked: boolean; onCheck: () => void; apply: (ids: string[], action: string, label: string) => void }) {
  const inr = p.pricing.find((x: any) => x.cycle === "MONTHLY" && x.currency === "INR") ?? p.pricing.filter((x: any) => x.currency === "INR").sort((a: any, b: any) => a.price - b.price)[0];
  const tracked = p.stockControl;
  const oos = isOos(p);
  return (
    <li className={cx("grid grid-cols-[auto_minmax(0,1fr)] items-center gap-x-3 gap-y-3 px-4 py-3 transition sm:px-5 xl:grid-cols-[auto_minmax(0,2.2fr)_110px_minmax(0,1.3fr)_70px_150px_160px_40px]", checked && "bg-primary-tint/60", !p.enabled && "opacity-60")}>
      <input type="checkbox" aria-label={`Select ${p.name}`} checked={checked} onChange={onCheck} className="h-4 w-4 accent-[#7c3aed]" />
      <Link href={`/admin/products/${p.id}`} className="flex min-w-0 items-center gap-3">
        <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-primary-soft text-primary-dark"><Icon name={planIcon(p.type, p.provisioner)} className="text-[19px]" /></span>
        <span className="min-w-0">
          <span className="flex items-center gap-1.5">
            <span className="truncate font-bold text-ink hover:text-primary-dark">{p.name}</span>
            {p.featured && <Icon name="star" fill className="shrink-0 text-[15px] text-amber-400" />}
            {!p.enabled && <Badge status="CANCELLED">disabled</Badge>}
          </span>
          <span className="block truncate text-[11.5px] text-mute">{p.slug}{p.legacyPid ? ` · pid ${p.legacyPid}` : ""}{p.cpuCores ? ` · ${p.cpuCores} vCPU · ${gb(p.ramMb)} · ${p.diskGb} GB` : ""}</span>
        </span>
      </Link>
      <div className="col-start-2 flex flex-wrap items-center gap-x-4 gap-y-2 xl:contents">
        <div className="whitespace-nowrap text-[13px] font-extrabold tabular-nums text-ink xl:text-right">
          {inr ? money(inr.price) : <span className="font-semibold text-rose-600">no price</span>}
          {inr && <span className="text-[11px] font-semibold text-mute">/{inr.cycle === "MONTHLY" ? "mo" : inr.cycle.toLowerCase()}</span>}
        </div>
        <div className="hidden min-w-0 truncate text-[12px] text-slate-600 xl:block">
          {p.provisioner}{p.servers.length ? ` · ${p.servers.map((s: any) => s.server.name).join(", ")}` : p.provisioner !== "MANUAL" ? <span className="font-bold text-amber-600"> · no server</span> : ""}
        </div>
        <div className="text-[12px] text-slate-600 xl:text-center" title="Services on this plan"><span className="font-bold text-ink">{p._count.services}</span><span className="xl:hidden"> services</span></div>
        <Switch on={isLive(p)} onChange={(v) => apply([p.id], v ? "show" : "hide", v ? "shown on the website" : "hidden")} onLabel="On website" offLabel="Hidden" tone="green" title={isLive(p) ? "Hide from website & order page" : "Show on website & order page"} />
        <div className="flex flex-col items-start gap-0.5">
          <Switch on={!p.outOfStock} onChange={(v) => apply([p.id], v ? "in_stock" : "out_of_stock", v ? "back in stock" : "marked out of stock")} onLabel="In stock" offLabel="Out of stock" tone="green" title={p.outOfStock ? "Mark back in stock" : "Mark out of stock"} />
          {tracked && <span className={cx("pl-1 text-[11px] font-semibold", p.stockQty <= 0 ? "text-amber-700" : "text-mute")}>{p.stockQty <= 0 ? "stock count is 0" : `${p.stockQty} left`}</span>}
        </div>
        <Link href={`/admin/products/${p.id}`} aria-label={`Edit ${p.name}`} className="ml-auto grid h-8 w-8 place-items-center rounded-lg text-slate-500 ring-1 ring-line hover:bg-primary-tint hover:text-primary-dark xl:ml-0"><Icon name="edit" className="text-[17px]" /></Link>
      </div>
    </li>
  );
}
