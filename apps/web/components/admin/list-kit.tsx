"use client";
/** Building blocks for the admin list pages (Orders, Customers): avatar, status tabs, toolbar, time-ago. */
import { useEffect, useState, type ReactNode } from "react";
import { Icon, cx } from "@/components/ui";

const AVATAR_TONES = [
  "from-violet-500 to-purple-700",
  "from-sky-500 to-indigo-600",
  "from-emerald-500 to-teal-600",
  "from-amber-500 to-orange-600",
  "from-rose-500 to-pink-600",
  "from-fuchsia-500 to-violet-600",
  "from-cyan-500 to-sky-600",
  "from-lime-500 to-emerald-600",
];

export function initialsOf(first?: string | null, last?: string | null, email?: string | null) {
  const a = (first ?? "").trim()[0] ?? (email ?? "?")[0];
  const b = (last ?? "").trim()[0] ?? "";
  return (a + b).toUpperCase();
}

/** Coloured initials, the same colour for the same person every time. */
export function Avatar({ name, seed, size = 38, className }: { name: string; seed: string; size?: number; className?: string }) {
  let h = 0;
  for (const ch of seed) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return (
    <span
      className={cx("grid shrink-0 place-items-center rounded-xl bg-gradient-to-br font-extrabold text-white shadow-sm", AVATAR_TONES[h % AVATAR_TONES.length], className)}
      style={{ width: size, height: size, fontSize: Math.round(size * 0.36) }}
      aria-hidden
    >
      {name}
    </span>
  );
}

export type Tab = { key: string; label: string; icon?: string; tone?: "slate" | "amber" | "green" | "rose" | "sky" | "purple" };
const TAB_DOT: Record<string, string> = { slate: "bg-slate-400", amber: "bg-amber-500", green: "bg-emerald-500", rose: "bg-rose-500", sky: "bg-sky-500", purple: "bg-primary" };

/** Scrollable row of filter tabs with counts. */
export function StatusTabs({ tabs, value, onChange, counts }: { tabs: Tab[]; value: string; onChange: (k: string) => void; counts?: Record<string, number> }) {
  return (
    <div role="tablist" className="-mx-1 flex gap-1 overflow-x-auto px-1 pb-0.5 [scrollbar-width:none]">
      {tabs.map((t) => {
        const on = value === t.key;
        const n = counts?.[t.key || "all"];
        return (
          <button
            key={t.key || "all"}
            role="tab"
            aria-selected={on}
            onClick={() => onChange(t.key)}
            className={cx(
              "inline-flex shrink-0 items-center gap-2 whitespace-nowrap rounded-xl px-3.5 py-2 text-[13px] font-bold transition",
              on ? "bg-primary-dark text-white shadow-glow" : "text-slate-600 hover:bg-primary-tint hover:text-primary-dark",
            )}
          >
            {t.tone && !on && <span className={cx("h-2 w-2 rounded-full", TAB_DOT[t.tone])} />}
            {t.icon && <Icon name={t.icon} className="text-[17px]" />}
            {t.label}
            {n !== undefined && <span className={cx("rounded-md px-1.5 py-px text-[11px] tabular-nums", on ? "bg-white/20" : "bg-slate-100 text-slate-500")}>{n.toLocaleString("en-IN")}</span>}
          </button>
        );
      })}
    </div>
  );
}

/** Search box that applies after the user stops typing. */
export function SearchBox({ value, onSearch, placeholder, className }: { value: string; onSearch: (v: string) => void; placeholder: string; className?: string }) {
  const [v, setV] = useState(value);
  useEffect(() => setV(value), [value]);
  useEffect(() => {
    if (v === value) return;
    const t = setTimeout(() => onSearch(v.trim()), 350);
    return () => clearTimeout(t);
  }, [v]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div className={cx("relative min-w-0", className)}>
      <Icon name="search" className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[20px] text-mute" />
      <input
        value={v}
        onChange={(e) => setV(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && onSearch(v.trim())}
        placeholder={placeholder}
        aria-label={placeholder}
        className="h-10 w-full rounded-xl border border-line bg-white pl-10 pr-9 text-[13.5px] text-ink outline-none transition placeholder:text-slate-400 focus:border-primary focus:ring-2 focus:ring-primary/15"
      />
      {v && (
        <button type="button" aria-label="Clear search" onClick={() => { setV(""); onSearch(""); }} className="absolute right-2 top-1/2 grid h-6 w-6 -translate-y-1/2 place-items-center rounded-md text-slate-400 hover:bg-slate-100 hover:text-slate-600">
          <Icon name="close" className="text-[17px]" />
        </button>
      )}
    </div>
  );
}

/** Compact select used in list toolbars. */
export function FilterSelect({ value, onChange, options, label, icon }: { value: string; onChange: (v: string) => void; options: [string, string][]; label: string; icon: string }) {
  return (
    <label className={cx("relative inline-flex h-10 shrink-0 items-center rounded-xl border bg-white pl-10 pr-2 text-[13px] font-bold transition", value ? "border-primary/50 text-primary-dark ring-2 ring-primary/10" : "border-line text-slate-600")}>
      <Icon name={icon} className="pointer-events-none absolute left-3 text-[18px]" />
      <span className="sr-only">{label}</span>
      <select value={value} onChange={(e) => onChange(e.target.value)} className="h-full cursor-pointer appearance-none bg-transparent pr-6 outline-none">
        {options.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
      </select>
      <Icon name="expand_more" className="pointer-events-none absolute right-2 text-[18px] text-mute" />
    </label>
  );
}

/** "3 min ago", "yesterday", "12 Oct" — with the exact time on hover. */
export function Ago({ at, className }: { at: string | Date | null | undefined; className?: string }) {
  if (!at) return <span className={className}>—</span>;
  const d = new Date(at);
  const s = Math.round((Date.now() - d.getTime()) / 1000);
  const exact = d.toLocaleString("en-IN", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "Asia/Kolkata" });
  let t: string;
  if (s < 0) {
    // future (due dates): today / tomorrow / in 3 days / 12 Dec
    const days = Math.round((new Date(d.toDateString()).getTime() - new Date(new Date().toDateString()).getTime()) / 86400000);
    t = days <= 0 ? "today" : days === 1 ? "tomorrow" : days < 7 ? `in ${days} days` : d.toLocaleDateString("en-IN", { day: "numeric", month: "short", timeZone: "Asia/Kolkata" });
  } else if (s < 60) t = "just now";
  else if (s < 3600) t = `${Math.floor(s / 60)} min ago`;
  else if (s < 86400) t = `${Math.floor(s / 3600)} h ago`;
  else if (s < 2 * 86400) t = "yesterday";
  else if (s < 7 * 86400) t = `${Math.floor(s / 86400)} days ago`;
  else t = d.toLocaleDateString("en-IN", { day: "numeric", month: "short", ...(d.getFullYear() !== new Date().getFullYear() ? { year: "numeric" } : {}), timeZone: "Asia/Kolkata" });
  return <time dateTime={d.toISOString()} title={exact} className={className}>{t}</time>;
}

/** Card shell for a list: toolbar on top, rows, pager at the bottom. */
export function ListShell({ toolbar, children, footer }: { toolbar: ReactNode; children: ReactNode; footer?: ReactNode }) {
  return (
    <section className="overflow-hidden rounded-2xl border border-line bg-white shadow-card">
      <div className="space-y-3 border-b border-line p-3 sm:p-4">{toolbar}</div>
      {children}
      {footer}
    </section>
  );
}

/** Icon for a plan type. */
export function planIcon(type?: string, provisioner?: string) {
  if (type === "RESELLER_HOSTING") return "groups";
  if (type === "WORDPRESS") return "web";
  if (type === "SHARED" || provisioner === "CPANEL") return "language";
  if (type === "DEDICATED" || type === "GPU") return "storage";
  if (type === "COLOCATION") return "dns";
  if (type === "VPS_WINDOWS") return "desktop_windows";
  if (type === "VPS_FOREX") return "candlestick_chart";
  if (type === "TALLY") return "receipt_long";
  if (type === "VPS_MINECRAFT") return "sports_esports";
  return "cloud";
}
