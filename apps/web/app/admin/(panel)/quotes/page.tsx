"use client";
import Link from "next/link";
import { useState } from "react";
import { date, money } from "@/lib/api";
import { Badge, Button, Card, Empty, Input, Loading, PageHeader, Pager, Table, Td, useApi } from "@/components/ui";
import { StatusTabs } from "@/components/admin/list-kit";

const TABS = [
  { key: "", label: "All", icon: "list" },
  { key: "DRAFT", label: "Drafts", tone: "slate" as const },
  { key: "SENT", label: "Sent", tone: "purple" as const },
  { key: "INVOICED", label: "Accepted", tone: "green" as const },
  { key: "DECLINED", label: "Declined", tone: "rose" as const },
  { key: "EXPIRED", label: "Expired", tone: "amber" as const },
];

export default function Quotes() {
  const [status, setStatus] = useState("");
  const [q, setQ] = useState("");
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  const { data, loading } = useApi(`/admin/quotes?status=${status}&page=${page}&q=${encodeURIComponent(query)}`, [status, page, query]);
  const c = data?.counts ?? {};
  const counts = Object.fromEntries(TABS.map((t) => [t.key || "all", t.key ? c[t.key]?.count ?? 0 : Object.values(c).reduce((a: number, x: any) => a + x.count, 0)]));
  const sent = c.SENT?.count ?? 0;
  const won = c.INVOICED?.count ?? 0;
  const lost = (c.DECLINED?.count ?? 0) + (c.EXPIRED?.count ?? 0);
  return (
    <>
      <PageHeader icon="request_quote" title="Quotes" subtitle="Send a priced proposal; when the customer accepts it online, an invoice is created automatically."
        actions={<Button icon="add" href="/admin/quotes/new">New quote</Button>}
        stats={[
          ["Awaiting answer", String(sent), c.SENT ? money(c.SENT.total) : "—"],
          ["Accepted", String(won), c.INVOICED ? money(c.INVOICED.total) : "—"],
          ["Win rate", won + lost ? `${Math.round((won / (won + lost)) * 100)}%` : "—", "accepted vs declined/expired"],
        ]} />
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <StatusTabs tabs={TABS} value={status} counts={counts} onChange={(k) => { setStatus(k); setPage(1); }} />
        <form onSubmit={(e) => { e.preventDefault(); setQuery(q); setPage(1); }} className="w-full sm:w-72"><Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Quote no., subject or email" /></form>
      </div>
      <Card pad={false}>
        {loading ? <Loading /> : !data.quotes.length ? <Empty icon="request_quote" title="No quotes yet">Create a quote for a custom server, a bulk deal or a project — the customer can accept it from their account.</Empty> : (
          <>
            <Table head={["Quote", "Customer", "Created", "Valid until", "Total", "Status"]}>
              {data.quotes.map((x: any) => (
                <tr key={x.id} className="hover:bg-primary-tint">
                  <Td><Link href={`/admin/quotes/${x.id}`} className="font-bold text-ink hover:text-primary-dark">{x.number}</Link><div className="max-w-xs truncate text-xs text-mute">{x.subject}</div></Td>
                  <Td className="text-xs">{x.user.firstName} {x.user.lastName}<div className="text-mute">{x.user.email}</div></Td>
                  <Td className="whitespace-nowrap text-mute">{date(x.createdAt)}</Td>
                  <Td className={x.status === "SENT" && new Date(x.validUntil) < new Date(Date.now() + 2 * 86400_000) ? "font-bold text-amber-600" : "text-mute"}>{date(x.validUntil)}</Td>
                  <Td className="font-semibold">{money(x.total, x.currency)}</Td>
                  <Td><Badge status={x.status}>{x.status === "INVOICED" ? "accepted" : undefined}</Badge></Td>
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
