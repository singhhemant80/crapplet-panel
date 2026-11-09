"use client";
import { useState } from "react";
import { money } from "@/lib/api";
import { Card, Field, Input, Loading, PageHeader, Table, Td, useApi } from "@/components/ui";

export default function Reports() {
  const [from, setFrom] = useState(new Date(Date.now() - 365 * 86400000).toISOString().slice(0, 10));
  const [to, setTo] = useState(new Date().toISOString().slice(0, 10));
  const { data, loading } = useApi(`/admin/reports/summary?from=${from}&to=${to}T23:59:59`, [from, to]);
  const csv = () => {
    const rows = [["Month", "Invoices", "Taxable (INR)", "CGST", "SGST", "IGST", "Exports zero-rated (INR)", "Total (INR)"], ...data.gst.map((r: any) => [r.month, r.invoices, r.taxable / 100, r.cgst / 100, r.sgst / 100, r.igst / 100, r.exports / 100, r.total / 100])];
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([rows.map((r) => r.join(",")).join("\n")], { type: "text/csv" }));
    a.download = `gst-summary-${from}-${to}.csv`;
    a.click();
  };
  return (
    <>
      <PageHeader title="Reports" actions={<div className="flex gap-2"><Field><Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></Field><Field><Input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></Field></div>} />
      {loading || !data ? <Loading /> : (
        <div className="space-y-6">
          <Card title="GST summary in INR (paid tax invoices, for GSTR-1 / 3B — foreign-currency invoices at their invoice-date rate)" action={<button className="text-sm font-bold text-primary-dark" onClick={csv}>Export CSV</button>} pad={false}>
            <Table head={["Month", "Invoices", "Taxable value", "CGST", "SGST", "IGST", "Exports (zero-rated)", "Invoice total"]}>
              {data.gst.map((r: any) => <tr key={r.month}><Td className="font-bold">{r.month}</Td><Td>{r.invoices}{r.foreign > 0 && <span className="ml-1 text-xs text-mute">({r.foreign} USD)</span>}</Td><Td>{money(r.taxable)}</Td><Td>{money(r.cgst)}</Td><Td>{money(r.sgst)}</Td><Td>{money(r.igst)}</Td><Td>{money(r.exports)}</Td><Td className="font-bold">{money(r.total)}</Td></tr>)}
            </Table>
          </Card>
          <div className="grid gap-6 lg:grid-cols-3">
            <Card title="MRR by product type" pad={false}><Table head={["Type", "Services", "MRR"]}>{data.byType.map((r: any) => <tr key={r.type}><Td>{r.type}</Td><Td>{r.services}</Td><Td className="font-bold">{money(r.mrr)}</Td></tr>)}</Table></Card>
            <Card title="Payments by gateway" pad={false}><Table head={["Gateway", "Payments", "Amount"]}>{data.gateways.map((r: any) => <tr key={r.gateway}><Td className="uppercase">{r.gateway}</Td><Td>{r.payments}</Td><Td className="font-bold">{money(r.amount)}</Td></tr>)}</Table></Card>
            <Card title="New customers" pad={false}><Table head={["Month", "Signups"]}>{data.newClients.map((r: any) => <tr key={r.month}><Td>{r.month}</Td><Td className="font-bold">{r.clients}</Td></tr>)}</Table></Card>
          </div>
        </div>
      )}
    </>
  );
}
