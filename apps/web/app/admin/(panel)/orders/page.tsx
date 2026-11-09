"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { api, date, money } from "@/lib/api";
import { Badge, Button, Card, Input, Loading, PageHeader, Pager, Select, Table, Td, toast, useApi } from "@/components/ui";

export default function Orders() {
  const [status, setStatus] = useState("");
  const [page, setPage] = useState(1);
  const [q, setQ] = useState("");
  const router = useRouter();
  const { data, loading, reload } = useApi(`/admin/orders?page=${page}${status ? `&status=${status}` : ""}${q ? `&q=${encodeURIComponent(q)}` : ""}`, [page, status, q]);
  const act = (id: string, path: string, body = {}) => api(`/admin/orders/${id}/${path}`, { body }).then(() => { toast.success("Done"); reload(); }).catch((e) => toast.error(e.message));
  return (
    <>
      <PageHeader title="Orders" actions={<><Input className="w-56" placeholder="Order #, email, hostname…" value={q} onChange={(e) => { setQ(e.target.value); setPage(1); }} /><Select className="w-44" value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }}><option value="">All statuses</option><option>PENDING</option><option>ACTIVE</option><option>CANCELLED</option><option>FRAUD</option></Select></>} />
      <Card pad={false}>
        {loading ? <Loading /> : (
          <>
            <Table head={["Order", "Customer", "Items", "Total", "Invoice", "Status", "Date", ""]}>
              {data.orders.map((o: any) => (
                <tr key={o.id} className="cursor-pointer hover:bg-primary-tint" onClick={(e) => { if (!(e.target as HTMLElement).closest("a,button")) router.push(`/admin/orders/${o.id}`); }}>
                  <Td><Link className="font-bold text-primary-dark hover:underline" href={`/admin/orders/${o.id}`}>{o.number}</Link></Td>
                  <Td><Link className="font-semibold text-primary-dark" href={`/admin/clients/${o.user.id}`}>{o.user.firstName} {o.user.lastName}</Link><div className="text-xs text-mute">{o.ip}</div></Td>
                  <Td className="text-xs">{[...o.services.map((s: any) => `${s.product.name}${s.hostname ? ` (${s.hostname})` : ""}`), ...o.domains.map((d: any) => d.name)].join(", ")}{o.promoCode && <div className="font-bold text-emerald-600">{o.promoCode}</div>}</Td>
                  <Td className="font-semibold">{money(o.total, o.currency)}</Td>
                  <Td>{o.invoice && <Link href={`/admin/invoices/${o.invoice.id}`}><Badge status={o.invoice.status} /></Link>}</Td>
                  <Td><Badge status={o.status} /></Td>
                  <Td className="whitespace-nowrap text-mute">{date(o.createdAt, true)}</Td>
                  <Td className="whitespace-nowrap text-right">
                    {o.status === "PENDING" && <>
                      <Button size="sm" variant="secondary" onClick={() => confirm(o.invoice?.status !== "PAID" ? "Invoice is unpaid. Accept and provision anyway?" : "Accept and provision this order?") && act(o.id, "accept")}>Accept</Button>
                      <button className="ml-3 text-xs font-bold text-rose-600" onClick={() => confirm("Cancel this order and release reserved IPs?") && act(o.id, "cancel")}>Cancel</button>
                      <button className="ml-3 text-xs font-bold text-rose-600" onClick={() => confirm("Mark as fraud?") && act(o.id, "cancel", { fraud: true })}>Fraud</button>
                    </>}
                  </Td>
                </tr>
              ))}
            </Table>
            <Pager page={data.page} pageSize={data.pageSize} total={data.total} onPage={setPage} />
          </>
        )}
      </Card>
    </>
  );
}
