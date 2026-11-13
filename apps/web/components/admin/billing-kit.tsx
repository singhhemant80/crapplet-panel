"use client";
/** Shared pieces for invoice / quote / billable-item editors. Amounts in the UI are in rupees; the API takes paise. */
import { useEffect, useState } from "react";
import { api, money } from "@/lib/api";
import { Button, Icon, Input, Select, cx, useApi } from "@/components/ui";

export type Line = { key: string; id?: string; description: string; quantity: string; unitPrice: string; taxable: boolean; hsnSac?: string };

let seq = 0;
export const newLine = (p: Partial<Line> = {}): Line => ({ key: `l${++seq}`, description: "", quantity: "1", unitPrice: "", taxable: true, hsnSac: "", ...p });
export const toPaise = (v: string) => Math.round((Number(v) || 0) * 100);
export const toRupees = (p: number) => String(p / 100);
export const linesFromApi = (items: any[]): Line[] => items.map((i) => newLine({ id: i.id, description: i.description, quantity: String(i.quantity ?? 1), unitPrice: toRupees(i.unitPrice), taxable: i.taxable !== false, hsnSac: i.hsnSac ?? "" }));
export const linesToApi = (lines: Line[], withId = true) =>
  lines.filter((l) => l.description.trim()).map((l) => ({ ...(withId && l.id ? { id: l.id } : {}), description: l.description.trim(), quantity: Math.max(1, Math.round(Number(l.quantity) || 1)), unitPrice: toPaise(l.unitPrice), taxable: l.taxable, ...(l.hsnSac ? { hsnSac: l.hsnSac } : {}) }));
export const linesTotal = (lines: Line[]) => lines.reduce((a, l) => a + toPaise(l.unitPrice) * Math.max(1, Math.round(Number(l.quantity) || 1)), 0);

/** Editable table of lines. Negative prices are discounts. */
export function LineEditor({ lines, onChange, currency = "INR", hsn = true }: { lines: Line[]; onChange: (l: Line[]) => void; currency?: string; hsn?: boolean }) {
  const set = (k: string, p: Partial<Line>) => onChange(lines.map((l) => (l.key === k ? { ...l, ...p } : l)));
  return (
    <div className="overflow-hidden rounded-xl border border-line">
      <div className={cx("hidden gap-2 bg-[#fbf9ff] px-3 py-2 text-[11px] font-bold uppercase tracking-wider text-mute sm:grid", hsn ? "sm:grid-cols-[1fr_70px_120px_90px_64px_36px]" : "sm:grid-cols-[1fr_70px_120px_64px_36px]")}>
        <span>Description</span><span>Qty</span><span>Unit price ({currency})</span>{hsn && <span>HSN/SAC</span>}<span>GST</span><span />
      </div>
      {lines.map((l) => {
        const amt = toPaise(l.unitPrice) * Math.max(1, Math.round(Number(l.quantity) || 1));
        return (
          <div key={l.key} className={cx("grid grid-cols-2 items-center gap-2 border-t border-line px-3 py-2 first:border-t-0 sm:first:border-t", hsn ? "sm:grid-cols-[1fr_70px_120px_90px_64px_36px]" : "sm:grid-cols-[1fr_70px_120px_64px_36px]")}>
            <div className="col-span-2 sm:col-span-1">
              <Input className="!h-10" value={l.description} placeholder="e.g. Server setup, extra IP, consulting…" onChange={(e) => set(l.key, { description: e.target.value })} aria-label="Description" />
              {amt !== 0 && <div className={cx("mt-0.5 pl-1 text-[11px] font-semibold", amt < 0 ? "text-emerald-700" : "text-mute")}>{amt < 0 ? "Discount " : "Line total "}{money(Math.abs(amt), currency)}</div>}
            </div>
            <Input className="!h-10" type="number" min={1} value={l.quantity} onChange={(e) => set(l.key, { quantity: e.target.value })} aria-label="Quantity" />
            <Input className="!h-10" type="number" step="0.01" value={l.unitPrice} placeholder={l.description === "Discount" ? "-100.00" : "0.00"} onChange={(e) => set(l.key, { unitPrice: e.target.value })} aria-label="Unit price" />
            {hsn && <Input className="!h-10" value={l.hsnSac ?? ""} placeholder="998315" onChange={(e) => set(l.key, { hsnSac: e.target.value })} aria-label="HSN/SAC" />}
            <label className="flex items-center gap-1.5 text-xs font-semibold text-slate-600"><input type="checkbox" className="h-4 w-4 accent-primary" checked={l.taxable} onChange={(e) => set(l.key, { taxable: e.target.checked })} />GST</label>
            <button type="button" className="grid h-9 w-9 place-items-center rounded-lg text-slate-400 hover:bg-rose-50 hover:text-rose-600" onClick={() => onChange(lines.filter((x) => x.key !== l.key))} aria-label="Remove line" title="Remove line">
              <Icon name="delete" className="text-[19px]" />
            </button>
          </div>
        );
      })}
      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-line bg-[#fdfcff] px-3 py-2">
        <div className="flex gap-2">
          <Button type="button" size="sm" variant="ghost" icon="add" onClick={() => onChange([...lines, newLine()])}>Add line</Button>
          <Button type="button" size="sm" variant="ghost" icon="sell" onClick={() => onChange([...lines, newLine({ description: "Discount", unitPrice: "", taxable: true })])}>Add discount</Button>
        </div>
        <span className="text-sm text-mute">Before tax <b className="text-ink">{money(linesTotal(lines), currency)}</b></span>
      </div>
    </div>
  );
}

/** Search a customer by name / email. */
export function ClientPicker({ value, onChange, disabled }: { value: any | null; onChange: (c: any | null) => void; disabled?: boolean }) {
  const [q, setQ] = useState("");
  const [found, setFound] = useState<any[]>([]);
  useEffect(() => {
    if (q.trim().length < 2) return setFound([]);
    const t = setTimeout(() => api(`/admin/clients?q=${encodeURIComponent(q.trim())}&pageSize=8`).then((r) => setFound(r.clients ?? [])).catch(() => {}), 250);
    return () => clearTimeout(t);
  }, [q]);
  if (value)
    return (
      <div className="flex h-11 items-center justify-between rounded-xl border border-line bg-primary-tint/50 px-3 text-sm">
        <span className="min-w-0 truncate"><b>{`${value.firstName ?? ""} ${value.lastName ?? ""}`.trim() || value.email}</b> <span className="text-mute">{value.email}</span></span>
        {!disabled && <button type="button" className="text-xs font-bold text-primary-dark" onClick={() => onChange(null)}>Change</button>}
      </div>
    );
  return (
    <div className="relative">
      <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search customer by name or email" autoComplete="off" />
      {found.length > 0 && (
        <ul className="absolute z-20 mt-1 max-h-64 w-full overflow-auto rounded-xl border border-line bg-white py-1 shadow-xl">
          {found.map((c) => (
            <li key={c.id}>
              <button type="button" className="block w-full px-3 py-2 text-left text-sm hover:bg-primary-tint" onClick={() => { onChange(c); setQ(""); setFound([]); }}>
                <b>{c.firstName} {c.lastName}</b> <span className="text-mute">{c.email}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function CurrencySelect({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const { data } = useApi("/admin/currencies");
  const codes: string[] = (data?.items ?? []).filter((c: any) => c.enabled !== false).map((c: any) => c.code);
  const list = codes.length ? codes : ["INR"];
  return <Select value={value} onChange={(e) => onChange(e.target.value)}>{(list.includes(value) ? list : [value, ...list]).map((c) => <option key={c}>{c}</option>)}</Select>;
}

export const dateInput = (d?: string | Date | null) => (d ? new Date(d).toISOString().slice(0, 10) : "");
