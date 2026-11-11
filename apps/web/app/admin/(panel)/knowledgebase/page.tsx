"use client";
import { useState } from "react";
import { cx, useApi } from "@/components/ui";
import { ResourceManager } from "@/components/admin/resource";

export default function Kb() {
  const [tab, setTab] = useState("articles");
  const cats = useApi("/admin/kb-categories");
  const catOpts = (cats.data?.items ?? []).map((c: any) => ({ value: c.id, label: c.name }));
  return (
    <>
      <div className="mb-4 flex flex-wrap gap-2">{[["articles", "Articles"], ["categories", "Categories"], ["downloads", "Downloads"], ["canned", "Canned responses"], ["departments", "Ticket departments"]].map(([k, l]) => <button key={k} onClick={() => setTab(k)} className={cx("rounded-full px-4 py-2 text-sm font-bold", tab === k ? "bg-primary-dark text-white" : "bg-white text-slate-600 ring-1 ring-line")}>{l}</button>)}</div>
      {tab === "articles" && <ResourceManager title="Knowledgebase articles" endpoint="/admin/kb-articles" fields={[{ key: "title", label: "Title", required: true }, { key: "slug", label: "Slug", required: true }, { key: "categoryId", label: "Category", type: "select", required: true, options: catOpts }, { key: "published", label: "Published", type: "bool", default: true }, { key: "body", label: "Body (plain text / markdown)", type: "textarea", required: true }]} columns={[{ label: "Title", render: (r) => <b>{r.title}</b> }, { label: "Slug", render: (r) => r.slug }, { label: "Views", render: (r) => r.views }, { label: "Published", render: (r) => (r.published ? "Yes" : "Draft") }]} />}
      {tab === "categories" && <ResourceManager title="KB categories" endpoint="/admin/kb-categories" fields={[{ key: "name", label: "Name", required: true }, { key: "slug", label: "Slug", required: true }]} columns={[{ label: "Name", render: (r) => <b>{r.name}</b> }, { label: "Articles", render: (r) => r._count?.articles }]} />}
      {tab === "downloads" && <ResourceManager title="Downloads" endpoint="/admin/downloads" fields={[{ key: "title", label: "Title", required: true }, { key: "url", label: "File URL", required: true }, { key: "category", label: "Category", default: "General" }, { key: "clientsOnly", label: "Clients only", type: "bool", default: true }, { key: "description", label: "Description", type: "textarea" }]} columns={[{ label: "Title", render: (r) => <b>{r.title}</b> }, { label: "Category", render: (r) => r.category }, { label: "URL", render: (r) => <span className="text-xs">{r.url}</span> }]} />}
      {tab === "canned" && <ResourceManager title="Canned responses" subtitle="Use {{name}} for the customer's first name." endpoint="/admin/canned-responses" fields={[{ key: "title", label: "Title", required: true, full: true }, { key: "body", label: "Body", type: "textarea", required: true }]} columns={[{ label: "Title", render: (r) => <b>{r.title}</b> }, { label: "Preview", render: (r) => <span className="text-xs text-mute">{r.body.slice(0, 90)}</span> }]} />}
      {tab === "departments" && <ResourceManager title="Ticket departments" endpoint="/admin/ticket-departments" fields={[{ key: "name", label: "Name", required: true }, { key: "email", label: "Inbound email (piping)" }, { key: "slaHours", label: "First-response SLA (hours)", type: "number", default: 4 }, { key: "sortOrder", label: "Sort order", type: "number", default: 0 }, { key: "hidden", label: "Hidden from customers", type: "bool" }]} columns={[{ label: "Department", render: (r) => <b>{r.name}</b> }, { label: "SLA", render: (r) => `${r.slaHours} h` }, { label: "Email", render: (r) => r.email ?? "—" }]} />}
    </>
  );
}
