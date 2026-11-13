"use client";
/**
 * Admin sidebar: brand, quick menu filter, collapsible sections (remembered), live badges,
 * a slim icon-only mode for desktop, and the signed-in staff card with Security / Collapse / Sign out.
 */
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { api } from "@/lib/api";
import { can, useSession } from "@/lib/session";
import { Icon, cx } from "@/components/ui";
import { lockedArea, useReauth } from "@/components/admin/reauth";

type Badge = "orders" | "tickets" | "paymentReviews" | "failedSetup";
type Item = { href: string; label: string; icon: string; perm?: string; badge?: Badge };
type Group = { group: string; icon: string; items: Item[] };

export const NAV: Group[] = [
  { group: "Overview", icon: "space_dashboard", items: [{ href: "/admin", label: "Dashboard", icon: "space_dashboard" }] },
  {
    group: "Customers",
    icon: "group",
    items: [
      { href: "/admin/clients", label: "Customers", icon: "group", perm: "clients.view" },
      { href: "/admin/orders", label: "Orders", icon: "shopping_bag", perm: "orders.view", badge: "orders" },
      { href: "/admin/resellers", label: "Resellers", icon: "storefront", perm: "resellers.manage" },
      { href: "/admin/affiliates", label: "Affiliates", icon: "handshake", perm: "clients.view" },
      { href: "/admin/campaigns", label: "Email Campaigns", icon: "outgoing_mail", perm: "campaigns.manage" },
    ],
  },
  {
    group: "Catalogue",
    icon: "inventory_2",
    items: [
      { href: "/admin/products", label: "Products", icon: "inventory_2", perm: "products.manage" },
      { href: "/admin/product-groups", label: "Product Groups", icon: "category", perm: "products.manage" },
      { href: "/admin/addons", label: "Add-ons", icon: "extension", perm: "products.manage" },
      { href: "/admin/promo-codes", label: "Promo Codes", icon: "sell", perm: "products.manage" },
      { href: "/admin/os-templates", label: "OS Templates", icon: "album", perm: "products.manage" },
    ],
  },
  {
    group: "Infrastructure",
    icon: "dns",
    items: [
      { href: "/admin/servers", label: "Servers", icon: "dns", perm: "servers.manage" },
      { href: "/admin/proxmox", label: "Proxmox", icon: "hub", perm: "servers.manage" },
      { href: "/admin/monitoring", label: "Node Monitoring", icon: "monitor_heart", perm: "servers.manage" },
      { href: "/admin/virtualizor", label: "Virtualizor", icon: "lan", perm: "servers.manage" },
      { href: "/admin/ips", label: "IP Management", icon: "router", perm: "ips.view" },
      { href: "/admin/services", label: "VPS & Services", icon: "developer_board", perm: "services.view" },
      { href: "/admin/provisioning", label: "Provisioning", icon: "rocket_launch", perm: "services.view", badge: "failedSetup" },
      { href: "/admin/locations", label: "Locations", icon: "location_on", perm: "servers.manage" },
      { href: "/admin/domains", label: "Domains", icon: "language", perm: "domains.manage" },
    ],
  },
  {
    group: "Billing",
    icon: "account_balance_wallet",
    items: [
      { href: "/admin/invoices", label: "Invoices", icon: "receipt_long", perm: "billing.view" },
      { href: "/admin/quotes", label: "Quotes", icon: "request_quote", perm: "billing.view" },
      { href: "/admin/billable-items", label: "Billable Items", icon: "playlist_add", perm: "billing.view" },
      { href: "/admin/transactions", label: "Transactions", icon: "payments", perm: "billing.view" },
      { href: "/admin/payment-reviews", label: "Payment Reviews", icon: "fact_check", perm: "billing.view", badge: "paymentReviews" },
      { href: "/admin/gateways", label: "Payment Gateways", icon: "account_balance", perm: "payments.manage" },
      { href: "/admin/currencies", label: "Currencies", icon: "currency_exchange", perm: "settings.manage" },
      { href: "/admin/reports", label: "Reports", icon: "monitoring", perm: "reports.view" },
    ],
  },
  {
    group: "Support",
    icon: "support_agent",
    items: [
      { href: "/admin/tickets", label: "Support Tickets", icon: "support_agent", perm: "tickets.view", badge: "tickets" },
      { href: "/admin/knowledgebase", label: "Knowledgebase", icon: "menu_book", perm: "content.manage" },
      { href: "/admin/announcements", label: "Announcements", icon: "campaign", perm: "content.manage" },
    ],
  },
  {
    group: "Setup",
    icon: "tune",
    items: [
      { href: "/admin/staff", label: "Staff", icon: "badge", perm: "staff.manage" },
      { href: "/admin/roles", label: "Roles & Permissions", icon: "admin_panel_settings", perm: "staff.manage" },
      { href: "/admin/email", label: "Email Delivery", icon: "forward_to_inbox", perm: "settings.manage" },
      { href: "/admin/email-templates", label: "Email Templates", icon: "mail", perm: "settings.manage" },
      { href: "/admin/whatsapp", label: "WhatsApp", icon: "chat", perm: "settings.manage" },
      { href: "/admin/settings", label: "Settings", icon: "settings", perm: "settings.manage" },
      { href: "/admin/automation", label: "Automation", icon: "schedule", perm: "reports.view" },
      { href: "/admin/backups", label: "Database Backups", icon: "backup", perm: "settings.manage" },
      { href: "/admin/broker-latency", label: "Broker Latency", icon: "network_ping", perm: "settings.manage" },
      { href: "/admin/migration", label: "WHMCS Migration", icon: "move_up", perm: "settings.manage" },
      { href: "/admin/activity", label: "Activity Log", icon: "history", perm: "reports.view" },
      { href: "/admin/security", label: "My Security", icon: "shield_lock" },
    ],
  },
];

const BADGE_TONE: Record<Badge, string> = {
  orders: "bg-amber-400 text-amber-950",
  paymentReviews: "bg-amber-400 text-amber-950",
  tickets: "bg-rose-500 text-white",
  failedSetup: "bg-rose-500 text-white",
};
const BADGE_HINT: Record<Badge, string> = { orders: "pending", tickets: "awaiting reply", paymentReviews: "to verify", failedSetup: "failed" };

const read = <T,>(k: string, d: T): T => {
  try {
    const v = localStorage.getItem(k);
    return v ? (JSON.parse(v) as T) : d;
  } catch {
    return d;
  }
};
const write = (k: string, v: unknown) => {
  try {
    localStorage.setItem(k, JSON.stringify(v));
  } catch {
    /* private mode */
  }
};

/** Desktop slim (icons only) mode, remembered per browser. */
export function useRail() {
  const [rail, setRail] = useState(false);
  useEffect(() => setRail(read("adm.rail", false)), []);
  const toggle = () => setRail((r) => (write("adm.rail", !r), !r));
  return { rail, toggle };
}

const fmt = (n: number) => (n > 99 ? "99+" : String(n));

export function Sidebar({ rail, onToggleRail, mobile }: { rail: boolean; onToggleRail: () => void; mobile?: boolean }) {
  const { me, logout } = useSession();
  const { active: unlocked } = useReauth();
  const router = useRouter();
  const path = usePathname();
  const slim = rail && !mobile;
  const [q, setQ] = useState("");
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [counts, setCounts] = useState<Partial<Record<Badge, number>>>({});
  const [tip, setTip] = useState<{ label: string; top: number } | null>(null);

  useEffect(() => setOpen(read("adm.groups", { Overview: true, Customers: true })), []);
  useEffect(() => {
    let alive = true;
    const load = () => api<Record<Badge, number>>("/admin/nav-counts").then((c) => alive && setCounts(c), () => undefined);
    load();
    const t = setInterval(load, 60_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [path]);

  const isActive = (h: string) => (h === "/admin" ? path === h : path === h || path.startsWith(h + "/"));
  const groups = useMemo(() => {
    const s = q.trim().toLowerCase();
    return NAV.map((g) => ({
      ...g,
      items: g.items.filter((i) => (!i.perm || can(me, i.perm)) && (!s || i.label.toLowerCase().includes(s) || g.group.toLowerCase().includes(s))),
    })).filter((g) => g.items.length);
  }, [me, q]);

  const toggleGroup = (g: string, now: boolean) => {
    const next = { ...open, [g]: !now };
    setOpen(next);
    write("adm.groups", next);
  };
  const initials = `${me?.firstName?.[0] ?? ""}${me?.lastName?.[0] ?? ""}`.toUpperCase() || "A";

  return (
    <div className="relative flex h-full flex-col overflow-hidden bg-[#0b0f2a] text-slate-300">
      {/* light from the logo's colours */}
      <div className="pointer-events-none absolute -left-20 -top-24 h-72 w-72 rounded-full bg-sky-500/20 blur-3xl" />
      <div className="pointer-events-none absolute -bottom-24 -right-16 h-72 w-72 rounded-full bg-violet-600/25 blur-3xl" />
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(rgba(255,255,255,.045)_1px,transparent_1px)] [background-size:18px_18px] [mask-image:linear-gradient(180deg,#000,transparent_45%)]" />

      {/* brand — the full logo, unaltered, on a white plate (slim mode shows the logo's cloud mark) */}
      <Link href="/admin" className={cx("relative block shrink-0", slim ? "px-3 pb-3 pt-4" : "px-4 pb-3 pt-4")} aria-label="Crapplet Cloud — Dashboard">
        <span className={cx("flex items-center justify-center rounded-2xl bg-white shadow-[0_10px_28px_-10px_rgba(56,189,248,.6)] ring-1 ring-white/50", slim ? "h-[58px] w-[58px]" : "h-[66px] px-4")}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          {slim ? <img src="/Crapplet_Icon.png" alt="Crapplet Cloud" className="h-11 w-11" /> : <img src="/Crapplet_logo.png" alt="Crapplet Cloud" className="h-auto w-full max-w-[212px]" />}
        </span>
        {!slim && (
          <span className="mt-2.5 flex items-center justify-center gap-1.5 text-[10.5px] font-bold uppercase tracking-[.18em] text-slate-400">
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 shadow-[0_0_8px_#34d399]" />
            Admin console
          </span>
        )}
      </Link>

      {/* quick filter */}
      {!slim && (
        <div className="relative shrink-0 px-4 pb-3">
          <label className="flex h-10 items-center gap-2 rounded-xl bg-white/[.06] px-3 ring-1 ring-white/10 transition focus-within:bg-white/[.09] focus-within:ring-sky-400/50">
            <Icon name="filter_list" className="text-[18px] text-slate-400" />
            <input value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => { if (e.key === "Escape") setQ(""); if (e.key === "Enter" && groups[0]?.items[0]) { router.push(groups[0].items[0].href); setQ(""); } }} placeholder="Find in menu…" className="min-w-0 flex-1 bg-transparent text-[13px] font-semibold text-white outline-none placeholder:text-slate-500" />
            {q && <button onClick={() => setQ("")} className="text-slate-400 hover:text-white" aria-label="Clear"><Icon name="close" className="text-[16px]" /></button>}
          </label>
        </div>
      )}

      {/* menu */}
      <nav className={cx("relative flex-1 overflow-y-auto overflow-x-hidden pb-4", slim ? "px-3" : "px-3")} style={{ scrollbarWidth: "thin", scrollbarColor: "rgba(255,255,255,.12) transparent" }} onScroll={() => setTip(null)}>
        {groups.map((g, gi) => {
          const hasActive = g.items.some((i) => isActive(i.href));
          const expanded = slim || !!q || g.group === "Overview" || hasActive || !!open[g.group];
          const groupBadge = g.items.reduce((n, i) => n + (i.badge ? counts[i.badge] ?? 0 : 0), 0);
          return (
            <div key={g.group} className={cx(gi > 0 && (slim ? "mt-2 border-t border-white/[.07] pt-2" : "mt-1"))}>
              {!slim && g.group !== "Overview" && (
                <button
                  onClick={() => !q && !hasActive && toggleGroup(g.group, expanded)}
                  className={cx("group flex w-full items-center gap-2 rounded-lg px-3 pb-1.5 pt-3 text-left", hasActive || q ? "cursor-default" : "")}
                  aria-expanded={expanded}
                >
                  <span className={cx("text-[10.5px] font-extrabold uppercase tracking-[.16em] transition", hasActive ? "text-sky-300/90" : "text-slate-500 group-hover:text-slate-300")}>{g.group}</span>
                  {!expanded && groupBadge > 0 && <span className="rounded-full bg-white/10 px-1.5 text-[10px] font-extrabold text-slate-200">{fmt(groupBadge)}</span>}
                  <span className="h-px flex-1 bg-white/[.06]" />
                  {!hasActive && !q && <Icon name="expand_more" className={cx("text-[18px] text-slate-500 transition group-hover:text-slate-300", expanded ? "rotate-180" : "")} />}
                </button>
              )}
              <div className={cx("grid transition-[grid-template-rows] duration-300 ease-out", expanded ? "grid-rows-[1fr]" : "grid-rows-[0fr]")}>
                <div className="min-h-0 space-y-0.5 overflow-hidden">
                  {g.items.map((i) => {
                    const on = isActive(i.href);
                    const n = i.badge ? counts[i.badge] ?? 0 : 0;
                    const locked = !unlocked && lockedArea(i.href);
                    return (
                      <Link
                        key={i.href}
                        href={i.href}
                        onClick={() => setQ("")}
                        onMouseEnter={(e) => slim && setTip({ label: i.label + (n ? ` · ${n} ${BADGE_HINT[i.badge!]}` : ""), top: e.currentTarget.getBoundingClientRect().top + 4 })}
                        onMouseLeave={() => setTip(null)}
                        aria-label={i.label}
                        className={cx(
                          "group/item relative flex items-center gap-3 rounded-xl text-[13.5px] font-semibold transition",
                          slim ? "justify-center p-1.5" : "px-2 py-1.5",
                          on ? "bg-white/[.08] text-white ring-1 ring-white/10" : "text-slate-300/85 hover:bg-white/[.05] hover:text-white",
                        )}
                      >
                        {on && !slim && <span className="absolute -left-3 top-1/2 h-6 w-1 -translate-y-1/2 rounded-r-full bg-gradient-to-b from-sky-400 to-violet-500 shadow-[0_0_12px_rgba(99,102,241,.8)]" />}
                        <span
                          className={cx(
                            "relative grid h-8 w-8 shrink-0 place-items-center rounded-[10px] transition",
                            on ? "bg-gradient-to-br from-sky-400 via-indigo-500 to-violet-600 text-white shadow-[0_6px_16px_-4px_rgba(99,102,241,.75)]" : "bg-white/[.04] text-slate-400 group-hover/item:bg-white/10 group-hover/item:text-white",
                          )}
                        >
                          <Icon name={i.icon} className="text-[18px]" fill={on} />
                          {slim && n > 0 && <span className={cx("absolute -right-1.5 -top-1.5 min-w-[18px] rounded-full px-1 text-center text-[10px] font-extrabold leading-[18px] ring-2 ring-[#0b0f2a]", BADGE_TONE[i.badge!])}>{fmt(n)}</span>}
                        </span>
                        {!slim && <span className="min-w-0 flex-1 truncate">{i.label}</span>}
                        {!slim && n > 0 && <span className={cx("min-w-[22px] rounded-full px-1.5 text-center text-[11px] font-extrabold leading-5", BADGE_TONE[i.badge!])} title={`${n} ${BADGE_HINT[i.badge!]}`}>{fmt(n)}</span>}
                        {!slim && !n && locked && <span title="Asks for your password"><Icon name="lock" className="text-[14px] text-slate-500" /></span>}
                      </Link>
                    );
                  })}
                </div>
              </div>
            </div>
          );
        })}
        {!groups.length && <div className="px-3 py-8 text-center text-[12.5px] text-slate-500">Nothing in the menu matches “{q}”.</div>}
      </nav>

      {/* signed-in staff */}
      <div className={cx("relative shrink-0 border-t border-white/[.07]", slim ? "p-2" : "p-3")}>
        <div className={cx("rounded-2xl bg-white/[.05] ring-1 ring-white/10", slim ? "flex flex-col items-center gap-1 p-1.5" : "p-2.5")}>
          <div className={cx("flex items-center gap-2.5", slim && "flex-col")}>
            <span className="relative grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-gradient-to-br from-sky-400 to-violet-600 text-[13px] font-extrabold text-white" title={slim ? `${me?.firstName} ${me?.lastName}` : undefined}>
              {initials}
              <span className="absolute -bottom-0.5 -right-0.5 h-3 w-3 rounded-full bg-emerald-400 ring-2 ring-[#11163a]" />
            </span>
            {!slim && (
              <span className="min-w-0 flex-1 leading-tight">
                <span className="block truncate text-[13px] font-extrabold text-white">{me?.firstName} {me?.lastName}</span>
                <span className="block truncate text-[11.5px] font-semibold text-slate-400">{me?.role?.name ?? "Staff"}</span>
              </span>
            )}
          </div>
          <div className={cx("flex gap-1", slim ? "flex-col" : "mt-2.5 border-t border-white/[.07] pt-2")}>
            {[
              { icon: "shield_lock", label: "My Security", onClick: () => router.push("/admin/security") },
              ...(mobile ? [] : [{ icon: slim ? "left_panel_open" : "left_panel_close", label: slim ? "Expand menu" : "Collapse menu", onClick: onToggleRail }]),
              { icon: "logout", label: "Sign out", danger: true, onClick: async () => { await logout(); router.replace("/admin/login"); } },
            ].map((b) => (
              <button
                key={b.label}
                onClick={b.onClick}
                title={b.label}
                aria-label={b.label}
                className={cx("grid h-8 flex-1 place-items-center rounded-lg text-slate-400 transition hover:bg-white/10", b.danger ? "hover:text-rose-300" : "hover:text-white", slim && "w-9 flex-none")}
              >
                <Icon name={b.icon} className="text-[18px]" />
              </button>
            ))}
          </div>
        </div>
      </div>

      {slim && tip && (
        <div className="pointer-events-none fixed left-[84px] z-[70] whitespace-nowrap rounded-lg bg-slate-900 px-2.5 py-1.5 text-[12.5px] font-bold text-white shadow-xl ring-1 ring-white/10" style={{ top: tip.top }}>
          {tip.label}
        </div>
      )}
    </div>
  );
}
