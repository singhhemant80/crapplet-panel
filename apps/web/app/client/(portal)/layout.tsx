"use client";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { useSession } from "@/lib/session";
import { api, money } from "@/lib/api";
import { readCart } from "@/lib/cart";
import { Alert, Button, Icon, Loading, cx, toast } from "@/components/ui";

type Shell = { unpaidInvoices: number; overdueInvoices: number; outstanding: number; ticketsAwaitingReply: number; services: number; creditBalance: number; currency: string };
type NavItem = { href: string; label: string; icon: string; exact?: boolean; badge?: (s: Shell) => number | string | null; tone?: "rose" | "amber" | "violet" };

const SECTIONS: { title: string; items: NavItem[] }[] = [
  { title: "Overview", items: [{ href: "/client", label: "Dashboard", icon: "space_dashboard", exact: true }] },
  {
    title: "Services",
    items: [
      { href: "/client/services", label: "My services", icon: "dns", badge: (s) => s.services || null, tone: "violet" },
      { href: "/client/domains", label: "Domains", icon: "language" },
      { href: "/order", label: "Order new service", icon: "add_shopping_cart" },
    ],
  },
  {
    title: "Billing",
    items: [
      { href: "/client/invoices", label: "Invoices", icon: "receipt_long", badge: (s) => s.unpaidInvoices || null, tone: "rose" },
      { href: "/client/payments", label: "Payments", icon: "payments" },
      { href: "/client/wallet", label: "Wallet & credit", icon: "account_balance_wallet" },
    ],
  },
  {
    title: "Support",
    items: [
      { href: "/client/tickets", label: "Support tickets", icon: "support_agent", badge: (s) => s.ticketsAwaitingReply || null, tone: "amber" },
      { href: "/client/knowledgebase", label: "Knowledgebase", icon: "menu_book" },
      { href: "/client/downloads", label: "Downloads", icon: "download" },
    ],
  },
  {
    title: "Account",
    items: [
      { href: "/client/profile", label: "Profile & billing", icon: "person" },
      { href: "/client/security", label: "Security", icon: "shield_lock" },
      { href: "/client/affiliates", label: "Affiliates", icon: "handshake" },
      { href: "/client/reseller", label: "VPS reseller", icon: "storefront" },
    ],
  },
];
const ALL = SECTIONS.flatMap((s) => s.items);

export default function PortalLayout({ children }: { children: React.ReactNode }) {
  const { me, loading, logout } = useSession();
  const router = useRouter();
  const path = usePathname();
  const [drawer, setDrawer] = useState(false);
  const [shell, setShell] = useState<Shell | null>(null);
  const [cart, setCart] = useState(0);

  useEffect(() => {
    if (!loading && (!me || me.type !== "CLIENT")) router.replace(`/client/login?next=${encodeURIComponent(path)}`);
  }, [loading, me, path, router]);
  useEffect(() => setDrawer(false), [path]);

  const loadShell = useCallback(() => {
    api<Shell>("/client/shell").then(setShell).catch(() => {});
  }, []);
  useEffect(() => {
    if (!me || me.type !== "CLIENT") return;
    loadShell();
    const t = setInterval(loadShell, 60_000);
    return () => clearInterval(t);
  }, [me, path, loadShell]);
  useEffect(() => {
    const count = () => {
      const c = readCart();
      setCart(c.items.length + c.domains.length);
    };
    count();
    window.addEventListener("cc-cart", count);
    window.addEventListener("storage", count);
    return () => {
      window.removeEventListener("cc-cart", count);
      window.removeEventListener("storage", count);
    };
  }, []);

  if (loading || !me || me.type !== "CLIENT") return <Loading />;

  const active = (n: NavItem) => (n.exact ? path === n.href : path === n.href || path.startsWith(n.href + "/"));
  const current = ALL.find((n) => active(n));
  const cur = shell?.currency ?? me.profile?.currency ?? "INR";
  const initials = `${me.firstName?.[0] ?? ""}${me.lastName?.[0] ?? ""}`.toUpperCase() || me.email[0].toUpperCase();
  const signOut = async () => {
    await logout();
    router.replace("/client/login");
  };

  const sidebar = (
    <div className="flex h-full flex-col">
      <div className="flex h-16 shrink-0 items-center justify-between px-5">
        <Link href="/client" className="flex items-center">
          <img src="/Crapplet_logo.png" alt="Crapplet Cloud" className="h-8 brightness-0 invert" />
        </Link>
        <button className="grid h-9 w-9 place-items-center rounded-lg text-white/70 hover:bg-white/10 lg:hidden" onClick={() => setDrawer(false)} aria-label="Close menu">
          <Icon name="close" />
        </button>
      </div>
      <nav className="flex-1 space-y-4 overflow-y-auto px-3 pb-3 pt-1 [scrollbar-width:thin]">
        {SECTIONS.map((sec) => (
          <div key={sec.title}>
            <div className="mb-1 px-3 text-[10.5px] font-bold uppercase tracking-[0.14em] text-white/40">{sec.title}</div>
            <div className="space-y-0.5">
              {sec.items.map((n) => {
                const on = active(n);
                const b = shell && n.badge ? n.badge(shell) : null;
                return (
                  <Link
                    key={n.href}
                    href={n.href}
                    className={cx(
                      "group relative flex items-center gap-3 rounded-xl px-3 py-2 text-[13.5px] font-semibold transition",
                      on ? "bg-white/[0.12] text-white shadow-[inset_0_0_0_1px_rgba(255,255,255,.06)]" : "text-white/65 hover:bg-white/[0.06] hover:text-white",
                    )}
                  >
                    {on && <span className="absolute -left-3 top-2 h-[calc(100%-16px)] w-1 rounded-r-full bg-gradient-to-b from-fuchsia-400 to-violet-400" />}
                    <Icon name={n.icon} className={cx("text-[20px]", on ? "text-fuchsia-300" : "text-white/50 group-hover:text-white/80")} fill={on} />
                    <span className="flex-1 truncate">{n.label}</span>
                    {b ? <span className={cx("min-w-[20px] rounded-full px-1.5 py-px text-center text-[11px] font-bold", n.tone === "rose" ? "bg-rose-500 text-white" : n.tone === "amber" ? "bg-amber-400 text-amber-950" : "bg-white/15 text-white")}>{b}</span> : null}
                  </Link>
                );
              })}
            </div>
          </div>
        ))}
      </nav>
      <div className="shrink-0 border-t border-white/10 p-3">
        <div className="flex items-center gap-3 rounded-2xl bg-gradient-to-br from-white/[0.12] to-white/[0.04] p-3 ring-1 ring-white/10">
          <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-white/10 text-fuchsia-200"><Icon name="account_balance_wallet" className="text-[19px]" /></span>
          <div className="min-w-0 flex-1">
            <div className="text-[10.5px] font-bold uppercase tracking-wider text-white/50">Account credit</div>
            <div className="truncate text-[15px] font-extrabold text-white">{shell ? money(shell.creditBalance, cur) : "…"}</div>
          </div>
          <Link href="/client/wallet" className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-white text-primary-dark hover:bg-fuchsia-50" aria-label="Add funds" title="Add funds">
            <Icon name="add" className="text-[18px]" />
          </Link>
        </div>
        <Link href="/client/tickets/new" className="mt-2 flex items-center gap-3 rounded-xl px-3 py-1.5 text-[13px] font-semibold text-white/70 hover:bg-white/[0.06] hover:text-white">
          <span className="grid h-7 w-7 place-items-center rounded-lg bg-emerald-400/15 text-emerald-300"><Icon name="headset_mic" className="text-[17px]" /></span>
          <span className="leading-tight">24/7 support · <span className="font-medium text-white/50">open a ticket</span></span>
        </Link>
      </div>
    </div>
  );

  return (
    <div className="min-h-screen bg-[#f5f3fb]">
      {/* desktop sidebar */}
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-[264px] bg-[radial-gradient(120%_60%_at_0%_0%,#3b1786_0%,#1d0b45_45%,#130730_100%)] lg:block">{sidebar}</aside>
      {/* mobile drawer */}
      <div className={cx("fixed inset-0 z-50 lg:hidden", drawer ? "" : "pointer-events-none")}>
        <div className={cx("absolute inset-0 bg-slate-950/50 backdrop-blur-sm transition", drawer ? "opacity-100" : "opacity-0")} onClick={() => setDrawer(false)} />
        <aside className={cx("absolute inset-y-0 left-0 w-[280px] max-w-[85vw] bg-[radial-gradient(120%_60%_at_0%_0%,#3b1786_0%,#1d0b45_45%,#130730_100%)] shadow-2xl transition-transform", drawer ? "translate-x-0" : "-translate-x-full")}>{sidebar}</aside>
      </div>

      <div className="lg:pl-[264px]">
        <header className="sticky top-0 z-20 border-b border-[#ece7f7] bg-white/85 backdrop-blur-xl">
          <div className="flex h-16 items-center gap-3 px-4 sm:px-6 lg:px-8">
            <button className="grid h-10 w-10 place-items-center rounded-xl border border-line text-slate-600 lg:hidden" onClick={() => setDrawer(true)} aria-label="Open menu">
              <Icon name="menu" />
            </button>
            <div className="min-w-0 flex-1">
              <div className="hidden text-[11px] font-semibold uppercase tracking-wider text-mute sm:block">Client area</div>
              <div className="truncate text-[15px] font-extrabold text-ink">{current?.label ?? "Client area"}</div>
            </div>
            <Link href="/order" className="hidden h-10 items-center gap-2 rounded-xl bg-gradient-to-r from-primary to-primary-dark px-4 text-[13px] font-bold text-white shadow-glow transition hover:-translate-y-px sm:inline-flex">
              <Icon name="rocket_launch" className="text-[18px]" /> Order new
            </Link>
            <Link href="/order/cart" className="relative grid h-10 w-10 place-items-center rounded-xl border border-line text-slate-600 hover:border-[#dccafb] hover:text-primary-dark" aria-label="Cart">
              <Icon name="shopping_cart" className="text-[21px]" />
              {cart > 0 && <span className="absolute -right-1 -top-1 grid h-5 min-w-[20px] place-items-center rounded-full bg-primary px-1 text-[11px] font-bold text-white ring-2 ring-white">{cart}</span>}
            </Link>
            <Notifications shell={shell} cur={cur} />
            <UserMenu me={me} initials={initials} onLogout={signOut} />
          </div>
        </header>

        <main className="overflow-x-clip px-4 py-6 sm:px-6 lg:px-8 lg:py-8">
          <div className="mx-auto max-w-[1360px] fade-up">
            {me.impersonatedBy && (
              <div className="mb-5 flex flex-wrap items-center justify-between gap-3 rounded-2xl bg-amber-50 px-4 py-3 text-sm text-amber-900 ring-1 ring-amber-200">
                <span className="flex items-center gap-2"><Icon name="admin_panel_settings" className="shrink-0 text-[20px]" /><span>You're signed in as <b>{me.firstName} {me.lastName}</b> ({me.email}) by {me.impersonatedBy.name}. Everything you do is recorded as staff.</span></span>
                <button
                  type="button"
                  className="rounded-lg bg-amber-600 px-3 py-1.5 text-xs font-bold text-white hover:bg-amber-700"
                  onClick={async () => {
                    try {
                      const r = await api<{ redirect: string }>("/auth/impersonate/end", { body: {} });
                      window.location.href = r.redirect;
                    } catch (e: any) {
                      toast.error(e.message);
                    }
                  }}
                >
                  Back to admin
                </button>
              </div>
            )}
            {!me.emailVerified && (
              <Alert tone="warn" className="mb-5">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span>Please verify your email address — we sent a link to {me.email}.</span>
                  <Button size="sm" variant="outline" onClick={() => api("/auth/resend-verification", { body: {} }).then(() => toast.success("Verification email sent")).catch((e) => toast.error(e.message))}>
                    Resend
                  </Button>
                </div>
              </Alert>
            )}
            {children}
          </div>
        </main>
        <footer className="px-4 pb-8 text-center text-xs text-mute sm:px-6 lg:px-8">
          © {new Date().getFullYear()} Crapplet Infotech · <Link href="/" className="hover:text-primary-dark">Website</Link> · <Link href="/client/knowledgebase" className="hover:text-primary-dark">Help</Link>
        </footer>
      </div>
    </div>
  );
}

function useOutside(open: boolean, close: () => void) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const h = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && close();
    const k = (e: KeyboardEvent) => e.key === "Escape" && close();
    document.addEventListener("mousedown", h);
    document.addEventListener("keydown", k);
    return () => {
      document.removeEventListener("mousedown", h);
      document.removeEventListener("keydown", k);
    };
  }, [open, close]);
  return ref;
}

function Notifications({ shell, cur }: { shell: Shell | null; cur: string }) {
  const [open, setOpen] = useState(false);
  const path = usePathname();
  useEffect(() => setOpen(false), [path]);
  const ref = useOutside(open, () => setOpen(false));
  const items: { icon: string; tone: string; title: string; text: string; href: string }[] = [];
  if (shell?.overdueInvoices) items.push({ icon: "warning", tone: "bg-rose-50 text-rose-600", title: `${shell.overdueInvoices} overdue invoice${shell.overdueInvoices > 1 ? "s" : ""}`, text: "Pay now to avoid suspension", href: "/client/invoices?status=UNPAID" });
  else if (shell?.unpaidInvoices) items.push({ icon: "receipt_long", tone: "bg-violet-50 text-primary-dark", title: `${shell.unpaidInvoices} unpaid invoice${shell.unpaidInvoices > 1 ? "s" : ""}`, text: `${money(shell.outstanding, cur)} due`, href: "/client/invoices?status=UNPAID" });
  if (shell?.ticketsAwaitingReply) items.push({ icon: "forum", tone: "bg-amber-50 text-amber-700", title: `${shell.ticketsAwaitingReply} ticket${shell.ticketsAwaitingReply > 1 ? "s" : ""} answered`, text: "Our team replied — take a look", href: "/client/tickets" });
  return (
    <div ref={ref} className="relative">
      <button className="relative grid h-10 w-10 place-items-center rounded-xl border border-line text-slate-600 hover:border-[#dccafb] hover:text-primary-dark" onClick={() => setOpen(!open)} aria-label="Notifications">
        <Icon name="notifications" className="text-[21px]" />
        {items.length > 0 && <span className="absolute right-2 top-2 h-2.5 w-2.5 rounded-full bg-rose-500 ring-2 ring-white" />}
      </button>
      {open && (
        <div className="absolute right-0 top-12 w-[320px] max-w-[calc(100vw-32px)] overflow-hidden rounded-2xl border border-line bg-white shadow-2xl">
          <div className="border-b border-line px-4 py-3 text-sm font-extrabold text-ink">Notifications</div>
          {items.length ? (
            items.map((n) => (
              <Link key={n.title} href={n.href} className="flex items-start gap-3 px-4 py-3 hover:bg-primary-tint">
                <span className={cx("grid h-9 w-9 shrink-0 place-items-center rounded-xl", n.tone)}><Icon name={n.icon} className="text-[19px]" /></span>
                <span className="min-w-0"><span className="block text-[13px] font-bold text-ink">{n.title}</span><span className="block text-xs text-mute">{n.text}</span></span>
              </Link>
            ))
          ) : (
            <div className="flex flex-col items-center gap-1 px-4 py-8 text-center text-sm text-mute"><Icon name="notifications_off" className="text-[28px] text-slate-300" />You're all caught up</div>
          )}
        </div>
      )}
    </div>
  );
}

function UserMenu({ me, initials, onLogout }: { me: any; initials: string; onLogout: () => void }) {
  const [open, setOpen] = useState(false);
  const path = usePathname();
  useEffect(() => setOpen(false), [path]);
  const ref = useOutside(open, () => setOpen(false));
  return (
    <div ref={ref} className="relative">
      <button className="flex items-center gap-2.5 rounded-xl py-1 pl-1 pr-2 hover:bg-primary-tint" onClick={() => setOpen(!open)}>
        <span className="grid h-9 w-9 place-items-center rounded-xl bg-gradient-to-br from-primary to-primary-dark text-[13px] font-extrabold text-white">{initials}</span>
        <span className="hidden text-left leading-tight md:block">
          <span className="block max-w-[150px] truncate text-[13px] font-bold text-ink">{me.firstName} {me.lastName}</span>
          <span className="block max-w-[150px] truncate text-[11px] text-mute">{me.profile?.companyName || "Client"}</span>
        </span>
        <Icon name="expand_more" className="hidden text-[18px] text-mute md:block" />
      </button>
      {open && (
        <div className="absolute right-0 top-12 w-64 overflow-hidden rounded-2xl border border-line bg-white shadow-2xl">
          <div className="border-b border-line px-4 py-3">
            <div className="truncate text-sm font-extrabold text-ink">{me.firstName} {me.lastName}</div>
            <div className="truncate text-xs text-mute">{me.email}</div>
            <div className="mt-1 text-[11px] font-semibold text-mute">Client #{String(me.id).slice(-6).toUpperCase()}</div>
          </div>
          <div className="p-1.5">
            {[
              ["/client/profile", "person", "Profile & billing"],
              ["/client/security", "shield_lock", "Security & 2FA"],
              ["/client/wallet", "account_balance_wallet", "Wallet"],
              ["/client/affiliates", "handshake", "Refer & earn"],
              ["/", "public", "Visit website"],
            ].map(([href, icon, label]) => (
              <Link key={href} href={href} className="flex items-center gap-2.5 rounded-lg px-3 py-2 text-[13px] font-semibold text-slate-700 hover:bg-primary-tint hover:text-primary-dark">
                <Icon name={icon} className="text-[18px] text-mute" />
                {label}
              </Link>
            ))}
            <button onClick={onLogout} className="mt-1 flex w-full items-center gap-2.5 rounded-lg border-t border-line px-3 py-2 text-left text-[13px] font-semibold text-rose-600 hover:bg-rose-50">
              <Icon name="logout" className="text-[18px]" /> Sign out
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
