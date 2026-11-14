"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { api, date, money } from "@/lib/api";
import { can, useSession } from "@/lib/session";
import { Badge, Button, Icon, Loading, PageHeader, cx, toast, useApi } from "@/components/ui";

/** ₹1,26,930 → "₹1.27L"; ₹2.4 cr → "₹2.42Cr" — for big tiles and chart labels */
function inr(paise: number, compact = false) {
  const v = Math.round(paise / 100);
  if (!compact || Math.abs(v) < 100000) return "₹" + v.toLocaleString("en-IN");
  if (Math.abs(v) < 10000000) return `₹${(v / 100000).toFixed(v < 1000000 ? 2 : 1)}L`;
  return `₹${(v / 10000000).toFixed(2)}Cr`;
}
function change(cur: number, prev: number) {
  if (!prev) return cur ? { text: "new", up: true } : null;
  const p = Math.round(((cur - prev) / prev) * 100);
  return { text: `${p > 0 ? "+" : ""}${p}%`, up: p >= 0 };
}
const greet = () => {
  const h = Number(new Date().toLocaleString("en-IN", { hour: "numeric", hour12: false, timeZone: "Asia/Kolkata" }));
  return h < 12 ? "Good morning" : h < 17 ? "Good afternoon" : "Good evening";
};
const ago = (d: string | Date) => {
  const s = Math.max(0, (Date.now() - new Date(d).getTime()) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
};

function Panel({ title, icon, action, children, className, flush }: { title: string; icon: string; action?: React.ReactNode; children: React.ReactNode; className?: string; flush?: boolean }) {
  return (
    <section className={cx("min-w-0 overflow-hidden rounded-2xl border border-line bg-white shadow-card", className)}>
      <header className="flex items-center gap-2.5 border-b border-line px-5 py-3.5">
        <span className="grid h-8 w-8 place-items-center rounded-lg bg-primary-soft text-primary-dark"><Icon name={icon} className="text-[18px]" /></span>
        <h3 className="min-w-0 flex-1 truncate text-[15px] font-extrabold text-ink">{title}</h3>
        {action}
      </header>
      <div className={flush ? "" : "p-5"}>{children}</div>
    </section>
  );
}
const More = ({ href, children = "View all" }: { href: string; children?: React.ReactNode }) => (
  <Link href={href} className="inline-flex shrink-0 items-center gap-0.5 text-[12.5px] font-bold text-primary-dark hover:underline">{children}<Icon name="chevron_right" className="text-[17px]" /></Link>
);

/** 12 months: income bars + orders line */
function Chart({ rows }: { rows: { month: string; income: number; orders: number; clients: number }[] }) {
  const [hover, setHover] = useState<number | null>(null);
  const W = 720, H = 230, P = { l: 52, r: 36, t: 16, b: 28 };
  const maxI = Math.max(1, ...rows.map((r) => r.income));
  const maxO = Math.max(1, ...rows.map((r) => r.orders));
  const cw = (W - P.l - P.r) / rows.length;
  const y = (v: number) => P.t + (H - P.t - P.b) * (1 - v / maxI);
  const yo = (v: number) => P.t + (H - P.t - P.b) * (1 - v / maxO);
  const line = rows.map((r, i) => `${i ? "L" : "M"}${P.l + cw * i + cw / 2},${yo(r.orders)}`).join(" ");
  const h = hover !== null ? rows[hover] : null;
  return (
    <div className="relative">
      <svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full" onMouseLeave={() => setHover(null)}>
        <defs>
          <linearGradient id="bar" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stopColor="#a365fe" /><stop offset="1" stopColor="#6d28d9" /></linearGradient>
        </defs>
        {[0, 0.25, 0.5, 0.75, 1].map((f) => (
          <g key={f}>
            <line x1={P.l} x2={W - P.r} y1={y(maxI * f)} y2={y(maxI * f)} stroke="#efe9fb" />
            <text x={P.l - 8} y={y(maxI * f) + 4} textAnchor="end" fontSize="10.5" fill="#8a84a3">{inr(maxI * f, true)}</text>
            <text x={W - P.r + 8} y={yo(maxO * f) + 4} fontSize="10.5" fill="#0ea5e9">{Math.round(maxO * f)}</text>
          </g>
        ))}
        {rows.map((r, i) => {
          const bh = Math.max(r.income ? 3 : 0, H - P.b - y(r.income));
          return (
            <g key={r.month} onMouseEnter={() => setHover(i)}>
              <rect x={P.l + cw * i} y={P.t} width={cw} height={H - P.t - P.b} fill={hover === i ? "#f6f1ff" : "transparent"} />
              <rect x={P.l + cw * i + cw * 0.22} y={H - P.b - bh} width={cw * 0.56} height={bh} rx="5" fill="url(#bar)" opacity={hover === null || hover === i ? 1 : 0.55} />
              <text x={P.l + cw * i + cw / 2} y={H - 8} textAnchor="middle" fontSize="11" fill="#8a84a3" fontWeight={hover === i ? 700 : 500}>{new Date(r.month + "-01").toLocaleString("en-IN", { month: "short" })}</text>
            </g>
          );
        })}
        <path d={line} fill="none" stroke="#0ea5e9" strokeWidth="2.5" strokeLinejoin="round" />
        {rows.map((r, i) => <circle key={r.month} cx={P.l + cw * i + cw / 2} cy={yo(r.orders)} r={hover === i ? 5 : 3.5} fill="#fff" stroke="#0ea5e9" strokeWidth="2.5" />)}
      </svg>
      {h && (
        <div className="pointer-events-none absolute left-1/2 top-0 -translate-x-1/2 rounded-xl bg-ink px-3 py-2 text-xs text-white shadow-lg">
          <div className="font-bold">{new Date(h.month + "-01").toLocaleString("en-IN", { month: "long", year: "numeric" })}</div>
          <div>Income <b>{inr(h.income)}</b> · Orders <b>{h.orders}</b> · New clients <b>{h.clients}</b></div>
        </div>
      )}
      <div className="mt-1 flex justify-center gap-5 text-xs font-semibold text-mute">
        <span className="flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-sm bg-primary-dark" />Income</span>
        <span className="flex items-center gap-1.5"><span className="h-0.5 w-4 rounded bg-sky-500" />Orders</span>
      </div>
    </div>
  );
}

const TODO: { key: string; label: string; icon: string; href: string; tone: "rose" | "amber" | "sky" | "violet" }[] = [
  { key: "pendingOrders", label: "Pending orders", icon: "shopping_bag", href: "/admin/orders?status=PENDING", tone: "amber" },
  { key: "overdueInvoices", label: "Overdue invoices", icon: "receipt_long", href: "/admin/invoices?status=UNPAID", tone: "rose" },
  { key: "awaitingReply", label: "Tickets awaiting reply", icon: "support_agent", href: "/admin/tickets", tone: "sky" },
  { key: "failedSetup", label: "Failed setups", icon: "error", href: "/admin/services?status=FAILED", tone: "rose" },
  { key: "paymentReviews", label: "Payments to verify", icon: "fact_check", href: "/admin/payment-reviews", tone: "amber" },
  { key: "cancelRequests", label: "Cancellation requests", icon: "cancel", href: "/admin/tickets", tone: "violet" },
  { key: "domainsExpiring", label: "Domains expiring (30d)", icon: "public", href: "/admin/domains", tone: "violet" },
  { key: "serversDown", label: "Servers with errors", icon: "dns", href: "/admin/servers", tone: "rose" },
];
const TONE = { rose: "bg-rose-50 text-rose-600", amber: "bg-amber-50 text-amber-600", sky: "bg-sky-50 text-sky-600", violet: "bg-primary-soft text-primary-dark" };

/** Clients with the client area open right now (activity in the last few minutes), refreshed every 30 s. */
function OnlineNow() {
  const [d, setD] = useState<any>(null);
  const [all, setAll] = useState(false);
  useEffect(() => {
    let live = true;
    const load = () => api("/admin/dashboard/online").then((r) => live && setD(r)).catch(() => {});
    load();
    const t = setInterval(() => document.visibilityState === "visible" && load(), 30_000);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, []);
  const ago = (t: string) => {
    const s = Math.max(0, Math.round((Date.now() - new Date(t).getTime()) / 1000));
    return s < 60 ? "just now" : `${Math.floor(s / 60)} min ago`;
  };
  const rows: any[] = d?.clients ?? [];
  const shown = all ? rows : rows.slice(0, 8);
  return (
    <Panel
      title="Clients online now"
      icon="sensors"
      className="mb-6"
      flush
      action={
        <span className="inline-flex items-center gap-2 text-xs font-semibold text-mute">
          <span className="relative flex h-2.5 w-2.5"><span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-60" /><span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-emerald-500" /></span>
          {d ? `${d.count} online · last ${d.windowMinutes} min` : "Loading…"}
        </span>
      }
    >
      {!d ? (
        <div className="px-5 py-6 text-sm text-mute">Loading…</div>
      ) : rows.length === 0 ? (
        <div className="px-5 py-8 text-center text-sm text-mute">
          <Icon name="bedtime" className="mb-1 block text-[28px] text-slate-300" />
          No clients are using the client area right now.
        </div>
      ) : (
        <>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] text-left text-[13px]">
              <thead className="bg-[#faf7ff] text-[11px] font-bold uppercase tracking-wider text-mute">
                <tr><th className="px-5 py-2.5">Client</th><th className="px-3 py-2.5">Viewing</th><th className="px-3 py-2.5">Device · IP</th><th className="px-5 py-2.5 text-right">Last active</th></tr>
              </thead>
              <tbody className="divide-y divide-line">
                {shown.map((c) => (
                  <tr key={c.id} className="hover:bg-[#fcfaff]">
                    <td className="px-5 py-2.5">
                      <Link href={`/admin/clients/${c.id}`} className="flex items-center gap-2.5">
                        <span className="relative grid h-8 w-8 shrink-0 place-items-center rounded-full bg-gradient-to-br from-primary to-primary-dark text-[11px] font-extrabold text-white">
                          {c.name.split(" ").map((w: string) => w[0]).join("").slice(0, 2).toUpperCase()}
                          <span className="absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full bg-emerald-500 ring-2 ring-white" />
                        </span>
                        <span className="min-w-0"><span className="block truncate font-bold text-ink hover:text-primary-dark">{c.name}</span><span className="block truncate text-xs text-mute">{c.company ?? c.email}{c.activeServices ? ` · ${c.activeServices} active service${c.activeServices > 1 ? "s" : ""}` : ""}</span></span>
                      </Link>
                    </td>
                    <td className="px-3 py-2.5">{c.page ? <span title={c.path ?? ""} className="rounded-full bg-primary/10 px-2.5 py-1 text-xs font-semibold text-primary-dark">{c.page}</span> : <span className="text-xs text-mute">—</span>}</td>
                    <td className="px-3 py-2.5 text-xs text-mute">
                      <span className="flex items-center gap-1">{c.device && <Icon name={c.device.mobile ? "smartphone" : "computer"} className="text-[15px]" />}{c.device?.label ?? "—"}</span>
                      <span><span className="font-mono text-[11px]">{c.ip ?? ""}</span>{c.location ? ` · ${c.location}` : ""}</span>
                    </td>
                    <td className="px-5 py-2.5 text-right text-xs font-semibold text-mute">{ago(c.lastSeenAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {(rows.length > 8 || d.viewedByStaff > 0) && (
            <div className="flex items-center justify-between border-t border-line px-5 py-2.5 text-xs text-mute">
              <span>{d.viewedByStaff > 0 ? `+ ${d.viewedByStaff} client area${d.viewedByStaff > 1 ? "s" : ""} opened by staff (login as client) — not counted` : ""}</span>
              {rows.length > 8 && <button onClick={() => setAll(!all)} className="font-bold text-primary-dark hover:underline">{all ? "Show fewer" : `Show all ${rows.length}`}</button>}
            </div>
          )}
        </>
      )}
    </Panel>
  );
}

export default function AdminDashboard() {
  const { me } = useSession();
  const { data, loading, reload } = useApi("/admin/dashboard/overview");
  const legacy = useApi("/admin/dashboard");
  const [running, setRunning] = useState(false);
  if (loading || !data) return <Loading />;
  const d = data;
  const mrr = legacy.data?.stats.mrr ?? 0;
  const mChange = change(d.income.month.total, d.income.lastMonth.total);
  const tChange = change(d.income.today.total, d.income.yesterday.total);
  const todos = TODO.map((t) => ({ ...t, n: d.todo[t.key] ?? 0 }));
  const attention = todos.reduce((s, t) => s + t.n, 0);
  const svcTotal = (d.services.active + d.services.suspended + d.services.pending) || 1;
  const autoToday: [string, number][] = Object.entries(d.automation.today) as [string, number][];
  const serverRows = [...d.servers].sort((a: any, b: any) => Number(a.ok !== false) - Number(b.ok !== false) || b.active - a.active).slice(0, 6);

  async function runAutomation() {
    if (!confirm("Run the daily automation now?")) return;
    setRunning(true);
    try {
      const r = await api("/admin/automation/run", { body: {} });
      toast.success(r.skipped ?? `Automation finished in ${(r.durationMs / 1000).toFixed(1)} s`);
      reload();
    } catch (e: any) {
      toast.error(e.message);
    } finally {
      setRunning(false);
    }
  }

  return (
    <>
      <PageHeader
        icon="space_dashboard"
        title={`${greet()}, ${me?.firstName ?? "Admin"}`}
        subtitle={new Date().toLocaleDateString("en-IN", { weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: "Asia/Kolkata" })}
        meta={<>
          <span className="inline-flex items-center gap-1.5"><Icon name="group" className="text-[16px] text-white/60" />{d.clients.online} client{d.clients.online === 1 ? "" : "s"} online</span>
          <span className="inline-flex items-center gap-1.5"><Icon name="badge" className="text-[16px] text-white/60" />{d.staffOnline.length} staff online</span>
          <span className={cx("inline-flex items-center gap-1.5", !d.automation.healthy && "font-bold text-amber-200")}><Icon name="schedule" className="text-[16px] text-white/60" />{d.automation.enabled ? (d.automation.healthy ? "Automation running" : "Automation not running") : "Automation off"}</span>
        </>}
        actions={<>
          <Button size="sm" icon="add_shopping_cart" href="/admin/orders/new">New order</Button>
          <Button size="sm" variant="outline" icon="play_arrow" loading={running} onClick={runAutomation}>Run automation</Button>
        </>}
        stats={[
          ["Income today", inr(d.income.today.total), tChange ? <span key="t" className={tChange.up ? "font-bold text-emerald-600" : "font-bold text-rose-600"}>{tChange.text} vs yesterday</span> : `${d.income.today.count} payments`],
          ["This month", inr(d.income.month.total), mChange ? <span key="m" className={mChange.up ? "font-bold text-emerald-600" : "font-bold text-rose-600"}>{mChange.text} vs last month</span> : undefined],
          ["This financial year", inr(d.income.fy.total, true), "since 1 April"],
          ["All-time income", inr(d.income.all.total, true), `${d.income.all.count.toLocaleString("en-IN")} payments`],
          ["Monthly recurring", inr(mrr, true), `ARR ${inr(mrr * 12, true)}`],
          ["Outstanding", inr(d.invoices.unpaid.amount, true), <span key="o" className={d.invoices.overdue.count ? "font-bold text-rose-600" : ""}>{d.invoices.overdue.count} overdue</span>],
        ]}
      />

      {/* ── to-do ── */}
      <section className="mb-6 rounded-2xl border border-line bg-white p-4 shadow-card sm:p-5">
        <div className="mb-3 flex items-center gap-2">
          <Icon name="checklist" className="text-primary-dark" />
          <h3 className="text-[15px] font-extrabold text-ink">Needs attention</h3>
          <span className={cx("rounded-full px-2 py-0.5 text-[11px] font-bold", attention ? "bg-rose-50 text-rose-600" : "bg-emerald-50 text-emerald-700")}>{attention ? `${attention} items` : "All clear"}</span>
        </div>
        <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4 xl:grid-cols-8">
          {todos.map((t) => (
            <Link key={t.key} href={t.href} className={cx("group flex flex-col gap-2 rounded-xl border p-3 transition hover:-translate-y-0.5 hover:shadow-md", t.n ? "border-line bg-white" : "border-dashed border-line bg-[#fcfbff] opacity-70")}>
              <span className="flex items-center justify-between">
                <span className={cx("grid h-8 w-8 place-items-center rounded-lg", t.n ? TONE[t.tone] : "bg-slate-100 text-slate-400")}><Icon name={t.icon} className="text-[18px]" /></span>
                <span className={cx("text-xl font-extrabold", t.n ? "text-ink" : "text-slate-400")}>{t.n}</span>
              </span>
              <span className="text-[11.5px] font-semibold leading-tight text-mute group-hover:text-primary-dark">{t.label}</span>
            </Link>
          ))}
        </div>
      </section>

      {/* ── at a glance ── */}
      <div className="mb-6 grid gap-6 lg:grid-cols-3">
        <Panel title="Clients" icon="group" action={<More href="/admin/clients" />}>
          <div className="flex items-end justify-between">
            <div><div className="text-3xl font-extrabold tracking-tight text-ink">{d.clients.total.toLocaleString("en-IN")}</div><div className="text-xs text-mute">total clients</div></div>
            <div className="text-right"><div className="text-lg font-extrabold text-emerald-600">+{d.clients.month}</div><div className="text-xs text-mute">this month</div></div>
          </div>
          <dl className="mt-4 grid grid-cols-3 gap-2 text-center">
            {[["Active", d.clients.active], ["New today", d.clients.today], ["Online", d.clients.online]].map(([l, v]) => (
              <div key={l as string} className="rounded-xl bg-[#faf7ff] py-2.5"><dd className="text-lg font-extrabold text-ink">{v as number}</dd><dt className="text-[11px] font-semibold text-mute">{l}</dt></div>
            ))}
          </dl>
          {d.staffOnline.length > 0 && (
            <div className="mt-4 flex items-center gap-2 border-t border-line pt-3">
              <span className="text-[11px] font-bold uppercase tracking-wider text-mute">Staff online</span>
              <div className="flex -space-x-2">{d.staffOnline.slice(0, 6).map((u: any) => <span key={u.id} title={u.email} className="grid h-7 w-7 place-items-center rounded-full bg-gradient-to-br from-primary to-primary-dark text-[10px] font-extrabold text-white ring-2 ring-white">{`${u.firstName?.[0] ?? ""}${u.lastName?.[0] ?? ""}`.toUpperCase() || "S"}</span>)}</div>
            </div>
          )}
        </Panel>

        <Panel title="Services" icon="dns" action={<More href="/admin/services" />}>
          <div className="flex items-end justify-between">
            <div><div className="text-3xl font-extrabold tracking-tight text-ink">{d.services.active.toLocaleString("en-IN")}</div><div className="text-xs text-mute">active services</div></div>
            <div className="text-right"><div className="text-lg font-extrabold text-ink">{d.services.domains}</div><div className="text-xs text-mute">active domains</div></div>
          </div>
          <div className="mt-4 flex h-2.5 overflow-hidden rounded-full bg-slate-100">
            <div className="bg-emerald-500" style={{ width: `${(d.services.active / svcTotal) * 100}%` }} />
            <div className="bg-amber-400" style={{ width: `${(d.services.suspended / svcTotal) * 100}%` }} />
            <div className="bg-sky-400" style={{ width: `${(d.services.pending / svcTotal) * 100}%` }} />
          </div>
          <div className="mt-2.5 flex flex-wrap gap-x-4 gap-y-1 text-xs font-semibold text-slate-600">
            <Link href="/admin/services?status=ACTIVE" className="flex items-center gap-1.5 hover:text-primary-dark"><span className="h-2 w-2 rounded-full bg-emerald-500" />{d.services.active} active</Link>
            <Link href="/admin/services?status=SUSPENDED" className="flex items-center gap-1.5 hover:text-primary-dark"><span className="h-2 w-2 rounded-full bg-amber-400" />{d.services.suspended} suspended</Link>
            <Link href="/admin/services?status=PENDING" className="flex items-center gap-1.5 hover:text-primary-dark"><span className="h-2 w-2 rounded-full bg-sky-400" />{d.services.pending} pending</Link>
          </div>
          <dl className="mt-4 grid grid-cols-3 gap-2 text-center">
            {[["VPS", d.services.byKind.vps ?? 0, "dns"], ["Hosting", d.services.byKind.hosting ?? 0, "language"], ["Other", d.services.byKind.other ?? 0, "widgets"]].map(([l, v, i]) => (
              <div key={l as string} className="rounded-xl bg-[#faf7ff] py-2.5"><dd className="flex items-center justify-center gap-1 text-lg font-extrabold text-ink"><Icon name={i as string} className="text-[16px] text-primary" />{v as number}</dd><dt className="text-[11px] font-semibold text-mute">{l}</dt></div>
            ))}
          </dl>
        </Panel>

        <Panel title="Billing" icon="account_balance" action={<More href="/admin/invoices" />}>
          <dl className="divide-y divide-line text-[13px]">
            {[
              ["Unpaid invoices", `${d.invoices.unpaid.count} · ${inr(d.invoices.unpaid.amount)}`, "/admin/invoices?status=UNPAID", ""],
              ["Overdue", `${d.invoices.overdue.count} · ${inr(d.invoices.overdue.amount)}`, "/admin/invoices?status=UNPAID", d.invoices.overdue.count ? "text-rose-600" : ""],
              ["Due today", `${d.invoices.dueToday.count} · ${inr(d.invoices.dueToday.amount)}`, "/admin/invoices?status=UNPAID", ""],
              ["Orders today / this month", `${d.orders.today} / ${d.orders.month}`, "/admin/orders", ""],
              ["Refunds this month", `${d.income.refundsMonth.count} · ${inr(d.income.refundsMonth.total)}`, "/admin/transactions", ""],
              ["Payments this month", `${d.income.month.count}`, "/admin/transactions", ""],
            ].map(([l, v, h, c]) => (
              <Link key={l} href={h} className="flex items-center justify-between gap-3 py-2.5 hover:text-primary-dark">
                <dt className="text-mute">{l}</dt><dd className={cx("font-bold text-ink", c)}>{v}</dd>
              </Link>
            ))}
          </dl>
        </Panel>
      </div>

      {can(me, "clients.view") && <OnlineNow />}

      {/* ── chart + automation ── */}
      <div className="mb-6 grid items-start gap-6 xl:grid-cols-[minmax(0,1fr)_360px]">
        <Panel title="Income & orders · 12 months" icon="monitoring" action={<More href="/admin/reports">Reports</More>}>
          <Chart rows={d.chart} />
        </Panel>
        <Panel title="Automation" icon="schedule" action={<More href="/admin/automation">Details</More>}>
          <div className={cx("flex items-center gap-3 rounded-xl p-3", d.automation.healthy && d.automation.enabled ? "bg-emerald-50" : "bg-rose-50")}>
            <Icon name={d.automation.healthy && d.automation.enabled ? "check_circle" : "warning"} className={cx("text-[24px]", d.automation.healthy && d.automation.enabled ? "text-emerald-600" : "text-rose-600")} />
            <div className="min-w-0 text-[13px]">
              <div className="font-extrabold text-ink">{!d.automation.enabled ? "Automation is off" : d.automation.healthy ? "Running normally" : "Not running — check the worker"}</div>
              <div className="text-xs text-mute">Last {d.automation.lastRun ? ago(d.automation.lastRun.startedAt) : "never"} · next {d.automation.nextRunAt ? date(d.automation.nextRunAt, true) : "—"}</div>
            </div>
          </div>
          <div className="mt-4 text-[11px] font-bold uppercase tracking-wider text-mute">Today</div>
          {autoToday.length ? (
            <ul className="mt-2 space-y-1.5 text-[13px]">
              {autoToday.sort((a, b) => b[1] - a[1]).slice(0, 7).map(([k, n]) => (
                <li key={k}><Link href="/admin/automation" className="flex items-center justify-between gap-3 hover:text-primary-dark"><span className="text-slate-600">{AUTO_LABEL[k] ?? k}</span><b className={k === "error" ? "text-rose-600" : "text-ink"}>{n}</b></Link></li>
              ))}
            </ul>
          ) : <p className="mt-2 text-[13px] text-mute">Nothing yet today — the run is at {d.automation.runAt} IST.</p>}
        </Panel>
      </div>

      {/* ── recent orders + tickets ── */}
      <div className="mb-6 grid items-start gap-6 xl:grid-cols-[minmax(0,1fr)_400px]">
        <Panel title="Recent orders" icon="shopping_bag" action={<More href="/admin/orders" />} flush>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[560px] text-sm">
              <thead><tr className="bg-[#fbf9ff] text-left text-[11px] font-bold uppercase tracking-wider text-mute"><th className="px-5 py-2.5">Order</th><th className="px-3 py-2.5">Client</th><th className="px-3 py-2.5">Total</th><th className="px-3 py-2.5">Payment</th><th className="px-5 py-2.5 text-right">Status</th></tr></thead>
              <tbody className="divide-y divide-line">
                {d.recentOrders.map((o: any) => (
                  <tr key={o.id} className="hover:bg-[#fcfaff]">
                    <td className="px-5 py-3"><Link href={`/admin/orders/${o.id}`} className="font-bold text-primary-dark hover:underline">{o.number}</Link><div className="max-w-[180px] truncate text-xs text-mute">{o.product ?? "—"} · {ago(o.createdAt)}</div></td>
                    <td className="px-3 py-3"><Link href={`/admin/clients/${o.clientId}`} className="font-semibold text-ink hover:text-primary-dark">{o.client}</Link></td>
                    <td className="px-3 py-3 font-semibold">{money(o.total, o.currency)}</td>
                    <td className="px-3 py-3"><span className={cx("inline-flex items-center gap-1 text-xs font-bold", o.paid ? "text-emerald-600" : "text-amber-600")}><Icon name={o.paid ? "check_circle" : "schedule"} className="text-[15px]" />{o.paid ? "Paid" : "Unpaid"}</span></td>
                    <td className="px-5 py-3 text-right"><Badge status={o.status} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Panel>
        <Panel title="Tickets awaiting reply" icon="support_agent" action={<More href="/admin/tickets" />} flush>
          {d.tickets.length ? (
            <ul className="divide-y divide-line">
              {d.tickets.map((t: any) => (
                <li key={t.id}><Link href={`/admin/tickets/${t.id}`} className="flex items-start gap-3 px-5 py-3 hover:bg-[#fcfaff]">
                  <span className={cx("mt-1.5 h-2 w-2 shrink-0 rounded-full", t.priority === "HIGH" || t.priority === "URGENT" ? "bg-rose-500" : t.priority === "MEDIUM" ? "bg-amber-400" : "bg-sky-400")} />
                  <span className="min-w-0 flex-1"><span className="block truncate text-[13.5px] font-bold text-ink">#{t.number} {t.subject}</span><span className="text-xs text-mute">{t.user ? `${t.user.firstName ?? ""} ${t.user.lastName ?? ""}`.trim() || t.user.email : "Guest"} · {t.department?.name}</span></span>
                  <span className="shrink-0 text-xs font-semibold text-mute">{ago(t.lastReplyAt ?? t.createdAt)}</span>
                </Link></li>
              ))}
            </ul>
          ) : (
            <div className="flex flex-col items-center gap-2 px-5 py-10 text-center"><span className="grid h-12 w-12 place-items-center rounded-full bg-emerald-50 text-emerald-600"><Icon name="task_alt" className="text-[26px]" /></span><b className="text-sm text-ink">Inbox zero</b><span className="text-xs text-mute">No tickets are waiting for a reply.</span></div>
          )}
        </Panel>
      </div>

      {/* ── products, clients, domains, servers, activity ── */}
      <div className="mb-6 grid items-start gap-6 md:grid-cols-2 xl:grid-cols-3">
        <Panel title="Top plans" icon="inventory_2" action={<More href="/admin/products" />} flush>
          <ul className="divide-y divide-line">
            {d.topProducts.map((p: any, i: number) => {
              const max = d.topProducts[0]?.active || 1;
              return (
                <li key={p.id} className="px-5 py-3">
                  <div className="flex items-center justify-between gap-3 text-[13px]"><Link href={`/admin/products/${p.id}`} className="min-w-0 truncate font-bold text-ink hover:text-primary-dark">{i + 1}. {p.name}</Link><span className="shrink-0 font-bold text-ink">{p.active}</span></div>
                  <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-slate-100"><div className="h-full rounded-full bg-gradient-to-r from-primary to-primary-dark" style={{ width: `${(p.active / max) * 100}%` }} /></div>
                </li>
              );
            })}
            {!d.topProducts.length && <li className="px-5 py-6 text-sm text-mute">No active services yet.</li>}
          </ul>
        </Panel>

        <Panel title="Newest clients" icon="person_add" action={<More href="/admin/clients" />} flush>
          <ul className="divide-y divide-line">
            {d.newClients.map((c: any) => (
              <li key={c.id}><Link href={`/admin/clients/${c.id}`} className="flex items-center gap-3 px-5 py-2.5 hover:bg-[#fcfaff]">
                <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-primary-soft text-[11px] font-extrabold text-primary-dark">{`${c.firstName?.[0] ?? ""}${c.lastName?.[0] ?? ""}`.toUpperCase() || "?"}</span>
                <span className="min-w-0 flex-1"><span className="block truncate text-[13px] font-bold text-ink">{`${c.firstName ?? ""} ${c.lastName ?? ""}`.trim() || c.email}</span><span className="block truncate text-xs text-mute">{c.profile?.companyName || [c.profile?.city, c.profile?.state].filter(Boolean).join(", ") || c.email}</span></span>
                <span className="shrink-0 text-xs text-mute">{ago(c.createdAt)}</span>
              </Link></li>
            ))}
          </ul>
        </Panel>

        <Panel title="Server health" icon="monitor_heart" action={<More href="/admin/servers" />} flush>
          <ul className="divide-y divide-line">
            {serverRows.map((s: any) => (
              <li key={s.id} className="flex items-center gap-3 px-5 py-2.5">
                <span className={cx("h-2.5 w-2.5 shrink-0 rounded-full", s.ok === false ? "bg-rose-500" : s.ok ? "bg-emerald-500" : "bg-slate-300")} />
                <span className="min-w-0 flex-1"><span className="block truncate text-[13px] font-bold text-ink">{s.name}</span><span className="block truncate text-xs text-mute">{s.ok === false ? s.error : `${s.type.toLowerCase()}${s.nodes != null ? ` · ${s.nodesOnline ?? 0}/${s.nodes} nodes online` : ""}${s.latencyMs != null ? ` · ${s.latencyMs} ms` : ""}`}</span></span>
                <span className="shrink-0 text-xs font-semibold text-mute">{s.active} active</span>
              </li>
            ))}
            {!serverRows.length && <li className="px-5 py-6 text-sm text-mute">No servers added yet.</li>}
          </ul>
        </Panel>

        <Panel title="Expiring domains" icon="event_upcoming" action={<More href="/admin/domains" />} flush>
          {d.domainsExpiring.length ? (
            <ul className="divide-y divide-line">
              {d.domainsExpiring.map((x: any) => (
                <li key={x.id} className="flex items-center gap-3 px-5 py-2.5 text-[13px]">
                  <Icon name="public" className="text-primary" />
                  <span className="min-w-0 flex-1"><span className="block truncate font-bold text-ink">{x.name}</span><span className="block truncate text-xs text-mute">{x.user?.email}</span></span>
                  <span className="shrink-0 text-right text-xs"><b className="text-ink">{date(x.expiryDate)}</b><span className="block text-mute">{x.autoRenew ? "auto-renew" : "manual"}</span></span>
                </li>
              ))}
            </ul>
          ) : <p className="px-5 py-6 text-sm text-mute">No domains expire in the next 30 days.</p>}
        </Panel>

        <Panel title="Recent activity" icon="history" action={<More href="/admin/activity" />} flush className="xl:col-span-2">
          <ul className="divide-y divide-line">
            {d.activity.map((a: any) => (
              <li key={a.id} className="flex items-center gap-3 px-5 py-2.5 text-[13px]">
                <span className={cx("grid h-7 w-7 shrink-0 place-items-center rounded-full", a.staff ? "bg-primary-soft text-primary-dark" : "bg-slate-100 text-slate-500")}><Icon name={a.staff ? "badge" : a.actor === "System" ? "smart_toy" : "person"} className="text-[15px]" /></span>
                <span className="min-w-0 flex-1 truncate"><b className="text-ink">{a.actor}</b> <span className="text-slate-600">{a.action.replace(/[._]/g, " ")}</span>{a.entity && <span className="text-mute"> · {a.entity}</span>}</span>
                <span className="shrink-0 text-xs text-mute">{ago(a.createdAt)}</span>
              </li>
            ))}
          </ul>
        </Panel>
      </div>
    </>
  );
}

const AUTO_LABEL: Record<string, string> = {
  invoice_created: "Invoices generated", credit_applied: "Paid from credit", invoice_cancelled: "Invoices cancelled (ended services)", reminder_sent: "Payment reminders", overdue_1: "First overdue notices", overdue_2: "Second overdue notices", overdue_3: "Third overdue notices",
  late_fee: "Late fees added", suspended: "Services suspended", unsuspended: "Services unsuspended", terminated: "Services terminated", order_cancelled: "Unpaid orders cancelled",
  domain_notice: "Domain renewal notices", domain_expired: "Domains expired", ticket_closed: "Tickets closed", error: "Failed actions",
};
