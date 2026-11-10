"use client";
import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { cx } from "./ui";

export type LiveState = "running" | "stopped" | "suspended" | "locked" | "unknown";

const STYLE: Record<LiveState, { label: string; dot: string; chip: string }> = {
  running: { label: "Online", dot: "bg-emerald-500 shadow-[0_0_0_3px_rgba(16,185,129,.22)]", chip: "bg-emerald-50 text-emerald-700 ring-emerald-200" },
  stopped: { label: "Offline", dot: "bg-rose-500", chip: "bg-rose-50 text-rose-700 ring-rose-200" },
  suspended: { label: "Suspended", dot: "bg-amber-500", chip: "bg-amber-50 text-amber-800 ring-amber-200" },
  locked: { label: "Locked", dot: "bg-slate-500", chip: "bg-slate-100 text-slate-700 ring-slate-300" },
  unknown: { label: "Unknown", dot: "bg-slate-300", chip: "bg-slate-50 text-slate-500 ring-line" },
};

/** Online / Offline / Suspended / Locked chip with a dot, as Virtualizor reports the VPS. */
export function LiveBadge({ state, reason, loading, className }: { state?: string | null; reason?: string | null; loading?: boolean; className?: string }) {
  if (loading && !state) return <span className={cx("inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11.5px] font-bold text-slate-400 ring-1 ring-line", className)}><span className="h-2 w-2 animate-pulse rounded-full bg-slate-300" />Checking…</span>;
  const st = STYLE[(state as LiveState) ?? "unknown"] ?? STYLE.unknown;
  return (
    <span title={reason ?? undefined} className={cx("inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 py-1 text-[11.5px] font-bold ring-1", st.chip, className)}>
      <span className={cx("h-2 w-2 rounded-full", st.dot)} />
      {st.label}
    </span>
  );
}

/** Polls live states for a list of services (every 30 s). */
export function useLiveStates(path: string | null) {
  const [states, setStates] = useState<Record<string, { state: LiveState; reason?: string }>>({});
  const [loading, setLoading] = useState(!!path);
  useEffect(() => {
    if (!path) return;
    let alive = true;
    const load = () =>
      api<{ states: Record<string, { state: LiveState; reason?: string }> }>(path)
        .then((r) => alive && setStates(r.states))
        .catch(() => {})
        .finally(() => alive && setLoading(false));
    load();
    const t = setInterval(load, 30_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [path]);
  return { states, loading };
}
