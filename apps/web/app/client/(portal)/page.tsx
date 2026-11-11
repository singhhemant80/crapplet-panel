"use client";
import Link from "next/link";
import type { ReactNode } from "react";
import { useSession } from "@/lib/session";
import { CYCLES, date, gb, invNo, money } from "@/lib/api";
import { Badge, Copy, Icon, Loading, cx, useApi } from "@/components/ui";
import { LiveBadge, useLiveStates } from "@/components/live-state";
import { OsLogo } from "@/components/os-logo";

const greet = () => {
  const h = new Date().getHours();
  return h < 12 ? "Good morning" : h < 17 ? "Good afternoon" : "Good evening";
};
const daysUntil = (d?: string | null) => (d ? Math.ceil((new Date(d).getTime() - Date.now()) / 86400_000) : null);

export default function Dashboard() {
  const { me } = useSession();
  const { data, loading } = useApi("/client/dashboard");
  const live = useLiveStates("/client/services-live");
  if (loading || !data) return <Loading />;
  const s = data.stats;
  const a = data.account;
  const cur: string = a.currency ?? "INR";
  const services: any[] = data.services;
  const maxSpend = Math.max(1, ...data.spend.map((m: any) => m.total));
  const renewDays = daysUntil(data.nextRenewal?.date);
  const pct = Math.round((a.completeness.done / a.completeness.total) * 100);

  return (
    <div className="space-y-6">
      {/* ── welcome ── */}
      <section className="relative overflow-hidden rounded-3xl bg-[radial-gradient(110%_140%_at_0%_0%,#7c3aed_0%,#5b21b6_42%,#2e1065_100%)] p-6 text-white shadow-[0_20px_50px_-20px_rgba(76,29,149,.6)] sm:p-8">
        <div className="pointer-events-none absolute -right-20 -top-24 h-72 w-72 rounded-full bg-fuchsia-400/20 blur-3xl" />
        <div className="pointer-events-none absolute -bottom-28 right-40 h-64 w-64 rounded-full bg-indigo-400/20 blur-3xl" />
        <div className="pointer-events-none absolute inset-0 bg-[linear-gradient(rgba(255,255,255,.04)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,.04)_1px,transparent_1px)] bg-[size:32px_32px] [mask-image:linear-gradient(90deg,transparent,black)]" />
        <div className="relative flex flex-col gap-6 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <p className="text-sm font-semibold text-white/75">{new Date().toLocaleDateString("en-IN", { weekday: "long", day: "numeric", month: "long", year: "numeric" })}</p>
            <h1 className="mt-1 text-2xl font-extrabold tracking-tight sm:text-[32px]">{greet()}, {me?.firstName}</h1>
            <p className="mt-2 max-w-xl text-sm text-white/80">
              {s.overdueInvoices ? `You have ${s.overdueInvoices} overdue invoice${s.overdueInvoices > 1 ? "s" : ""} — pay now to keep your services running.` : s.activeServices ? `All ${s.activeServices} of your services are managed from here — servers, hosting, domains, billing and support.` : "Welcome to Crapplet Cloud. Deploy your first VPS or hosting plan in minutes."}
            </p>
            <div className="mt-4 flex flex-wrap gap-x-5 gap-y-1 text-[12.5px] font-semibold text-white/70">
              <span className="inline-flex items-center gap-1.5"><Icon name="badge" className="text-[16px]" />Client #{a.clientNo}</span>
              <span className="inline-flex items-center gap-1.5"><Icon name="event_available" className="text-[16px]" />Member since {date(a.since)}</span>
              {a.company && <span className="inline-flex items-center gap-1.5"><Icon name="apartment" className="text-[16px]" />{a.company}</span>}
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            {s.outstanding > 0 && <HeroBtn href={data.unpaid.length === 1 ? `/client/invoices/${data.unpaid[0].id}` : "/client/invoices?status=UNPAID"} icon="bolt" primary>Pay {money(s.outstanding, cur)}</HeroBtn>}
            <HeroBtn href="/order" icon="rocket_launch" primary={!s.outstanding}>Order new</HeroBtn>
            <HeroBtn href="/client/tickets/new" icon="support_agent">Get support</HeroBtn>
            <HeroBtn href="/client/wallet" icon="add_card">Add funds</HeroBtn>
          </div>
        </div>
      </section>

      {/* ── alerts ── */}
      {(s.overdueInvoices > 0 || s.suspendedServices > 0 || s.failedServices > 0 || data.expiringDomains.length > 0) && (
        <div className="grid gap-3 md:grid-cols-2 [&>*]:min-w-0">
          {s.overdueInvoices > 0 && <Notice tone="rose" icon="warning" title={`${s.overdueInvoices} overdue invoice${s.overdueInvoices > 1 ? "s" : ""}`} text="Services are suspended automatically when invoices stay unpaid." href="/client/invoices?status=UNPAID" cta="Pay now" />}
          {s.suspendedServices > 0 && <Notice tone="amber" icon="pause_circle" title={`${s.suspendedServices} suspended service${s.suspendedServices > 1 ? "s" : ""}`} text="Paying the overdue invoice restores them automatically." href="/client/services?status=SUSPENDED" cta="View" />}
          {s.failedServices > 0 && <Notice tone="amber" icon="build" title="A setup needs our attention" text="Our team has been alerted and is on it — no action needed from you." href="/client/services" cta="Details" />}
          {data.expiringDomains.length > 0 && <Notice tone="violet" icon="language" title={`${data.expiringDomains.length} domain${data.expiringDomains.length > 1 ? "s" : ""} expiring soon`} text={`${data.expiringDomains[0].name} expires ${date(data.expiringDomains[0].expiryDate)}`} href="/client/domains" cta="Renew" />}
        </div>
      )}

      {/* ── KPIs ── */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-6">
        <Kpi href="/client/services?status=ACTIVE" icon="dns" tone="violet" label="Active services" value={s.activeServices} hint={s.pendingServices ? `${s.pendingServices} being set up` : `${services.length} in total`} />
        <Kpi href="/client/invoices?status=UNPAID" icon="receipt_long" tone={s.outstanding ? "rose" : "emerald"} label="Amount due" value={money(s.outstanding, cur)} hint={s.unpaidInvoices ? `${s.unpaidInvoices} unpaid invoice${s.unpaidInvoices > 1 ? "s" : ""}` : "Nothing to pay"} />
        <Kpi href="/client/wallet" icon="account_balance_wallet" tone="indigo" label="Account credit" value={money(s.creditBalance, cur)} hint="Used automatically on invoices" />
        <Kpi href="/client/tickets" icon="support_agent" tone={s.awaitingReply ? "amber" : "sky"} label="Open tickets" value={s.openTickets} hint={s.awaitingReply ? `${s.awaitingReply} answered — reply needed` : "Average reply under 15 min"} />
        <Kpi href="/client/domains" icon="language" tone="teal" label="Domains" value={s.activeDomains} hint={data.expiringDomains.length ? `${data.expiringDomains.length} expiring in 60 days` : "All up to date"} />
        <Kpi href={data.nextRenewal ? `/client/services/${data.nextRenewal.id}` : "/client/services"} icon="event_repeat" tone="fuchsia" label="Next renewal" value={data.nextRenewal ? date(data.nextRenewal.date) : "—"} hint={data.nextRenewal ? `${money(data.nextRenewal.amount, data.nextRenewal.currency ?? cur)} · ${renewDays! <= 0 ? "due now" : `in ${renewDays} day${renewDays === 1 ? "" : "s"}`}` : "No upcoming renewals"} />
      </div>

      {/* ── services + billing ── */}
      <div className="grid items-start gap-6 xl:grid-cols-[minmax(0,1fr)_380px]">
        <Panel title="Your services" icon="dns" sub={`${services.length} service${services.length === 1 ? "" : "s"} · about ${money(s.monthlySpend, cur)}/month`} action={<PanelLink href="/client/services">View all</PanelLink>} flush>
          {services.length ? (
            <ul className="divide-y divide-[#f1edf9]">
              {services.slice(0, 8).map((x) => {
                const st = live.states[x.id];
                const due = daysUntil(x.nextDueDate);
                return (
                  <li key={x.id} className="group flex flex-wrap items-center gap-x-4 gap-y-2 px-5 py-4 transition hover:bg-[#fbf9ff] sm:flex-nowrap">
                    <ServiceIcon kind={x.kind} os={x.os} />
                    <Link href={`/client/services/${x.id}`} className="min-w-0 flex-1">
                      <div className="flex items-center gap-2"><span className="truncate text-[14.5px] font-bold text-ink group-hover:text-primary-dark">{x.product}</span>{x.status !== "ACTIVE" && <Badge status={x.status} />}</div>
                      <div className="mt-0.5 flex flex-wrap items-center gap-x-3 text-[12.5px] text-mute">
                        <span className="truncate">{x.hostname ?? "—"}</span>
                        {x.specs && x.kind === "vps" && <span className="hidden sm:inline">{x.specs.cpu} vCPU · {gb(x.specs.ramMb)} · {x.specs.diskGb} GB</span>}
                      </div>
                    </Link>
                    <div className="hidden w-[150px] shrink-0 md:block">
                      {x.ip ? <span className="inline-flex items-center gap-1 font-mono text-[12.5px] text-slate-700">{x.ip}<Copy text={x.ip} /></span> : <span className="text-xs text-mute">{x.kind === "hosting" ? "Shared IP" : "—"}</span>}
                    </div>
                    <div className="w-[96px] shrink-0">{st ? <LiveBadge state={st.state} reason={st.reason} /> : x.status === "ACTIVE" ? <LiveBadge state="running" /> : <span className="text-xs text-mute">—</span>}</div>
                    <div className="hidden w-[118px] shrink-0 text-right sm:block">
                      <div className="text-[13px] font-bold text-ink">{money(x.amount, x.currency ?? cur)}</div>
                      <div className={cx("text-[11.5px]", due !== null && due <= 7 ? "font-semibold text-rose-600" : "text-mute")}>{x.nextDueDate ? `due ${date(x.nextDueDate)}` : CYCLES[x.cycle]}</div>
                    </div>
                    <Link href={`/client/services/${x.id}`} className="grid h-9 w-9 shrink-0 place-items-center rounded-xl border border-line text-slate-500 transition group-hover:border-primary group-hover:bg-primary group-hover:text-white" aria-label="Manage">
                      <Icon name="arrow_forward" className="text-[18px]" />
                    </Link>
                  </li>
                );
              })}
            </ul>
          ) : (
            <div className="flex flex-col items-center px-6 py-12 text-center">
              <span className="grid h-16 w-16 place-items-center rounded-2xl bg-primary-soft text-primary-dark"><Icon name="rocket_launch" className="text-[32px]" /></span>
              <div className="mt-4 text-lg font-extrabold text-ink">Launch your first service</div>
              <p className="mt-1 max-w-sm text-sm text-mute">NVMe VPS in India with your choice of IP, or cPanel hosting for your website — ready within minutes of payment.</p>
              <div className="mt-5 flex gap-2"><Link href="/order" className="inline-flex h-10 items-center gap-2 rounded-xl bg-primary-dark px-4 text-sm font-bold text-white">Browse plans</Link></div>
            </div>
          )}
        </Panel>

        <div className="space-y-6">
          <Panel title="Billing" icon="receipt_long" action={<PanelLink href="/client/invoices">Invoices</PanelLink>}>
            <div className={cx("rounded-2xl p-4", s.outstanding ? "bg-gradient-to-br from-rose-50 to-white ring-1 ring-rose-100" : "bg-gradient-to-br from-emerald-50 to-white ring-1 ring-emerald-100")}>
              <div className="text-xs font-bold uppercase tracking-wider text-mute">{s.outstanding ? "Total due" : "You're all paid up"}</div>
              <div className={cx("mt-1 text-[28px] font-extrabold tracking-tight", s.outstanding ? "text-rose-600" : "text-emerald-700")}>{money(s.outstanding, cur)}</div>
              {s.outstanding > 0 && <Link href={data.unpaid.length === 1 ? `/client/invoices/${data.unpaid[0].id}` : "/client/invoices?status=UNPAID"} className="mt-3 flex h-10 items-center justify-center gap-2 rounded-xl bg-rose-600 text-sm font-bold text-white hover:bg-rose-700"><Icon name="bolt" className="text-[18px]" />Pay now with UPI / card</Link>}
            </div>
            {data.unpaid.length > 0 && (
              <ul className="mt-3 divide-y divide-[#f1edf9]">
                {data.unpaid.slice(0, 4).map((i: any) => (
                  <li key={i.id}>
                    <Link href={`/client/invoices/${i.id}`} className="flex items-center justify-between gap-3 py-2.5 text-sm hover:text-primary-dark">
                      <span className="min-w-0"><span className="block font-bold text-ink">{invNo(i)}</span><span className={cx("block text-xs", i.overdue ? "font-semibold text-rose-600" : "text-mute")}>{i.overdue ? "Overdue since" : "Due"} {date(i.dueDate)}</span></span>
                      <span className="font-extrabold text-ink">{money(i.balance, i.currency ?? cur)}</span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
            <div className="mt-4 border-t border-line pt-4">
              <div className="mb-3 flex items-center justify-between text-xs font-bold text-mute"><span>Payments — last 6 months</span><span className="text-ink">{money(data.spend.reduce((t: number, m: any) => t + m.total, 0), cur)}</span></div>
              <div className="flex items-end gap-2">
                {data.spend.map((m: any, i: number) => (
                  <div key={i} className="group flex min-w-0 flex-1 flex-col items-center gap-1.5" title={`${m.label}: ${money(m.total, cur)}`}>
                    <div className="flex h-24 w-full items-end">
                      <div className={cx("w-full rounded-t-lg transition", i === data.spend.length - 1 ? "bg-gradient-to-t from-primary-dark to-primary" : m.total ? "bg-[#d9cbfa] group-hover:bg-[#c4adf6]" : "bg-[#efe9fc]")} style={{ height: `${Math.max(4, Math.round((m.total / maxSpend) * 96))}px` }} />
                    </div>
                    <span className="text-[10.5px] font-semibold text-mute">{m.label}</span>
                  </div>
                ))}
              </div>
            </div>
          </Panel>
        </div>
      </div>

      {/* ── support, domains, account ── */}
      <div className="grid items-start gap-6 lg:grid-cols-2 2xl:grid-cols-3">
        <Panel title="Support" icon="support_agent" action={<PanelLink href="/client/tickets/new">New ticket</PanelLink>} flush>
          {data.tickets.length ? (
            <ul className="divide-y divide-[#f1edf9]">
              {data.tickets.map((t: any) => (
                <li key={t.id}>
                  <Link href={`/client/tickets/${t.id}`} className="flex items-center gap-3 px-5 py-3 hover:bg-[#fbf9ff]">
                    <span className={cx("grid h-9 w-9 shrink-0 place-items-center rounded-xl", t.status === "ANSWERED" ? "bg-amber-50 text-amber-600" : t.status === "CLOSED" ? "bg-slate-100 text-slate-400" : "bg-sky-50 text-sky-600")}><Icon name={t.status === "ANSWERED" ? "mark_chat_unread" : "chat"} className="text-[18px]" /></span>
                    <span className="min-w-0 flex-1"><span className="block truncate text-[13.5px] font-bold text-ink">{t.subject}</span><span className="block text-xs text-mute">#{t.number} · {t.department} · {date(t.lastReplyAt, true)}</span></span>
                    <Badge status={t.status} />
                  </Link>
                </li>
              ))}
            </ul>
          ) : (
            <div className="px-5 py-8 text-center">
              <span className="mx-auto grid h-12 w-12 place-items-center rounded-2xl bg-emerald-50 text-emerald-600"><Icon name="headset_mic" /></span>
              <div className="mt-3 text-sm font-bold text-ink">We're here 24/7</div>
              <p className="mt-1 text-xs text-mute">Hindi or English — open a ticket and an engineer replies, usually within 15 minutes.</p>
            </div>
          )}
          <div className="grid grid-cols-2 gap-2 border-t border-line p-3">
            <QuickLink href="/client/knowledgebase" icon="menu_book">Knowledgebase</QuickLink>
            <QuickLink href="/client/downloads" icon="download">Downloads</QuickLink>
          </div>
        </Panel>

        <Panel title="Account & security" icon="verified_user" action={<PanelLink href="/client/profile">Profile</PanelLink>}>
          <div className="flex items-center gap-4">
            <div className="relative h-[72px] w-[72px] shrink-0">
              <svg viewBox="0 0 36 36" className="h-full w-full -rotate-90"><circle cx="18" cy="18" r="15.5" fill="none" stroke="#ede9fe" strokeWidth="3.5" /><circle cx="18" cy="18" r="15.5" fill="none" stroke="url(#g)" strokeWidth="3.5" strokeLinecap="round" strokeDasharray={`${(pct / 100) * 97.4} 97.4`} /><defs><linearGradient id="g"><stop stopColor="#a855f7" /><stop offset="1" stopColor="#6d28d9" /></linearGradient></defs></svg>
              <span className="absolute inset-0 grid place-items-center text-sm font-extrabold text-ink">{pct}%</span>
            </div>
            <div className="min-w-0">
              <div className="text-sm font-extrabold text-ink">{pct === 100 ? "Your account is fully set up" : "Finish setting up your account"}</div>
              <div className="text-xs text-mute">{pct === 100 ? "Everything's in place." : `Still to do: ${a.completeness.missing.join(", ")}`}</div>
            </div>
          </div>
          <ul className="mt-4 space-y-2">
            <Check ok={a.emailVerified} label="Email address verified" href="/client/profile" />
            <Check ok={a.twoFactor} label="Two-factor sign-in" href="/client/security" cta="Turn on" />
            <Check ok={!!a.gstin} label={a.gstin ? `GSTIN ${a.gstin}` : "GSTIN for input tax credit (businesses)"} href="/client/profile" cta="Add" soft />
          </ul>
          {a.logins.length > 0 && (
            <div className="mt-4 border-t border-line pt-3">
              <div className="mb-2 text-xs font-bold text-mute">Recent sign-ins</div>
              {a.logins.map((l: any, i: number) => (
                <div key={i} className="flex items-center justify-between gap-2 py-1 text-xs">
                  <span className="flex min-w-0 items-center gap-1.5 text-slate-700"><Icon name={/mobile|android|iphone/i.test(l.userAgent ?? "") ? "smartphone" : "computer"} className="text-[16px] text-mute" /><span className="truncate font-mono">{l.ip}</span></span>
                  <span className="shrink-0 text-mute">{date(l.createdAt, true)}</span>
                </div>
              ))}
            </div>
          )}
        </Panel>

        <div className="space-y-6 lg:col-span-2 2xl:col-span-1">
          {data.expiringDomains.length > 0 && (
            <Panel title="Domains expiring soon" icon="language" action={<PanelLink href="/client/domains">All domains</PanelLink>} flush>
              <ul className="divide-y divide-[#f1edf9]">
                {data.expiringDomains.map((d: any) => {
                  const n = daysUntil(d.expiryDate);
                  return (
                    <li key={d.id}>
                      <Link href={`/client/domains/${d.id}`} className="flex items-center justify-between gap-3 px-5 py-3 hover:bg-[#fbf9ff]">
                        <span className="min-w-0"><span className="block truncate text-sm font-bold text-ink">{d.name}</span><span className="block text-xs text-mute">{d.autoRenew ? "Auto-renew on" : "Auto-renew off"}</span></span>
                        <span className={cx("rounded-full px-2.5 py-1 text-xs font-bold", n !== null && n <= 15 ? "bg-rose-50 text-rose-600" : "bg-amber-50 text-amber-700")}>{n !== null && n <= 0 ? "Expired" : `${n} days`}</span>
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </Panel>
          )}
          <Panel title="Recent payments" icon="payments" action={<PanelLink href="/client/payments">All payments</PanelLink>} flush>
            {data.transactions.length ? (
              <ul className="divide-y divide-[#f1edf9]">
                {data.transactions.map((t: any) => (
                  <li key={t.id} className="flex items-center gap-3 px-5 py-3">
                    <span className={cx("grid h-9 w-9 shrink-0 place-items-center rounded-xl", t.type === "REFUND" ? "bg-rose-50 text-rose-600" : "bg-emerald-50 text-emerald-600")}><Icon name={t.type === "REFUND" ? "undo" : t.type === "WALLET_TOPUP" ? "savings" : "check"} className="text-[18px]" /></span>
                    <span className="min-w-0 flex-1"><span className="block truncate text-[13.5px] font-semibold text-ink">{t.description ?? t.type.replace(/_/g, " ").toLowerCase()}</span><span className="block text-xs text-mute">{date(t.createdAt, true)} · {String(t.gateway).toUpperCase()}</span></span>
                    <span className={cx("text-sm font-extrabold", t.type === "REFUND" ? "text-rose-600" : "text-emerald-600")}>{t.type === "REFUND" ? "−" : "+"}{money(Math.abs(t.amount), t.currency)}</span>
                  </li>
                ))}
              </ul>
            ) : <p className="px-5 py-8 text-center text-sm text-mute">No payments yet.</p>}
          </Panel>
        </div>
      </div>

      {/* ── news + referral ── */}
      <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_380px]">
        <Panel title="Announcements" icon="campaign" flush>
          {data.announcements.length ? (
            <ul className="divide-y divide-[#f1edf9]">
              {data.announcements.map((n: any) => (
                <li key={n.id} className="flex gap-4 px-5 py-4">
                  <div className="w-14 shrink-0 rounded-xl bg-primary-tint py-1.5 text-center"><div className="text-lg font-extrabold leading-none text-primary-dark">{new Date(n.publishedAt).getDate()}</div><div className="text-[10px] font-bold uppercase text-mute">{new Date(n.publishedAt).toLocaleString("en-IN", { month: "short" })}</div></div>
                  <div className="min-w-0"><div className="text-sm font-bold text-ink">{n.title}</div><p className="mt-0.5 line-clamp-2 text-[13px] text-mute">{n.body}</p></div>
                </li>
              ))}
            </ul>
          ) : <p className="px-5 py-8 text-center text-sm text-mute">No announcements right now.</p>}
        </Panel>
        <section className="relative overflow-hidden rounded-2xl bg-gradient-to-br from-[#1d0b45] to-[#3b1786] p-6 text-white shadow-card">
          <div className="pointer-events-none absolute -right-10 -top-10 h-40 w-40 rounded-full bg-fuchsia-500/25 blur-2xl" />
          <span className="relative grid h-11 w-11 place-items-center rounded-xl bg-white/10"><Icon name="redeem" className="text-[22px] text-fuchsia-200" /></span>
          <div className="relative mt-4 text-lg font-extrabold">Refer & earn</div>
          {a.affiliate ? (
            <>
              <p className="relative mt-1 text-sm text-white/75">{a.affiliate.referrals} referral{a.affiliate.referrals === 1 ? "" : "s"} so far · {money(a.affiliate.balance, cur)} earned</p>
              <div className="relative mt-4 flex items-center justify-between rounded-xl bg-white/10 px-3 py-2 font-mono text-sm">{a.affiliate.code}<Copy text={a.affiliate.code} /></div>
            </>
          ) : <p className="relative mt-1 text-sm text-white/75">Earn commission on every customer you send our way — paid into your wallet.</p>}
          <Link href="/client/affiliates" className="relative mt-4 inline-flex h-10 items-center gap-2 rounded-xl bg-white px-4 text-sm font-bold text-primary-dark">{a.affiliate ? "View earnings" : "Become an affiliate"}<Icon name="arrow_forward" className="text-[17px]" /></Link>
        </section>
      </div>
    </div>
  );
}

// ───── building blocks ─────
function HeroBtn({ href, icon, children, primary }: { href: string; icon: string; children: ReactNode; primary?: boolean }) {
  return (
    <Link href={href} className={cx("inline-flex h-11 items-center gap-2 rounded-xl px-4 text-[13.5px] font-bold transition hover:-translate-y-px", primary ? "bg-white text-primary-dark shadow-lg" : "border border-white/25 bg-white/10 text-white backdrop-blur hover:bg-white/20")}>
      <Icon name={icon} className="text-[19px]" />
      {children}
    </Link>
  );
}

const TONES: Record<string, string> = {
  violet: "from-violet-500 to-purple-600",
  rose: "from-rose-500 to-pink-600",
  emerald: "from-emerald-500 to-teal-600",
  indigo: "from-indigo-500 to-blue-600",
  amber: "from-amber-400 to-orange-500",
  sky: "from-sky-500 to-cyan-600",
  teal: "from-teal-500 to-emerald-600",
  fuchsia: "from-fuchsia-500 to-purple-600",
};
function Kpi({ href, icon, tone, label, value, hint }: { href: string; icon: string; tone: string; label: string; value: ReactNode; hint?: string }) {
  return (
    <Link href={href} className="group relative overflow-hidden rounded-2xl border border-[#ece7f7] bg-white p-4 shadow-card transition hover:-translate-y-0.5 hover:border-[#dccafb] hover:shadow-lg">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-[12.5px] font-semibold text-mute">{label}</div>
          <div className="mt-1 truncate text-[22px] font-extrabold tracking-tight text-ink">{value}</div>
        </div>
        <span className={cx("grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-gradient-to-br text-white shadow-md", TONES[tone])}><Icon name={icon} className="text-[20px]" /></span>
      </div>
      {hint && <div className="mt-2 truncate text-[12px] text-mute">{hint}</div>}
    </Link>
  );
}

function Panel({ title, icon, sub, action, children, flush }: { title: string; icon: string; sub?: string; action?: ReactNode; children: ReactNode; flush?: boolean }) {
  return (
    <section className="overflow-hidden rounded-2xl border border-[#ece7f7] bg-white shadow-card">
      <div className="flex items-center justify-between gap-3 border-b border-[#f1edf9] px-5 py-4">
        <div className="flex min-w-0 items-center gap-3">
          <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-primary-soft text-primary-dark"><Icon name={icon} className="text-[19px]" /></span>
          <div className="min-w-0"><h2 className="truncate text-[15px] font-extrabold text-ink">{title}</h2>{sub && <div className="truncate text-xs text-mute">{sub}</div>}</div>
        </div>
        {action}
      </div>
      <div className={flush ? "" : "p-5"}>{children}</div>
    </section>
  );
}
function PanelLink({ href, children }: { href: string; children: ReactNode }) {
  return <Link href={href} className="inline-flex shrink-0 items-center gap-0.5 rounded-lg px-2 py-1 text-[13px] font-bold text-primary-dark hover:bg-primary-tint">{children}<Icon name="chevron_right" className="text-[18px]" /></Link>;
}
function Notice({ tone, icon, title, text, href, cta }: { tone: "rose" | "amber" | "violet"; icon: string; title: string; text: string; href: string; cta: string }) {
  const t = { rose: ["bg-rose-50 ring-rose-200", "bg-rose-500", "bg-rose-600 hover:bg-rose-700"], amber: ["bg-amber-50 ring-amber-200", "bg-amber-500", "bg-amber-600 hover:bg-amber-700"], violet: ["bg-violet-50 ring-violet-200", "bg-primary", "bg-primary-dark hover:bg-primary-deep"] }[tone];
  return (
    <div className={cx("flex min-w-0 items-center gap-3 rounded-2xl p-3.5 ring-1", t[0])}>
      <span className={cx("grid h-10 w-10 shrink-0 place-items-center rounded-xl text-white", t[1])}><Icon name={icon} className="text-[20px]" /></span>
      <div className="min-w-0 flex-1"><div className="text-sm font-extrabold text-ink">{title}</div><div className="truncate text-xs text-slate-600">{text}</div></div>
      <Link href={href} className={cx("shrink-0 rounded-lg px-3 py-2 text-xs font-bold text-white", t[2])}>{cta}</Link>
    </div>
  );
}
function ServiceIcon({ kind, os }: { kind: string; os?: any }) {
  if (kind === "vps" && os) return <OsLogo os={os} size={42} className="rounded-xl" />;
  return (
    <span className={cx("grid h-[42px] w-[42px] shrink-0 place-items-center rounded-xl", kind === "hosting" ? "bg-sky-50 text-sky-600" : kind === "vps" ? "bg-primary-soft text-primary-dark" : "bg-slate-100 text-slate-600")}>
      <Icon name={kind === "hosting" ? "language" : kind === "vps" ? "terminal" : "widgets"} className="text-[21px]" />
    </span>
  );
}
function QuickLink({ href, icon, children }: { href: string; icon: string; children: ReactNode }) {
  return <Link href={href} className="flex items-center justify-center gap-2 rounded-xl py-2 text-[13px] font-bold text-slate-600 hover:bg-primary-tint hover:text-primary-dark"><Icon name={icon} className="text-[18px]" />{children}</Link>;
}
function Check({ ok, label, href, cta = "Fix", soft }: { ok: boolean; label: string; href: string; cta?: string; soft?: boolean }) {
  return (
    <li className="flex items-center gap-2.5 text-[13px]">
      <span className={cx("grid h-6 w-6 shrink-0 place-items-center rounded-full", ok ? "bg-emerald-100 text-emerald-600" : soft ? "bg-slate-100 text-slate-400" : "bg-amber-100 text-amber-600")}><Icon name={ok ? "check" : soft ? "remove" : "priority_high"} className="text-[15px]" /></span>
      <span className={cx("min-w-0 flex-1 truncate", ok ? "text-slate-700" : "font-semibold text-ink")}>{label}</span>
      {!ok && <Link href={href} className="shrink-0 text-xs font-bold text-primary-dark hover:underline">{cta}</Link>}
    </li>
  );
}
