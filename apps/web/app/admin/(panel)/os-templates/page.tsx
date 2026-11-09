"use client";
import { ResourceManager } from "@/components/admin/resource";

export default function Page() {
  return (
    <ResourceManager title="OS Templates" subtitle="Map each operating system to your Proxmox template VMID / LXC volume and Virtualizor OS id." endpoint="/admin/os-templates"
      fields={[{ key: "name", label: "Name", required: true }, { key: "family", label: "Family", type: "select", required: true, options: [{ value: "linux", label: "Linux" }, { value: "windows", label: "Windows" }], default: "linux" }, { key: "proxmoxKvmVmid", label: "Proxmox KVM template VMID", type: "number", hint: "A cloud-init enabled template (qm template …)" }, { key: "proxmoxLxcVolid", label: "Proxmox LXC template volume", placeholder: "local:vztmpl/ubuntu-24.04-standard_24.04-2_amd64.tar.zst" }, { key: "virtualizorOsId", label: "Virtualizor OS id", type: "number" }, { key: "defaultUser", label: "Default user", default: "root" }, { key: "sortOrder", label: "Sort order", type: "number", default: 0 }, { key: "enabled", label: "Enabled", type: "bool", default: true }]}
      columns={[{ label: "Name", render: (r) => <b>{r.name}</b> }, { label: "Family", render: (r) => r.family }, { label: "KVM VMID", render: (r) => r.proxmoxKvmVmid ?? "—" }, { label: "LXC", render: (r) => <span className="text-xs">{r.proxmoxLxcVolid ?? "—"}</span> }, { label: "Virtualizor", render: (r) => r.virtualizorOsId ?? "—" }, { label: "Enabled", render: (r) => (r.enabled ? "Yes" : "No") }]} />
  );
}
