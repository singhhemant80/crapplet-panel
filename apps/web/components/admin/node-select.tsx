"use client";
import { Field, Select, useApi } from "@/components/ui";

/**
 * Pick the Virtualizor node a VPS will be built on ("" = use the plan's placement rule).
 * Options come from Node Monitoring (refreshed every 5 minutes).
 */
export function NodeSelect({ serverIds, value: raw, onChange, disabled, hint }: { serverIds: string[]; value: string; onChange: (v: string) => void; disabled?: boolean; hint?: string }) {
  // Virtualizor nodes are numeric serids; anything else (e.g. a Proxmox node name left from an older plan) means "plan default"
  const value = /^\d+$/.test(raw ?? "") ? raw : "";
  const mon = useApi("/admin/monitoring");
  const nodes: any[] = (mon.data?.servers ?? [])
    .filter((s: any) => s.type === "VIRTUALIZOR" && (!serverIds.length || serverIds.includes(s.id)))
    .flatMap((s: any) => s.nodes.map((n: any) => ({ ...n, serverName: s.name })));
  const pct = (u: number, t: number) => (t ? Math.round((u / t) * 100) : 0);
  return (
    <Field label="Node" hint={hint ?? "Leave on the plan's rule, or pin this VPS to a node"}>
      <Select value={value} disabled={disabled} onChange={(e) => onChange(e.target.value)}>
        <option value="">Plan default (automatic)</option>
        {value && !nodes.some((n) => n.externalId === value) && <option value={value}>Node #{value}</option>}
        {nodes.map((n) => (
          <option key={n.id} value={n.externalId ?? ""} disabled={n.externalId === null || !n.online}>
            {n.name} #{n.externalId} — {n.online ? `RAM ${pct(n.ramUsedMb, n.ramTotalMb)}% · CPU ${Math.round(n.cpuPct)}% · ${n.meta?.vpsCount ?? 0} VPS` : "offline"}
            {!n.enabled ? " · new VPS off" : ""}
          </option>
        ))}
      </Select>
    </Field>
  );
}
