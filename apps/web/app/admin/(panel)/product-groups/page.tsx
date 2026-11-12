"use client";
import { ResourceManager } from "@/components/admin/resource";
import { CopyLink } from "@/components/admin/copy-link";

export default function Page() {
  return (
    <ResourceManager title="Product Groups" subtitle="Groups are the categories on the order page (Shared Hosting, Reseller Hosting, VPS…). Link your website's pages to them." endpoint="/admin/product-groups"
      fields={[
        { key: "name", label: "Name", required: true },
        { key: "slug", label: "Slug", required: true, hint: "Order page link: /order?group=slug" },
        { key: "headline", label: "Headline", hint: "Shown in the banner above the plans" },
        { key: "sortOrder", label: "Sort order", type: "number", default: 0 },
        { key: "legacyGid", label: "Old WHMCS gid", type: "number", hint: "Keeps website links like cart.php?gid=2 working" },
        { key: "description", label: "Description", type: "textarea" },
        { key: "hidden", label: "Hidden", type: "bool" },
      ]}
      columns={[
        { label: "Name", render: (r) => <b>{r.name}</b> },
        { label: "Products", render: (r) => r._count?.products },
        { label: "Order page link", render: (r) => <CopyLink path={`/order?group=${r.slug}`} /> },
        { label: "WHMCS gid", render: (r) => r.legacyGid ?? "—" },
        { label: "Order", render: (r) => r.sortOrder },
        { label: "Visible", render: (r) => (r.hidden ? "Hidden" : "Yes") },
      ]} />
  );
}
