"use client";
import Link from "next/link";
import { api, date, money, rupees } from "@/lib/api";
import { Alert, Badge, Button, Card, Loading, PageHeader, Stat, Table, Td, toast, useApi } from "@/components/ui";

function RevenueChart({ rows }: { rows: { month: string; total: number }[] }) {
  if (!rows.length) return <p className="py-10 text-center text-sm text-mute">No payments recorded yet.</p>;
  const max = Math.max(...rows.map((r) => r.total), 1);
  return (
    <div className="flex h-56 items-end gap-2 pt-6">
      {rows.map((r) => (
        <div key={r.month} className="group relative flex h-full flex-1 flex-col justify-end">
          <div className="pointer-events-none absolute -top-1 left-1/2 hidden -translate-x-1/2 whitespace-nowrap rounded-md bg-ink px-2 py-1 text-[11px] font-bold text-white group-hover:block">{rupees(r.total)}</div>
          <div className="w-full rounded-t-lg bg-gradient-to-t from-primary-dark to-primary transition group-hover:opacity-80" style={{ height: `${Math.max(3, (r.total / max) * 100)}%` }} />
          <div className="mt-2 text-center text-[11px] font-semibold text-mute">{new Date(r.month + "-01").toLocaleString("en-IN", { month: "short" })}</div>
        </div>
      ))}
    </div>
  );
}

export default function AdminDashboard() {
  const { data, loading } = useApi("/admin/dashboard");
  if (loading || !data) return <Loading />;
  const s = data.stats;
  return (
    <>
      <PageHeader title="Dashboard" subtitle={new Date().toLocaleDateString("en-IN", { weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: "Asia/Kolkata" })}
        actions={<Button variant="outline" icon="autorenew" onClick={() => api("/admin/billing/run", { body: {} }).then((r) => toast.success(`Automation run: ${r.invoices} invoices, ${r.reminders} reminders, ${r.suspended} suspensions — details in Automation`)).catch((e) => toast.error(e.message))}>Run billing now</Button>} />
      {(s.pendingPaymentReviews > 0 || s.failedProvisioning > 0) && (
        <div className="mb-6 grid gap-3 md:grid-cols-2">
          {s.pendingPaymentReviews > 0 && <Alert tone="warn"><Link href="/admin/payment-reviews" className="font-bold underline">{s.pendingPaymentReviews} UPI / bank payments</Link> are waiting for verification.</Alert>}
          {s.failedProvisioning > 0 && <Alert tone="error"><Link href="/admin/services?status=FAILED" className="font-bold underline">{s.failedProvisioning} services</Link> failed to provision and need attention.</Alert>}
        </div>
      )}
      <div className="grid grid-cols-2 gap-3 sm:gap-4 xl:grid-cols-4">
        <Stat label="Monthly recurring revenue" value={rupees(s.mrr)} icon="trending_up" tone="green" hint={`ARR ${rupees(s.arr)}`} />
        <Stat label="Collected this month" value={rupees(s.monthRevenue)} icon="payments" hint={`${s.paidThisMonth} invoices paid`} />
        <Stat label="Outstanding" value={rupees(s.outstanding)} icon="pending_actions" tone="amber" href="/admin/invoices?status=UNPAID" hint={`${s.unpaidInvoices} unpaid invoices`} />
        <Stat label="Customers" value={s.clients} icon="group" tone="sky" href="/admin/clients" hint={`${s.activeClients} with active services`} />
        <Stat label="VPS instances" value={s.vpsTotal} icon="dns" href="/admin/services?vps=1" hint={`${s.vpsActive} active`} />
        <Stat label="Suspended VPS" value={s.vpsSuspended} icon="pause_circle" tone="rose" href="/admin/services?status=SUSPENDED" />
        <Stat label="Orders (7 days)" value={s.newOrders} icon="shopping_bag" tone="slate" href="/admin/orders" hint={`${s.pendingOrders} pending`} />
        <Stat label="Open tickets" value={s.openTickets} icon="support_agent" tone="purple" href="/admin/tickets" />
      </div>
      <div className="mt-6 grid gap-6 xl:grid-cols-3">
        <Card title="Revenue — last 12 months" className="xl:col-span-2"><RevenueChart rows={data.revenue} /></Card>
        <Card title="Server health" action={<Link href="/admin/servers" className="text-sm font-bold text-primary-dark">Manage</Link>} pad={false}>
          {!data.servers.length ? <p className="p-5 text-sm text-mute">No servers yet. <Link href="/admin/servers" className="font-bold text-primary-dark">Add a Proxmox server</Link>.</p> : (
            <ul className="divide-y divide-[#f3effb]">
              {data.servers.map((sv: any) => (
                <li key={sv.id} className="px-5 py-3.5">
                  <div className="flex items-center justify-between">
                    <span className="flex items-center gap-2 text-sm font-bold text-ink"><span className={`h-2.5 w-2.5 rounded-full ${sv.status?.ok ? "bg-emerald-500" : sv.status ? "bg-rose-500" : "bg-slate-300"}`} />{sv.name}</span>
                    <span className="text-xs text-mute">{sv.activeServices} active</span>
                  </div>
                  {sv.nodes.map((n: any) => (
                    <div key={n.id} className="mt-2 grid grid-cols-[70px_1fr_1fr] items-center gap-2 text-[11px] text-mute">
                      <span className="font-semibold">{n.name}</span>
                      <Meter label="CPU" pct={n.cpuPct} />
                      <Meter label="RAM" pct={n.ramTotalMb ? (n.ramUsedMb / n.ramTotalMb) * 100 : 0} />
                    </div>
                  ))}
                  {sv.status?.error && <div className="mt-1 truncate text-xs text-rose-600">{sv.status.error}</div>}
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
      <Card title="Recent orders" className="mt-6" pad={false} action={<Link href="/admin/orders" className="text-sm font-bold text-primary-dark">All orders</Link>}>
        <Table head={["Order", "Customer", "Total", "Payment", "Status", "Date"]}>
          {data.recentOrders.map((o: any) => (
            <tr key={o.id}>
              <Td><Link className="font-bold text-primary-dark hover:underline" href={`/admin/orders/${o.id}`}>{o.number}</Link></Td>
              <Td><div className="font-semibold text-ink">{o.client}</div><div className="text-xs text-mute">{o.email}</div></Td>
              <Td className="font-semibold">{money(o.total, o.currency)}</Td>
              <Td>{o.paid ? <Badge status="PAID" /> : <Badge status="UNPAID" />}</Td>
              <Td><Badge status={o.status} /></Td>
              <Td className="whitespace-nowrap text-mute">{date(o.createdAt, true)}</Td>
            </tr>
          ))}
        </Table>
      </Card>
    </>
  );
}

function Meter({ label, pct }: { label: string; pct: number }) {
  const p = Math.min(100, Math.round(pct));
  return (
    <div className="flex items-center gap-1.5">
      <span className="w-7">{label}</span>
      <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-slate-100"><div className={`h-full rounded-full ${p > 85 ? "bg-rose-500" : p > 65 ? "bg-amber-400" : "bg-primary"}`} style={{ width: `${p}%` }} /></div>
      <span className="w-8 text-right">{p}%</span>
    </div>
  );
}

