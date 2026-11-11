"use client";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { api, money } from "@/lib/api";
import { Badge, Icon, cx } from "@/components/ui";

export type SearchResults = { q: string; clients: any[]; services: any[]; orders: any[]; invoices: any[]; domains: any[]; tickets: any[]; transactions: any[] };
type Hit = { group: string; icon: string; href: string; title: string; sub: string; status?: string };

const name = (u: any) => [u?.firstName, u?.lastName].filter(Boolean).join(" ") || u?.email || "";

export function toHits(r: SearchResults | null): Hit[] {
  if (!r) return [];
  return [
    ...r.services.map((s) => ({ group: "Services", icon: s.product?.provisioner === "CPANEL" ? "language" : "dns", href: `/admin/services/${s.id}`, title: `${s.hostname ?? s.product?.name}`, sub: [s.ips?.map((i: any) => i.address).join(", "), s.product?.name, s.remoteId && `#${s.remoteId}`, name(s.user)].filter(Boolean).join(" · "), status: s.status })),
    ...r.clients.map((c) => ({ group: "Customers", icon: "person", href: `/admin/clients/${c.id}`, title: name(c), sub: [c.email, c.phone, c.profile?.companyName, c.profile?.gstin].filter(Boolean).join(" · "), status: c.status })),
    ...r.orders.map((o) => ({ group: "Orders", icon: "shopping_bag", href: `/admin/orders/${o.id}`, title: o.number, sub: `${name(o.user)} · ${money(o.total, o.currency)}`, status: o.status })),
    ...r.invoices.map((i) => ({ group: "Invoices", icon: "receipt_long", href: `/admin/invoices/${i.id}`, title: i.number ?? i.proformaNumber, sub: `${name(i.user)} · ${money(i.total, i.currency)}`, status: i.status })),
    ...r.domains.map((d) => ({ group: "Domains", icon: "public", href: `/admin/clients/${d.user?.id}`, title: d.name, sub: d.user?.email ?? "", status: d.status })),
    ...r.tickets.map((t) => ({ group: "Tickets", icon: "support_agent", href: `/admin/tickets/${t.id}`, title: `#${t.number} ${t.subject}`, sub: t.user?.email ?? "", status: t.status })),
    ...r.transactions.map((t) => ({ group: "Payments", icon: "payments", href: t.invoiceId ? `/admin/invoices/${t.invoiceId}` : "/admin/transactions", title: t.gatewayTxnId, sub: `${t.gateway} · ${t.type.toLowerCase()} · ${money(t.amount, t.currency)}` })),
  ];
}

/** Header search: IP, hostname, VPS id, name, email, mobile, GSTIN, company, order / invoice / ticket numbers. */
export function GlobalSearch() {
  const router = useRouter();
  const path = usePathname();
  const [q, setQ] = useState("");
  const [r, setR] = useState<SearchResults | null>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [cursor, setCursor] = useState(0);
  const box = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const hits = useMemo(() => toHits(r), [r]);

  useEffect(() => setOpen(false), [path]);
  useEffect(() => {
    const t = q.trim();
    if (t.length < 2) {
      setR(null);
      return;
    }
    setBusy(true);
    const h = setTimeout(() => api<SearchResults>(`/admin/search?q=${encodeURIComponent(t)}&take=5`).then((x) => { setR(x); setCursor(0); }).catch(() => {}).finally(() => setBusy(false)), 220);
    return () => clearTimeout(h);
  }, [q]);
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if ((e.key === "k" && (e.metaKey || e.ctrlKey)) || (e.key === "/" && !["INPUT", "TEXTAREA", "SELECT"].includes((e.target as HTMLElement)?.tagName))) {
        e.preventDefault();
        input.current?.focus();
        setOpen(true);
      }
    };
    const m = (e: MouseEvent) => box.current && !box.current.contains(e.target as Node) && setOpen(false);
    document.addEventListener("keydown", k);
    document.addEventListener("mousedown", m);
    return () => {
      document.removeEventListener("keydown", k);
      document.removeEventListener("mousedown", m);
    };
  }, []);

  const go = (href: string) => {
    setOpen(false);
    router.push(href);
  };
  let lastGroup = "";
  return (
    <div ref={box} className="relative hidden max-w-xl flex-1 sm:block">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (hits[cursor] && open && r) go(hits[cursor].href);
          else if (q.trim().length >= 2) go(`/admin/search?q=${encodeURIComponent(q.trim())}`);
        }}
      >
        <label className="flex h-10 items-center gap-2 rounded-xl border border-line bg-white px-3 text-sm focus-within:border-primary focus-within:ring-2 focus-within:ring-primary/15">
          <Icon name="search" className="text-mute" />
          <input
            ref={input}
            value={q}
            onChange={(e) => { setQ(e.target.value); setOpen(true); }}
            onFocus={() => setOpen(true)}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") { e.preventDefault(); setCursor((c) => Math.min(hits.length - 1, c + 1)); }
              if (e.key === "ArrowUp") { e.preventDefault(); setCursor((c) => Math.max(0, c - 1)); }
              if (e.key === "Escape") setOpen(false);
            }}
            className="min-w-0 flex-1 bg-transparent outline-none"
            placeholder="Search IP, hostname, name, mobile, GSTIN, company, order, invoice…"
          />
          {busy ? <span className="h-4 w-4 animate-spin rounded-full border-2 border-slate-200 border-t-primary" /> : <kbd className="hidden rounded-md border border-line px-1.5 text-[10px] font-bold text-mute md:inline">Ctrl K</kbd>}
        </label>
      </form>
      {open && q.trim().length >= 2 && r && (
        <div className="absolute left-0 right-0 top-12 z-50 max-h-[70vh] overflow-y-auto rounded-2xl border border-line bg-white p-1.5 shadow-2xl">
          {hits.length ? (
            hits.map((h, i) => {
              const head = h.group !== lastGroup;
              lastGroup = h.group;
              return (
                <div key={h.href + i}>
                  {head && <div className="px-3 pb-1 pt-2.5 text-[10.5px] font-bold uppercase tracking-wider text-mute">{h.group}</div>}
                  <Link href={h.href} onMouseEnter={() => setCursor(i)} onClick={() => setOpen(false)} className={cx("flex items-center gap-3 rounded-xl px-3 py-2", i === cursor ? "bg-primary-tint" : "")}>
                    <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-primary-soft text-primary-dark"><Icon name={h.icon} className="text-[17px]" /></span>
                    <span className="min-w-0 flex-1"><span className="block truncate text-[13.5px] font-bold text-ink">{h.title}</span><span className="block truncate text-xs text-mute">{h.sub}</span></span>
                    {h.status && <Badge status={h.status} />}
                  </Link>
                </div>
              );
            })
          ) : (
            <div className="px-4 py-6 text-center text-sm text-mute">Nothing found for “{q.trim()}”</div>
          )}
          <Link href={`/admin/search?q=${encodeURIComponent(q.trim())}`} onClick={() => setOpen(false)} className="mt-1 flex items-center justify-center gap-1 rounded-xl border-t border-line py-2.5 text-[13px] font-bold text-primary-dark hover:bg-primary-tint">
            See all results <Icon name="arrow_forward" className="text-[16px]" />
          </Link>
        </div>
      )}
    </div>
  );
}
