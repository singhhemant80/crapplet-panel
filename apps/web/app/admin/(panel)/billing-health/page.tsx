"use client";
import Link from "next/link";
import { useState } from "react";
import { api, date } from "@/lib/api";
import { Button, Icon, Loading, PageHeader, cx, toast, useApi } from "@/components/ui";
import { can, useSession } from "@/lib/session";

const TONE: Record<string, { ring: string; chip: string; icon: string }> = {
  error: { ring: "ring-rose-200", chip: "bg-rose-50 text-rose-700", icon: "error" },
  warn: { ring: "ring-amber-200", chip: "bg-amber-50 text-amber-800", icon: "warning" },
  info: { ring: "ring-sky-200", chip: "bg-sky-50 text-sky-700", icon: "info" },
};

export default function BillingHealth() {
  const { me } = useSession();
  const { data, loading, reload } = useApi("/admin/billing/health");
  const [busy, setBusy] = useState<string | null>(null);
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const manage = can(me, "billing.manage");

  async function fix(c: any) {
    if (!confirm(`${c.fix}?\n\nThis applies to all ${c.count} item${c.count === 1 ? "" : "s"} in “${c.title}”.`)) return;
    setBusy(c.key);
    try {
      const r = await api("/admin/billing/health/fix", { body: { key: c.key } });
      toast.success(`Fixed ${r.fixed}${r.skipped ? ` · ${r.skipped} left for review` : ""}`);
      if (r.notes?.length) toast.info(r.notes.slice(0, 3).join(" · "));
      reload();
    } catch (e: any) {
      toast.error(e.message);
    } finally {
      setBusy(null);
    }
  }

  const checks: any[] = data?.checks ?? [];
  const problems = checks.filter((c) => c.count > 0);
  const clean = checks.filter((c) => c.count === 0);
  return (
    <>
      <PageHeader
        icon="health_and_safety"
        title="Billing Health"
        subtitle="Checks invoices, payments, credit and renewals for things that don't add up — with one-click fixes where there's exactly one right answer."
        actions={<Button variant="outline" icon="refresh" loading={loading} onClick={reload}>Check again</Button>}
      />
      {loading && !data ? <Loading /> : (
        <>
          <div className="mb-6 grid gap-3 sm:grid-cols-3">
            {(["error", "warn", "info"] as const).map((sev) => {
              const n = problems.filter((c) => c.severity === sev).reduce((a, c) => a + c.count, 0);
              return (
                <div key={sev} className={cx("rounded-2xl bg-white p-4 shadow-card ring-1", TONE[sev].ring)}>
                  <div className="flex items-center gap-2 text-[11px] font-bold uppercase tracking-wider text-mute"><Icon name={TONE[sev].icon} className="text-[17px]" />{sev === "error" ? "Needs fixing" : sev === "warn" ? "Should review" : "Good to know"}</div>
                  <div className="mt-1 text-2xl font-extrabold text-ink">{n.toLocaleString("en-IN")}</div>
                </div>
              );
            })}
          </div>

          {!problems.length && <div className="mb-6 rounded-2xl bg-emerald-50 p-6 text-center font-bold text-emerald-800 ring-1 ring-emerald-200"><Icon name="verified" className="mb-1 block text-[34px]" />Everything adds up.</div>}

          <div className="space-y-4">
            {problems.map((c) => (
              <section key={c.key} className={cx("overflow-hidden rounded-2xl bg-white shadow-card ring-1", TONE[c.severity].ring)}>
                <div className="flex flex-wrap items-start gap-3 p-5">
                  <span className={cx("grid h-10 w-10 shrink-0 place-items-center rounded-xl", TONE[c.severity].chip)}><Icon name={TONE[c.severity].icon} /></span>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2"><h3 className="text-[15px] font-extrabold text-ink">{c.title}</h3><span className={cx("rounded-full px-2 py-0.5 text-xs font-bold", TONE[c.severity].chip)}>{c.count.toLocaleString("en-IN")}</span></div>
                    <p className="mt-1 text-[13px] text-slate-600">{c.explain}</p>
                  </div>
                  <div className="flex w-full flex-wrap gap-2 sm:w-auto">
                    <Button size="sm" variant="ghost" icon={open[c.key] ? "expand_less" : "expand_more"} onClick={() => setOpen({ ...open, [c.key]: !open[c.key] })}>{open[c.key] ? "Hide" : "Show"}</Button>
                    {c.fix && manage && <Button size="sm" icon="build" loading={busy === c.key} onClick={() => fix(c)}>{c.fix}</Button>}
                  </div>
                </div>
                {open[c.key] && (
                  <div className="overflow-x-auto border-t border-line">
                    <table className="w-full min-w-[560px] text-[13px]">
                      <tbody className="divide-y divide-line">
                        {c.rows.map((r: any) => (
                          <tr key={r.id} className="hover:bg-[#fcfaff]">
                            <td className="px-5 py-2.5"><Link href={r.href} className="font-bold text-primary-dark hover:underline">{r.label}</Link></td>
                            <td className="px-3 py-2.5 text-mute">{r.customer ?? ""}</td>
                            <td className="px-5 py-2.5 text-right text-slate-700">{r.detail}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    {c.count > c.rows.length && <p className="border-t border-line px-5 py-2 text-xs text-mute">Showing {c.rows.length} of {c.count.toLocaleString("en-IN")}. The fix applies to all of them.</p>}
                  </div>
                )}
              </section>
            ))}
          </div>

          {clean.length > 0 && (
            <div className="mt-6 rounded-2xl bg-white p-5 shadow-card">
              <div className="mb-2 text-[11px] font-bold uppercase tracking-wider text-mute">All clear</div>
              <ul className="grid gap-x-6 gap-y-1.5 text-[13px] text-slate-700 sm:grid-cols-2">{clean.map((c) => <li key={c.key} className="flex items-center gap-2"><Icon name="check_circle" className="text-[17px] text-emerald-500" />{c.title}</li>)}</ul>
            </div>
          )}
          {data && <p className="mt-4 text-xs text-mute">Checked {date(data.checkedAt, true)}.</p>}
        </>
      )}
    </>
  );
}
