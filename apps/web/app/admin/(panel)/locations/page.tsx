"use client";
import { ResourceManager } from "@/components/admin/resource";

export default function Page() {
  return (
    <ResourceManager title="Locations" subtitle="Data centre locations shown to customers when ordering." endpoint="/admin/locations"
      fields={[{ key: "name", label: "Name", required: true, placeholder: "Noida, India" }, { key: "code", label: "Code", required: true, placeholder: "GWL" }, { key: "country", label: "Country (ISO-2)", default: "IN" }]}
      columns={[{ label: "Name", render: (r) => <b>{r.name}</b> }, { label: "Code", render: (r) => r.code }, { label: "Country", render: (r) => r.country }, { label: "Servers", render: (r) => r._count?.servers }]} />
  );
}
