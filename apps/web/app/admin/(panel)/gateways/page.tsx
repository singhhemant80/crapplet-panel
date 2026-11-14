"use client";
import { useState } from "react";
import { api } from "@/lib/api";
import { Alert, Badge, Button, Card, Copy, Field, Input, Loading, PageHeader, Select, Textarea, Toggle, toast, useApi } from "@/components/ui";

export default function Gateways() {
  const { data, loading, reload } = useApi("/admin/gateways");
  if (loading) return <Loading />;
  return (
    <>
      <PageHeader title="Payment gateways" subtitle="Secrets are encrypted at rest. Services are only activated by verified, signed webhooks or server-side verification — never by the browser alone." />
      <AutopayCard gateways={data.gateways} />
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

/** UPI AutoPay: customers approve a UPI mandate once; renewals are then charged automatically. */
function AutopayCard({ gateways }: { gateways: any[] }) {
  const { data, reload } = useApi("/admin/gateways/autopay");
  const [v, setV] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  if (!data) return null;
  const f = v ?? data;
  const set = (k: string, x: any) => setV({ ...f, [k]: x });
  const on = (code: string) => gateways.some((g) => g.code === code && g.enabled);
  const origin = typeof window !== "undefined" ? window.location.origin : "";
  const active = (data.mandates ?? []).filter((m: any) => m.status === "ACTIVE").reduce((a: number, m: any) => a + m._count, 0);
  const provider = data.provider === "cashfree" ? "Cashfree" : data.provider === "razorpay" ? "Razorpay" : null;
  async function save() {
    setBusy(true);
    try {
      await api("/admin/gateways/autopay", { method: "PUT", body: { upiAutopay: f.upiAutopay, autopayGateway: f.autopayGateway, autopayDaysBeforeDue: Number(f.autopayDaysBeforeDue) } });
      toast.success("UPI AutoPay saved");
      setV(null);
      reload();
    } catch (e: any) {
      toast.error(e.message);
    }
    setBusy(false);
  }
  return (
    <Card className="mb-5" title={<span className="flex items-center gap-2">UPI AUTOPAY {data.upiAutopay && provider ? <Badge status="ACTIVE">on · {provider}</Badge> : <Badge>off</Badge>}</span>}>
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <div className="space-y-4">
          <p className="text-sm text-slate-600">Customers paying for a service can choose <b>UPI AutoPay</b>: they approve a mandate once in their UPI app, and renewals are charged automatically. Max ₹99,999 per debit.</p>
          <Toggle checked={f.upiAutopay} onChange={(x) => set("upiAutopay", x)} label="Offer UPI AutoPay to customers" />
          <Field label="Gateway for new mandates" hint="Existing mandates keep renewing on the gateway they were set up with">
            <Select value={f.autopayGateway} onChange={(e) => set("autopayGateway", e.target.value)}>
              <option value="auto">Automatic — Razorpay if it's on, otherwise Cashfree</option>
              <option value="cashfree">Cashfree{on("cashfree") ? "" : " (not enabled below)"}</option>
              <option value="razorpay">Razorpay{on("razorpay") ? "" : " (not enabled below)"}</option>
            </Select>
          </Field>
          <Field label="Charge renewals (days before due)" hint="2–15 days. The bank notifies the customer 24 hours before each debit."><Input type="number" min={2} max={15} value={f.autopayDaysBeforeDue} onChange={(e) => set("autopayDaysBeforeDue", e.target.value)} /></Field>
          <Button icon="save" loading={busy} onClick={save}>Save AutoPay</Button>
        </div>
        <div className="space-y-3 text-sm">
          {!provider && f.upiAutopay && <Alert tone="warn">No gateway can take mandates yet — enable Cashfree or Razorpay below (with live keys), or customers won't see AutoPay.</Alert>}
          {provider && <Alert tone="info">New mandates go to <b>{provider}</b>. {active ? <>{active} customer{active === 1 ? " has" : "s have"} an active mandate.</> : "No customer has set one up yet."}</Alert>}
          {data.lastFailure && <Alert tone="error">Last AutoPay setup failed ({new Date(data.lastFailure.at).toLocaleString("en-IN")}): <span className="break-all font-mono text-xs">{data.lastFailure.error || "no details"}</span></Alert>}
          <div className="rounded-xl border border-line p-4">
            <div className="mb-2 font-bold text-ink">Set up on Cashfree</div>
            <ol className="list-decimal space-y-1.5 pl-5 text-slate-600">
              <li>In the Cashfree dashboard, open <b>Subscriptions</b> and ask Cashfree to activate <b>UPI AutoPay</b> for your account (it's a separate product from Payment Gateway).</li>
              <li>Use the same App ID and Secret Key as the Cashfree card below — make sure Cashfree is <b>Enabled</b> and not in test mode.</li>
              <li>Under <b>Subscriptions → Developers → Webhooks</b>, add <span className="font-mono text-xs">{origin}/api/webhooks/cashfree</span> <Copy text={`${origin}/api/webhooks/cashfree`} /> and tick all subscription events.</li>
              <li>Pick <b>Cashfree</b> above and save. Test with a small invoice from a customer account.</li>
            </ol>
          </div>
          <p className="text-xs text-mute">Razorpay: enable <b>UPI AutoPay / Recurring payments</b> on your Razorpay account; the Razorpay webhook below also receives mandate events.</p>
        </div>
      </div>
    </Card>
  );
}
