"use client";
import { date } from "@/lib/api";
import { ResourceManager } from "@/components/admin/resource";

export default function Page() {
  return (
    <ResourceManager title="Announcements" subtitle="Shown on every customer's dashboard." endpoint="/admin/announcements"
      fields={[{ key: "title", label: "Title", required: true, full: true }, { key: "publishedAt", label: "Publish date", type: "date" }, { key: "published", label: "Published", type: "bool", default: true }, { key: "body", label: "Body", type: "textarea", required: true }]}
      columns={[{ label: "Title", render: (r) => <b>{r.title}</b> }, { label: "Date", render: (r) => date(r.publishedAt) }, { label: "Published", render: (r) => (r.published ? "Yes" : "Draft") }]} />
  );
}
