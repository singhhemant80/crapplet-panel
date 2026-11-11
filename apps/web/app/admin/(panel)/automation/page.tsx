"use client";
import Link from "next/link";
import { Suspense, useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { api, date } from "@/lib/api";
import { Alert, Badge, Button, Card, Field, Icon, Input, Loading, PageHeader, Select, Toggle, cx, toast, useApi } from "@/components/ui";

const ACTION_STYLE: Record<string, { icon: string; tone: string }> = {
  invoice_created: { icon: "receipt_long", tone: "bg-primary-soft text-primary-dark" },
  credit_applied: { icon: "account_balance_wallet", tone: "bg-indigo-50 text-indigo-600" },
  reminder_sent: { icon: "notifications", tone: "bg-sky-50 text-sky-600" },
  overdue_1: { icon: "mark_email_unread", tone: "bg-amber-50 text-amber-600" },
  overdue_2: { icon: "mark_email_unread", tone: "bg-orange-50 text-orange-600" },
  overdue_3: { icon: "mark_email_unread", tone: "bg-rose-50 text-rose-600" },
  late_fee: { icon: "request_quote", tone: "bg-amber-50 text-amber-700" },
  suspended: { icon: "pause_circle", tone: "bg-orange-50 text-orange-600" },
  unsuspended: { icon: "play_circle", tone: "bg-emerald-50 text-emerald-600" },
  terminated: { icon: "delete_forever", tone: "bg-rose-50 text-rose-600" },
  order_cancelled: { icon: "remove_shopping_cart", tone: "bg-slate-100 text-slate-600" },
  domain_notice: { icon: "public", tone: "bg-teal-50 text-teal-600" },
  domain_expired: { icon: "event_busy", tone: "bg-slate-100 text-slate-600" },
  ticket_closed: { icon: "task_alt", tone: "bg-emerald-50 text-emerald-600" },
  error: { icon: "error", tone: "bg-rose-50 text-rose-600" },
};
const LINK: Record<string, (id: string, label?: string) => string> = {
  invoice: (id) => `/admin/invoices/${id}`,
  service: (id) => `/admin/services/${id}`,
  order: (id) => `/admin/orders/${id}`,
  ticket: (id) => `/admin/tickets/${id}`,
  domain: (_id, label) => `/admin/domains?q=${encodeURIComponent(label ?? "")}`,
};
const dayLabel = (ymd: string) => new Date(`${ymd}T00:00:00`).toLocaleDateString("en-IN", { weekday: "short", day: "numeric", month: "short" });

function AutomationPage() {
  const sp = useSearchParams();
  const router = useRouter();
  const tab = sp.get("tab") === "settings" ? "settings" : "status";
  const st = useApi("/admin/automation/status?days=30");
  const [running, setRunning] = useState(false);

  async function runNow() {
    if (!confirm("Run the daily automation now? It only does what's due today — running it twice doesn't bill or suspend twice.")) return;
    setRunning(true);
    try {
      const r = await api("/admin/automation/run", { body: {} });
      if (r.skipped) toast.error(r.skipped);
      else toast.success(`Automation finished in ${(r.durationMs / 1000).toFixed(1)} s`);
      st.reload();
    } catch (e: any) {
      toast.error(e.message);
    } finally {
      setRunning(false);
    }
  }

  if (st.loading && !st.data) return <Loading />;
  const d = st.data;
  const last = d?.lastRun;
  return (
    <>
      <PageHeader
        title="Automation"
        subtitle="The daily run that bills renewals, sends reminders, adds late fees, suspends and terminates overdue services, and tidies up — like the WHMCS cron."
        badge={d?.settings.enabled ? <Badge status={d.healthy ? "ACTIVE" : "FAILED"}>{d.healthy ? "Running" : "Not running"}</Badge> : <Badge status="CANCELLED">Off</Badge>}
        actions={<>
          <Button size="sm" icon="play_arrow" loading={running} onClick={runNow}>Run now</Button>
          <Button size="sm" variant="outline" icon={tab === "status" ? "tune" : "monitoring"} onClick={() => router.replace(`/admin/automation${tab === "status" ? "?tab=settings" : ""}`)}>{tab === "status" ? "Settings" : "Status"}</Button>
        </>}
        stats={d ? [
          ["Daily run", d.settings.enabled ? `${d.settings.runAt} IST` : "Off", d.settings.enabled ? "missed runs catch up automatically" : "turn on in Settings"],
          ["Last run", last ? date(last.startedAt, true) : "Never", last ? `${last.trigger === "manual" ? "Run now" : "Scheduled"} · ${last.durationMs != null ? `${(last.durationMs / 1000).toFixed(1)} s` : "running…"}` : undefined],
          ["Next run", d.nextRunAt ? date(d.nextRunAt, true) : "—"],
          ["Today", `${Object.values(d.days[0]?.counts ?? {}).reduce((a: number, b: any) => a + b, 0)} actions`, d.days[0]?.counts?.error ? `${d.days[0].counts.error} failed` : "no failures"],
        ] : []}
      />
      {tab === "settings" ? <SettingsTab data={d} onSaved={st.reload} /> : <StatusTab data={d} />}
    </>
  );
}

function StatusTab({ data }: { data: any }) {
  const [day, setDay] = useState<string>(data.days[0]?.day);
  const [action, setAction] = useState<string>("");
  const [page, setPage] = useState(1);
  useEffect(() => setPage(1), [day, action]);
  const ev = useApi(`/admin/automation/events?day=${day}${action ? `&action=${action}` : ""}&page=${page}`, [day, action, page]);
  const selected = data.days.find((x: any) => x.day === day) ?? data.days[0];
  const strip = data.days.slice(0, 14);
  const max = Math.max(1, ...strip.map((x: any) => Object.values(x.counts).reduce((a: number, b: any) => a + b, 0) as number));
  const actions: [string, string][] = Object.entries(data.actions);

  return (
    <div className="space-y-6">
      {data.settings.enabled && !data.healthy && (
        <Alert tone="error">
          <b>The daily automation hasn&apos;t run in the last 26 hours.</b> Invoices, reminders and suspensions are not going out. Check the worker on the server (<code className="text-xs">pm2 status crapplet-worker</code>, then <code className="text-xs">pm2 logs crapplet-worker</code>), or click <b>Run now</b>.
        </Alert>
      )}
      {!data.settings.enabled && <Alert tone="warn"><b>Automation is turned off.</b> No renewal invoices, reminders, suspensions or terminations happen until you turn it on in Settings.</Alert>}

      <Card title="Last 14 days" pad={false}>
        <div className="flex gap-2 overflow-x-auto p-4 [scrollbar-width:thin]">
          {strip.map((x: any) => {
            const total = Object.values(x.counts).reduce((a: number, b: any) => a + b, 0) as number;
            const failed = x.counts.error ?? 0;
            return (
              <button key={x.day} onClick={() => { setDay(x.day); setAction(""); }} className={cx("flex w-[78px] shrink-0 flex-col items-center rounded-xl border px-2 pb-2 pt-3 transition", x.day === day ? "border-primary bg-primary-tint ring-2 ring-primary/20" : "border-line bg-white hover:border-primary/40")}>
                <div className="flex h-14 w-full items-end justify-center">
                  <div className={cx("w-6 rounded-t-md", failed ? "bg-gradient-to-t from-rose-500 to-rose-400" : "bg-gradient-to-t from-primary-dark to-primary")} style={{ height: `${Math.max(4, (total / max) * 56)}px`, opacity: total ? 1 : 0.25 }} />
                </div>
                <div className="mt-1.5 text-[15px] font-extrabold text-ink">{total}</div>
                <div className="text-[10.5px] font-semibold text-mute">{dayLabel(x.day)}</div>
              </button>
            );
          })}
        </div>
      </Card>

      <Card title={`${dayLabel(selected.day)} — what the automation did`} action={action && <button className="text-[13px] font-bold text-primary-dark hover:underline" onClick={() => setAction("")}>Show everything</button>}>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
          {actions.map(([k, label]) => {
            const n = selected.counts[k] ?? 0;
            const sty = ACTION_STYLE[k] ?? { icon: "bolt", tone: "bg-slate-100 text-slate-600" };
            return (
              <button key={k} onClick={() => setAction(action === k ? "" : k)} className={cx("flex items-center gap-3 rounded-xl border p-3 text-left transition", action === k ? "border-primary bg-primary-tint ring-2 ring-primary/20" : "border-line bg-white hover:border-primary/40", !n && "opacity-60")}>
                <span className={cx("grid h-9 w-9 shrink-0 place-items-center rounded-lg", sty.tone)}><Icon name={sty.icon} className="text-[19px]" /></span>
                <span className="min-w-0"><span className={cx("block text-lg font-extrabold leading-tight", k === "error" && n ? "text-rose-600" : "text-ink")}>{n}</span><span className="block truncate text-[11.5px] font-semibold text-mute">{label}</span></span>
              </button>
            );
          })}
        </div>
      </Card>

      <Card title={action ? `${data.actions[action]} · ${dayLabel(selected.day)}` : `All actions · ${dayLabel(selected.day)}`} pad={false} action={ev.data && <span className="text-xs text-mute">{ev.data.total} item{ev.data.total === 1 ? "" : "s"}</span>}>
        {!ev.data ? <Loading /> : !ev.data.items.length ? <p className="p-5 text-sm text-mute">Nothing{action ? ` of this kind` : ""} on this day.</p> : (
          <>
            <ul className="divide-y divide-line">
              {ev.data.items.map((e: any) => {
                const sty = ACTION_STYLE[e.action] ?? { icon: "bolt", tone: "bg-slate-100 text-slate-600" };
                const href = e.entity && e.entityId && LINK[e.entity] ? LINK[e.entity](e.entityId, e.label) : null;
                return (
                  <li key={e.id} className="flex items-start gap-3 px-5 py-3">
                    <span className={cx("mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-lg", sty.tone)}><Icon name={sty.icon} className="text-[17px]" /></span>
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                        <span className="text-[12px] font-bold uppercase tracking-wide text-mute">{data.actions[e.action] ?? e.action}</span>
                        {href ? <Link href={href} className="text-[13.5px] font-bold text-primary-dark hover:underline">{e.label ?? e.entityId}</Link> : <span className="text-[13.5px] font-bold text-ink">{e.label}</span>}
                        {e.user && <Link href={`/admin/clients/${e.user.id}`} className="text-xs text-mute hover:text-primary-dark">· {[e.user.firstName, e.user.lastName].filter(Boolean).join(" ") || e.user.email}</Link>}
                      </div>
                      {e.message && <div className={cx("mt-0.5 break-words text-xs", e.success ? "text-mute" : "font-semibold text-rose-600")}>{e.message}</div>}
                    </div>
                    <span className="shrink-0 text-xs text-mute">{new Date(e.createdAt).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" })}</span>
                  </li>
                );
              })}
            </ul>
            {ev.data.pages > 1 && (
              <div className="flex items-center justify-between border-t border-line px-5 py-3 text-sm">
                <Button size="sm" variant="ghost" disabled={page <= 1} onClick={() => setPage(page - 1)}>Previous</Button>
                <span className="text-mute">Page {page} of {ev.data.pages}</span>
                <Button size="sm" variant="ghost" disabled={page >= ev.data.pages} onClick={() => setPage(page + 1)}>Next</Button>
              </div>
            )}
          </>
        )}
      </Card>

      <Card title="Run history" pad={false}>
        {!data.runs.length ? <p className="p-5 text-sm text-mute">No runs yet — the first scheduled run happens at {data.settings.runAt} IST, or click Run now.</p> : (
          <ul className="divide-y divide-line">
            {data.runs.map((r: any) => {
              const top = Object.entries(r.summary ?? {}).sort((a: any, b: any) => b[1] - a[1]);
              return (
                <li key={r.id} className="flex flex-wrap items-center gap-x-4 gap-y-2 px-5 py-3">
                  <span className="w-44 shrink-0">
                    <span className="block text-[13.5px] font-bold text-ink">{date(r.startedAt, true)}</span>
                    <span className="text-xs text-mute">{r.trigger === "manual" ? "Run now" : "Scheduled"} · {r.durationMs != null ? `${(r.durationMs / 1000).toFixed(1)} s` : "running…"}</span>
                  </span>
                  <span className="flex min-w-0 flex-1 flex-wrap gap-1.5">
                    {top.length ? top.map(([k, n]: any) => (
                      <span key={k} className={cx("rounded-md px-2 py-0.5 text-[11.5px] font-bold", k === "error" ? "bg-rose-50 text-rose-700" : "bg-[#f4effd] text-primary-dark")}>{n} {(data.actions[k] ?? k).toLowerCase()}</span>
                    )) : <span className="text-xs text-mute">Nothing was due</span>}
                  </span>
                  <Badge status={r.status === "RUNNING" ? "PROVISIONING" : r.summary?.error ? "SUSPENDED" : "ACTIVE"}>{r.status === "RUNNING" ? "Running" : r.summary?.error ? "With errors" : "Completed"}</Badge>
                </li>
              );
            })}
          </ul>
        )}
      </Card>
    </div>
  );
}

const list = (v: number[]) => v.join(", ");
const parseList = (s: string) => s.split(/[\s,]+/).map(Number).filter((n) => Number.isInteger(n) && n > 0);

function SettingsTab({ data, onSaved }: { data: any; onSaved: () => void }) {
  const [f, setF] = useState<any>(() => ({ ...data.settings, autoCloseHours: data.support.autoCloseHours, lateFeeEnabled: data.settings.lateFeeEnabled || data.settings.lateFeePct > 0, lateFeeAmount: data.settings.lateFeeEnabled ? data.settings.lateFeeAmount : data.settings.lateFeePct || data.settings.lateFeeAmount }));
  const [txt, setTxt] = useState({ reminderDaysBefore: list(data.settings.reminderDaysBefore), overdueReminderDaysAfter: list(data.settings.overdueReminderDaysAfter), domainExpiryNoticeDays: list(data.settings.domainExpiryNoticeDays) });
  const [busy, setBusy] = useState(false);
  const set = (k: string, v: any) => setF((x: any) => ({ ...x, [k]: v }));
  const num = (k: string) => ({ type: "number", value: f[k], onChange: (e: any) => set(k, e.target.value === "" ? "" : Number(e.target.value)) });
  const overdue = useMemo(() => parseList(txt.overdueReminderDaysAfter).sort((a, b) => a - b), [txt.overdueReminderDaysAfter]);

  async function save() {
    setBusy(true);
    try {
      const { lateFeePct, ...rest } = f;
      await api("/admin/automation/settings", { method: "PUT", body: { ...rest, reminderDaysBefore: parseList(txt.reminderDaysBefore), overdueReminderDaysAfter: parseList(txt.overdueReminderDaysAfter), domainExpiryNoticeDays: parseList(txt.domainExpiryNoticeDays) } });
      toast.success("Automation settings saved");
      onSaved();
    } catch (e: any) {
      toast.error(e.message);
    } finally {
      setBusy(false);
    }
  }

  const Row = ({ children }: { children: React.ReactNode }) => <div className="grid gap-4 sm:grid-cols-2">{children}</div>;
  return (
    <div className="grid items-start gap-6 xl:grid-cols-2">
      <Card title="Schedule">
        <div className="space-y-4">
          <Toggle checked={f.enabled} onChange={(v) => set("enabled", v)} label="Run the daily automation" />
          <Row>
            <Field label="Run every day at (IST)" hint="24-hour time. If the server was down, the run happens as soon as it's back."><Input value={f.runAt} onChange={(e) => set("runAt", e.target.value)} placeholder="09:00" /></Field>
            <Field label="Keep activity history (days)" hint="Older automation records are deleted."><Input {...num("historyDays")} /></Field>
          </Row>
        </div>
      </Card>

      <Card title="Invoices">
        <div className="space-y-4">
          <Row>
            <Field label="Create renewal invoices (days before due)" hint="WHMCS: Invoice Generation"><Input {...num("invoiceDaysBeforeDue")} /></Field>
            <Field label="Domain renewal invoices (days before due)"><Input {...num("domainInvoiceDaysBeforeDue")} /></Field>
          </Row>
          <Toggle checked={f.invoiceCreatedEmail} onChange={(v) => set("invoiceCreatedEmail", v)} label="Email the customer when an invoice is created" />
          <Toggle checked={f.applyCreditAutomatically} onChange={(v) => set("applyCreditAutomatically", v)} label="Pay new invoices from account credit automatically" />
        </div>
      </Card>

      <Card title="Payment reminders">
        <div className="space-y-4">
          <Field label="Reminder before due (days, comma separated)" hint="e.g. 7, 3 — an “invoice due soon” email on each of these days"><Input value={txt.reminderDaysBefore} onChange={(e) => setTxt({ ...txt, reminderDaysBefore: e.target.value })} /></Field>
          <Field label="Overdue notices (days after due, comma separated)" hint={overdue.length ? `First notice on day ${overdue[0]}${overdue[1] ? `, second on day ${overdue[1]}` : ""}${overdue[2] ? `, third on day ${overdue[2]}` : ""}` : "No overdue notices"}><Input value={txt.overdueReminderDaysAfter} onChange={(e) => setTxt({ ...txt, overdueReminderDaysAfter: e.target.value })} /></Field>
        </div>
      </Card>

      <Card title="Late fees">
        <div className="space-y-4">
          <Toggle checked={f.lateFeeEnabled} onChange={(v) => set("lateFeeEnabled", v)} label="Add a late fee to overdue invoices" />
          {f.lateFeeEnabled && (
            <>
              <Row>
                <Field label="Fee type"><Select value={f.lateFeeType} onChange={(e) => set("lateFeeType", e.target.value)}><option value="percent">Percentage of the invoice</option><option value="fixed">Fixed amount</option></Select></Field>
                <Field label={f.lateFeeType === "percent" ? "Percentage (%)" : "Amount (invoice currency)"}><Input step="0.01" {...num("lateFeeAmount")} /></Field>
                <Field label="Minimum fee (invoice currency)" hint="0 = no minimum"><Input step="0.01" {...num("lateFeeMinimum")} /></Field>
                <Field label="Add it this many days after due"><Input {...num("lateFeeDaysAfterDue")} /></Field>
              </Row>
              <p className="text-xs text-mute">Added once per invoice as a “Late payment fee” line, with GST, so the customer pays it with the invoice.</p>
            </>
          )}
        </div>
      </Card>

      <Card title="Suspension">
        <div className="space-y-4">
          <Toggle checked={f.autoSuspend} onChange={(v) => set("autoSuspend", v)} label="Suspend services with overdue invoices" />
          {f.autoSuspend && <Field label="Suspend this many days after due"><Input {...num("suspendDaysAfterDue")} /></Field>}
          <Toggle checked={f.suspendEmail} onChange={(v) => set("suspendEmail", v)} label="Email the customer when a service is suspended" />
          <Toggle checked={f.autoUnsuspend} onChange={(v) => set("autoUnsuspend", v)} label="Unsuspend automatically when the overdue invoices are paid" />
          <Toggle checked={f.unsuspendEmail} onChange={(v) => set("unsuspendEmail", v)} label="Email the customer when a service is unsuspended" />
          <p className="text-xs text-mute">Services marked “Exempt from automatic suspension” are never suspended or terminated by the automation.</p>
        </div>
      </Card>

      <Card title="Termination">
        <div className="space-y-4">
          <Toggle checked={f.autoTerminate} onChange={(v) => set("autoTerminate", v)} label="Terminate services still unpaid after suspension" />
          {f.autoTerminate && <Field label="Terminate this many days after due" hint="Must be more than the suspension days. The VPS / hosting account is deleted on the server."><Input {...num("terminateDaysAfterDue")} /></Field>}
          <Toggle checked={f.terminateEmail} onChange={(v) => set("terminateEmail", v)} label="Email the customer when a service is terminated" />
        </div>
      </Card>

      <Card title="Orders, domains & support">
        <div className="space-y-4">
          <Row>
            <Field label="Cancel unpaid orders after (days)" hint="0 = never. Releases the IPs held for the order."><Input {...num("cancelUnpaidOrdersAfterDays")} /></Field>
            <Field label="Close answered tickets after (hours)" hint="0 = never. Tickets waiting on the customer."><Input {...num("autoCloseHours")} /></Field>
          </Row>
          <Field label="Domain expiry notices (days before expiry, comma separated)"><Input value={txt.domainExpiryNoticeDays} onChange={(e) => setTxt({ ...txt, domainExpiryNoticeDays: e.target.value })} /></Field>
        </div>
      </Card>

      <div className="xl:col-span-2">
        <div className="sticky bottom-4 flex items-center justify-end gap-3 rounded-2xl border border-line bg-white/95 p-3 shadow-card backdrop-blur">
          <span className="mr-auto hidden text-xs text-mute sm:block">Changes apply from the next run.</span>
          <Button icon="save" loading={busy} onClick={save}>Save automation settings</Button>
        </div>
      </div>
    </div>
  );
}

export default function Page() {
  return <Suspense fallback={<Loading />}><AutomationPage /></Suspense>;
}
