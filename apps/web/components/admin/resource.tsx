"use client";
import { useState, type ReactNode } from "react";
import { api } from "@/lib/api";
import { Button, Card, Empty, Field, Input, Loading, Modal, PageHeader, Select, Table, Td, Textarea, Toggle, toast, useApi } from "@/components/ui";

export type FieldDef = {
  key: string;
  label: string;
  type?: "text" | "number" | "money" | "textarea" | "bool" | "select" | "date" | "list" | "multiselect";
  options?: { value: string; label: string }[];
  required?: boolean;
  hint?: string;
  placeholder?: string;
  full?: boolean;
  default?: unknown;
};
export type ColDef = { label: string; render: (row: any) => ReactNode };

/** Generic list + create/edit modal for simple admin resources backed by the /admin CRUD routes. */
export function ResourceManager({ title, subtitle, endpoint, idKey = "id", fields, columns, itemsKey = "items", canDelete = true, extraActions }: {
  title: string;
  subtitle?: string;
  endpoint: string;
  idKey?: string;
  fields: FieldDef[];
  columns: ColDef[];
  itemsKey?: string;
  canDelete?: boolean;
  extraActions?: ReactNode;
}) {
  const { data, loading, reload } = useApi(endpoint);
  const [editing, setEditing] = useState<any | null>(null);
  const [form, setForm] = useState<Record<string, any>>({});
  const [busy, setBusy] = useState(false);

  const open = (row?: any) => {
    const init: Record<string, any> = {};
    for (const f of fields) {
      let v = row ? row[f.key] : f.default;
      if (f.type === "money" && typeof v === "number") v = v / 100;
      if (f.type === "list" && Array.isArray(v)) v = v.join("\n");
      if (f.type === "date" && v) v = String(v).slice(0, 10);
      init[f.key] = v ?? (f.type === "bool" ? false : f.type === "multiselect" ? [] : "");
    }
    setForm(init);
    setEditing(row ?? {});
  };

  async function save() {
    setBusy(true);
    const body: Record<string, any> = {};
    for (const f of fields) {
      let v = form[f.key];
      if (f.type === "number") v = v === "" || v === null ? null : Number(v);
      if (f.type === "money") v = v === "" ? 0 : Math.round(Number(v) * 100);
      if (f.type === "list") v = String(v ?? "").split(/\n|,/).map((x) => x.trim()).filter(Boolean);
      if (f.type === "date") v = v ? new Date(v).toISOString() : null;
      if ((f.type === "text" || f.type === "textarea" || f.type === "select") && v === "" && !f.required) v = null;
      body[f.key] = v;
    }
    try {
      if (editing?.[idKey]) await api(`${endpoint}/${encodeURIComponent(editing[idKey])}`, { method: "PUT", body });
      else await api(endpoint, { body });
      toast.success("Saved");
      setEditing(null);
      reload();
    } catch (e: any) {
      toast.error(e.message);
    } finally {
      setBusy(false);
    }
  }

  const rows = data?.[itemsKey] ?? [];
  return (
    <>
      <PageHeader title={title} subtitle={subtitle} actions={<>{extraActions}<Button icon="add" onClick={() => open()}>Add</Button></>} />
      <Card pad={false}>
        {loading ? <Loading /> : !rows.length ? <Empty title={`No ${title.toLowerCase()} yet`} /> : (
          <Table head={[...columns.map((c) => c.label), ""]}>
            {rows.map((r: any) => (
              <tr key={r[idKey]} className="hover:bg-primary-tint">
                {columns.map((c) => <Td key={c.label}>{c.render(r)}</Td>)}
                <Td className="whitespace-nowrap text-right">
                  <button className="text-sm font-bold text-primary-dark hover:underline" onClick={() => open(r)}>Edit</button>
                  {canDelete && (
                    <button className="ml-4 text-sm font-bold text-rose-600 hover:underline" onClick={() => confirm("Delete this item?") && api(`${endpoint}/${encodeURIComponent(r[idKey])}`, { method: "DELETE" }).then(() => { toast.success("Deleted"); reload(); }).catch((e) => toast.error(e.message))}>Delete</button>
                  )}
                </Td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
      <Modal open={!!editing} onClose={() => setEditing(null)} title={editing?.[idKey] ? `Edit ${title.replace(/s$/, "").toLowerCase()}` : `New ${title.replace(/s$/, "").toLowerCase()}`} wide={fields.length > 6}>
        <div className="grid gap-4 sm:grid-cols-2">
          {fields.map((f) => (
            <Field key={f.key} label={f.label + (f.type === "money" ? " (₹)" : "")} hint={f.hint} className={f.full || f.type === "textarea" || f.type === "list" ? "sm:col-span-2" : ""}>
              {f.type === "textarea" || f.type === "list" ? (
                <Textarea rows={f.type === "list" ? 4 : 6} value={form[f.key] ?? ""} placeholder={f.placeholder} onChange={(e) => setForm({ ...form, [f.key]: e.target.value })} />
              ) : f.type === "bool" ? (
                <Toggle checked={!!form[f.key]} onChange={(v) => setForm({ ...form, [f.key]: v })} />
              ) : f.type === "select" ? (
                <Select value={form[f.key] ?? ""} onChange={(e) => setForm({ ...form, [f.key]: e.target.value })}>
                  {!f.required && <option value="">—</option>}
                  {f.options?.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                </Select>
              ) : f.type === "multiselect" ? (
                <div className="flex max-h-40 flex-wrap gap-2 overflow-y-auto rounded-xl border border-line p-2">
                  {f.options?.map((o) => {
                    const on = (form[f.key] ?? []).includes(o.value);
                    return (
                      <button type="button" key={o.value} onClick={() => setForm({ ...form, [f.key]: on ? form[f.key].filter((x: string) => x !== o.value) : [...(form[f.key] ?? []), o.value] })} className={`rounded-lg px-2.5 py-1 text-xs font-bold ${on ? "bg-primary-dark text-white" : "bg-slate-100 text-slate-600"}`}>{o.label}</button>
                    );
                  })}
                </div>
              ) : (
                <Input type={f.type === "number" || f.type === "money" ? "number" : f.type === "date" ? "date" : "text"} step={f.type === "money" ? "0.01" : undefined} value={form[f.key] ?? ""} placeholder={f.placeholder} required={f.required} onChange={(e) => setForm({ ...form, [f.key]: e.target.value })} />
              )}
            </Field>
          ))}
        </div>
        <div className="mt-6 flex justify-end gap-2">
          <Button variant="ghost" onClick={() => setEditing(null)}>Cancel</Button>
          <Button loading={busy} onClick={save} icon="save">Save</Button>
        </div>
      </Modal>
    </>
  );
}
