"use client";
import { useState } from "react";
import { api } from "@/lib/api";
import { Badge, Button, Card, Field, Input, Loading, PageHeader, Textarea, Toggle, cx, toast, useApi } from "@/components/ui";

export default function Templates() {
  const { data, loading, reload } = useApi("/admin/email-templates");
  const [sel, setSel] = useState<any>(null);
  const [preview, setPreview] = useState<{ subject: string; body: string } | null>(null);
  if (loading) return <Loading />;
  return (
    <>
      <PageHeader title="Email templates" subtitle="Use {{placeholders}} such as {{name}}, {{invoiceNumber}}, {{total}}, {{hostname}}, {{ip}}, {{password}}, {{company.brand}}." />
      <div className="grid gap-6 lg:grid-cols-[300px_1fr]">
        <Card pad={false}>
          <ul className="divide-y divide-[#f3effb]">
            {data.templates.map((t: any) => (
              <li key={t.key}><button onClick={() => { setSel({ ...t }); setPreview(null); }} className={cx("flex w-full items-center justify-between px-4 py-3 text-left text-sm", sel?.key === t.key ? "bg-primary-soft font-bold text-primary-dark" : "hover:bg-primary-tint")}>
                <span>{t.name}<div className="font-mono text-[11px] text-mute">{t.key}</div></span>{t.customized && <Badge>custom</Badge>}
              </button></li>
            ))}
          </ul>
        </Card>
        {sel ? (
          <Card title={sel.name}>
            <div className="space-y-4">
              <Field label="Subject"><Input value={sel.subject} onChange={(e) => setSel({ ...sel, subject: e.target.value })} /></Field>
              <Field label="HTML body"><Textarea rows={12} className="font-mono text-xs" value={sel.body} onChange={(e) => setSel({ ...sel, body: e.target.value })} /></Field>
              <Toggle checked={sel.enabled} onChange={(v) => setSel({ ...sel, enabled: v })} label="Send this email" />
              <div className="flex flex-wrap gap-2">
                <Button icon="save" onClick={() => api(`/admin/email-templates/${sel.key}`, { method: "PUT", body: { subject: sel.subject, body: sel.body, enabled: sel.enabled } }).then(() => { toast.success("Saved"); reload(); })}>Save</Button>
                <Button variant="outline" icon="visibility" onClick={() => api(`/admin/email-templates/${sel.key}/preview`, { body: { subject: sel.subject, body: sel.body } }).then(setPreview)}>Preview</Button>
                <Button variant="outline" icon="send" onClick={() => { const to = prompt("Send a test to"); if (to) api(`/admin/email-templates/${sel.key}/preview`, { body: { sendTo: to } }).then(() => toast.success("Test sent")).catch((e) => toast.error(e.message)); }}>Send test</Button>
                {sel.customized && <Button variant="ghost" onClick={() => api(`/admin/email-templates/${sel.key}`, { method: "DELETE" }).then(() => { toast.success("Reset to default"); setSel(null); reload(); })}>Reset to default</Button>}
              </div>
              {preview && <div className="rounded-xl border border-line p-4"><div className="mb-2 text-sm font-bold">{preview.subject}</div><div className="text-sm" dangerouslySetInnerHTML={{ __html: preview.body }} /></div>}
            </div>
          </Card>
        ) : <Card><p className="text-sm text-mute">Select a template to edit.</p></Card>}
      </div>
    </>
  );
}
