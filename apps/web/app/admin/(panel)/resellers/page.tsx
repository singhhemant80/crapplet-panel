"use client";
import Link from "next/link";
import { api, date, money } from "@/lib/api";
import { Badge, Card, Empty, Input, Loading, PageHeader, Select, Table, Td, toast, useApi } from "@/components/ui";

export default function Resellers() {
  const { data, loading, reload } = useApi("/admin/resellers");
  const upd = (id: string, body: any) => api(`/admin/resellers/${id}`, { method: "PUT", body }).then(() => { toast.success("Updated"); reload(); }).catch((e) => toast.error(e.message));
  return (
    <>
      <PageHeader title="Resellers" subtitle="Approve applications, set extra wholesale discounts. Wholesale prices are set per product." />
      <Card pad={false}>
        {loading ? <Loading /> : !data.resellers.length ? <Empty icon="storefront" title="No reseller applications yet" /> : (
          <Table head={["Brand", "Account", "Wallet", "VPS", "Customers", "Discount %", "Status", "Applied"]}>
            {data.resellers.map((r: any) => (
              <tr key={r.id}>
                <Td><b>{r.brandName}</b>{r.website && <div className="text-xs text-mute">{r.website}</div>}{r.notes && <div className="max-w-[260px] truncate text-xs text-mute">{r.notes}</div>}</Td>
                <Td><Link className="text-sm font-bold text-primary-dark" href={`/admin/clients/${r.user.id}`}>{r.user.email}</Link></Td>
                <Td>{money(r.user.profile?.creditBalance)}</Td>
                <Td>{r._count.services}</Td>
                <Td>{r._count.customers}</Td>
                <Td><Input className="h-9 w-20" type="number" defaultValue={r.discountPct} onBlur={(e) => Number(e.target.value) !== r.discountPct && upd(r.id, { discountPct: Number(e.target.value) })} /></Td>
                <Td><Select className="h-9 w-36" value={r.status} onChange={(e) => upd(r.id, { status: e.target.value })}>{["PENDING", "APPROVED", "REJECTED", "SUSPENDED"].map((s) => <option key={s}>{s}</option>)}</Select></Td>
                <Td className="text-mute">{date(r.createdAt)}</Td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
    </>
  );
}
