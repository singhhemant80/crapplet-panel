"use client";
import { api, date, money } from "@/lib/api";
import { Badge, Button, Card, Loading, PageHeader, Table, Td, toast, useApi } from "@/components/ui";

export default function Affiliates() {
  const { data, loading, reload } = useApi("/admin/affiliates");
  if (loading) return <Loading />;
  return (
    <>
      <PageHeader title="Affiliates" />
      <Card title="Pending commissions" className="mb-6" pad={false}>
        <Table head={["Affiliate", "Referred customer", "Commission", "Date", ""]}>
          {data.pending.map((r: any) => (
            <tr key={r.id}><Td>{r.affiliate.user.email}</Td><Td>{r.referredUser.email}</Td><Td className="font-bold">{money(r.amount)}</Td><Td>{date(r.createdAt)}</Td>
              <Td className="text-right"><Button size="sm" variant="secondary" onClick={() => api(`/admin/referrals/${r.id}/approve`, { body: { payout: "credit" } }).then(() => { toast.success("Paid as account credit"); reload(); })}>Approve → credit</Button></Td></tr>
          ))}
        </Table>
      </Card>
      <Card title="Affiliates" pad={false}>
        <Table head={["Affiliate", "Code", "Rate", "Referrals", "Balance", "Joined"]}>
          {data.affiliates.map((a: any) => <tr key={a.id}><Td>{a.user.email}</Td><Td className="font-mono">{a.code}</Td><Td>{a.commissionPct}%</Td><Td>{a._count.referrals}</Td><Td>{money(a.balance)}</Td><Td>{date(a.createdAt)}</Td></tr>)}
        </Table>
      </Card>
    </>
  );
}
