"use client";
import { useState } from "react";
import { api } from "@/lib/api";
import { Alert, Badge, Button, Card, Copy, Field, Input, Loading, PageHeader, Textarea, Toggle, toast, useApi } from "@/components/ui";

export default function Gateways() {
  const { data, loading, reload } = useApi("/admin/gateways");
  if (loading) return <Loading />;
  return (
    <>
      <PageHeader title="Payment gateways" subtitle="Secrets are encrypted at rest. Services are only activated by verified, signed webhooks or server-side verification — never by the browser alone." />
      <div className="grid gap-5 xl:grid-cols-2">{data.gateways.map((g: any) => <GatewayCard key={g.code} g={g} onSaved={reload} />)}</div>
    </>
  );
}

const HINTS: Record<string, string> = {
  paypal: "PayPal Developer → Apps & Credentials → your REST app. Add a webhook for PAYMENT.CAPTURE.COMPLETED and CHECKOUT.ORDER.APPROVED pointing at the URL below, and paste its Webhook ID.",
  wire: "Shown to customers paying USD invoices by SWIFT: beneficiary name & address, bank name, account number, SWIFT/BIC, intermediary bank if any.",
  stripe: "Stripe charges INR and USD. For international cards on an Indian account, enable international payments in the Stripe dashboard.",
  razorpay: "Razorpay can also take USD if International Payments are enabled on your account — then tick USD below.",
};
const FIELD_LABELS: Record<string, string> = { clientId: "Client ID", clientSecret: "Client secret", webhookId: "Webhook ID", instructions: "Instructions shown to the customer" };

function GatewayCard({ g, onSaved }: { g: any; onSaved: () => void }) {
  const [v, setV] = useState({ name: g.name, enabled: g.enabled, testMode: g.testMode, secrets: { ...g.configured }, publicConfig: { ...g.publicConfig, currencies: g.currencies } });
  const curs: string[] = v.publicConfig.currencies ?? g.defaultCurrencies;
  const toggleCur = (c: string) => setV({ ...v, publicConfig: { ...v.publicConfig, currencies: curs.includes(c) ? curs.filter((x) => x !== c) : [...curs, c] } });
  const origin = typeof window !== "undefined" ? window.location.origin : "";
  return (
    <Card title={<span className="flex items-center gap-2">{g.code.toUpperCase()} {v.enabled ? <Badge status="ACTIVE">enabled</Badge> : <Badge>disabled</Badge>}{g.offline && <Badge>manual verification</Badge>}</span>}>
      <div className="space-y-3">
        {HINTS[g.code] && <p className="text-xs text-mute">{HINTS[g.code]}</p>}
        <Field label="Display name"><Input value={v.name} onChange={(e) => setV({ ...v, name: e.target.value })} /></Field>
        {g.fields.secret.map((f: string) => (
          <Field key={f} label={FIELD_LABELS[f] ?? f}><Input type={/secret|salt|key$/i.test(f) && f !== "keyId" && f !== "key" ? "password" : "text"} value={v.secrets[f] ?? ""} onChange={(e) => setV({ ...v, secrets: { ...v.secrets, [f]: e.target.value } })} placeholder={g.configured[f] ? "unchanged" : ""} /></Field>
        ))}
        {g.fields.public.map((f: string) => (
          <Field key={f} label={FIELD_LABELS[f] ?? f}>{f === "instructions" ? <Textarea rows={4} value={v.publicConfig[f] ?? ""} onChange={(e) => setV({ ...v, publicConfig: { ...v.publicConfig, [f]: e.target.value } })} /> : <Input value={v.publicConfig[f] ?? ""} onChange={(e) => setV({ ...v, publicConfig: { ...v.publicConfig, [f]: e.target.value } })} />}</Field>
        ))}
        <Field label="Accepts currencies" hint={`Customers only see this method on invoices in these currencies. Default: ${g.defaultCurrencies.join(", ")}`}>
          <div className="flex gap-2">
            {["INR", "USD"].map((c) => (
              <button key={c} type="button" onClick={() => toggleCur(c)} disabled={g.code === "upi" && c !== "INR"} className={`rounded-lg px-3 py-1.5 text-xs font-extrabold ${curs.includes(c) ? "bg-primary-dark text-white" : "bg-slate-100 text-slate-500"} disabled:opacity-40`}>
                {c}
              </button>
            ))}
          </div>
        </Field>
        {!g.offline && <Alert>Webhook URL: <span className="font-mono text-xs">{origin}{g.webhookUrl}</span> <Copy text={`${origin}${g.webhookUrl}`} /></Alert>}
        <div className="flex flex-wrap gap-5"><Toggle checked={v.enabled} onChange={(x) => setV({ ...v, enabled: x })} label="Enabled" />{!g.offline && <Toggle checked={v.testMode} onChange={(x) => setV({ ...v, testMode: x })} label="Test / sandbox mode" />}</div>
        <Button icon="save" onClick={() => (curs.length ? api(`/admin/gateways/${g.code}`, { method: "PUT", body: v }) : Promise.reject(new Error("Pick at least one currency"))).then(() => { toast.success("Gateway saved"); onSaved(); }).catch((e) => toast.error(e.message))}>Save</Button>
      </div>
    </Card>
  );
}
