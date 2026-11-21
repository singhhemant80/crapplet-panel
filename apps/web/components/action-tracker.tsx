"use client";
/**
 * Progress of what's happening to a service: reinstall, change IP, power actions, password reset …
 * Polls quickly while something runs, slowly otherwise. Call pingActivity() right after starting an action.
 */
import { useEffect, useRef, useState } from "react";
import { api } from "@/lib/api";
import { Icon, cx } from "@/components/ui";

type Item = {
  id: string;
  action: string;
  label: string;
  state: "queued" | "running" | "retrying" | "installing" | "done" | "failed";
  percent: number;
  steps: { label: string; state: "done" | "current" | "pending" | "failed" }[];
  message: string;
  queuedAt: string | null;
  startedAt: string | null;
  finishedAt: string | null;
};

export const pingActivity = () => {
  try {
    window.dispatchEvent(new Event("service-activity"));
  } catch {
    /* server render */
  }
};

const since = (iso: string | null) => {
  if (!iso) return "";
  const s = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${Math.floor(s / 3600)}h`;
};
const ICON: Record<string, string> = { reinstall: "install_desktop", change_ip: "swap_horiz", reset_password: "key", start: "play_arrow", stop: "stop_circle", shutdown: "power_settings_new", reboot: "restart_alt", hard_reset: "bolt", suspend: "pause_circle", unsuspend: "play_circle", terminate: "delete_forever", change_package: "upgrade", change_plan: "upgrade" };

export function ActionTracker({ url, onFinished, className }: { url: string; onFinished?: () => void; className?: string }) {
  const [items, setItems] = useState<Item[]>([]);
  const [, tick] = useState(0);
  const fastUntil = useRef(0);
  const finished = useRef(new Set<string>());
  const first = useRef(true);
  const [hidden, setHidden] = useState<string[]>([]);

  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout>;
    const load = async () => {
      try {
        const r = await api<{ items: Item[]; active: boolean }>(url);
        if (!alive) return;
        setItems(r.items);
        // something finished since last look → refresh the page's data (new IPs, OS, status …)
        let changed = false;
        for (const i of r.items) {
          if ((i.state === "done" || i.state === "failed") && !finished.current.has(i.id)) {
            finished.current.add(i.id);
            if (!first.current) changed = true;
          }
        }
        first.current = false;
        if (changed) onFinished?.();
        if (r.active) fastUntil.current = Math.max(fastUntil.current, Date.now() + 5000);
      } catch {
        /* keep the last view */
      }
      if (alive) timer = setTimeout(load, Date.now() < fastUntil.current ? 2500 : 15000);
    };
    const kick = () => {
      fastUntil.current = Date.now() + 60_000;
      clearTimeout(timer);
      timer = setTimeout(load, 800);
    };
    load();
    window.addEventListener("service-activity", kick);
    const t = setInterval(() => tick((x) => x + 1), 1000);
    return () => {
      alive = false;
      clearTimeout(timer);
      clearInterval(t);
      window.removeEventListener("service-activity", kick);
    };
  }, [url]); // eslint-disable-line react-hooks/exhaustive-deps

  const shown = items.filter((i) => !hidden.includes(i.id));
  if (!shown.length) return null;
  return (
    <div className={cx("space-y-3", className)}>
      {shown.map((i) => {
        const busy = ["queued", "running", "retrying", "installing"].includes(i.state);
        const tone = i.state === "failed" ? "rose" : i.state === "done" ? "emerald" : "violet";
        return (
          <div key={i.id} className={cx("overflow-hidden rounded-2xl border bg-white shadow-card", tone === "rose" ? "border-rose-200" : tone === "emerald" ? "border-emerald-200" : "border-[#e4d8ff]")}>
            <div className="flex items-start gap-3 px-5 py-4">
              <span className={cx("grid h-11 w-11 shrink-0 place-items-center rounded-xl", tone === "rose" ? "bg-rose-50 text-rose-600" : tone === "emerald" ? "bg-emerald-50 text-emerald-600" : "bg-[#f1ecfd] text-[#7c3aed]")}>
                <Icon name={i.state === "done" ? "check_circle" : i.state === "failed" ? "error" : ICON[i.action] ?? "sync"} className={cx("text-[22px]", busy && i.state !== "queued" && "animate-pulse")} fill={!busy} />
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                  <b className="text-[15px] text-ink">{i.label}</b>
                  <span className={cx("rounded-full px-2 py-0.5 text-[11px] font-extrabold uppercase tracking-wide", tone === "rose" ? "bg-rose-100 text-rose-700" : tone === "emerald" ? "bg-emerald-100 text-emerald-700" : "bg-[#f1ecfd] text-[#6d28d9]")}>
                    {{ queued: "Queued", running: "In progress", retrying: "Retrying", installing: "Installing", done: "Done", failed: "Failed" }[i.state]}
                  </span>
                  <span className="text-xs font-semibold text-mute">
                    {busy ? (i.startedAt ? `running for ${since(i.startedAt)}` : i.queuedAt ? `queued ${since(i.queuedAt)} ago` : "") : i.finishedAt ? `${since(i.finishedAt)} ago` : ""}
                  </span>
                </div>
                <p className={cx("mt-1 text-[13px] leading-relaxed", i.state === "failed" ? "text-rose-700" : "text-slate-600")}>{i.message}</p>
              </div>
              {!busy && (
                <button onClick={() => setHidden((h) => [...h, i.id])} aria-label="Dismiss" className="grid h-8 w-8 shrink-0 place-items-center rounded-lg text-slate-400 hover:bg-slate-50 hover:text-slate-700">
                  <Icon name="close" className="text-[18px]" />
                </button>
              )}
            </div>
            <div className="px-5 pb-4">
              <div className="h-2 overflow-hidden rounded-full bg-[#f1eff8]">
                <div className={cx("h-full rounded-full transition-all duration-700", tone === "rose" ? "bg-rose-500" : tone === "emerald" ? "bg-emerald-500" : "bg-gradient-to-r from-[#a365fe] to-[#7c3aed]", busy && "animate-pulse")} style={{ width: `${i.percent}%` }} />
              </div>
              <ol className="mt-3 flex flex-wrap gap-x-5 gap-y-1.5">
                {i.steps.map((st) => (
                  <li key={st.label} className={cx("flex items-center gap-1.5 text-[12px] font-bold", st.state === "done" ? "text-emerald-700" : st.state === "current" ? "text-[#6d28d9]" : st.state === "failed" ? "text-rose-600" : "text-slate-400")}>
                    <Icon name={st.state === "done" ? "check_circle" : st.state === "current" ? "progress_activity" : st.state === "failed" ? "cancel" : "radio_button_unchecked"} className={cx("text-[15px]", st.state === "current" && "animate-spin")} fill={st.state === "done"} />
                    {st.label}
                  </li>
                ))}
              </ol>
            </div>
          </div>
        );
      })}
    </div>
  );
}
