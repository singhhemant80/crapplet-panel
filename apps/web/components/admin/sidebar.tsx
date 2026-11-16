"use client";
/**
 * Admin sidebar (light, two panes):
 *  - a slim section column (Home, Customers, Catalogue, Servers, Billing, Support, System) with a dot when a
 *    section has something waiting, the collapse button and the staff menu (My Security / Sign out);
 *  - a list pane with the selected section's pages and a one-line description of each, a menu search,
 *    and on Home: "Needs you" (live counts) and pages the staff member pinned.
 * Collapsed ("slim") mode keeps only the section column; clicking a section opens its list as a flyout.
 */
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "@/lib/api";
import { can, useSession } from "@/lib/session";
import { Icon, cx } from "@/components/ui";
import { lockedArea, useReauth } from "@/components/admin/reauth";

type Badge = "orders" | "tickets" | "paymentReviews" | "failedSetup" | "overdueInvoices";
type Item = { href: string; label: string; icon: string; desc: string; perm?: string; badge?: Badge };
type Group = { key: string; group: string; short: string; icon: string; items: Item[] };

export const NAV: Group[] = [
  {
    key: "home", group: "Home", short: "Home", icon: "space_dashboard",
    items: [
      { href: "/admin", label: "Dashboard", icon: "space_dashboard", desc: "Today at a glance" },
      { href: "/admin/reports", label: "Reports", icon: "monitoring", desc: "Income, growth, taxes", perm: "reports.view" },
      { href: "/admin/activity", label: "Activity Log", icon: "history", desc: "Who did what", perm: "reports.view" },
    ],
  },
  {
    key: "customers", group: "Customers", short: "Customers", icon: "group",
    items: [
      { href: "/admin/clients", label: "Customers", icon: "group", desc: "Accounts, profiles, balances", perm: "clients.view" },
      { href: "/admin/orders", label: "Orders", icon: "shopping_bag", desc: "New and pending orders", perm: "orders.view", badge: "orders" },
      { href: "/admin/resellers", label: "Resellers", icon: "storefront", desc: "White-label partners", perm: "resellers.manage" },
      { href: "/admin/affiliates", label: "Affiliates", icon: "handshake", desc: "Referrals and payouts", perm: "clients.view" },
      { href: "/admin/campaigns", label: "Email Campaigns", icon: "outgoing_mail", desc: "Newsletters and offers", perm: "campaigns.manage" },
    ],
  },
  {
    key: "catalogue", group: "Catalogue", short: "Catalogue", icon: "inventory_2",
    items: [
      { href: "/admin/products", label: "Products", icon: "inventory_2", desc: "Plans and pricing", perm: "products.manage" },
      { href: "/admin/product-groups", label: "Product Groups", icon: "category", desc: "How plans are grouped", perm: "products.manage" },
      { href: "/admin/addons", label: "Add-ons", icon: "extension", desc: "Extras sold with plans", perm: "products.manage" },
      { href: "/admin/promo-codes", label: "Promo Codes", icon: "sell", desc: "Discounts and coupons", perm: "products.manage" },
      { href: "/admin/os-templates", label: "OS Templates", icon: "album", desc: "Operating systems offered", perm: "products.manage" },
    ],
  },
  {
    key: "servers", group: "Infrastructure", short: "Servers", icon: "dns",
    items: [
      { href: "/admin/services", label: "VPS & Services", icon: "developer_board", desc: "Every customer service", perm: "services.view" },
      { href: "/admin/provisioning", label: "Provisioning", icon: "rocket_launch", desc: "Setups and failures", perm: "services.view", badge: "failedSetup" },
      { href: "/admin/servers", label: "Servers", icon: "dns", desc: "Connected panels", perm: "servers.manage" },
      { href: "/admin/proxmox", label: "Proxmox", icon: "hub", desc: "Proxmox clusters", perm: "servers.manage" },
      { href: "/admin/virtualizor", label: "Virtualizor", icon: "lan", desc: "Virtualizor panels", perm: "servers.manage" },
      { href: "/admin/monitoring", label: "Node Monitoring", icon: "monitor_heart", desc: "Load, uptime, alerts", perm: "servers.manage" },
      { href: "/admin/ips", label: "IP Management", icon: "router", desc: "Pools and assignments", perm: "ips.view" },
      { href: "/admin/locations", label: "Locations", icon: "location_on", desc: "Data centres", perm: "servers.manage" },
      { href: "/admin/domains", label: "Domains", icon: "language", desc: "Registrations and renewals", perm: "domains.manage" },
    ],
  },
  {
    key: "billing", group: "Billing", short: "Billing", icon: "receipt_long",
    items: [
      { href: "/admin/invoices", label: "Invoices", icon: "receipt_long", desc: "Paid, unpaid, overdue", perm: "billing.view", badge: "overdueInvoices" },
      { href: "/admin/transactions", label: "Transactions", icon: "payments", desc: "Payments received", perm: "billing.view" },
      { href: "/admin/payment-reviews", label: "Payment Reviews", icon: "fact_check", desc: "Bank transfers to verify", perm: "billing.view", badge: "paymentReviews" },
      { href: "/admin/quotes", label: "Quotes", icon: "request_quote", desc: "Estimates for customers", perm: "billing.view" },
      { href: "/admin/billable-items", label: "Billable Items", icon: "playlist_add", desc: "One-off charges", perm: "billing.view" },
      { href: "/admin/billing-health", label: "Billing Health", icon: "health_and_safety", desc: "Checks and mismatches", perm: "billing.view" },
      { href: "/admin/gateways", label: "Payment Gateways", icon: "account_balance", desc: "Razorpay, UPI, bank", perm: "payments.manage" },
      { href: "/admin/currencies", label: "Currencies", icon: "currency_exchange", desc: "Rates and formats", perm: "settings.manage" },
    ],
  },
  {
    key: "support", group: "Support", short: "Support", icon: "support_agent",
    items: [
      { href: "/admin/tickets", label: "Support Tickets", icon: "support_agent", desc: "Customer conversations", perm: "tickets.view", badge: "tickets" },
      { href: "/admin/knowledgebase", label: "Knowledgebase", icon: "menu_book", desc: "Help articles", perm: "content.manage" },
      { href: "/admin/announcements", label: "Announcements", icon: "campaign", desc: "News for customers", perm: "content.manage" },
    ],
  },
  {
    key: "system", group: "System", short: "System", icon: "settings",
    items: [
      { href: "/admin/settings", label: "Settings", icon: "settings", desc: "Company, tax, invoices", perm: "settings.manage" },
      { href: "/admin/staff", label: "Staff", icon: "badge", desc: "Team members", perm: "staff.manage" },
      { href: "/admin/roles", label: "Roles & Permissions", icon: "admin_panel_settings", desc: "Who can do what", perm: "staff.manage" },
      { href: "/admin/email", label: "Email Delivery", icon: "forward_to_inbox", desc: "SMTP, log, staff alerts", perm: "settings.manage" },
      { href: "/admin/email-templates", label: "Email Templates", icon: "mail", desc: "What customers receive", perm: "settings.manage" },
      { href: "/admin/whatsapp", label: "WhatsApp", icon: "chat", desc: "Messages and templates", perm: "settings.manage" },
      { href: "/admin/automation", label: "Automation", icon: "schedule", desc: "Daily billing run", perm: "reports.view" },
      { href: "/admin/backups", label: "Database Backups", icon: "backup", desc: "Schedules and restore", perm: "settings.manage" },
      { href: "/admin/broker-latency", label: "Broker Latency", icon: "network_ping", desc: "Connection health", perm: "settings.manage" },
      { href: "/admin/migration", label: "WHMCS Migration", icon: "move_up", desc: "Import from WHMCS", perm: "settings.manage" },
      { href: "/admin/security", label: "My Security", icon: "shield_lock", desc: "Password and 2FA" },
    ],
  },
];

/** Shown under "Needs you" on Home. */
const NEEDS: { badge: Badge; href: string; label: string; icon: string; perm: string; hint: string; always?: boolean }[] = [
  { badge: "orders", href: "/admin/orders", label: "Orders", icon: "shopping_bag", perm: "orders.view", hint: "Pending review", always: true },
  { badge: "overdueInvoices", href: "/admin/invoices", label: "Invoices", icon: "receipt_long", perm: "billing.view", hint: "Overdue", always: true },
  { badge: "tickets", href: "/admin/tickets", label: "Support Tickets", icon: "support_agent", perm: "tickets.view", hint: "Awaiting reply", always: true },
  { badge: "paymentReviews", href: "/admin/payment-reviews", label: "Payment Reviews", icon: "fact_check", perm: "billing.view", hint: "To verify" },
  { badge: "failedSetup", href: "/admin/provisioning", label: "Failed Setups", icon: "error", perm: "services.view", hint: "Need a retry" },
];

const BADGE_TONE: Record<Badge, string> = {
  orders: "bg-amber-100 text-amber-700",
  paymentReviews: "bg-amber-100 text-amber-700",
  tickets: "bg-rose-100 text-rose-600",
  failedSetup: "bg-rose-100 text-rose-600",
  overdueInvoices: "bg-rose-100 text-rose-600",
};
const BADGE_HINT: Record<Badge, string> = { orders: "pending", tickets: "awaiting reply", paymentReviews: "to verify", failedSetup: "failed", overdueInvoices: "overdue" };
const DEFAULT_PINS = ["/admin/clients", "/admin/services"];
const ALL_ITEMS = NAV.flatMap((g) => g.items.map((i) => ({ ...i, section: g })));

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

/** Desktop slim (section column only) mode, remembered per browser. */
export function useRail() {
  const [rail, setRail] = useState(false);
  useEffect(() => setRail(read("adm.rail", false)), []);
  const toggle = () => setRail((r) => (write("adm.rail", !r), !r));
  return { rail, toggle };
}

const fmt = (n: number) => (n > 99 ? "99+" : String(n));
const isActive = (path: string, h: string) => (h === "/admin" ? path === h : path === h || path.startsWith(h + "/"));
const sectionOf = (path: string) => NAV.find((g) => g.items.some((i) => isActive(path, i.href)))?.key ?? "home";

export function Sidebar({ rail, onToggleRail, mobile }: { rail: boolean; onToggleRail: () => void; mobile?: boolean }) {
  const { me, logout } = useSession();
  const { active: unlocked } = useReauth();
  const router = useRouter();
  const path = usePathname();
  const slim = rail && !mobile;
  const [sec, setSec] = useState(() => sectionOf(path));
  const [peek, setPeek] = useState(false);
  const [q, setQ] = useState("");
  const [counts, setCounts] = useState<Partial<Record<Badge, number>>>({});
  const [pins, setPins] = useState<string[]>(DEFAULT_PINS);
  const [menu, setMenu] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => setPins(read("adm.pins", DEFAULT_PINS)), []);
  useEffect(() => {
    setSec(sectionOf(path));
    setPeek(false);
    setMenu(false);
    setQ("");
  }, [path]);
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
  useEffect(() => {
    if (!menu) return;
    const close = (e: MouseEvent) => !menuRef.current?.contains(e.target as Node) && setMenu(false);
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [menu]);

  const allowed = (i: { perm?: string }) => !i.perm || can(me, i.perm);
  const sections = useMemo(() => NAV.map((g) => ({ ...g, items: g.items.filter(allowed) })).filter((g) => g.items.length), [me]); // eslint-disable-line react-hooks/exhaustive-deps
  const current = sections.find((g) => g.key === sec) ?? sections[0];
  const waiting = (g: Group) => g.key !== "home" && g.items.some((i) => i.badge && (counts[i.badge] ?? 0) > 0);
  const results = useMemo(() => {
    const s = q.trim().toLowerCase();
    if (!s) return [];
    return ALL_ITEMS.filter((i) => allowed(i) && (i.label.toLowerCase().includes(s) || i.desc.toLowerCase().includes(s) || i.section.group.toLowerCase().includes(s) || i.section.short.toLowerCase().includes(s)));
  }, [q, me]); // eslint-disable-line react-hooks/exhaustive-deps
  const pinned = pins.map((h) => ALL_ITEMS.find((i) => i.href === h)).filter((i): i is (typeof ALL_ITEMS)[number] => !!i && allowed(i));
  const togglePin = (h: string) => {
    const next = pins.includes(h) ? pins.filter((x) => x !== h) : [...pins, h].slice(-6);
    setPins(next);
    write("adm.pins", next);
  };
  const initials = `${me?.firstName?.[0] ?? ""}${me?.lastName?.[0] ?? ""}`.toUpperCase() || "A";
  const pickSection = (k: string) => {
    setSec(k);
    setQ("");
    if (slim) setPeek((p) => !(p && sec === k));
  };

  const row = (i: Item, opts: { sub?: string; count?: number; tone?: string; pinnable?: boolean } = {}) => {
    const on = isActive(path, i.href);
    const n = opts.count ?? (i.badge ? counts[i.badge] ?? 0 : 0);
    const locked = !unlocked && lockedArea(i.href);
    const isPinned = pins.includes(i.href);
    return (
      <div key={i.href + (opts.sub ?? "")} className="group/row relative">
        <Link
          href={i.href}
          aria-label={i.label}
          aria-current={on ? "page" : undefined}
          className={cx(
            "flex items-center gap-[11px] rounded-xl border px-2.5 py-2 transition",
            on ? "border-[#ebe3fd] bg-white text-ink shadow-[0_8px_20px_-14px_rgba(76,29,149,.45)]" : "border-transparent text-slate-700 hover:border-[#efeafb] hover:bg-white/70",
          )}
        >
          <span className={cx("grid h-[34px] w-[34px] shrink-0 place-items-center rounded-[10px] transition", on ? "bg-gradient-to-br from-[#a365fe] to-[#7c3aed] text-white shadow-[0_6px_14px_-6px_#7c3aed]" : "bg-[#f1ecfd] text-[#7c3aed] group-hover/row:bg-[#ebe3fd]")}>
            <Icon name={i.icon} className="text-[18px]" fill={on} />
          </span>
          <span className="min-w-0 flex-1 leading-tight">
            <span className={cx("block truncate text-[13.5px]", on ? "font-bold" : "font-semibold")}>{i.label}</span>
            <span className="mt-0.5 block truncate text-[11.5px] font-medium text-slate-400">{opts.sub ?? i.desc}</span>
          </span>
          {n > 0 && <span className={cx("min-w-[24px] rounded-full px-2 text-center text-[11px] font-extrabold leading-[19px]", opts.tone ?? (i.badge ? BADGE_TONE[i.badge] : "bg-slate-100 text-slate-600"))} title={i.badge ? `${n} ${BADGE_HINT[i.badge]}` : undefined}>{fmt(n)}</span>}
          {!n && locked && <span title="Asks for your password"><Icon name="lock" className="text-[14px] text-slate-400" /></span>}
        </Link>
        {opts.pinnable && (
          <button
            onClick={() => togglePin(i.href)}
            title={isPinned ? "Unpin from Home" : "Pin to Home"}
            aria-label={isPinned ? `Unpin ${i.label}` : `Pin ${i.label}`}
            className={cx(
              "absolute right-2 top-1/2 grid h-7 w-7 -translate-y-1/2 place-items-center rounded-lg bg-white text-slate-400 shadow-sm ring-1 ring-[#ece8f8] transition hover:text-[#7c3aed]",
              isPinned ? "text-[#7c3aed] opacity-0 group-hover/row:opacity-100" : "opacity-0 focus:opacity-100 group-hover/row:opacity-100",
              n > 0 && "right-11",
            )}
          >
            <Icon name="push_pin" className="text-[16px]" fill={isPinned} />
          </button>
        )}
      </div>
    );
  };

  const heading = (t: string, first?: boolean) => <div className={cx("px-2.5 pb-2 text-[10.5px] font-extrabold uppercase tracking-[.14em] text-[#a0a5bd]", !first && "mt-3 border-t border-[#eeebf8] pt-4")}>{t}</div>;

  const listPane = (
    <div className={cx("flex h-full flex-col border-r border-[#eceaf5] bg-[#faf9ff]", mobile ? "min-w-0 flex-1" : "w-[252px]")}>
      <div className="shrink-0 px-3 pb-3 pt-[18px]">
        <Link href="/admin" className="block px-2 pb-4" aria-label="Crapplet Cloud — Dashboard">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/Crapplet_logo.png" alt="Crapplet Cloud" className="h-[30px] w-auto" />
        </Link>
        <label className="flex h-10 items-center gap-2 rounded-[11px] border border-[#e9e6f5] bg-white px-3 transition focus-within:border-[#c4b5fd] focus-within:ring-2 focus-within:ring-[#ede9fe]">
          <Icon name="search" className="text-[18px] text-slate-400" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") setQ("");
              if (e.key === "Enter" && results[0]) router.push(results[0].href);
            }}
            placeholder="Find in menu…"
            className="min-w-0 flex-1 bg-transparent text-[13px] font-semibold text-ink outline-none placeholder:font-medium placeholder:text-slate-400"
          />
          {q && <button onClick={() => setQ("")} className="text-slate-400 hover:text-slate-700" aria-label="Clear"><Icon name="close" className="text-[16px]" /></button>}
        </label>
      </div>

      <nav className="min-h-0 flex-1 space-y-[3px] overflow-y-auto px-3 pb-4" style={{ scrollbarWidth: "thin", scrollbarColor: "#e4def5 transparent" }}>
        {q ? (
          <>
            {heading(`${results.length} match${results.length === 1 ? "" : "es"}`, true)}
            {results.map((i) => row(i, { sub: `${i.section.short} · ${i.desc}` }))}
            {!results.length && <div className="px-3 py-8 text-center text-[12.5px] text-slate-400">Nothing in the menu matches “{q}”.</div>}
          </>
        ) : current ? (
          <>
            <div className="px-2.5 pb-2.5 text-[11px] font-extrabold uppercase tracking-[.14em] text-[#7c3aed]">{current.group}</div>
            {current.items.map((i) => row(i, { pinnable: current.key !== "home" }))}
            {current.key === "home" && (
              <>
                {(() => {
                  const needs = NEEDS.filter((n) => can(me, n.perm) && (n.always || (counts[n.badge] ?? 0) > 0));
                  return needs.length ? (
                    <>
                      {heading("Needs you")}
                      {needs.map((n) => row({ href: n.href, label: n.label, icon: n.icon, desc: n.hint, badge: n.badge }, { sub: (counts[n.badge] ?? 0) > 0 ? n.hint : "All clear" }))}
                    </>
                  ) : null;
                })()}
                {heading("Pinned")}
                {pinned.map((i) => row(i, { pinnable: true }))}
                {!pinned.length && <div className="px-2.5 pb-2 text-[12px] leading-snug text-slate-400">Pin pages you use a lot — hover a page in any section and click the pin.</div>}
              </>
            )}
          </>
        ) : null}
      </nav>

      <div className="shrink-0 p-3 [@media(max-height:760px)]:hidden">
        <div className="rounded-[14px] border border-[#e6dcff] bg-gradient-to-br from-[#f5f0ff] to-[#eef4ff] p-3 text-[12px] leading-snug text-slate-600">
          <b className="mb-0.5 block text-[13px] text-ink">Need a hand?</b>
          Press <kbd className="rounded border border-[#ddd3fb] bg-white px-1 text-[11px] font-bold text-ink">Ctrl K</kbd> to find any client, service or invoice.
        </div>
      </div>
    </div>
  );

  return (
    <div className="relative flex h-full bg-white">
      {/* section column */}
      <div className="flex h-full w-[92px] shrink-0 flex-col items-center gap-1 border-r border-[#eceaf5] bg-white pb-3.5 pt-4">
        <Link href="/admin" className="mb-3.5 grid h-[50px] w-[50px] shrink-0 place-items-center rounded-[15px] bg-gradient-to-br from-[#f3edff] to-[#e9e1ff] ring-1 ring-inset ring-[#e4d8ff]" aria-label="Dashboard">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/Crapplet_Icon.png" alt="" className="h-[34px] w-[34px]" />
        </Link>
        <div className="flex min-h-0 w-full flex-1 flex-col items-center gap-1 overflow-y-auto" style={{ scrollbarWidth: "none" }}>
          {sections.map((g) => {
            const on = (slim ? peek && sec === g.key : sec === g.key) || (slim && !peek && sectionOf(path) === g.key);
            return (
              <button
                key={g.key}
                onClick={() => pickSection(g.key)}
                aria-label={g.short}
                aria-pressed={on}
                className={cx(
                  "relative flex w-[78px] shrink-0 flex-col items-center gap-[5px] rounded-[14px] pb-2 pt-2.5 text-[11px] font-bold transition",
                  on ? "bg-gradient-to-br from-[#a365fe] to-[#7c3aed] text-white shadow-[0_10px_22px_-10px_#7c3aed]" : "text-[#7a7f99] hover:bg-[#f5f2fd] hover:text-[#5b21b6]",
                )}
              >
                <Icon name={g.icon} className="text-[22px]" fill={on} />
                {g.short}
                {waiting(g) && <span className={cx("absolute right-4 top-[7px] h-[9px] w-[9px] rounded-full bg-rose-500 ring-2", on ? "ring-[#8b4cf6]" : "ring-white")} />}
              </button>
            );
          })}
        </div>
        <div className="mt-2 flex shrink-0 flex-col items-center gap-2.5">
          {!mobile && (
            <button onClick={() => { setPeek(false); onToggleRail(); }} title={slim ? "Show page list" : "Hide page list"} aria-label={slim ? "Show page list" : "Hide page list"} className="grid h-9 w-9 place-items-center rounded-lg text-[#9aa0b8] transition hover:bg-[#f5f2fd] hover:text-[#5b21b6]">
              <Icon name={slim ? "left_panel_open" : "left_panel_close"} className="text-[20px]" />
            </button>
          )}
          <div ref={menuRef} className="relative">
            <button onClick={() => setMenu((m) => !m)} title={`${me?.firstName ?? ""} ${me?.lastName ?? ""}`.trim()} aria-label="Account menu" aria-expanded={menu} className="relative grid h-10 w-10 place-items-center rounded-xl bg-gradient-to-br from-[#a365fe] to-[#6d28d9] text-[13px] font-extrabold text-white">
              {initials}
              <span className="absolute -bottom-0.5 -right-0.5 h-[11px] w-[11px] rounded-full bg-emerald-500 ring-2 ring-white" />
            </button>
            {menu && (
              <div className="fixed bottom-4 left-[100px] z-[80] w-[230px] rounded-2xl border border-[#eceaf5] bg-white p-2 shadow-[0_24px_48px_-16px_rgba(46,16,101,.35)]">
                <div className="px-2.5 pb-2 pt-1.5">
                  <div className="truncate text-[13.5px] font-extrabold text-ink">{me?.firstName} {me?.lastName}</div>
                  <div className="truncate text-[12px] font-semibold text-slate-400">{me?.role?.name ?? "Staff"}</div>
                </div>
                <div className="border-t border-[#f1eff8] pt-1">
                  <Link href="/admin/security" className="flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-[13px] font-semibold text-slate-700 hover:bg-[#f5f2fd]"><Icon name="shield_lock" className="text-[18px] text-[#7c3aed]" />My Security</Link>
                  <button onClick={async () => { await logout(); router.replace("/admin/login"); }} className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-[13px] font-semibold text-slate-700 hover:bg-rose-50 hover:text-rose-600"><Icon name="logout" className="text-[18px]" />Sign out</button>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* list pane — beside the column, or a flyout when collapsed */}
      {!slim && listPane}
      {slim && peek && (
        <>
          <div className="fixed inset-0 z-[55]" onClick={() => setPeek(false)} />
          <div className="fixed inset-y-0 left-[92px] z-[60] shadow-[24px_0_48px_-24px_rgba(46,16,101,.35)]">{listPane}</div>
        </>
      )}
    </div>
  );
}
