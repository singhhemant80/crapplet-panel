"use client";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { can, useSession } from "@/lib/session";
import { Icon, Loading, cx } from "@/components/ui";

type Item = { href: string; label: string; icon: string; perm?: string };
const NAV: { group: string; items: Item[] }[] = [
  { group: "Overview", items: [{ href: "/admin", label: "Dashboard", icon: "space_dashboard" }] },
  {
    group: "Customers",
    items: [
      { href: "/admin/clients", label: "Customers", icon: "group", perm: "clients.view" },
      { href: "/admin/orders", label: "Orders", icon: "shopping_bag", perm: "orders.view" },
      { href: "/admin/resellers", label: "Resellers", icon: "storefront", perm: "resellers.manage" },
      { href: "/admin/affiliates", label: "Affiliates", icon: "handshake", perm: "clients.view" },
    ],
  },
  {
    group: "Catalogue",
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
    items: [
      { href: "/admin/servers", label: "Servers", icon: "dns", perm: "servers.manage" },
      { href: "/admin/proxmox", label: "Proxmox", icon: "hub", perm: "servers.manage" },
      { href: "/admin/monitoring", label: "Node Monitoring", icon: "monitor_heart", perm: "servers.manage" },
      { href: "/admin/virtualizor", label: "Virtualizor", icon: "lan", perm: "servers.manage" },
      { href: "/admin/ips", label: "IP Management", icon: "router", perm: "ips.view" },
      { href: "/admin/services", label: "VPS & Services", icon: "developer_board", perm: "services.view" },
      { href: "/admin/locations", label: "Locations", icon: "location_on", perm: "servers.manage" },
      { href: "/admin/domains", label: "Domains", icon: "language", perm: "domains.manage" },
    ],
  },
  {
    group: "Billing",
    items: [
      { href: "/admin/invoices", label: "Invoices", icon: "receipt_long", perm: "billing.view" },
      { href: "/admin/transactions", label: "Transactions", icon: "payments", perm: "billing.view" },
      { href: "/admin/payment-reviews", label: "Payment Reviews", icon: "fact_check", perm: "billing.view" },
      { href: "/admin/gateways", label: "Payment Gateways", icon: "account_balance", perm: "payments.manage" },
      { href: "/admin/currencies", label: "Currencies", icon: "currency_exchange", perm: "settings.manage" },
      { href: "/admin/reports", label: "Reports", icon: "monitoring", perm: "reports.view" },
    ],
  },
  {
    group: "Support",
    items: [
      { href: "/admin/tickets", label: "Support Tickets", icon: "support_agent", perm: "tickets.view" },
      { href: "/admin/knowledgebase", label: "Knowledgebase", icon: "menu_book", perm: "content.manage" },
      { href: "/admin/announcements", label: "Announcements", icon: "campaign", perm: "content.manage" },
    ],
  },
  {
    group: "Setup",
    items: [
      { href: "/admin/staff", label: "Staff", icon: "badge", perm: "staff.manage" },
      { href: "/admin/roles", label: "Roles & Permissions", icon: "admin_panel_settings", perm: "staff.manage" },
      { href: "/admin/email-templates", label: "Email Templates", icon: "mail", perm: "settings.manage" },
      { href: "/admin/settings", label: "Settings", icon: "settings", perm: "settings.manage" },
      { href: "/admin/migration", label: "WHMCS Migration", icon: "move_up", perm: "settings.manage" },
      { href: "/admin/activity", label: "Activity Log", icon: "history", perm: "reports.view" },
      { href: "/admin/security", label: "My Security", icon: "shield_lock" },
    ],
  },
];

export default function PanelLayout({ children }: { children: React.ReactNode }) {
  const { me, loading, logout } = useSession();
  const router = useRouter();
  const path = usePathname();
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!loading && (!me || me.type !== "STAFF")) router.replace(`/admin/login?next=${encodeURIComponent(path)}`);
  }, [loading, me, path, router]);
  useEffect(() => setOpen(false), [path]);
  if (loading || !me || me.type !== "STAFF") return <Loading />;

  const active = (h: string) => (h === "/admin" ? path === h : path === h || path.startsWith(h + "/"));
  const nav = (
    <nav className="flex-1 space-y-5 overflow-y-auto px-3 pb-6">
      {NAV.map((g) => {
        const items = g.items.filter((i) => !i.perm || can(me, i.perm));
        if (!items.length) return null;
        return (
          <div key={g.group}>
            <div className="px-3 pb-1.5 text-[10.5px] font-extrabold uppercase tracking-[.16em] text-violet-300/60">{g.group}</div>
            {items.map((i) => (
              <Link key={i.href} href={i.href} className={cx("flex items-center gap-3 rounded-xl px-3 py-2 text-[13.5px] font-semibold transition", active(i.href) ? "bg-white/10 text-white shadow-[inset_3px_0_0_#a365fe]" : "text-violet-100/75 hover:bg-white/5 hover:text-white")}>
                <Icon name={i.icon} className="text-[19px]" fill={active(i.href)} />
                {i.label}
              </Link>
            ))}
          </div>
        );
      })}
    </nav>
  );
  return (
    <div className="min-h-screen bg-[#f6f4fb] lg:grid lg:grid-cols-[256px_1fr]">
      <aside className={cx("fixed inset-y-0 left-0 z-50 flex w-[256px] flex-col bg-[#1a0d3b] bg-[linear-gradient(180deg,#1f0f4a_0%,#140a2e_100%)] transition-transform lg:sticky lg:top-0 lg:h-screen lg:translate-x-0", open ? "translate-x-0" : "-translate-x-full")}>
        <div className="flex h-16 items-center gap-2 px-5">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/Crapplet_logo.png" alt="Crapplet" className="h-8 brightness-0 invert" />
          <span className="ml-auto rounded-md bg-primary/30 px-1.5 py-0.5 text-[10px] font-extrabold uppercase tracking-wider text-violet-100">Admin</span>
        </div>
        {nav}
      </aside>
      {open && <div className="fixed inset-0 z-40 bg-black/40 lg:hidden" onClick={() => setOpen(false)} />}
      <div className="min-w-0">
        <header className="sticky top-0 z-30 flex h-16 items-center gap-3 border-b border-line bg-white/85 px-4 backdrop-blur sm:px-6">
          <button className="grid h-10 w-10 place-items-center rounded-xl border border-line lg:hidden" onClick={() => setOpen(true)} aria-label="Menu"><Icon name="menu" /></button>
          <form className="hidden max-w-md flex-1 sm:block" onSubmit={(e) => { e.preventDefault(); const q = new FormData(e.currentTarget).get("q"); if (q) router.push(`/admin/clients?q=${encodeURIComponent(String(q))}`); }}>
            <label className="flex h-10 items-center gap-2 rounded-xl border border-line bg-white px-3 text-sm focus-within:border-primary">
              <Icon name="search" className="text-mute" /><input name="q" className="flex-1 bg-transparent outline-none" placeholder="Search customers by name, email, GSTIN…" />
            </label>
          </form>
          <div className="ml-auto flex items-center gap-3">
            <a href="/" target="_blank" className="hidden text-sm font-bold text-mute hover:text-primary-dark md:inline">View website ↗</a>
            <div className="text-right">
              <div className="text-sm font-extrabold text-ink">{me.firstName} {me.lastName}</div>
              <div className="text-[11px] font-semibold text-mute">{me.role?.name}</div>
            </div>
            <button onClick={async () => { await logout(); router.replace("/admin/login"); }} className="grid h-10 w-10 place-items-center rounded-xl border border-line text-slate-500 hover:text-rose-600" title="Sign out"><Icon name="logout" /></button>
          </div>
        </header>
        <main className="mx-auto max-w-[1440px] p-4 sm:p-6 lg:p-8 fade-up">{children}</main>
      </div>
    </div>
  );
}
