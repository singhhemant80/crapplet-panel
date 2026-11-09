"use client";
import Link from "next/link";
import { api, date, invNo, money } from "@/lib/api";
import { Button, Card, Empty, Loading, PageHeader, Table, Td, toast, useApi } from "@/components/ui";

export default function Reviews() {
  const { data, loading, reload } = useApi("/admin/payment-reviews");
  const act = (id: string, approve: boolean) => {
    const note = approve ? undefined : prompt("Reason for rejection") ?? undefined;
    api(`/admin/payment-reviews/${id}`, { body: { approve, note } }).then(() => { toast.success(approve ? "Approved — invoice updated and services activated" : "Rejected"); reload(); }).catch((e) => toast.error(e.message));
  };
  return (
    <>
      <PageHeader title="Payment reviews" subtitle="UPI / bank transfer references submitted by customers. Match the UTR against your bank statement before approving." />
      <Card pad={false}>
        {loading ? <Loading /> : !data.intents.length ? <Empty icon="fact_check" title="Nothing to review" /> : (
          <Table head={["Submitted", "Customer", "Invoice", "Method", "UTR / reference", "Amount", ""]}>
            {data.intents.map((p: any) => (
              <tr key={p.id}>
                <Td className="whitespace-nowrap text-xs text-mute">{date(p.updatedAt, true)}</Td>
                <Td className="text-sm">{p.user.firstName} {p.user.lastName}<div className="text-xs text-mute">{p.user.email}</div></Td>
                <Td><Link className="font-bold text-primary-dark" href={`/admin/invoices/${p.invoice.id}`}>{invNo(p.invoice)}</Link></Td>
                <Td className="uppercase">{p.gateway}</Td>
                <Td className="font-mono font-bold">{p.reference}</Td>
                <Td className="font-bold">{money(p.amount, p.currency)}</Td>
                <Td className="whitespace-nowrap text-right"><Button size="sm" onClick={() => confirm(`Confirm ₹${p.amount / 100} received with reference ${p.reference}?`) && act(p.id, true)}>Approve</Button><button className="ml-3 text-sm font-bold text-rose-600" onClick={() => act(p.id, false)}>Reject</button></Td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
    </>
  );
}
