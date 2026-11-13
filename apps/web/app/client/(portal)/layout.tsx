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
      { href: "/client/quotes", label: "Quotes", icon: "request_quote" },
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
    <div className="relative flex h-full flex-col overflow-hidden bg-[#0b0f2a] text-slate-300">
      {/* light from the logo's colours — same look as the admin console */}
      <div className="pointer-events-none absolute -left-20 -top-24 h-72 w-72 rounded-full bg-sky-500/20 blur-3xl" />
      <div className="pointer-events-none absolute -bottom-24 -right-16 h-72 w-72 rounded-full bg-violet-600/25 blur-3xl" />
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(rgba(255,255,255,.045)_1px,transparent_1px)] [background-size:18px_18px] [mask-image:linear-gradient(180deg,#000,transparent_45%)]" />

      {/* brand — the full logo, unaltered, on a white plate */}
      <div className="relative shrink-0 px-4 pb-3 pt-4">
        <div className="flex items-center gap-2">
          <Link href="/client" className="flex h-[66px] min-w-0 flex-1 items-center justify-center rounded-2xl bg-white px-4 shadow-[0_10px_28px_-10px_rgba(56,189,248,.6)] ring-1 ring-white/50" aria-label="Crapplet Cloud — Dashboard">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/Crapplet_logo.png" alt="Crapplet Cloud" className="h-auto w-full max-w-[200px]" />
          </Link>
          <button className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-white/10 text-white lg:hidden" onClick={() => setDrawer(false)} aria-label="Close menu">
            <Icon name="close" className="text-[18px]" />
          </button>
        </div>
        <div className="mt-2.5 flex items-center justify-center gap-1.5 text-[10.5px] font-bold uppercase tracking-[.18em] text-slate-400">
          <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 shadow-[0_0_8px_#34d399]" />
          Client area
        </div>
      </div>

      <nav className="relative flex-1 overflow-y-auto overflow-x-hidden px-3 pb-3" style={{ scrollbarWidth: "thin", scrollbarColor: "rgba(255,255,255,.12) transparent" }}>
        {SECTIONS.map((sec, si) => (
          <div key={sec.title} className={si ? "mt-1" : ""}>
            {sec.title !== "Overview" && (
              <div className="flex items-center gap-2 px-3 pb-1.5 pt-3">
                <span className={cx("text-[10.5px] font-extrabold uppercase tracking-[.16em]", sec.items.some(active) ? "text-sky-300/90" : "text-slate-500")}>{sec.title}</span>
                <span className="h-px flex-1 bg-white/[.06]" />
              </div>
            )}
            <div className="space-y-0.5">
              {sec.items.map((n) => {
                const on = active(n);
                const b = shell && n.badge ? n.badge(shell) : null;
                return (
                  <Link
                    key={n.href}
                    href={n.href}
                    className={cx(
                      "group relative flex items-center gap-3 rounded-xl px-2 py-1.5 text-[13.5px] font-semibold transition",
                      on ? "bg-white/[.08] text-white ring-1 ring-white/10" : "text-slate-300/85 hover:bg-white/[.05] hover:text-white",
                    )}
                  >
                    {on && <span className="absolute -left-3 top-1/2 h-6 w-1 -translate-y-1/2 rounded-r-full bg-gradient-to-b from-sky-400 to-violet-500 shadow-[0_0_12px_rgba(99,102,241,.8)]" />}
                    <span className={cx("grid h-8 w-8 shrink-0 place-items-center rounded-[10px] transition", on ? "bg-gradient-to-br from-sky-400 via-indigo-500 to-violet-600 text-white shadow-[0_6px_16px_-4px_rgba(99,102,241,.75)]" : "bg-white/[.04] text-slate-400 group-hover:bg-white/10 group-hover:text-white")}>
                      <Icon name={n.icon} className="text-[18px]" fill={on} />
                    </span>
                    <span className="min-w-0 flex-1 truncate">{n.label}</span>
                    {b ? <span className={cx("min-w-[22px] rounded-full px-1.5 text-center text-[11px] font-extrabold leading-5", n.tone === "rose" ? "bg-rose-500 text-white" : n.tone === "amber" ? "bg-amber-400 text-amber-950" : "bg-white/15 text-white")}>{b}</span> : null}
                  </Link>
                );
              })}
            </div>
          </div>
        ))}
      </nav>

      <div className="relative shrink-0 border-t border-white/[.07] p-3">
        <div className="rounded-2xl bg-white/[.05] p-2.5 ring-1 ring-white/10">
          <div className="flex items-center gap-2.5">
            <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-gradient-to-br from-sky-400 to-violet-600 text-white"><Icon name="account_balance_wallet" className="text-[19px]" /></span>
            <div className="min-w-0 flex-1 leading-tight">
              <div className="text-[10.5px] font-bold uppercase tracking-wider text-slate-400">Account credit</div>
              <div className="truncate text-[15px] font-extrabold text-white">{shell ? money(shell.creditBalance, cur) : "…"}</div>
            </div>
            <Link href="/client/wallet" className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-white text-indigo-600 hover:bg-sky-50" aria-label="Add funds" title="Add funds">
              <Icon name="add" className="text-[18px]" />
            </Link>
          </div>
          <div className="mt-2.5 flex gap-1 border-t border-white/[.07] pt-2">
            <Link href="/client/tickets/new" title="24/7 support — open a ticket" className="flex h-8 flex-1 items-center justify-center gap-1.5 rounded-lg text-[12px] font-bold text-emerald-300 hover:bg-white/10"><Icon name="headset_mic" className="text-[17px]" />Support</Link>
            <Link href="/client/security" title="Security" aria-label="Security" className="grid h-8 w-9 place-items-center rounded-lg text-slate-400 hover:bg-white/10 hover:text-white"><Icon name="shield_lock" className="text-[18px]" /></Link>
            <button onClick={signOut} title="Sign out" aria-label="Sign out" className="grid h-8 w-9 place-items-center rounded-lg text-slate-400 hover:bg-white/10 hover:text-rose-300"><Icon name="logout" className="text-[18px]" /></button>
          </div>
        </div>
      </div>
    </div>
  );

  return (
    <div className="min-h-screen bg-[#f5f3fb]">
      {/* desktop sidebar */}
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-[272px] lg:block">{sidebar}</aside>
      {/* mobile drawer */}
      <div className={cx("fixed inset-0 z-50 lg:hidden", drawer ? "" : "pointer-events-none")}>
        <div className={cx("absolute inset-0 bg-slate-950/50 backdrop-blur-sm transition", drawer ? "opacity-100" : "opacity-0")} onClick={() => setDrawer(false)} />
        <aside className={cx("absolute inset-y-0 left-0 w-[288px] max-w-[85vw] shadow-2xl transition-transform", drawer ? "translate-x-0" : "-translate-x-full")}>{sidebar}</aside>
      </div>

      <div className="lg:pl-[272px]">
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
