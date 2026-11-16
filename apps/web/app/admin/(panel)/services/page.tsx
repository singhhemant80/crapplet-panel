"use client";
import { DateRangeFilter, rangeQs, type Range } from "@/components/admin/date-range";
import { VirtualizorSyncAll } from "@/components/admin/virtualizor-sync-all";
import Link from "next/link";
import { Suspense, useState } from "react";
import { useSearchParams } from "next/navigation";
import { date, money } from "@/lib/api";
import { Badge, Card, Input, Loading, PageHeader, Pager, Select, Table, Td, useApi } from "@/components/ui";
import { LiveBadge, useLiveStates } from "@/components/live-state";
import { BulkBar, Check, RemindButton, useSelection } from "@/components/admin/bulk";

function Services() {
  const sp = useSearchParams();
  const [status, setStatus] = useState(sp.get("status") ?? "");
  const [vps, setVps] = useState(sp.get("vps") ?? "");
  const [q, setQ] = useState("");
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  const [type, setType] = useState("");
  const [cycle, setCycle] = useState("");
  const [dateField, setDateField] = useState("created");
  const [range, setRange] = useState<Range>({ from: "", to: "" });
  const qs = [`page=${page}`, status && `status=${status}`, vps && `vps=${vps}`, query && `q=${encodeURIComponent(query)}`, type && `type=${type}`, cycle && `cycle=${cycle}`, (range.from || range.to) && `dateField=${dateField}`, rangeQs(range)].filter(Boolean).join("&");
  const { data, loading, reload } = useApi(`/admin/services?${qs}`, [qs]);
  const liveIds = (data?.items ?? []).filter((s: any) => s.remoteId && ["ACTIVE", "SUSPENDED"].includes(s.status)).map((s: any) => s.id).join(",");
  const live = useLiveStates(liveIds ? `/admin/live-states?ids=${liveIds}` : null);
  const pick = useSelection();
  const pageIds: string[] = (data?.services ?? []).map((s: any) => s.id);
  const suspendedPicked = (data?.services ?? []).filter((s: any) => pick.has(s.id) && s.status === "SUSPENDED").length;
  return (
    <>
      <PageHeader title="VPS & Services" subtitle="Every customer service. Open a VPS to run power actions, reinstall or suspend." actions={<VirtualizorSyncAll onDone={reload} />} />
      <div className="mb-2 grid gap-2 md:grid-cols-2 xl:grid-cols-[1.3fr_160px_190px_190px]">
        <form onSubmit={(e) => { e.preventDefault(); setPage(1); setQuery(q); }}><Input className="h-10" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Hostname, IP, VMID or customer email" /></form>
        <Select className="h-10" value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }}><option value="">All statuses</option>{["PENDING", "PROVISIONING", "ACTIVE", "SUSPENDED", "FAILED", "TERMINATED", "CANCELLED"].map((s) => <option key={s} value={s}>{s.charAt(0) + s.slice(1).toLowerCase()}</option>)}</Select>
        <Select className="h-10" value={type || (vps ? "vps" : "")} onChange={(e) => { const v = e.target.value; setVps(v === "vps" ? "1" : ""); setType(v === "vps" ? "" : v); setPage(1); }}>
          <option value="">All products</option><option value="vps">All VPS</option>
          {[["VPS_LINUX", "Linux VPS"], ["VPS_WINDOWS", "Windows VPS"], ["SHARED_HOSTING", "Shared hosting"], ["RESELLER_HOSTING", "Reseller hosting"], ["DEDICATED", "Dedicated servers"], ["COLOCATION", "Colocation"], ["CUSTOM", "Other"]].map(([k, l]) => <option key={k} value={k}>{l}</option>)}
        </Select>
        <Select className="h-10" value={cycle} onChange={(e) => { setCycle(e.target.value); setPage(1); }}><option value="">Any billing cycle</option>{[["MONTHLY", "Monthly"], ["QUARTERLY", "Quarterly"], ["SEMIANNUAL", "Half-yearly"], ["ANNUAL", "Yearly"], ["BIENNIAL", "2 years"], ["TRIENNIAL", "3 years"], ["ONETIME", "One-time"]].map(([k, l]) => <option key={k} value={k}>{l}</option>)}</Select>
      </div>
      <div className="mb-4">
        <DateRangeFilter className="max-w-2xl" value={range} onChange={(r) => { setRange(r); setPage(1); }} fields={[["created", "Created"], ["due", "Next due"], ["terminated", "Terminated"]]} field={dateField} onField={(f) => { setDateField(f); setPage(1); }} />
      </div>
      <BulkBar count={pick.sel.length} onClear={pick.clear}>
        <RemindButton ids={pick.sel} path="/admin/reminders/suspended" what="Payment reminder" confirmText={`Send a "pay to restore your service" reminder for the ${pick.sel.length} selected service(s)?\nOnly suspended services with an unpaid invoice get one — the rest are skipped.`} onDone={() => { pick.clear(); reload(); }} />
        <span className="text-xs font-semibold text-mute">{suspendedPicked} of {pick.sel.length} suspended{status !== "SUSPENDED" && <> · <button className="font-bold text-primary-dark hover:underline" onClick={() => { setStatus("SUSPENDED"); setPage(1); }}>show only suspended</button></>}</span>
      </BulkBar>
      <Card pad={false}>
        {loading ? <Loading /> : (
          <>
            <Table head={[<Check key="all" label="Select all on this page" checked={pick.allOn(pageIds)} onChange={(on) => pick.togglePage(pageIds, on)} />, "Service", "Customer", "IP", "Server / VMID", "Status", "Recurring", "Next due"]}>
              {data.services.map((s: any) => (
                <tr key={s.id} className={pick.has(s.id) ? "bg-primary-tint/70" : "hover:bg-primary-tint"}>
                  <Td><Check label={`Select ${s.hostname ?? s.product.name}`} checked={pick.has(s.id)} onChange={(on) => pick.toggle(s.id, on)} /></Td>
                  <Td><Link href={`/admin/services/${s.id}`} className="font-bold text-ink hover:text-primary-dark">{s.product.name}</Link><div className="text-xs text-mute">{s.hostname}</div></Td>
                  <Td><Link href={`/admin/clients/${s.user.id}`} className="text-sm text-primary-dark">{s.user.email}</Link></Td>
                  <Td className="font-mono text-xs">{s.ips.map((i: any) => i.address).join(", ") || "—"}</Td>
                  <Td className="text-xs">{s.server?.name ?? "—"}{s.remoteId && <div className="text-mute">{s.node ? `${s.node} · ` : ""}#{s.remoteId}</div>}</Td>
                  <Td><div className="flex flex-col items-start gap-1"><Badge status={s.status} />{s.remoteId && ["ACTIVE", "SUSPENDED"].includes(s.status) && live.states[s.id]?.state !== "unknown" && !(!live.loading && !live.states[s.id]) && <LiveBadge state={live.states[s.id]?.state} reason={live.states[s.id]?.reason} loading={live.loading} />}{s.failure && <span className="max-w-[220px] text-[11.5px] font-semibold leading-snug text-rose-700" title={s.failure.cause}>{s.failure.title}</span>}</div></Td>
                  <Td>{money(s.recurringAmount, s.currency)}</Td>
                  <Td className="whitespace-nowrap text-mute">{date(s.nextDueDate)}</Td>
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
export default function Page() { return <Suspense><Services /></Suspense>; }
