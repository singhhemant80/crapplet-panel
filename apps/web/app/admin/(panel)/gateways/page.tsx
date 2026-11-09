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

function GatewayCard({ g, onSaved }: { g: any; onSaved: () => void }) {
  const [v, setV] = useState({ name: g.name, enabled: g.enabled, testMode: g.testMode, secrets: { ...g.configured }, publicConfig: { ...g.publicConfig } });
  const origin = typeof window !== "undefined" ? window.location.origin : "";
  return (
    <Card title={<span className="flex items-center gap-2">{g.code.toUpperCase()} {v.enabled ? <Badge status="ACTIVE">enabled</Badge> : <Badge>disabled</Badge>}{g.offline && <Badge>manual verification</Badge>}</span>}>
      <div className="space-y-3">
        <Field label="Display name"><Input value={v.name} onChange={(e) => setV({ ...v, name: e.target.value })} /></Field>
        {g.fields.secret.map((f: string) => (
          <Field key={f} label={f}><Input type={/secret|salt|key$/i.test(f) && f !== "keyId" && f !== "key" ? "password" : "text"} value={v.secrets[f] ?? ""} onChange={(e) => setV({ ...v, secrets: { ...v.secrets, [f]: e.target.value } })} placeholder={g.configured[f] ? "unchanged" : ""} /></Field>
        ))}
        {g.fields.public.map((f: string) => (
          <Field key={f} label={f}>{f === "instructions" ? <Textarea rows={4} value={v.publicConfig[f] ?? ""} onChange={(e) => setV({ ...v, publicConfig: { ...v.publicConfig, [f]: e.target.value } })} /> : <Input value={v.publicConfig[f] ?? ""} onChange={(e) => setV({ ...v, publicConfig: { ...v.publicConfig, [f]: e.target.value } })} />}</Field>
        ))}
        {!g.offline && <Alert>Webhook URL: <span className="font-mono text-xs">{origin}{g.webhookUrl}</span> <Copy text={`${origin}${g.webhookUrl}`} /></Alert>}
        <div className="flex flex-wrap gap-5"><Toggle checked={v.enabled} onChange={(x) => setV({ ...v, enabled: x })} label="Enabled" />{!g.offline && <Toggle checked={v.testMode} onChange={(x) => setV({ ...v, testMode: x })} label="Test / sandbox mode" />}</div>
        <Button icon="save" onClick={() => api(`/admin/gateways/${g.code}`, { method: "PUT", body: v }).then(() => { toast.success("Gateway saved"); onSaved(); }).catch((e) => toast.error(e.message))}>Save</Button>
      </div>
    </Card>
  );
}
