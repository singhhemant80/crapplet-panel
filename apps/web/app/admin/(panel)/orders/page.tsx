"use client";
import Link from "next/link";
import { Suspense, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { api, CYCLES, money } from "@/lib/api";
import { Badge, Button, Empty, Icon, Loading, PageHeader, Pager, Spinner, cx, toast, useApi } from "@/components/ui";
import { Ago, Avatar, FilterSelect, ListShell, SearchBox, StatusTabs, initialsOf, planIcon, type Tab } from "@/components/admin/list-kit";

const TABS: Tab[] = [
  { key: "", label: "All orders" },
  { key: "PENDING", label: "Pending", tone: "amber" },
  { key: "ACTIVE", label: "Active", tone: "green" },
  { key: "SUSPENDED", label: "Suspended", tone: "rose" },
  { key: "TERMINATED", label: "Terminated", tone: "slate" },
  { key: "CANCELLED", label: "Cancelled", tone: "slate" },
  { key: "FRAUD", label: "Fraud", tone: "rose" },
];

const inr = (paise: number) => money(paise, "INR").replace(/\.00$/, "");

function Orders() {
  const sp = useSearchParams();
  const router = useRouter();
  const [status, setStatus] = useState(sp.get("status") ?? "");
  const [q, setQ] = useState(sp.get("q") ?? "");
  const [period, setPeriod] = useState("");
  const [payment, setPayment] = useState("");
  const [page, setPage] = useState(1);
  const [busy, setBusy] = useState<string | null>(null);
  const qs = new URLSearchParams({ page: String(page), ...(status && { status }), ...(q && { q }), ...(period && { period }), ...(payment && { payment }) });
  const { data, loading, reload } = useApi(`/admin/orders?${qs}`, [page, status, q, period, payment]);
  const reset = (f: () => void) => { f(); setPage(1); };
  const filtered = !!(q || period || payment);

  async function act(o: any, path: string, body: object, done: string) {
    setBusy(o.id);
    try {
      await api(`/admin/orders/${o.id}/${path}`, { body });
      toast.success(done);
      reload();
    } catch (e: any) {
      toast.error(e.message);
    } finally {
      setBusy(null);
    }
  }
  const accept = (o: any) => confirm(o.invoice?.status !== "PAID" ? `${o.number}: the invoice isn't paid yet. Accept and set it up anyway?` : `Accept ${o.number} and set up its services?`) && act(o, "accept", {}, `${o.number} accepted`);
  const cancel = (o: any) => confirm(`Cancel ${o.number}? Reserved IPs are released and the invoice is cancelled.`) && act(o, "cancel", {}, `${o.number} cancelled`);
  const fraud = (o: any) => confirm(`Mark ${o.number} as fraud? The order is cancelled.`) && act(o, "cancel", { fraud: true }, `${o.number} marked as fraud`);

  const s = data?.summary;
  return (
    <>
      <PageHeader
        title="Orders"
        subtitle="Every order placed by customers, resellers and staff — accept, cancel or open one to manage its services."
        actions={<Button icon="add_shopping_cart" href="/admin/orders/new">New order</Button>}
        stats={
          s
            ? [
                ["Today", `${s.todayCount} order${s.todayCount === 1 ? "" : "s"}`, inr(s.todayInr)],
                ["Paid this month", inr(s.monthPaidInr), `${s.monthPaidCount} orders`],
                ["Awaiting payment", String(s.awaitingPayment), "pending · invoice unpaid"],
                ["Paid · not set up", <span key="a" className={s.toAccept ? "text-amber-600" : ""}>{s.toAccept}</span>, "pending · ready to accept"],
              ]
            : undefined
        }
      />

      <ListShell
        toolbar={
          <>
            <StatusTabs tabs={TABS} value={status} onChange={(k) => reset(() => setStatus(k))} counts={data?.counts} />
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
              <SearchBox value={q} onSearch={(v) => reset(() => setQ(v))} placeholder="Search order #, customer, email, hostname, domain…" className="flex-1" />
              <div className="flex gap-2 overflow-x-auto [scrollbar-width:none]">
                <FilterSelect label="Placed" icon="calendar_month" value={period} onChange={(v) => reset(() => setPeriod(v))} options={[["", "Any time"], ["today", "Today"], ["7d", "Last 7 days"], ["30d", "Last 30 days"]]} />
                <FilterSelect label="Payment" icon="payments" value={payment} onChange={(v) => reset(() => setPayment(v))} options={[["", "Any payment"], ["paid", "Paid"], ["unpaid", "Unpaid"]]} />
                {filtered && <button onClick={() => reset(() => { setQ(""); setPeriod(""); setPayment(""); })} className="h-10 shrink-0 rounded-xl px-3 text-[13px] font-bold text-primary-dark hover:bg-primary-tint">Clear</button>}
              </div>
            </div>
          </>
        }
        footer={data && <Pager page={data.page} pageSize={data.pageSize} total={data.total} onPage={setPage} />}
      >
        {loading && !data ? <Loading /> : !data?.orders.length ? (
          <Empty icon="shopping_bag" title={filtered || status ? "No orders match" : "No orders yet"}>
            <p className="text-sm text-mute">{filtered || status ? "Try another tab or clear the filters." : "Orders appear here when customers check out."}</p>
          </Empty>
        ) : (
          <div className={cx("transition-opacity", loading && "opacity-60")}>
            {/* desktop table */}
            <div className="hidden xl:block">
              <table className="w-full table-fixed text-left text-sm">
                <colgroup><col style={{ width: "13%" }} /><col style={{ width: "20%" }} /><col style={{ width: "23%" }} /><col style={{ width: "11%" }} /><col style={{ width: "12%" }} /><col style={{ width: "10%" }} /><col style={{ width: "176px" }} /></colgroup>
                <thead>
                  <tr className="border-b border-line bg-[#fbf9ff] text-[11.5px] font-bold uppercase tracking-wider text-mute">
                    <th className="py-3 pl-5 pr-3">Order</th>
                    <th className="px-3 py-3">Customer</th>
                    <th className="px-3 py-3">Items</th>
                    <th className="px-3 py-3 text-right">Amount</th>
                    <th className="px-3 py-3">Payment</th>
                    <th className="px-3 py-3">Status</th>
                    <th className="py-3 pl-3 pr-5 text-right"><span className="sr-only">Actions</span></th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {data.orders.map((o: any) => (
                    <tr key={o.id} className="group cursor-pointer align-top transition hover:bg-[#fbf9ff]" onClick={(e) => { if (!(e.target as HTMLElement).closest("a,button")) router.push(`/admin/orders/${o.id}`); }}>
                      <td className="py-3.5 pl-5 pr-3">
                        <Link href={`/admin/orders/${o.id}`} className="font-mono text-[13px] font-bold text-primary-dark hover:underline">{o.number}</Link>
                        <div className="mt-0.5 text-[12px] text-mute"><Ago at={o.createdAt} /></div>
                        {o.resellerBrand && <span title={`Ordered through reseller ${o.resellerBrand}`} className="mt-1 inline-flex max-w-[130px] items-center gap-1 whitespace-nowrap rounded-md bg-sky-50 px-1.5 py-0.5 text-[10.5px] font-bold text-sky-700 ring-1 ring-sky-200"><Icon name="storefront" className="shrink-0 text-[13px]" /><span className="truncate">{o.resellerBrand}</span></span>}
                      </td>
                      <td className="px-3 py-3.5"><Customer o={o} /></td>
                      <td className="px-3 py-3.5"><Items o={o} /></td>
                      <td className="whitespace-nowrap px-3 py-3.5 text-right">
                        <div className="font-extrabold tabular-nums text-ink">{money(o.total, o.currency)}</div>
                        {o.services[0]?.billingCycle && <div className="text-[12px] text-mute">{CYCLES[o.services[0].billingCycle]}</div>}
                        {o.promoCode && <div className="mt-0.5 inline-flex items-center gap-0.5 text-[11px] font-bold text-emerald-600"><Icon name="sell" className="text-[13px]" />{o.promoCode}</div>}
                      </td>
                      <td className="px-3 py-3.5"><Payment o={o} /></td>
                      <td className="px-3 py-3.5"><Badge status={o.status} /></td>
                      <td className="whitespace-nowrap py-3.5 pl-3 pr-5 text-right"><Actions o={o} busy={busy === o.id} accept={accept} cancel={cancel} fraud={fraud} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {/* phone / tablet cards */}
            <ul className="divide-y divide-line xl:hidden">
              {data.orders.map((o: any) => (
                <li key={o.id} className="space-y-3 p-4">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <Link href={`/admin/orders/${o.id}`} className="font-mono text-[14px] font-bold text-primary-dark">{o.number}</Link>
                      <div className="text-[12px] text-mute"><Ago at={o.createdAt} />{o.resellerBrand ? ` · via ${o.resellerBrand}` : ""}</div>
                    </div>
                    <div className="text-right">
                      <div className="font-extrabold tabular-nums text-ink">{money(o.total, o.currency)}</div>
                      <div className="mt-1"><Badge status={o.status} /></div>
                    </div>
                  </div>
                  <Customer o={o} />
                  <Items o={o} />
                  <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl bg-[#fbf9ff] px-3 py-2">
                    <Payment o={o} inline />
                    <Actions o={o} busy={busy === o.id} accept={accept} cancel={cancel} fraud={fraud} />
                  </div>
                </li>
              ))}
            </ul>
          </div>
        )}
      </ListShell>
    </>
  );
}

function Customer({ o }: { o: any }) {
  const u = o.user;
  const name = `${u.firstName ?? ""} ${u.lastName ?? ""}`.trim() || u.email;
  return (
    <Link href={`/admin/clients/${u.id}`} className="group/c flex min-w-0 items-center gap-2.5">
      <Avatar name={initialsOf(u.firstName, u.lastName, u.email)} seed={u.id} size={34} />
      <span className="min-w-0">
        <span className="block truncate font-bold text-ink group-hover/c:text-primary-dark">{name}</span>
        <span className="block max-w-[180px] truncate text-[12px] text-mute">{u.profile?.companyName || u.email}</span>
      </span>
    </Link>
  );
}

function Items({ o }: { o: any }) {
  const rows = [
    ...o.services.map((s: any) => ({ key: s.id, icon: planIcon(s.product?.type, s.product?.provisioner), title: s.product?.name, sub: s.hostname, ip: s.ips?.[0]?.address, href: `/admin/services/${s.id}` })),
    ...o.domains.map((d: any) => ({ key: d.id, icon: d.action === "transfer" ? "swap_horiz" : "public", title: d.name, sub: d.action === "transfer" ? "Domain transfer" : "Domain registration", href: "/admin/domains" })),
  ];
  if (!rows.length) return <span className="text-[13px] text-mute">Wallet / custom items</span>;
  return (
    <ul className="space-y-1.5">
      {rows.slice(0, 2).map((r) => (
        <li key={r.key} className="flex min-w-0 items-start gap-2">
          <span className="mt-0.5 grid h-6 w-6 shrink-0 place-items-center rounded-md bg-primary-soft text-primary-dark"><Icon name={r.icon} className="text-[15px]" /></span>
          <Link href={r.href} className="min-w-0 leading-tight hover:text-primary-dark">
            <span className="block truncate text-[13px] font-semibold text-ink">{r.title}</span>
            {(r.sub || r.ip) && <span className="block truncate font-mono text-[11.5px] text-mute">{[r.sub, r.ip].filter(Boolean).join(" · ")}</span>}
          </Link>
        </li>
      ))}
      {rows.length > 2 && <li className="pl-8 text-[12px] font-bold text-primary-dark">+{rows.length - 2} more</li>}
    </ul>
  );
}

function Payment({ o, inline }: { o: any; inline?: boolean }) {
  const i = o.invoice;
  if (!i) return <span className="text-[12.5px] text-mute">No invoice</span>;
  const overdue = i.status === "UNPAID" && i.dueDate && new Date(i.dueDate) < new Date();
  const part = i.status === "UNPAID" && i.amountPaid > 0;
  return (
    <Link href={`/admin/invoices/${i.id}`} className={cx("flex gap-1.5", inline ? "items-center" : "flex-col items-start")}>
      <Badge status={part ? "PARTIAL" : i.status}>{part ? "Part paid" : undefined}</Badge>
      <span className={cx("text-[12px]", overdue ? "font-bold text-rose-600" : "text-mute")}>
        {i.status === "PAID" && i.paidAt ? <>paid <Ago at={i.paidAt} /></> : i.status === "UNPAID" && i.dueDate ? (overdue ? "overdue" : <>due <Ago at={i.dueDate} /></>) : null}
      </span>
    </Link>
  );
}

function Actions({ o, busy, accept, cancel, fraud }: { o: any; busy: boolean; accept: (o: any) => void; cancel: (o: any) => void; fraud: (o: any) => void }) {
  const [open, setOpen] = useState(false);
  if (busy) return <Spinner className="ml-auto h-5 w-5 text-primary-dark" />;
  if (o.status !== "PENDING")
    return <Link href={`/admin/orders/${o.id}`} className="inline-flex items-center gap-0.5 text-[12.5px] font-bold text-primary-dark opacity-70 hover:opacity-100 xl:opacity-0 xl:group-hover:opacity-100">Open<Icon name="chevron_right" className="text-[17px]" /></Link>;
  return (
    <div className="relative inline-flex items-center gap-1.5">
      <Button size="sm" onClick={() => accept(o)}>Accept</Button>
      <button aria-label="More actions" aria-expanded={open} onClick={() => setOpen(!open)} onBlur={() => setTimeout(() => setOpen(false), 150)} className="grid h-8 w-8 place-items-center rounded-lg text-slate-500 ring-1 ring-line hover:bg-slate-50 hover:text-ink">
        <Icon name="more_horiz" className="text-[19px]" />
      </button>
      {open && (
        <div role="menu" className="absolute right-0 top-9 z-20 w-44 overflow-hidden rounded-xl border border-line bg-white py-1 text-left shadow-xl">
          <button role="menuitem" onMouseDown={(e) => e.preventDefault()} onClick={() => { setOpen(false); cancel(o); }} className="flex w-full items-center gap-2 px-3 py-2 text-[13px] font-semibold text-slate-700 hover:bg-slate-50"><Icon name="cancel" className="text-[18px] text-slate-500" />Cancel order</button>
          <button role="menuitem" onMouseDown={(e) => e.preventDefault()} onClick={() => { setOpen(false); fraud(o); }} className="flex w-full items-center gap-2 px-3 py-2 text-[13px] font-semibold text-rose-600 hover:bg-rose-50"><Icon name="gpp_bad" className="text-[18px]" />Mark as fraud</button>
        </div>
      )}
    </div>
  );
}

export default function Page() {
  return <Suspense fallback={<Loading />}><Orders /></Suspense>;
}
