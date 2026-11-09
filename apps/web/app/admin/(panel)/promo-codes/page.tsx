"use client";
import { date, money } from "@/lib/api";
import { useApi } from "@/components/ui";
import { ResourceManager } from "@/components/admin/resource";

export default function Page() {
  const products = useApi("/admin/products");
  const opts = (products.data?.products ?? []).map((p: any) => ({ value: p.id, label: p.name }));
  return (
    <ResourceManager title="Promo Codes" endpoint="/admin/promo-codes"
      fields={[
        { key: "code", label: "Code", required: true },
        { key: "type", label: "Type", type: "select", required: true, options: [{ value: "PERCENT", label: "Percentage" }, { value: "FIXED", label: "Fixed amount" }], default: "PERCENT" },
        { key: "value", label: "Value", type: "number", required: true, hint: "Percent (e.g. 15) or, for fixed codes, the INR amount in paise (10000 = ₹100)" },
        { key: "usdFixed", label: "Fixed discount for USD orders", type: "money", currency: "USD", json: { column: "fixedAmounts", path: ["USD"] }, hint: "Fixed codes only. Blank = convert the INR amount" },
        { key: "maxUses", label: "Max uses (0 = unlimited)", type: "number", default: 0 },
        { key: "startsAt", label: "Starts", type: "date" },
        { key: "expiresAt", label: "Expires", type: "date" },
        { key: "recurring", label: "Applies to renewals too", type: "bool" },
        { key: "newOnly", label: "New customers only", type: "bool" },
        { key: "enabled", label: "Enabled", type: "bool", default: true },
        { key: "productIds", label: "Limit to products (none = all)", type: "multiselect", options: opts, full: true },
        { key: "cycles", label: "Limit to cycles (none = all)", type: "multiselect", options: ["MONTHLY", "QUARTERLY", "SEMIANNUAL", "ANNUAL", "BIENNIAL", "TRIENNIAL"].map((c) => ({ value: c, label: c })), full: true },
      ]}
      columns={[{ label: "Code", render: (r) => <b className="font-mono">{r.code}</b> }, { label: "Discount", render: (r) => (r.type === "PERCENT" ? `${r.value}%` : `${money(r.value)}${r.fixedAmounts?.USD !== undefined ? ` / ${money(r.fixedAmounts.USD, "USD")}` : ""}`) }, { label: "Uses", render: (r) => `${r.uses}${r.maxUses ? ` / ${r.maxUses}` : ""}` }, { label: "Expires", render: (r) => date(r.expiresAt) }, { label: "Products", render: (r) => (r.productIds.length ? `${r.productIds.length} products` : "All") }, { label: "Enabled", render: (r) => (r.enabled ? "Yes" : "No") }]} />
  );
}
