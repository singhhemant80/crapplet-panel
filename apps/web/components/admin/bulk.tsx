"use client";
/** Pick rows in a list and act on them together (send reminders …). */
import { useState, type ReactNode } from "react";
import { api } from "@/lib/api";
import { Icon, cx, toast } from "@/components/ui";

export function useSelection() {
  const [sel, setSel] = useState<string[]>([]);
  return {
    sel,
    has: (id: string) => sel.includes(id),
    toggle: (id: string, on: boolean) => setSel((s) => (on ? [...new Set([...s, id])] : s.filter((x) => x !== id))),
    /** header checkbox for the rows on this page */
    allOn: (ids: string[]) => ids.length > 0 && ids.every((id) => sel.includes(id)),
    togglePage: (ids: string[], on: boolean) => setSel((s) => (on ? [...new Set([...s, ...ids])] : s.filter((x) => !ids.includes(x)))),
    clear: () => setSel([]),
  };
}

export function Check({ checked, onChange, label }: { checked: boolean; onChange: (on: boolean) => void; label: string }) {
  return <input type="checkbox" aria-label={label} className="h-4 w-4 cursor-pointer accent-primary" checked={checked} onChange={(e) => onChange(e.target.checked)} onClick={(e) => e.stopPropagation()} />;
}

export function BulkBar({ count, onClear, children }: { count: number; onClear: () => void; children: ReactNode }) {
  if (!count) return null;
  return (
    <div className="sticky top-[72px] z-20 mb-3 flex flex-wrap items-center gap-2 rounded-2xl border border-primary/30 bg-white/95 px-4 py-2.5 shadow-lg backdrop-blur">
      <span className="mr-1 inline-flex items-center gap-1.5 text-sm font-bold text-ink"><Icon name="check_box" className="text-[18px] text-primary" fill />{count} selected</span>
      {children}
      <button className="ml-auto text-xs font-bold text-mute hover:text-ink" onClick={onClear}>Clear</button>
    </div>
  );
}

type Out = { sent: number; skipped: number; reasons: Record<string, number> };
/** Toast "Sent to N · M skipped (why)". */
export function reportSent(r: Out, what: string) {
  const why = Object.entries(r.reasons ?? {}).map(([k, n]) => `${n} ${k.charAt(0).toLowerCase()}${k.slice(1)}`).join("; ");
  if (r.sent && !r.skipped) toast.success(`${what} sent to ${r.sent} customer${r.sent === 1 ? "" : "s"}`);
  else if (r.sent) toast.success(`${what} sent to ${r.sent} · ${r.skipped} skipped (${why})`);
  else toast.error(`Nothing sent — ${why || "no matching customers"}`);
}

/** A bar button that confirms, posts the ids and reports. */
export function RemindButton({ ids, path, what, confirmText, onDone, className }: { ids: string[]; path: string; what: string; confirmText: string; onDone: () => void; className?: string }) {
  const [busy, setBusy] = useState(false);
  return (
    <button
      disabled={busy}
      onClick={async () => {
        if (!confirm(confirmText)) return;
        setBusy(true);
        try {
          reportSent(await api<Out>(path, { body: { ids } }), what);
          onDone();
        } catch (e: any) {
          toast.error(e.message);
        }
        setBusy(false);
      }}
      className={cx("inline-flex h-8 items-center gap-1.5 rounded-lg bg-primary px-3 text-[13px] font-bold text-white transition hover:bg-primary-dark disabled:opacity-60", className)}
    >
      <Icon name={busy ? "progress_activity" : "notifications_active"} className={cx("text-[17px]", busy && "animate-spin")} />
      {busy ? "Sending…" : `Send ${what.toLowerCase()}`}
    </button>
  );
}
