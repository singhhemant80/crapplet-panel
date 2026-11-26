"use client";
/**
 * Client-area sidebar — same light two-pane look as the admin console:
 *  - section column (Home, Services, Billing, Support, Account) with a dot when something needs attention,
 *    collapse button and the account menu;
 *  - page list with a one-line description per page, a menu search, and on Home: "Needs you" + quick links;
 *    account credit at the bottom.
 * Collapsed mode keeps only the section column; a section opens its pages as a flyout.
 */
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { money } from "@/lib/api";
import { Icon, cx } from "@/components/ui";

export type Shell = { unpaidInvoices: number; overdueInvoices: number; outstanding: number; ticketsAwaitingReply: number; services: number; byType?: Record<string, number>; domains?: number; creditBalance: number; currency: string; kyc?: { show: boolean; status: string; required: boolean; requiredFor: string } };

/** Service kinds shown with counts in the sidebar ("VPS servers 3 · Web hosting 1 …") and as filters on My services. */
export const SERVICE_KINDS: { key: string; label: string; icon: string; desc: string; types: string[] }[] = [
  { key: "vps", label: "VPS servers", icon: "developer_board", desc: "Linux, Windows, Forex & more", types: ["VPS_LINUX", "VPS_WINDOWS", "VPS_FOREX", "VPS_N8N", "VPS_MINECRAFT", "VPS_GOLD", "TALLY"] },
  { key: "hosting", label: "Web hosting", icon: "language", desc: "cPanel, WordPress, reseller", types: ["SHARED", "WORDPRESS", "RESELLER_HOSTING"] },
  { key: "dedicated", label: "Dedicated & GPU", icon: "dns", desc: "Bare-metal servers", types: ["DEDICATED", "GPU"] },
  { key: "other", label: "Other services", icon: "widgets", desc: "Colocation and custom", types: ["COLOCATION", "CUSTOM"] },
];
export const kindOf = (type: string) => SERVICE_KINDS.find((k) => k.types.includes(type))?.key ?? "other";
const kindCount = (s: Shell | null, key: string) => SERVICE_KINDS.find((k) => k.key === key)!.types.reduce((n, t) => n + (s?.byType?.[t] ?? 0), 0);
type Item = { href: string; label: string; icon: string; desc: string; exact?: boolean; external?: boolean; count?: (s: Shell) => number; tone?: "rose" | "amber" | "violet" };
type Section = { key: string; title: string; short: string; icon: string; items: Item[] };

export const CLIENT_NAV: Section[] = [
  {
    key: "home", title: "Home", short: "Home", icon: "space_dashboard",
    items: [{ href: "/client", label: "Dashboard", icon: "space_dashboard", desc: "Your account at a glance", exact: true }],
  },
  {
    key: "services", title: "Services", short: "Services", icon: "dns",
    items: [
      { href: "/client/services", label: "My services", icon: "dns", desc: "VPS, hosting and more", count: (s) => s.services, tone: "violet" },
      { href: "/client/domains", label: "Domains", icon: "language", desc: "Names and renewals" },
      { href: "/order", label: "Order new service", icon: "add_shopping_cart", desc: "Plans and pricing" },
    ],
  },
  {
    key: "billing", title: "Billing", short: "Billing", icon: "receipt_long",
    items: [
      { href: "/client/invoices", label: "Invoices", icon: "receipt_long", desc: "Pay and download", count: (s) => s.unpaidInvoices, tone: "rose" },
      { href: "/client/quotes", label: "Quotes", icon: "request_quote", desc: "Estimates from us" },
      { href: "/client/payments", label: "Payments", icon: "payments", desc: "What you've paid" },
      { href: "/client/wallet", label: "Wallet & credit", icon: "account_balance_wallet", desc: "Add funds, balance" },
    ],
  },
  {
    key: "support", title: "Support", short: "Support", icon: "support_agent",
    items: [
      { href: "/client/tickets", label: "Support tickets", icon: "support_agent", desc: "Talk to our team", count: (s) => s.ticketsAwaitingReply, tone: "amber" },
      { href: "/client/knowledgebase", label: "Knowledgebase", icon: "menu_book", desc: "Guides and answers" },
      { href: "/client/downloads", label: "Downloads", icon: "download", desc: "Files and tools" },
    ],
  },
  {
    key: "account", title: "Account", short: "Account", icon: "person",
    items: [
      { href: "/client/profile", label: "Profile & billing", icon: "person", desc: "Name, address, GSTIN" },
      { href: "/client/security", label: "Security", icon: "shield_lock", desc: "Password and 2FA" },
      { href: "/client/kyc", label: "Identity verification", icon: "badge", desc: "Aadhaar via DigiLocker", count: (s) => (s.kyc?.required ? 1 : 0), tone: "rose" },
      { href: "/client/affiliates", label: "Affiliates", icon: "handshake", desc: "Earn by referring" },
      { href: "/client/reseller", label: "VPS reseller", icon: "storefront", desc: "Sell under your brand" },
      { href: "/api-docs", label: "API documentation", icon: "code", desc: "Automate your account", external: true },
    ],
  },
];
const ALL = CLIENT_NAV.flatMap((g) => g.items.map((i) => ({ ...i, section: g })));
const TONE = { rose: "bg-rose-100 text-rose-600", amber: "bg-amber-100 text-amber-700", violet: "bg-[#f1ecfd] text-[#7c3aed]" };

export const isActiveItem = (path: string, i: { href: string; exact?: boolean }) => (i.exact ? path === i.href : path === i.href || path.startsWith(i.href + "/"));
export const currentItem = (path: string) => ALL.find((i) => isActiveItem(path, i));
const sectionOf = (path: string) => ALL.find((i) => isActiveItem(path, i))?.section.key ?? "home";

const read = (k: string) => {
  try {
    return localStorage.getItem(k) === "1";
  } catch {
    return false;
  }
};
/** Desktop slim (section column only) mode, remembered per browser. */
export function useClientRail() {
  const [rail, setRail] = useState(false);
  useEffect(() => setRail(read("cl.rail")), []);
  const toggle = () =>
    setRail((r) => {
      try {
        localStorage.setItem("cl.rail", r ? "0" : "1");
      } catch {
        /* private mode */
      }
      return !r;
    });
  return { rail, toggle };
}

export function ClientSidebar({ me, shell, rail, onToggleRail, mobile, onClose, onSignOut }: { me: any; shell: Shell | null; rail: boolean; onToggleRail: () => void; mobile?: boolean; onClose?: () => void; onSignOut: () => void }) {
  const path = usePathname();
  const router = useRouter();
  const slim = rail && !mobile;
  const [sec, setSec] = useState(() => sectionOf(path));
  const [peek, setPeek] = useState(false);
  const [q, setQ] = useState("");
  const [menu, setMenu] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const cur = shell?.currency ?? me.profile?.currency ?? "INR";
  // Identity verification appears only while staff have Aadhaar KYC switched on (or the customer is verified)
  const showItem = (i: { href: string }) => i.href !== "/client/kyc" || !!shell?.kyc?.show;
  const initials = `${me.firstName?.[0] ?? ""}${me.lastName?.[0] ?? ""}`.toUpperCase() || me.email[0].toUpperCase();

  useEffect(() => {
    setSec(sectionOf(path));
    setPeek(false);
    setMenu(false);
    setQ("");
  }, [path]);
  useEffect(() => {
    if (!menu) return;
    const close = (e: MouseEvent) => !menuRef.current?.contains(e.target as Node) && setMenu(false);
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [menu]);

  const current = CLIENT_NAV.find((g) => g.key === sec) ?? CLIENT_NAV[0];
  const waiting = (g: Section) => !!shell && g.key !== "home" && g.items.some((i) => i.tone !== "violet" && (i.count?.(shell) ?? 0) > 0);
  const results = useMemo(() => {
    const s = q.trim().toLowerCase();
    return s ? ALL.filter(showItem).filter((i) => i.label.toLowerCase().includes(s) || i.desc.toLowerCase().includes(s) || i.section.title.toLowerCase().includes(s)) : [];
  }, [q]);
  const pickSection = (k: string) => {
    setSec(k);
    setQ("");
    if (slim) setPeek((p) => !(p && sec === k));
  };

  const row = (i: Item, opts: { sub?: string; count?: number; tone?: keyof typeof TONE } = {}) => {
    const on = isActiveItem(path, i);
    const n = opts.count ?? (shell && i.count ? i.count(shell) : 0);
    return (
      <Link
        key={i.href + (opts.sub ?? "")}
        href={i.href}
        aria-current={on ? "page" : undefined}
        {...(i.external ? { target: "_blank", rel: "noreferrer", prefetch: false } : {})}
        className={cx(
          "group/row flex items-center gap-[11px] rounded-xl border px-2.5 py-2 transition",
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
        {i.external && <Icon name="open_in_new" className="text-[15px] text-slate-400" />}
        {n > 0 && <span className={cx("min-w-[24px] rounded-full px-2 text-center text-[11px] font-extrabold leading-[19px]", TONE[opts.tone ?? i.tone ?? "violet"])}>{n > 99 ? "99+" : n}</span>}
      </Link>
    );
  };
  const heading = (t: string, first?: boolean) => <div className={cx("px-2.5 pb-2 text-[10.5px] font-extrabold uppercase tracking-[.14em] text-[#a0a5bd]", !first && "mt-3 border-t border-[#eeebf8] pt-4")}>{t}</div>;

  const needs: { item: Item; sub: string; count: number; tone: keyof typeof TONE }[] = [];
  if (shell?.overdueInvoices) needs.push({ item: { href: "/client/invoices?status=UNPAID", label: "Overdue invoices", icon: "warning", desc: "" }, sub: "Pay now to avoid suspension", count: shell.overdueInvoices, tone: "rose" });
  else if (shell?.unpaidInvoices) needs.push({ item: { href: "/client/invoices?status=UNPAID", label: "Invoices to pay", icon: "receipt_long", desc: "" }, sub: `${money(shell.outstanding, cur)} due`, count: shell.unpaidInvoices, tone: "rose" });
  if (shell?.kyc?.show && shell.kyc.status === "REVIEW") needs.push({ item: { href: "/client/kyc", label: "Verification under review", icon: "hourglass_top", desc: "" }, sub: "Our team is checking it", count: 0, tone: "amber" });
  else if (shell?.kyc?.show && shell.kyc.status !== "VERIFIED" && (shell.kyc.required || shell.kyc.status === "REJECTED")) needs.push({ item: { href: "/client/kyc", label: "Verify your identity", icon: "badge", desc: "" }, sub: shell.kyc.requiredFor === "servers" ? "Needed before ordering a VPS" : "Needed before ordering · 2 min", count: 1, tone: "rose" });
  if (shell?.ticketsAwaitingReply) needs.push({ item: { href: "/client/tickets", label: "Tickets answered", icon: "forum", desc: "" }, sub: "Our team replied", count: shell.ticketsAwaitingReply, tone: "amber" });

  const listPane = (
    <div className={cx("flex h-full flex-col border-r border-[#eceaf5] bg-[#faf9ff]", mobile ? "min-w-0 flex-1" : "w-[252px]")}>
      <div className="shrink-0 px-3 pb-3 pt-[18px]">
        <div className="flex items-center gap-2 px-2 pb-4">
          <Link href="/client" className="block min-w-0 flex-1" aria-label="Crapplet Cloud — Dashboard">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/Crapplet_logo.png" alt="Crapplet Cloud" className="h-[30px] w-auto" />
          </Link>
          {mobile && onClose && (
            <button onClick={onClose} aria-label="Close menu" className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-white text-slate-500 ring-1 ring-[#e9e6f5] hover:text-slate-800"><Icon name="close" className="text-[18px]" /></button>
          )}
        </div>
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
            {results.map((i) => row(i, { sub: `${i.section.title} · ${i.desc}` }))}
            {!results.length && <div className="px-3 py-8 text-center text-[12.5px] text-slate-400">Nothing in the menu matches “{q}”.</div>}
          </>
        ) : (
          <>
            <div className="px-2.5 pb-2.5 text-[11px] font-extrabold uppercase tracking-[.14em] text-[#7c3aed]">{current.title}</div>
            {current.items.filter(showItem).map((i) => row(i))}
            {current.key === "services" && shell?.byType && (
              <>
                {heading(`Your services · ${shell.services} active`)}
                {SERVICE_KINDS.filter((k) => k.key === "vps" || k.key === "hosting" || kindCount(shell, k.key) > 0).map((k) =>
                  row({ href: `/client/services?type=${k.key}`, label: k.label, icon: k.icon, desc: k.desc }, { count: kindCount(shell, k.key), sub: kindCount(shell, k.key) ? k.desc : "None yet", tone: "violet" }),
                )}
                {row({ href: "/client/domains", label: "Domains", icon: "public", desc: "Registered with us" }, { count: shell.domains ?? 0, sub: shell.domains ? "Registered with us" : "None yet", tone: "violet" })}
              </>
            )}
            {current.key === "home" && (
              <>
                {heading("Needs you")}
                {needs.length ? needs.map((n) => row(n.item, { sub: n.sub, count: n.count, tone: n.tone })) : (
                  <div className="flex items-center gap-2.5 px-2.5 py-1.5 text-[12.5px] font-semibold text-emerald-700"><span className="grid h-[34px] w-[34px] place-items-center rounded-[10px] bg-emerald-50"><Icon name="task_alt" className="text-[18px]" /></span>All caught up</div>
                )}
                {heading("Your services")}
                {shell?.byType && (
                  <Link href="/client/services" className="mx-0.5 mb-1 grid grid-cols-3 gap-1.5 rounded-xl border border-[#ece8f8] bg-white p-1.5 transition hover:border-[#dccafb]">
                    {[{ k: "vps", l: "VPS" }, { k: "hosting", l: "Hosting" }, { k: "rest", l: "Others" }].map(({ k, l }) => {
                      const n = k === "rest" ? kindCount(shell, "dedicated") + kindCount(shell, "other") + (shell.domains ?? 0) : kindCount(shell, k);
                      return (
                        <span key={k} className="rounded-lg bg-[#f8f6fe] px-1 py-2 text-center">
                          <b className={cx("block text-[17px] font-extrabold leading-none", n ? "text-ink" : "text-slate-300")}>{n}</b>
                          <span className="mt-1 block text-[10.5px] font-bold uppercase tracking-wide text-slate-400">{l}</span>
                        </span>
                      );
                    })}
                  </Link>
                )}
                {heading("Quick links")}
                {row({ href: "/order", label: "Order new service", icon: "add_shopping_cart", desc: "Plans and pricing" })}
                {row({ href: "/client/tickets/new", label: "Get help", icon: "headset_mic", desc: "Open a ticket — 24/7" })}
              </>
            )}
          </>
        )}
      </nav>

      <div className="shrink-0 p-3">
        <div className="rounded-[14px] border border-[#e6dcff] bg-gradient-to-br from-[#f5f0ff] to-[#eef4ff] p-3">
          <div className="flex items-center gap-2.5">
            <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-gradient-to-br from-[#a365fe] to-[#7c3aed] text-white"><Icon name="account_balance_wallet" className="text-[19px]" /></span>
            <div className="min-w-0 flex-1 leading-tight">
              <div className="text-[10.5px] font-extrabold uppercase tracking-wider text-slate-500">Account credit</div>
              <div className="truncate text-[15px] font-extrabold text-ink">{shell ? money(shell.creditBalance, cur) : "…"}</div>
            </div>
            <Link href="/client/wallet" className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-white text-[#7c3aed] ring-1 ring-[#e4d8ff] hover:bg-[#f5f0ff]" aria-label="Add funds" title="Add funds">
              <Icon name="add" className="text-[18px]" />
            </Link>
          </div>
        </div>
      </div>
    </div>
  );

  return (
    <div className="relative flex h-full bg-white">
      <div className="flex h-full w-[92px] shrink-0 flex-col items-center gap-1 border-r border-[#eceaf5] bg-white pb-3.5 pt-4">
        <Link href="/client" className="mb-3.5 grid h-[50px] w-[50px] shrink-0 place-items-center rounded-[15px] bg-gradient-to-br from-[#f3edff] to-[#e9e1ff] ring-1 ring-inset ring-[#e4d8ff]" aria-label="Dashboard">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/Crapplet_Icon.png" alt="" className="h-[34px] w-[34px]" />
        </Link>
        <div className="flex min-h-0 w-full flex-1 flex-col items-center gap-1 overflow-y-auto" style={{ scrollbarWidth: "none" }}>
          {CLIENT_NAV.map((g) => {
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
            <button onClick={() => setMenu((m) => !m)} title={`${me.firstName ?? ""} ${me.lastName ?? ""}`.trim()} aria-label="Account menu" aria-expanded={menu} className="relative grid h-10 w-10 place-items-center rounded-xl bg-gradient-to-br from-[#a365fe] to-[#6d28d9] text-[13px] font-extrabold text-white">
              {initials}
              <span className="absolute -bottom-0.5 -right-0.5 h-[11px] w-[11px] rounded-full bg-emerald-500 ring-2 ring-white" />
            </button>
            {menu && (
              <div className="fixed bottom-4 left-[100px] z-[80] w-[240px] rounded-2xl border border-[#eceaf5] bg-white p-2 shadow-[0_24px_48px_-16px_rgba(46,16,101,.35)]">
                <div className="px-2.5 pb-2 pt-1.5">
                  <div className="truncate text-[13.5px] font-extrabold text-ink">{me.firstName} {me.lastName}</div>
                  <div className="truncate text-[12px] font-semibold text-slate-400">{me.email}</div>
                </div>
                <div className="border-t border-[#f1eff8] pt-1">
                  <Link href="/client/profile" className="flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-[13px] font-semibold text-slate-700 hover:bg-[#f5f2fd]"><Icon name="person" className="text-[18px] text-[#7c3aed]" />Profile & billing</Link>
                  <Link href="/client/security" className="flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-[13px] font-semibold text-slate-700 hover:bg-[#f5f2fd]"><Icon name="shield_lock" className="text-[18px] text-[#7c3aed]" />Security</Link>
                  {shell?.kyc?.show && <Link href="/client/kyc" className="flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-[13px] font-semibold text-slate-700 hover:bg-[#f5f2fd]"><Icon name="badge" className="text-[18px] text-[#7c3aed]" />Identity verification{shell.kyc.status === "VERIFIED" && <Icon name="verified" fill className="ml-auto text-[16px] text-emerald-600" />}</Link>}
                  <button onClick={onSignOut} className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-[13px] font-semibold text-slate-700 hover:bg-rose-50 hover:text-rose-600"><Icon name="logout" className="text-[18px]" />Sign out</button>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

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
