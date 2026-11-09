"use client";
import { useState } from "react";
import { api } from "@/lib/api";
import { Button, toast } from "@/components/ui";
import { OsLogo } from "@/components/os-logo";
import { ResourceManager } from "@/components/admin/resource";

export default function Page() {
  const [rev, setRev] = useState(0);
  const [busy, setBusy] = useState(false);

  async function sync() {
    setBusy(true);
    try {
      const r = await api("/admin/virtualizor/all/sync-os", { body: {} });
      for (const x of r.results) x.ok ? toast.success(`${x.serverName}: ${x.found} templates · ${x.created} new · ${x.disabled} removed`) : toast.error(`${x.serverName}: ${x.error}`);
      setRev((n) => n + 1);
    } catch (e: any) {
      toast.error(e.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <ResourceManager
      key={rev}
      title="OS Templates"
      subtitle="Virtualizor templates are imported automatically (daily at 03:00 and with the button). Proxmox templates are mapped by hand to a template VMID / LXC volume."
      endpoint="/admin/os-templates"
      extraActions={<Button variant="outline" icon="sync" loading={busy} onClick={sync}>Sync from Virtualizor</Button>}
      fields={[
        { key: "name", label: "Name shown to customers", required: true },
        { key: "family", label: "Family", type: "select", required: true, options: [{ value: "linux", label: "Linux" }, { value: "windows", label: "Windows" }], default: "linux" },
        { key: "proxmoxKvmVmid", label: "Proxmox KVM template VMID", type: "number", hint: "A cloud-init enabled template (qm template …)" },
        { key: "proxmoxLxcVolid", label: "Proxmox LXC template volume", placeholder: "local:vztmpl/ubuntu-24.04-standard_24.04-2_amd64.tar.zst" },
        { key: "virtualizorOsId", label: "Virtualizor OS id", type: "number", hint: "Filled in automatically for synced templates" },
        { key: "defaultUser", label: "Default user", default: "root" },
        { key: "logoUrl", label: "Custom logo URL (optional)", placeholder: "https://… or /images/windows.svg", hint: "Replaces the built-in logo — e.g. an official Windows logo you're licensed to use", full: true },
        { key: "sortOrder", label: "Sort order", type: "number", default: 0 },
        { key: "enabled", label: "Enabled", type: "bool", default: true },
      ]}
      columns={[
        { label: "Name", render: (r) => <span className="flex items-center gap-2.5"><OsLogo os={r} size={30} /><b>{r.name}</b></span> },
        {
          label: "Source",
          render: (r) =>
            r.source === "virtualizor" ? (
              <span className="inline-flex items-center gap-1.5">
                <span className="rounded-md bg-primary-tint px-2 py-0.5 text-[11px] font-extrabold text-primary-dark">Virtualizor</span>
                {r.virtualizorVirt && <span className="rounded-md bg-slate-100 px-1.5 py-0.5 text-[10px] font-bold uppercase text-slate-600">{r.virtualizorVirt}</span>}
              </span>
            ) : (
              <span className="rounded-md bg-slate-100 px-2 py-0.5 text-[11px] font-bold text-slate-600">Manual</span>
            ),
        },
        { label: "Family", render: (r) => <span className="capitalize">{r.family}</span> },
        { label: "Template", render: (r) => <span className="font-mono text-xs">{r.remoteName ?? r.proxmoxLxcVolid ?? (r.proxmoxKvmVmid ? `VMID ${r.proxmoxKvmVmid}` : "—")}</span> },
        { label: "OS id", render: (r) => r.virtualizorOsId ?? "—" },
        { label: "Enabled", render: (r) => (r.enabled ? "Yes" : <span className="text-rose-600">No</span>) },
      ]}
    />
  );
}
