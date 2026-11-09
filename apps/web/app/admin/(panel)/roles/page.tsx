"use client";
import { useApi } from "@/components/ui";
import { ResourceManager } from "@/components/admin/resource";

export default function Page() {
  const perms = useApi("/admin/permissions");
  return (
    <ResourceManager title="Roles" subtitle='Grant "*" for full access. ".manage" permissions include ".view".' endpoint="/admin/roles"
      fields={[{ key: "name", label: "Name", required: true }, { key: "description", label: "Description" }, { key: "permissions", label: "Permissions", type: "multiselect", full: true, options: (perms.data?.permissions ?? []).map((p: string) => ({ value: p, label: p })) }]}
      columns={[{ label: "Role", render: (r) => <b>{r.name}</b> }, { label: "Staff", render: (r) => r._count?.users }, { label: "Permissions", render: (r) => <span className="text-xs text-mute">{r.permissions.join(", ")}</span> }]} />
  );
}
