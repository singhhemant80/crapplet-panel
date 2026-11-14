"use client";
import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { Alert, Button, Card, Field, Input, Loading, PageHeader, Textarea, Toggle, cx, toast, useApi } from "@/components/ui";

const SECTIONS: Record<string, { title: string; hint?: string }> = {
  company: { title: "Company", hint: "Printed on every invoice. State code decides CGST+SGST vs IGST." },
  tax: { title: "GST", hint: "18% is standard for hosting (SAC 998315). Exports are zero-rated unless 'applyToForeign' is on." },
  invoice: { title: "Invoices", hint: "{FY} is replaced with the Indian financial year, e.g. 2026-27." },
  orders: { title: "Orders" },
  support: { title: "Support" },
  affiliates: { title: "Affiliates", hint: "Amounts in paise." },
};

export default function Settings() {
  const { data, loading, reload } = useApi("/admin/settings");
  const [tab, setTab] = useState("company");
  const [v, setV] = useState<any>(null);
  const [saved, setSaved] = useState(0);
  useEffect(() => { if (data) setV(structuredClone(data.settings)); }, [data]);
  if (loading || !v) return <Loading />;
  const sec = v[tab];
  const set = (k: string, val: any) => setV({ ...v, [tab]: { ...sec, [k]: val } });
  return (
    <>
      <PageHeader title="Settings" actions={<Button variant="outline" icon="schedule" href="/admin/automation?tab=settings">Automation settings</Button>} />
      <div className="mb-4 flex gap-2 overflow-x-auto">{Object.entries(SECTIONS).map(([k, s]) => <button key={k} onClick={() => setTab(k)} className={cx("whitespace-nowrap rounded-full px-4 py-2 text-sm font-bold", tab === k ? "bg-primary-dark text-white" : "bg-white text-slate-600 ring-1 ring-line")}>{s.title}</button>)}</div>
      <Card title={SECTIONS[tab].title}>
        {SECTIONS[tab].hint && <Alert className="mb-4">{SECTIONS[tab].hint}</Alert>}
        <div className="grid gap-4 sm:grid-cols-2">
          {Object.entries(sec).map(([k, val]) => (
            <Field key={k} label={k.replace(/([A-Z])/g, " $1").toLowerCase()} className={typeof val === "string" && (val.length > 60 || k === "bankDetails" || k === "footerNote") ? "sm:col-span-2" : ""}>
              {typeof val === "boolean" ? <Toggle checked={val} onChange={(x) => set(k, x)} />
                : Array.isArray(val) ? <Input value={val.join(", ")} onChange={(e) => set(k, e.target.value.split(",").map((x) => Number(x.trim())).filter((x) => !Number.isNaN(x)))} />
                : typeof val === "number" ? <Input type="number" value={val} onChange={(e) => set(k, Number(e.target.value))} />
                : k === "bankDetails" || k === "footerNote" || k === "address" ? <Textarea rows={3} value={String(val)} onChange={(e) => set(k, e.target.value)} />
                : <Input value={String(val ?? "")} onChange={(e) => set(k, e.target.value)} />}
            </Field>
          ))}
        </div>
        <Button className="mt-6" icon="save" onClick={() => api(`/admin/settings/${tab}`, { method: "PUT", body: sec }).then(() => { toast.success("Settings saved"); reload(); setSaved((n) => n + 1); }).catch((e) => toast.error(e.message))}>Save {SECTIONS[tab].title.toLowerCase()}</Button>
      </Card>
      {tab === "invoice" && <NumberSeries refresh={saved} />}
    </>
  );
}

/** Next number of each document series — set where numbering continues (e.g. after moving from WHMCS). */
function NumberSeries({ refresh }: { refresh: number }) {
  const { data, reload } = useApi("/admin/numbering", [refresh]);
  const [edit, setEdit] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  if (!data) return null;
  async function save(key: string) {
    const next = Number(edit[key]);
    if (!Number.isInteger(next) || next < 1) return toast.error("Enter a whole number");
    setBusy(key);
    try {
      const r = await api("/admin/numbering", { method: "PUT", body: { key, next } });
      toast.success(`Next number: ${r.preview}`);
      setEdit((e) => ({ ...e, [key]: "" }));
      reload();
    } catch (e: any) {
      toast.error(e.message);
    }
    setBusy(null);
  }
  return (
    <Card title="Next numbers" className="mt-6">
      <Alert className="mb-4">Set the number the next document will get — for example to continue from your old billing system. Numbers already used can't be issued again (GST requires unique invoice numbers), so you can only move forward. Series marked "per financial year" restart at 1 each April.</Alert>
      <div className="divide-y divide-line rounded-xl border border-line">
        {data.series.map((x: any) => (
          <div key={x.key} className="grid items-center gap-3 px-4 py-3 sm:grid-cols-[1fr_auto_auto]">
            <div className="min-w-0">
              <div className="font-bold text-ink">{x.label}{x.perYear && <span className="ml-2 text-xs font-semibold text-mute">per financial year · {data.financialYear}</span>}</div>
              <div className="mt-0.5 text-sm">Next: <span className="font-mono font-bold text-primary-dark">{x.preview}</span>{x.lastUsedNumber && <span className="text-mute"> · last used {x.lastUsedNumber}</span>}</div>
            </div>
            <Input className="!h-10 sm:w-36" type="number" min={x.highestUsed + 1} placeholder={String(x.next)} value={edit[x.key] ?? ""} onChange={(e) => setEdit({ ...edit, [x.key]: e.target.value })} aria-label={`Next ${x.label} number`} />
            <Button size="sm" variant="secondary" loading={busy === x.key} disabled={!edit[x.key]} onClick={() => save(x.key)}>Set next</Button>
          </div>
        ))}
      </div>
    </Card>
  );
}
