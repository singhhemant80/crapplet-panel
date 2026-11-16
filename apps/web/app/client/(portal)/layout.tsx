"use client";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { useSession } from "@/lib/session";
import { api, money } from "@/lib/api";
import { readCart } from "@/lib/cart";
import { Alert, Button, Icon, Loading, cx, toast } from "@/components/ui";
import { ClientSidebar, currentItem, useClientRail, type Shell } from "@/components/client/sidebar";

export default function PortalLayout({ children }: { children: React.ReactNode }) {
  const { me, loading, logout } = useSession();
  const router = useRouter();
  const path = usePathname();
  const [drawer, setDrawer] = useState(false);
  const [shell, setShell] = useState<Shell | null>(null);
  const [cart, setCart] = useState(0);
  const { rail, toggle } = useClientRail();

  useEffect(() => {
    if (!loading && (!me || me.type !== "CLIENT")) router.replace(`/client/login?next=${encodeURIComponent(path)}`);
  }, [loading, me, path, router]);
  useEffect(() => setDrawer(false), [path]);
  // "online now" heartbeat for the admin dashboard: on each page change, then every minute while the tab is visible
  useEffect(() => {
    if (!me || me.type !== "CLIENT" || me.impersonatedBy) return;
    const ping = () => document.visibilityState === "visible" && api("/auth/ping", { body: { path: location.pathname } }).catch(() => {});
    ping();
    const t = setInterval(ping, 60_000);
    document.addEventListener("visibilitychange", ping);
    return () => {
      clearInterval(t);
      document.removeEventListener("visibilitychange", ping);
    };
  }, [me, path]);

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

  const current = currentItem(path);
  const cur = shell?.currency ?? me.profile?.currency ?? "INR";
  const initials = `${me.firstName?.[0] ?? ""}${me.lastName?.[0] ?? ""}`.toUpperCase() || me.email[0].toUpperCase();
  const signOut = async () => {
    await logout();
    router.replace("/client/login");
  };

  return (
    <div className="min-h-screen bg-[#f5f3fb]">
      {/* desktop sidebar */}
      <aside className={cx("fixed inset-y-0 left-0 z-40 hidden lg:block", rail ? "w-[92px]" : "w-[344px]")}>
        <ClientSidebar me={me} shell={shell} rail={rail} onToggleRail={toggle} onSignOut={signOut} />
      </aside>
      {/* mobile drawer */}
      <div className={cx("fixed inset-0 z-50 lg:hidden", drawer ? "" : "pointer-events-none")}>
        <div className={cx("absolute inset-0 bg-slate-950/50 backdrop-blur-sm transition", drawer ? "opacity-100" : "opacity-0")} onClick={() => setDrawer(false)} />
        <aside className={cx("absolute inset-y-0 left-0 w-[344px] max-w-[92vw] shadow-2xl transition-transform", drawer ? "translate-x-0" : "-translate-x-full")}>
          <ClientSidebar me={me} shell={shell} rail={false} onToggleRail={toggle} mobile onClose={() => setDrawer(false)} onSignOut={signOut} />
        </aside>
      </div>

      <div className={rail ? "lg:pl-[92px]" : "lg:pl-[344px]"}>
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
                  <span>Your email address <b>{me.email}</b> isn't verified yet.</span>
                  <Button size="sm" variant="outline" onClick={() => api("/auth/resend-verification", { body: {} }).then(() => toast.success(`Verification email sent to ${me.email}`)).catch((e) => toast.error(e.message))}>
                    Send verification email
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

