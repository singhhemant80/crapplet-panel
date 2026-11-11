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
        <Button className="mt-6" icon="save" onClick={() => api(`/admin/settings/${tab}`, { method: "PUT", body: sec }).then(() => { toast.success("Settings saved"); reload(); }).catch((e) => toast.error(e.message))}>Save {SECTIONS[tab].title.toLowerCase()}</Button>
      </Card>
    </>
  );
}
