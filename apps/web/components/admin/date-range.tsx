"use client";
import { useState } from "react";
import { Input, Select, cx } from "@/components/ui";

export type Range = { from: string; to: string };

/** Today in IST as YYYY-MM-DD, plus helpers for the presets. */
const ist = (d = new Date()) => new Date(d.getTime() + 330 * 60_000);
const ymd = (d: Date) => d.toISOString().slice(0, 10);
const addDays = (s: string, n: number) => ymd(new Date(Date.parse(`${s}T00:00:00Z`) + n * 86400_000));

export const PRESETS: [string, string][] = [
  ["", "Any time"],
  ["today", "Today"],
  ["yesterday", "Yesterday"],
  ["7d", "Last 7 days"],
  ["30d", "Last 30 days"],
  ["month", "This month"],
  ["lastmonth", "Last month"],
  ["quarter", "Last 3 months"],
  ["fy", "This financial year"],
  ["lastfy", "Last financial year"],
  ["custom", "Custom range…"],
];

export function presetRange(p: string): Range {
  const t = ist();
  const today = ymd(t);
  const y = t.getUTCFullYear(), m = t.getUTCMonth();
  const fyY = m >= 3 ? y : y - 1;
  switch (p) {
    case "today": return { from: today, to: today };
    case "yesterday": return { from: addDays(today, -1), to: addDays(today, -1) };
    case "7d": return { from: addDays(today, -6), to: today };
    case "30d": return { from: addDays(today, -29), to: today };
    case "month": return { from: ymd(new Date(Date.UTC(y, m, 1))), to: today };
    case "lastmonth": return { from: ymd(new Date(Date.UTC(y, m - 1, 1))), to: ymd(new Date(Date.UTC(y, m, 0))) };
    case "quarter": return { from: ymd(new Date(Date.UTC(y, m - 2, 1))), to: today };
    case "fy": return { from: `${fyY}-04-01`, to: today };
    case "lastfy": return { from: `${fyY - 1}-04-01`, to: `${fyY}-03-31` };
    default: return { from: "", to: "" };
  }
}

/** `from=…&to=…` (only the parts that are set), prefixed for a second range on the same page. */
export const rangeQs = (r: Range, prefix = "") => [r.from && `${prefix}from=${r.from}`, r.to && `${prefix}to=${r.to}`].filter(Boolean).join("&");

/**
 * A date-range filter: a preset dropdown, with From / To boxes for a custom range.
 * Dates are Indian (IST) days; "To" includes the whole day.
 */
export function DateRangeFilter({ value, onChange, label = "Any time", className, fields, field, onField }: { value: Range; onChange: (r: Range) => void; label?: string; className?: string; fields?: [string, string][]; field?: string; onField?: (f: string) => void }) {
  const [preset, setPreset] = useState<string>(() => (value.from || value.to ? "custom" : ""));
  const pick = (p: string) => {
    setPreset(p);
    if (p !== "custom") onChange(presetRange(p));
  };
  return (
    <div className={cx("flex min-w-0 flex-wrap items-center gap-2", className)}>
      {fields && (
        // which date the range applies to (issued / due / paid …)
        <div className="w-[136px] shrink-0">
          <Select className="h-10 font-semibold" value={field} onChange={(e) => onField?.(e.target.value)} aria-label="Which date">
            {fields.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
          </Select>
        </div>
      )}
      <Select className="h-10 min-w-[150px] flex-1" value={preset} onChange={(e) => pick(e.target.value)} aria-label="Date range">
        {PRESETS.map(([k, l]) => <option key={k} value={k}>{k === "" ? label : l}</option>)}
      </Select>
      {preset === "custom" && (
        <div className="flex flex-1 items-center gap-1.5">
          <Input type="date" className="h-10 min-w-0 flex-1" value={value.from} max={value.to || undefined} onChange={(e) => onChange({ ...value, from: e.target.value })} aria-label="From" />
          <span className="text-xs font-bold text-mute">to</span>
          <Input type="date" className="h-10 min-w-0 flex-1" value={value.to} min={value.from || undefined} onChange={(e) => onChange({ ...value, to: e.target.value })} aria-label="To" />
        </div>
      )}
    </div>
  );
}
