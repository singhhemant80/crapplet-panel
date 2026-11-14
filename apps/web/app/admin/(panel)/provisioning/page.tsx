"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { Badge, Button, Card, Empty, Icon, Loading, PageHeader, Table, Td, cx, toast, useApi } from "@/components/ui";
import { ProvisioningTracker, type Progress } from "@/components/provisioning-tracker";

const FILTERS = [
  { k: "", label: "All" },
  { k: "running", label: "In progress" },
  { k: "failed", label: "Failed / stuck" },
  { k: "payment", label: "Waiting for payment" },
  { k: "done", label: "Ready (24h)" },
] as const;

export default function ProvisioningPage() {
  const { data, loading, reload } = useApi<any>("/admin/provisioning");
  const [filter, setFilter] = useState<(typeof FILTERS)[number]["k"]>("");
  const [busy, setBusy] = useState<string | null>(null);

  // refresh the whole board every 5 s while anything is moving, otherwise every 30 s
  useEffect(() => {
    const t = setInterval(reload, data?.summary?.inProgress ? 5000 : 30000);
    return () => clearInterval(t);
  }, [data?.summary?.inProgress, reload]);

  if (loading && !data) return <Loading />;
  const items: any[] = data?.items ?? [];
  const pay = (x: any) => x.progress.steps.find((s: any) => s.key === "payment")?.state === "current";
  const shown = items.filter((x) =>
    filter === "running" ? x.progress.inProgress : filter === "failed" ? x.status === "FAILED" || x.progress.stuck : filter === "payment" ? pay(x) : filter === "done" ? x.status === "ACTIVE" : true,
  );
  const s = data?.summary ?? {};

  async function retry(id: string) {
    setBusy(id);
    try {
      await api(`/admin/services/${id}/action`, { body: { action: "create" } });
      toast.success("Provisioning queued");
      setTimeout(reload, 1500);
    } catch (e: any) {
      toast.error(e.message);
    } finally {
      setBusy(null);
    }
  }

  const cards = [
    { k: "running", label: "In progress", value: s.inProgress ?? 0, icon: "progress_activity", cls: "text-primary-dark bg-primary-soft" },
    { k: "failed", label: "Failed or stuck", value: s.failed ?? 0, icon: "error", cls: "text-rose-600 bg-rose-50" },
    { k: "payment", label: "Waiting for payment", value: s.waitingPayment ?? 0, icon: "payments", cls: "text-amber-600 bg-amber-50" },
    { k: "done", label: "Ready in last 24h", value: s.doneToday ?? 0, icon: "check_circle", cls: "text-emerald-600 bg-emerald-50" },
  ] as const;

  return (
    <>
      <PageHeader title="Provisioning" subtitle="Every VPS being set up right now, waiting, failed, or finished in the last 24 hours. Updates live." actions={<Button variant="outline" icon="refresh" onClick={reload}>Refresh</Button>} />
      <div className="mb-5 grid grid-cols-2 gap-3 lg:grid-cols-4">
        {cards.map((c) => (
          <button key={c.k} onClick={() => setFilter(filter === c.k ? "" : c.k)} className={cx("flex items-center gap-3 rounded-2xl border bg-white p-4 text-left shadow-card transition", filter === c.k ? "border-primary ring-2 ring-primary/20" : "border-line hover:border-primary/40")}>
            <span className={cx("grid h-11 w-11 place-items-center rounded-xl", c.cls)}><Icon name={c.icon} fill={c.k !== "running"} className={c.k === "running" && c.value ? "animate-spin [animation-duration:2.5s]" : ""} /></span>
            <span>
              <span className="block text-2xl font-extrabold text-ink">{c.value}</span>
              <span className="text-xs font-semibold text-mute">{c.label}</span>
            </span>
          </button>
        ))}
      </div>
      <div className="mb-3 flex gap-2 overflow-x-auto">
        {FILTERS.map((f) => (
          <button key={f.k} onClick={() => setFilter(f.k)} className={cx("whitespace-nowrap rounded-full px-4 py-1.5 text-sm font-bold", filter === f.k ? "bg-primary-dark text-white" : "bg-white text-slate-600 ring-1 ring-line")}>{f.label}</button>
        ))}
      </div>
      <Card pad={false}>
        <Table head={["Service", "Customer", "Progress", "Current step", "Status", ""]} empty={!shown.length ? <Empty icon="rocket_launch" title="Nothing here">No VPS {filter ? "in this state" : "being set up"} right now.</Empty> : undefined}>
          {shown.map((x) => {
            const p: Progress = x.progress;
            const cur = p.steps.find((st) => st.state === "current" || st.state === "failed");
            return (
              <tr key={x.id} className="hover:bg-[#fcfaff]">
                <Td>
                  <Link href={`/admin/services/${x.id}`} className="font-bold text-ink hover:text-primary-dark">{x.product.name}</Link>
                  <div className="text-xs text-mute">{x.hostname ?? "—"}{x.order && <> · <Link href={`/admin/orders/${x.order.id}`} className="font-semibold text-primary-dark hover:underline">{x.order.number}</Link></>}</div>
                </Td>
                <Td><div className="font-semibold">{[x.user.firstName, x.user.lastName].filter(Boolean).join(" ") || "—"}</div><div className="text-xs text-mute">{x.user.email}</div></Td>
                <Td className="w-[220px]"><ProvisioningTracker key={`${x.id}-${p.status}-${p.percent}`} path={`/admin/services/${x.id}/provisioning`} audience="admin" compact initial={p} /></Td>
                <Td className="max-w-[320px]">
                  <div className={cx("text-sm font-semibold", x.status === "FAILED" || p.stuck ? "text-rose-700" : "text-ink")}>{x.status === "ACTIVE" ? "Ready" : p.stuck ? p.headline : cur?.label ?? p.headline}</div>
                  <div className="line-clamp-3 break-words text-xs text-mute">{p.stuck ? "No job queued and nothing logged for 15+ minutes — retry it" : x.status === "FAILED" ? (p.explain ? <><b className="text-rose-700">{p.explain.title}:</b> {p.explain.cause} <span className="text-slate-700">→ {p.explain.fix}</span></> : p.error) : cur?.detail ?? (p.job?.state === "delayed" ? `Retrying (attempt ${p.job.attempt} of ${p.job.maxAttempts})` : p.message)}</div>
                </Td>
                <Td><Badge status={x.status} /></Td>
                <Td className="text-right">
                  {x.status === "FAILED" || p.stuck ? (
                    <Button size="sm" icon="rocket_launch" loading={busy === x.id} onClick={() => retry(x.id)}>Retry</Button>
                  ) : (
                    <Button size="sm" variant="ghost" icon="arrow_forward" href={`/admin/services/${x.id}`}>Open</Button>
                  )}
                </Td>
              </tr>
            );
          })}
        </Table>
      </Card>
    </>
  );
}
