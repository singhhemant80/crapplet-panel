"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { api } from "@/lib/api";
import { STARTERS } from "@/lib/campaign-templates";
import { Badge, Button, Icon, Loading, Modal, PageHeader, cx, toast, useApi } from "@/components/ui";
import { Ago, ListShell, SearchBox, StatusTabs, type Tab } from "@/components/admin/list-kit";

const TABS: Tab[] = [
  { key: "", label: "All" },
  { key: "DRAFT", label: "Drafts", tone: "slate" },
  { key: "SCHEDULED", label: "Scheduled", tone: "purple" },
  { key: "SENDING", label: "Sending", tone: "sky" },
  { key: "PAUSED", label: "Paused", tone: "amber" },
  { key: "SENT", label: "Sent", tone: "green" },
  { key: "CANCELLED", label: "Cancelled", tone: "slate" },
];

const pct = (n: number | null | undefined) => (n == null ? "—" : `${Math.round(n * 1000) / 10}%`);
const fmt = (n: number) => n.toLocaleString("en-IN");

export default function CampaignsPage() {
  const router = useRouter();
  const [status, setStatus] = useState("");
  const [q, setQ] = useState("");
  const [picker, setPicker] = useState(false);
  const [creating, setCreating] = useState<string | null>(null);
  const { data, loading } = useApi<any>(`/admin/campaigns?status=${status}&q=${encodeURIComponent(q)}`, [status, q]);

  async function create(key: string) {
    const s = STARTERS.find((x) => x.key === key)!;
    setCreating(key);
    try {
      const r = await api<{ campaign: { id: string } }>("/admin/campaigns", { body: { name: s.name, kind: s.kind, subject: s.subject || "(no subject yet)", preheader: s.preheader || null, body: s.body, audience: {} } });
      router.push(`/admin/campaigns/${r.campaign.id}`);
    } catch (e: any) {
      toast.error(e.message);
      setCreating(null);
    }
  }

  if (!data && loading) return <Loading />;
  const s = data?.summary ?? {};
  const counts = { all: Object.values(data?.counts ?? {}).reduce((a: number, b: any) => a + b, 0) as number, ...(data?.counts ?? {}) };
  return (
    <>
      <PageHeader
        icon="outgoing_mail"
        title="Email Campaigns"
        subtitle="Send offers, news and service information to your customers — with a live preview, audience filters, test sends and open tracking."
        actions={<Button icon="add" onClick={() => setPicker(true)}>New campaign</Button>}
        stats={[
          ["Sent · 30 days", fmt(s.sent30 ?? 0), "emails delivered"],
          ["Open rate · 30 days", pct(s.openRate30), "of delivered emails"],
          ["Accept offers", fmt(s.subscribers ?? 0), `of ${fmt(s.clients ?? 0)} active customers`],
          ["Unsubscribed · 30 days", fmt(s.unsubscribed30 ?? 0), "from offers"],
        ]}
      />
      <ListShell
        toolbar={
          <div className="flex flex-col gap-3 lg:flex-row lg:items-center">
            <div className="min-w-0 flex-1"><StatusTabs tabs={TABS} value={status} onChange={setStatus} counts={counts} /></div>
            <SearchBox value={q} onSearch={setQ} placeholder="Search campaigns…" className="lg:w-72" />
          </div>
        }
      >
        {!data?.campaigns?.length ? (
          <div className="px-5 py-16 text-center">
            <div className="mx-auto grid h-16 w-16 place-items-center rounded-2xl bg-primary-tint text-primary-dark"><Icon name="outgoing_mail" className="text-[32px]" /></div>
            <p className="mt-3 text-lg font-extrabold text-ink">{status || q ? "No campaigns match" : "No campaigns yet"}</p>
            <p className="mx-auto mt-1 max-w-md text-[13.5px] text-slate-500">Tell customers about an offer, a new product or planned maintenance. Start from a ready-made template and change anything you like.</p>
            {!status && !q && <Button className="mt-4" icon="add" onClick={() => setPicker(true)}>Create your first campaign</Button>}
          </div>
        ) : (
          <ul className="divide-y divide-line">
            {data.campaigns.map((c: any) => {
              const done = c.sent + c.failed + c.skipped;
              const progress = c.total ? Math.min(100, Math.round((done / c.total) * 100)) : 0;
              const when = c.status === "SCHEDULED" ? c.scheduledAt : c.finishedAt ?? c.startedAt ?? c.updatedAt;
              return (
                <li key={c.id}>
                  <Link href={`/admin/campaigns/${c.id}`} className="grid gap-3 px-4 py-4 transition hover:bg-[#faf8fe] sm:px-5 md:grid-cols-[minmax(0,1fr)_180px_200px] md:items-center">
                    <div className="flex min-w-0 items-start gap-3">
                      <div className={cx("grid h-11 w-11 shrink-0 place-items-center rounded-xl", c.kind === "OFFER" ? "bg-fuchsia-50 text-fuchsia-600" : "bg-sky-50 text-sky-600")}>
                        <Icon name={c.kind === "OFFER" ? "sell" : "info"} className="text-[22px]" />
                      </div>
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="truncate font-extrabold text-ink">{c.name}</span>
                          <Badge status={c.status} />
                          <span className={cx("rounded-md px-1.5 py-0.5 text-[10.5px] font-extrabold uppercase tracking-wide", c.kind === "OFFER" ? "bg-fuchsia-50 text-fuchsia-700" : "bg-sky-50 text-sky-700")}>{c.kind === "OFFER" ? "Offer" : "Information"}</span>
                        </div>
                        <div className="mt-0.5 truncate text-[13px] text-slate-500">{c.subject}</div>
                        {c.lastError && ["PAUSED", "SENDING"].includes(c.status) && <div className="mt-1 truncate text-[12px] font-semibold text-amber-700">{c.lastError}</div>}
                      </div>
                    </div>
                    <div className="text-[12.5px] text-slate-500 md:text-right">
                      {c.status === "SCHEDULED" ? (
                        <><div className="font-bold text-violet-700">Sends {new Date(c.scheduledAt).toLocaleString("en-IN", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "Asia/Kolkata" })}</div><Ago at={when} /></>
                      ) : c.status === "DRAFT" ? (
                        <>Edited <Ago at={c.updatedAt} /></>
                      ) : (
                        <><div className="font-bold text-ink">{fmt(c.sent)} <span className="font-semibold text-slate-500">of {fmt(c.total)} delivered</span></div><Ago at={when} /></>
                      )}
                    </div>
                    <div>
                      {["SENDING", "PAUSED", "SENT", "CANCELLED"].includes(c.status) ? (
                        <>
                          <div className="flex justify-between text-[12px] font-bold">
                            <span className="text-slate-500">{c.status === "SENT" ? "Opened" : "Progress"}</span>
                            <span className="tabular-nums text-ink">{c.status === "SENT" ? pct(c.sent ? c.opened / c.sent : null) : `${progress}%`}</span>
                          </div>
                          <div className="mt-1.5 h-2 overflow-hidden rounded-full bg-slate-100">
                            <div className={cx("h-full rounded-full", c.status === "SENT" ? "bg-emerald-500" : c.status === "PAUSED" ? "bg-amber-500" : "bg-primary")} style={{ width: `${c.status === "SENT" ? (c.sent ? Math.round((c.opened / c.sent) * 100) : 0) : progress}%` }} />
                          </div>
                        </>
                      ) : (
                        <span className="inline-flex items-center gap-1 text-[12.5px] font-bold text-primary-dark">{c.status === "DRAFT" ? "Continue editing" : "View"}<Icon name="arrow_forward" className="text-[16px]" /></span>
                      )}
                    </div>
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </ListShell>

      <Modal open={picker} onClose={() => setPicker(false)} title="Start a campaign" wide>
        <div className="grid gap-3 sm:grid-cols-2">
          {STARTERS.map((t) => (
            <button key={t.key} disabled={!!creating} onClick={() => create(t.key)} className="group flex items-start gap-3 rounded-2xl border border-line p-4 text-left transition hover:border-primary hover:bg-[#faf7ff] disabled:opacity-60">
              <div className={cx("grid h-11 w-11 shrink-0 place-items-center rounded-xl", t.kind === "OFFER" ? "bg-fuchsia-50 text-fuchsia-600" : "bg-sky-50 text-sky-600", t.key === "blank" && "bg-slate-100 text-slate-500")}>
                <Icon name={creating === t.key ? "progress_activity" : t.icon} className={cx("text-[22px]", creating === t.key && "animate-spin")} />
              </div>
              <div className="min-w-0">
                <div className="font-extrabold text-ink group-hover:text-primary-dark">{t.label}</div>
                <div className="mt-0.5 text-[12.5px] leading-snug text-slate-500">{t.blurb}</div>
              </div>
            </button>
          ))}
        </div>
      </Modal>
    </>
  );
}
