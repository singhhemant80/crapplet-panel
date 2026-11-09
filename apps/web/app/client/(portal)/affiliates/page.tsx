"use client";
import { api, date, money } from "@/lib/api";
import { Badge, Button, Card, Copy, Empty, Loading, PageHeader, Stat, Table, Td, toast, useApi } from "@/components/ui";

export default function Affiliates() {
  const { data, loading, reload } = useApi("/client/affiliate");
  if (loading) return <Loading />;
  const a = data?.affiliate;
  if (!a)
    return (
      <>
        <PageHeader title="Affiliates & Referrals" />
        <Card>
          <Empty icon="handshake" title="Earn commission on every referral">
            Share your link — when someone you refer pays their first invoice, you earn a commission as account credit.
            <div className="mt-4"><Button onClick={() => api("/client/affiliate/activate", { body: {} }).then(reload).catch((e) => toast.error(e.message))}>Activate my affiliate account</Button></div>
          </Empty>
        </Card>
      </>
    );
  const link = `${typeof window !== "undefined" ? window.location.origin : "https://crapplet.co.in"}/client/register?ref=${a.code}`;
  const earned = a.referrals.reduce((s: number, r: any) => s + r.amount, 0);
  return (
    <>
      <PageHeader title="Affiliates & Referrals" />
      <div className="mb-6 grid gap-4 sm:grid-cols-3">
        <Stat label="Commission rate" value={`${a.commissionPct}%`} icon="percent" />
        <Stat label="Referrals" value={a.referrals.length} icon="group_add" tone="sky" />
        <Stat label="Total earned" value={money(earned)} icon="savings" tone="green" />
      </div>
      <Card title="Your referral link" className="mb-6">
        <div className="flex items-center gap-2 rounded-xl bg-[#fbf9ff] p-3 font-mono text-sm"><span className="flex-1 truncate">{link}</span><Copy text={link} /></div>
        <p className="mt-2 text-xs text-mute">Anyone who creates an account through this link is linked to you.</p>
      </Card>
      <Card title="Referrals" pad={false}>
        {!a.referrals.length ? <Empty icon="group_add" title="No referrals yet" /> : (
          <Table head={["Customer", "Joined", "Commission", "Status"]}>
            {a.referrals.map((r: any) => (
              <tr key={r.id}><Td className="font-semibold">{r.referredUser.firstName}</Td><Td className="whitespace-nowrap text-mute">{date(r.createdAt)}</Td><Td className="font-bold">{money(r.amount)}</Td><Td><Badge status={r.status} /></Td></tr>
            ))}
          </Table>
        )}
      </Card>
    </>
  );
}
