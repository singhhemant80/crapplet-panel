"use client";
import { useEffect, useState } from "react";
import { api, money } from "@/lib/api";
import { Alert, Button, Card, Field, Input, Loading, PageHeader, Select, Table, Td, Toggle, toast, useApi } from "@/components/ui";

const ROUNDING = [
  ["nice99", "4.12 → 4.99"],
  ["whole", "4.12 → 5.00"],
  ["cent", "4.12 (exact)"],
];

/** Mirrors lib/currency.ts on the API for the live preview. */
function preview(inrMajor: number, rate: number, markupPct: number, rounding: string) {
  const minor = inrMajor * 100 * rate * (1 + (markupPct || 0) / 100);
  if (minor <= 0) return 0;
  return rounding === "whole" ? Math.ceil(minor / 100) * 100 : rounding === "nice99" ? Math.max(99, Math.ceil(minor / 100) * 100 - 1) : Math.round(minor);
}

export default function Currencies() {
  const cur = useApi("/admin/currencies");
  const set = useApi("/admin/settings");
  const [cfg, setCfg] = useState<any>(null);
  const [rates, setRates] = useState<Record<string, { inrPer: string; enabled: boolean; prefix: string }>>({});
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    if (set.data && !cfg) setCfg(set.data.settings.currency);
  }, [set.data, cfg]);
  useEffect(() => {
    if (cur.data) setRates(Object.fromEntries(cur.data.items.map((c: any) => [c.code, { inrPer: c.code === "INR" ? "1" : (1 / c.rate).toFixed(4), enabled: c.enabled !== false, prefix: c.prefix }])));
  }, [cur.data]);

  if (!cfg || !cur.data) return <Loading />;
  const usd = cur.data.items.find((c: any) => c.code === "USD");
  const usdRate = rates.USD ? 1 / Number(rates.USD.inrPer || 0) : usd?.rate ?? 0;

  async function saveCurrency(code: string) {
    const r = rates[code];
    const row = cur.data.items.find((c: any) => c.code === code);
    const inrPer = Number(r.inrPer);
    if (!(inrPer > 0)) return toast.error("Enter how many rupees one unit is worth");
    setBusy(code);
    try {
      await api(`/admin/currencies/${code}`, { method: "PUT", body: { code, prefix: r.prefix, suffix: row?.suffix ?? "", rate: code === "INR" ? 1 : 1 / inrPer, isDefault: row?.isDefault ?? false, enabled: r.enabled } });
      toast.success(`${code} saved`);
      cur.reload();
    } catch (e: any) {
      toast.error(e.message);
    } finally {
      setBusy(null);
    }
  }

  async function refresh() {
    setBusy("refresh");
    try {
      const r = await api("/admin/currencies/refresh-rates", { body: {} });
      toast.success(`Rates updated: ${Object.entries(r.updated).map(([k, v]: any) => `1 ${k} = ₹${(1 / v).toFixed(2)}`).join(", ") || "nothing to update"}`);
      cur.reload();
    } catch (e: any) {
      toast.error(e.message);
    } finally {
      setBusy(null);
    }
  }

  async function saveCfg() {
    setBusy("cfg");
    try {
      await api("/admin/settings/currency", { method: "PUT", body: { ...cfg, markupPct: Number(cfg.markupPct) || 0 } });
      toast.success("Currency settings saved");
      set.reload();
    } catch (e: any) {
      toast.error(e.message);
    } finally {
      setBusy(null);
    }
  }

  return (
    <>
      <PageHeader title="Currencies" subtitle="INR is the base currency; USD (and others) can have their own prices or be converted from INR automatically." />
      <div className="grid gap-6 xl:grid-cols-[1.2fr_1fr]">
        <Card title="Exchange rates" action={<Button size="sm" variant="outline" icon="currency_exchange" loading={busy === "refresh"} onClick={refresh}>Fetch today's rates</Button>} pad={false}>
          <Table head={["Currency", "₹ per unit", "Symbol", "Offered", ""]}>
            {cur.data.items.map((c: any) => {
              const r = rates[c.code];
              if (!r) return null;
              const base = c.code === "INR";
              return (
                <tr key={c.code}>
                  <Td className="font-extrabold">{c.code}{base && <span className="ml-2 rounded bg-primary-tint px-1.5 py-0.5 text-[10px] font-extrabold text-primary-dark">BASE</span>}</Td>
                  <Td><Input className="h-9 w-32" type="number" step="0.0001" disabled={base} value={r.inrPer} onChange={(e) => setRates({ ...rates, [c.code]: { ...r, inrPer: e.target.value } })} /></Td>
                  <Td><Input className="h-9 w-16" value={r.prefix} onChange={(e) => setRates({ ...rates, [c.code]: { ...r, prefix: e.target.value } })} /></Td>
                  <Td>{base ? <span className="text-xs text-mute">always</span> : <Toggle checked={r.enabled} onChange={(v) => setRates({ ...rates, [c.code]: { ...r, enabled: v } })} />}</Td>
                  <Td className="text-right"><Button size="sm" variant="ghost" loading={busy === c.code} onClick={() => saveCurrency(c.code)}>Save</Button></Td>
                </tr>
              );
            })}
          </Table>
          <p className="px-5 py-3 text-xs text-mute">
            The rate is stored on every invoice when it's issued (for the INR value on export invoices and GST reports), so changing it only affects new invoices and auto-converted prices.
          </p>
        </Card>

        <Card title="Conversion & export settings">
          <div className="space-y-4">
            <Toggle checked={!!cfg.autoConvert} onChange={(v) => setCfg({ ...cfg, autoConvert: v })} label="Auto-convert prices that have no USD price" />
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Markup on converted prices (%)" hint="Covers card / PayPal FX fees">
                <Input type="number" step="0.5" value={cfg.markupPct} onChange={(e) => setCfg({ ...cfg, markupPct: e.target.value })} />
              </Field>
              <Field label="Rounding">
                <Select value={cfg.rounding} onChange={(e) => setCfg({ ...cfg, rounding: e.target.value })}>
                  {ROUNDING.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                </Select>
              </Field>
            </div>
            {usdRate > 0 && (
              <div className="rounded-xl bg-primary-tint p-3 text-sm">
                <div className="mb-1 text-xs font-extrabold uppercase tracking-wider text-primary-dark">Preview</div>
                {[399, 999, 2499].map((inr) => (
                  <div key={inr} className="flex justify-between"><span>{money(inr * 100)}/mo</span><b>{money(preview(inr, usdRate, Number(cfg.markupPct), cfg.rounding), "USD")}/mo</b></div>
                ))}
              </div>
            )}
            <div>
              <Toggle checked={!!cfg.autoUpdateRates} onChange={(v) => setCfg({ ...cfg, autoUpdateRates: v })} label="Update rates automatically every day" />
              <p className="mt-1 text-xs text-mute">Runs at 08:30 IST, before renewal invoices are created.</p>
            </div>
            <Field label="GST LUT ARN" hint="Printed on export invoices: “Supply meant for export under LUT without payment of IGST”">
              <Input value={cfg.lutArn ?? ""} placeholder="AD2304260012345" onChange={(e) => setCfg({ ...cfg, lutArn: e.target.value })} />
            </Field>
            {!cfg.lutArn && <Alert tone="warn">Without an LUT you must charge IGST on exports. File the LUT (GST RFD-11) and add its ARN here.</Alert>}
            <Button loading={busy === "cfg"} onClick={saveCfg} icon="save">Save settings</Button>
          </div>
        </Card>
      </div>
    </>
  );
}
