"use client";
import { money } from "@/lib/api";
import { ResourceManager } from "@/components/admin/resource";

export default function Page() {
  return (
    <ResourceManager title="Add-ons" subtitle="Optional extras (backups, cPanel licence, extra IP…) attached to products." endpoint="/admin/addons"
      fields={[{ key: "name", label: "Name", required: true }, { key: "monthly", label: "Monthly price", type: "money" }, { key: "setupFee", label: "Setup fee", type: "money" }, { key: "usdMonthly", label: "Monthly price", type: "money", currency: "USD", json: { column: "prices", path: ["USD", "monthly"] }, hint: "Blank = auto-convert from INR" }, { key: "usdSetup", label: "Setup fee", type: "money", currency: "USD", json: { column: "prices", path: ["USD", "setupFee"] }, hint: "Blank = auto-convert from INR" }, { key: "taxable", label: "Taxable (GST)", type: "bool", default: true }, { key: "enabled", label: "Enabled", type: "bool", default: true }, { key: "description", label: "Description", type: "textarea" }]}
      columns={[{ label: "Name", render: (r) => <b>{r.name}</b> }, { label: "Monthly", render: (r) => money(r.monthly) }, { label: "Setup", render: (r) => money(r.setupFee) }, { label: "USD / mo", render: (r) => (r.prices?.USD?.monthly !== undefined ? money(r.prices.USD.monthly, "USD") : <span className="text-xs text-mute">auto</span>) }, { label: "Enabled", render: (r) => (r.enabled ? "Yes" : "No") }]} />
  );
}
