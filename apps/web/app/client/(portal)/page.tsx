"use client";
import Link from "next/link";
import { useSession } from "@/lib/session";
import { date, money } from "@/lib/api";
import { Badge, Button, Card, Empty, Icon, Loading, Stat, useApi } from "@/components/ui";

export default function Dashboard() {
  const { me } = useSession();
  const { data, loading } = useApi("/client/dashboard");
  if (loading || !data) return <Loading />;
  const s = data.stats;
  return (
    <div className="space-y-6">
      <div className="hero-band relative overflow-hidden rounded-3xl p-6 text-white sm:p-8">
        <div className="absolute -bottom-16 -right-10 h-48 w-48 rounded-full bg-white/10" />
        <p className="text-sm font-semibold text-white/80">Namaste,</p>
        <h1 className="mt-1 text-2xl font-extrabold sm:text-3xl">{me?.firstName} 👋</h1>
        <p className="mt-2 max-w-xl text-sm text-white/85">Manage your servers, pay invoices with UPI and get help from our 24/7 team — all in one place.</p>
        <div className="relative mt-5 flex flex-wrap gap-2">
          <Link href="/order" className="inline-flex h-11 items-center gap-2 rounded-xl bg-white px-5 text-sm font-extrabold text-primary-dark shadow-lg hover:-translate-y-px">
            <Icon name="rocket_launch" className="text-[19px]" /> Deploy a VPS
          </Link>
          <Link href="/client/tickets/new" className="inline-flex h-11 items-center gap-2 rounded-xl border border-white/30 bg-white/10 px-5 text-sm font-bold text-white hover:bg-white/20">
            <Icon name="support_agent" className="text-[19px]" /> Get support
          </Link>
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Stat label="Active services" value={s.activeServices} icon="dns" tone="green" href="/client/services?status=ACTIVE" />
        <Stat label="Pending services" value={s.pendingServices} icon="hourglass_top" tone="amber" href="/client/services" />
        <Stat label="Suspended" value={s.suspendedServices} icon="pause_circle" tone="rose" href="/client/services?status=SUSPENDED" />
        <Stat label="Unpaid invoices" value={s.unpaidInvoices} icon="receipt_long" tone="purple" href="/client/invoices?status=UNPAID" hint={s.outstanding ? `${money(s.outstanding)} outstanding` : undefined} />
      </div>

      <div className="grid gap-6 xl:grid-cols-3">
        <Card className="xl:col-span-2" title="Upcoming renewals" action={<Link className="text-sm font-bold text-primary-dark hover:underline" href="/client/services">All services</Link>} pad={false}>
          {data.renewals.length ? (
            <ul className="divide-y divide-[#f3effb]">
              {data.renewals.map((r: any) => (
                <li key={r.id}>
                  <Link href={`/client/services/${r.id}`} className="flex flex-wrap items-center gap-3 px-5 py-3.5 hover:bg-primary-tint">
                    <span className="grid h-10 w-10 place-items-center rounded-xl bg-primary-soft text-primary-dark">
                      <Icon name="dns" />
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-bold text-ink">{r.product}</div>
                      <div className="truncate text-xs text-mute">
                        {r.hostname ?? "—"} {r.ip && <>· {r.ip}</>}
                      </div>
                    </div>
                    <div className="text-right">
                      <div className="text-sm font-bold text-ink">{money(r.amount)}</div>
                      <div className="text-xs text-mute">due {date(r.nextDueDate)}</div>
                    </div>
                    <Badge status={r.status} />
                  </Link>
                </li>
              ))}
            </ul>
          ) : (
            <Empty icon="dns" title="No active services yet">
              Pick a plan and choose your own IPv4 address — servers deploy within a minute of payment.
              <div className="mt-4">
                <Button href="/order" icon="add">Order a service</Button>
              </div>
            </Empty>
          )}
        </Card>

        <div className="space-y-6">
          <Card title="Account balance">
            <div className="flex items-end justify-between">
              <div>
                <div className="text-3xl font-extrabold text-ink">{money(s.creditBalance)}</div>
                <div className="text-xs text-mute">Wallet credit — applied automatically to new invoices</div>
              </div>
              <Button size="sm" variant="secondary" href="/client/wallet" icon="add">
                Top up
              </Button>
            </div>
          </Card>
          <Card title="Announcements" pad={false}>
            {data.announcements.length ? (
              <ul className="divide-y divide-[#f3effb]">
                {data.announcements.map((a: any) => (
                  <li key={a.id} className="px-5 py-3.5">
                    <div className="text-xs font-semibold text-primary-dark">{date(a.publishedAt)}</div>
                    <div className="text-sm font-bold text-ink">{a.title}</div>
                    <p className="mt-0.5 line-clamp-2 text-xs text-mute">{a.body}</p>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="px-5 py-6 text-sm text-mute">No announcements.</p>
            )}
          </Card>
        </div>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card title="Recent transactions" action={<Link className="text-sm font-bold text-primary-dark hover:underline" href="/client/payments">View all</Link>} pad={false}>
          {data.transactions.length ? (
            <ul className="divide-y divide-[#f3effb]">
              {data.transactions.map((t: any) => (
                <li key={t.id} className="flex items-center justify-between gap-3 px-5 py-3">
                  <div className="min-w-0">
                    <div className="truncate text-sm font-semibold text-ink">{t.description ?? t.type}</div>
                    <div className="text-xs text-mute">
                      {date(t.createdAt, true)} · {t.gateway.toUpperCase()}
                    </div>
                  </div>
                  <div className={`text-sm font-extrabold ${t.type === "REFUND" ? "text-rose-600" : "text-emerald-600"}`}>
                    {t.type === "REFUND" ? "−" : "+"}
                    {money(t.amount, t.currency)}
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <p className="px-5 py-6 text-sm text-mute">No transactions yet.</p>
          )}
        </Card>
        <Card title="Recent support tickets" action={<Link className="text-sm font-bold text-primary-dark hover:underline" href="/client/tickets">All tickets</Link>} pad={false}>
          {data.tickets.length ? (
            <ul className="divide-y divide-[#f3effb]">
              {data.tickets.map((t: any) => (
                <li key={t.id}>
                  <Link href={`/client/tickets/${t.id}`} className="flex items-center justify-between gap-3 px-5 py-3 hover:bg-primary-tint">
                    <div className="min-w-0">
                      <div className="truncate text-sm font-semibold text-ink">{t.subject}</div>
                      <div className="text-xs text-mute">
                        #{t.number} · {t.department} · {date(t.lastReplyAt, true)}
                      </div>
                    </div>
                    <Badge status={t.status} />
                  </Link>
                </li>
              ))}
            </ul>
          ) : (
            <p className="px-5 py-6 text-sm text-mute">No tickets — we're here 24/7 if you need us.</p>
          )}
        </Card>
      </div>
    </div>
  );
}
