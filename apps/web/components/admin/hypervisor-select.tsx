"use client";
import { Field, Select, useApi } from "@/components/ui";

/** Pick the hypervisor (Virtualizor master / Proxmox server) a VPS is built on. Servers of this plan are listed first. */
export function HypervisorSelect({ type, planServerIds, value, onChange, disabled, hint }: { type: "VIRTUALIZOR" | "PROXMOX"; planServerIds: string[]; value: string; onChange: (v: string) => void; disabled?: boolean; hint?: string }) {
  const { data } = useApi(`/admin/server-choices?type=${type}`);
  const all: any[] = data?.servers ?? [];
  const plan = all.filter((s) => planServerIds.includes(s.id));
  const other = all.filter((s) => !planServerIds.includes(s.id));
  const label = (s: any) => `${s.name}${s.location ? ` · ${s.location}` : ""}${s.enabled ? "" : " (disabled)"}`;
  return (
    <Field label="Hypervisor" hint={hint ?? (value && !planServerIds.includes(value) ? "Not one of this plan's servers — make sure the plan and OS exist there" : "Where this VPS will be built")}>
      <Select value={value} disabled={disabled} onChange={(e) => onChange(e.target.value)}>
        {!value && <option value="">Plan default (automatic)</option>}
        {value && !all.some((s) => s.id === value) && <option value={value}>Current server</option>}
        {plan.length > 0 && <optgroup label="This plan's servers">{plan.map((s) => <option key={s.id} value={s.id}>{label(s)}</option>)}</optgroup>}
        {other.length > 0 && <optgroup label="Other servers">{other.map((s) => <option key={s.id} value={s.id}>{label(s)}</option>)}</optgroup>}
      </Select>
    </Field>
  );
}
