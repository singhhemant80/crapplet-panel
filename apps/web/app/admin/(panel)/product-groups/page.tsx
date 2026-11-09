"use client";
import { ResourceManager } from "@/components/admin/resource";

export default function Page() {
  return (
    <ResourceManager title="Product Groups" subtitle="Groups appear as sections in the order form." endpoint="/admin/product-groups"
      fields={[{ key: "name", label: "Name", required: true }, { key: "slug", label: "Slug", required: true, hint: "Used in /order?group=slug and old WHMCS store links" }, { key: "headline", label: "Headline" }, { key: "sortOrder", label: "Sort order", type: "number", default: 0 }, { key: "description", label: "Description", type: "textarea" }, { key: "hidden", label: "Hidden", type: "bool" }]}
      columns={[{ label: "Name", render: (r) => <b>{r.name}</b> }, { label: "Slug", render: (r) => <code className="text-xs">{r.slug}</code> }, { label: "Products", render: (r) => r._count?.products }, { label: "Order", render: (r) => r.sortOrder }, { label: "Visible", render: (r) => (r.hidden ? "Hidden" : "Yes") }]} />
  );
}
