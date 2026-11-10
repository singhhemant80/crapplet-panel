"use client";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { api } from "@/lib/api";
import { Button, Icon, cx } from "./ui";

type Step = { key: string; label: string; state: "done" | "current" | "pending" | "failed"; at?: string | null; detail?: string };
export type Progress = {
  serviceId: string;
  status: string;
  inProgress: boolean;
  stuck?: boolean;
  percent: number;
  headline: string;
  message: string;
  steps: Step[];
  invoiceId?: string | null;
  job?: { state: string; attempt: number; maxAttempts: number; nextRetryAt: string | null; lastError?: string | null } | null;
  error?: string | null;
  startedAt?: string | null;
  finishedAt?: string | null;
  now?: string;
};

const ICON: Record<string, string> = { order: "shopping_bag", payment: "payments", queue: "schedule", server: "dns", create: "deployed_code", ready: "rocket_launch" };
const time = (v?: string | null) => (v ? new Date(v).toLocaleString("en-IN", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }) : "");

/** server clock minus this device's clock — "running for" stays right when the viewer's clock is wrong */
let skew = 0;
function elapsed(from?: string | null, to?: string | null) {
  if (!from) return "";
  const s = Math.max(0, Math.round(((to ? new Date(to).getTime() : Date.now() + skew) - new Date(from).getTime()) / 1000));
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}

/**
 * Live provisioning progress (order → payment → queue → server → build → ready). Polls while setup is
 * running and calls onChange when the service status changes, so the parent page can reload.
 */
export function ProvisioningTracker({ path, audience, onChange, onRetry, compact, initial }: { path: string; audience: "admin" | "client"; onChange?: (status: string) => void; onRetry?: () => void; compact?: boolean; initial?: Progress }) {
  const [p, setP] = useState<Progress | null>(initial ?? null);
  const [, tick] = useState(0);
  const last = useRef<string | null>(initial?.status ?? null);

  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout>;
    const load = async () => {
      try {
        const r = await api<Progress>(path);
        if (!alive) return;
        if (r.now) skew = new Date(r.now).getTime() - Date.now();
        setP(r);
        if (last.current && last.current !== r.status) onChange?.(r.status);
        last.current = r.status;
        // fast while building; still check a failed/stuck one often so a staff retry shows up quickly
        timer = setTimeout(load, r.inProgress ? 4000 : r.status === "ACTIVE" ? 60000 : 10000);
      } catch {
        if (alive) timer = setTimeout(load, 10000);
      }
    };
    if (!initial) load();
    else timer = setTimeout(load, initial.inProgress ? 4000 : 30000);
    return () => { alive = false; clearTimeout(timer); };
  }, [path]); // eslint-disable-line react-hooks/exhaustive-deps

  // keeps the "running for 1m 20s" counter moving between polls
  useEffect(() => {
    if (!p?.inProgress) return;
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [p?.inProgress]);

  if (!p) return null;
  const failed = p.status === "FAILED" || !!p.stuck;
  const done = p.status === "ACTIVE";
  const tone = failed ? "rose" : done ? "emerald" : "violet";
  const retrying = p.job?.state === "delayed";

  if (compact) {
    const cur = p.steps.find((s) => s.state === "current" || s.state === "failed");
    return (
      <div className="min-w-[180px]">
        <div className="mb-1 flex items-center justify-between gap-2 text-[12px] font-bold">
          <span className={cx(failed ? "text-rose-700" : done ? "text-emerald-700" : "text-primary-dark")}>{done ? "Ready" : p.stuck ? "Stuck" : cur?.label ?? p.headline}</span>
          <span className="text-mute">{p.percent}%</span>
        </div>
        <div className="h-1.5 overflow-hidden rounded-full bg-slate-100">
          <div className={cx("h-full rounded-full transition-all duration-700", failed ? "bg-rose-500" : done ? "bg-emerald-500" : "bg-primary", p.inProgress && "animate-pulse")} style={{ width: `${Math.max(p.percent, 6)}%` }} />
        </div>
      </div>
    );
  }

  return (
    <section className={cx("mb-6 overflow-hidden rounded-2xl border bg-white shadow-card", failed ? "border-rose-200" : done ? "border-emerald-200" : "border-[#e9d5ff]")}>
      <div className={cx("flex flex-wrap items-start gap-4 px-5 py-4 sm:px-6", failed ? "bg-rose-50/70" : done ? "bg-emerald-50/60" : "bg-[#faf6ff]")}>
        <span className={cx("grid h-11 w-11 shrink-0 place-items-center rounded-xl", failed ? "bg-rose-100 text-rose-600" : done ? "bg-emerald-100 text-emerald-600" : "bg-primary-soft text-primary-dark")}>
          {p.inProgress ? <span className="h-5 w-5 animate-spin rounded-full border-[3px] border-current border-t-transparent" /> : <Icon name={failed ? "error" : done ? "check_circle" : retrying ? "autorenew" : "hourglass_top"} className="text-[24px]" fill />}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <h3 className="text-[17px] font-extrabold text-ink">{p.headline}</h3>
            {p.inProgress && p.startedAt && <span className="rounded-full bg-white px-2.5 py-0.5 text-xs font-bold text-primary-dark ring-1 ring-[#e9d5ff]">running {elapsed(p.startedAt)}</span>}
            {done && p.startedAt && p.finishedAt && <span className="rounded-full bg-white px-2.5 py-0.5 text-xs font-bold text-emerald-700 ring-1 ring-emerald-200">built in {elapsed(p.startedAt, p.finishedAt)}</span>}
            {audience === "admin" && p.job && p.job.maxAttempts > 1 && !done && <span className="rounded-full bg-white px-2.5 py-0.5 text-xs font-bold text-slate-600 ring-1 ring-line">attempt {Math.max(1, p.job.attempt)} of {p.job.maxAttempts} · {p.job.state}</span>}
          </div>
          {p.message && <p className={cx("mt-1 break-words text-sm", failed && audience === "admin" ? "font-semibold text-rose-800" : "text-slate-600")}>{p.message}</p>}
          {retrying && p.job?.nextRetryAt && <p className="mt-1 text-xs font-semibold text-amber-700">Next attempt around {time(p.job.nextRetryAt)}</p>}
        </div>
        <div className="flex flex-wrap gap-2">
          {p.invoiceId && audience === "client" && <Button size="sm" icon="payments" href={`/client/invoices/${p.invoiceId}`}>Pay invoice</Button>}
          {p.invoiceId && audience === "admin" && <Button size="sm" variant="outline" icon="receipt_long" href={`/admin/invoices/${p.invoiceId}`}>Invoice</Button>}
          {failed && audience === "admin" && onRetry && <Button size="sm" icon="rocket_launch" onClick={onRetry}>Retry provisioning</Button>}
          {failed && audience === "admin" && !onRetry && <Button size="sm" variant="outline" icon="arrow_forward" href={`/admin/services/${p.serviceId}`}>Open</Button>}
          {failed && audience === "client" && <Button size="sm" variant="outline" icon="support_agent" href="/client/tickets/new">Contact support</Button>}
        </div>
      </div>

      <div className="h-1 bg-slate-100">
        <div className={cx("h-full transition-all duration-700", tone === "rose" ? "bg-rose-500" : tone === "emerald" ? "bg-emerald-500" : "bg-gradient-to-r from-primary to-primary-dark")} style={{ width: `${Math.max(p.percent, 4)}%` }} />
      </div>

      <ol className="grid gap-0 px-5 py-4 sm:px-6 md:grid-cols-6">
        {p.steps.map((s, i) => (
          <li key={s.key} className="relative flex gap-3 pb-4 md:flex-col md:items-center md:gap-2 md:pb-0 md:text-center">
            {/* connector */}
            {i < p.steps.length - 1 && (
              <span className={cx("absolute left-[17px] top-9 h-[calc(100%-28px)] w-0.5 md:left-[calc(50%+22px)] md:top-[17px] md:h-0.5 md:w-[calc(100%-44px)]", s.state === "done" ? "bg-emerald-300" : "bg-slate-200")} />
            )}
            <span
              className={cx(
                "relative z-10 grid h-9 w-9 shrink-0 place-items-center rounded-full ring-4 ring-white",
                s.state === "done" && "bg-emerald-500 text-white",
                s.state === "current" && "bg-primary text-white shadow-[0_0_0_6px_rgba(163,101,254,.18)]",
                s.state === "failed" && "bg-rose-500 text-white",
                s.state === "pending" && "bg-slate-100 text-slate-400",
              )}
            >
              {s.state === "current" && p.inProgress ? <span className="h-4 w-4 animate-spin rounded-full border-2 border-white border-t-transparent" /> : <Icon name={s.state === "done" ? "check" : s.state === "failed" ? "close" : ICON[s.key] ?? "circle"} className="text-[18px]" />}
            </span>
            <div className="min-w-0 pt-1 md:px-1 md:pt-0">
              <div className={cx("text-[13px] font-bold leading-tight", s.state === "pending" ? "text-slate-400" : s.state === "failed" ? "text-rose-700" : "text-ink")}>{s.label}</div>
              {s.at && <div className="mt-0.5 text-[11px] text-mute">{time(s.at)}</div>}
              {s.detail && <div className={cx("mt-1 break-words text-[11.5px] leading-snug", s.state === "failed" ? "text-rose-700" : "text-slate-500")}>{s.detail}</div>}
            </div>
          </li>
        ))}
      </ol>
      {audience === "client" && p.inProgress && (
        <div className="border-t border-line px-5 py-3 text-xs text-mute sm:px-6">
          You can leave this page — we&apos;ll email your login details as soon as the server is ready. <Link href="/client/services" className="font-bold text-primary-dark hover:underline">Back to services</Link>
        </div>
      )}
    </section>
  );
}
