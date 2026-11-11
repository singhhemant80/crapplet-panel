"use client";
import Link from "next/link";
import { Suspense, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { api, date } from "@/lib/api";
import { Alert, Badge, Button, Card, Field, Icon, Input, Loading, PageHeader, Select, Textarea, Toggle, cx, toast, useApi } from "@/components/ui";

const TABS = [["setup", "Setup", "settings"], ["notifications", "Notifications", "notifications_active"], ["messages", "Messages", "forum"]] as const;

function WhatsAppPage() {
  const sp = useSearchParams();
  const router = useRouter();
  const tab = (sp.get("tab") ?? "setup") as (typeof TABS)[number][0];
  const { data, loading, reload } = useApi("/admin/whatsapp");
  if (loading || !data) return <Loading />;
  const c = data.config;
  const st = data.stats ?? {};
  return (
    <>
      <PageHeader
        icon="chat"
        title="WhatsApp"
        subtitle="Send invoices, reminders, overdue notices, service updates and ticket replies to clients on WhatsApp — alongside email."
        badge={<Badge status={c.enabled ? "ACTIVE" : "CANCELLED"}>{c.enabled ? "On" : "Off"}</Badge>}
        stats={[
          ["Provider", c.provider === "meta" ? "Meta Cloud API" : "HTTP gateway", c.hasToken ? "token saved" : "no token yet"],
          ["Sent (30 days)", st.SENT ?? 0],
          ["Failed (30 days)", <span key="f" className={st.FAILED ? "text-rose-600" : ""}>{st.FAILED ?? 0}</span>],
          ["Notifications on", `${Object.values(c.events).filter((e: any) => e.enabled).length} of ${Object.keys(c.events).length}`],
        ]}
      />
      <div className="mb-5 flex gap-2 overflow-x-auto">
        {TABS.map(([k, l, i]) => (
          <button key={k} onClick={() => router.replace(`/admin/whatsapp?tab=${k}`)} className={cx("inline-flex shrink-0 items-center gap-2 rounded-xl px-4 py-2.5 text-[13.5px] font-bold", tab === k ? "bg-primary-dark text-white shadow-glow" : "bg-white text-slate-600 ring-1 ring-line hover:text-primary-dark")}>
            <Icon name={i} className="text-[18px]" />{l}
          </button>
        ))}
      </div>
      {tab === "setup" && <Setup c={c} onSaved={reload} />}
      {tab === "notifications" && <Notifications c={c} events={data.events} onSaved={reload} />}
      {tab === "messages" && <Messages />}
    </>
  );
}

function Setup({ c, onSaved }: { c: any; onSaved: () => void }) {
  const [f, setF] = useState<any>(() => structuredClone(c));
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [to, setTo] = useState("");
  const [text, setText] = useState("Test message from your billing panel ✅");
  const [testing, setTesting] = useState(false);
  const set = (path: string, v: any) => setF((x: any) => { const y = structuredClone(x); const ks = path.split("."); let o = y; for (const k of ks.slice(0, -1)) o = o[k]; o[ks[ks.length - 1]] = v; return y; });

  async function save() {
    setBusy(true);
    try {
      await api("/admin/whatsapp", { method: "PUT", body: { enabled: f.enabled, provider: f.provider, defaultCountryCode: f.defaultCountryCode, meta: f.meta, http: f.http, ...(token ? { token } : {}) } });
      setToken("");
      toast.success("WhatsApp settings saved");
      onSaved();
    } catch (e: any) {
      toast.error(e.message);
    } finally {
      setBusy(false);
    }
  }
  async function test() {
    setTesting(true);
    try {
      await api("/admin/whatsapp/test", { body: { to, text } });
      toast.success("Test message sent");
    } catch (e: any) {
      toast.error(e.message);
    } finally {
      setTesting(false);
    }
  }
  return (
    <div className="grid items-start gap-6 xl:grid-cols-[minmax(0,1fr)_380px]">
      <div className="space-y-6">
        <Card title="Connection">
          <div className="space-y-5">
            <Toggle checked={f.enabled} onChange={(v) => set("enabled", v)} label="Send WhatsApp messages to clients" />
            <div className="grid gap-3 sm:grid-cols-2">
              {([["meta", "verified", "Meta WhatsApp Cloud API", "Official API · approved templates"], ["http", "api", "Other WhatsApp gateway", "Interakt, AiSensy, WATI, UltraMsg, …"]] as const).map(([k, i, t, d]) => (
                <button key={k} type="button" onClick={() => set("provider", k)} className={cx("flex items-start gap-3 rounded-xl border p-3.5 text-left", f.provider === k ? "border-primary bg-primary-tint ring-2 ring-primary/20" : "border-line hover:border-primary/40")}>
                  <span className={cx("grid h-9 w-9 shrink-0 place-items-center rounded-lg", f.provider === k ? "bg-primary-dark text-white" : "bg-primary-soft text-primary-dark")}><Icon name={i} className="text-[19px]" /></span>
                  <span><span className="block text-sm font-extrabold text-ink">{t}</span><span className="text-xs text-mute">{d}</span></span>
                </button>
              ))}
            </div>
            {f.provider === "meta" ? (
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Phone number ID" hint="Meta → WhatsApp → API Setup"><Input value={f.meta.phoneNumberId} onChange={(e) => set("meta.phoneNumberId", e.target.value.trim())} placeholder="123456789012345" /></Field>
                <Field label="Graph API version"><Input value={f.meta.apiVersion} onChange={(e) => set("meta.apiVersion", e.target.value.trim())} placeholder="v21.0" /></Field>
                <Field label="Permanent access token" className="sm:col-span-2" hint={c.hasToken ? "A token is saved — leave empty to keep it" : "System user token with whatsapp_business_messaging permission"}><Input type="password" value={token} onChange={(e) => setToken(e.target.value)} placeholder={c.hasToken ? "••••••••••••" : "EAAG…"} /></Field>
              </div>
            ) : (
              <div className="grid gap-4 sm:grid-cols-[120px_1fr]">
                <Field label="Method"><Select value={f.http.method} onChange={(e) => set("http.method", e.target.value)}><option>POST</option><option>GET</option></Select></Field>
                <Field label="URL" hint="Use {{phone}}, {{message}}, {{token}} where the gateway expects them"><Input value={f.http.url} onChange={(e) => set("http.url", e.target.value)} placeholder="https://api.gateway.com/v1/send" /></Field>
                <Field label="Headers (JSON)" className="sm:col-span-2"><Textarea rows={3} className="font-mono text-xs" value={f.http.headers} onChange={(e) => set("http.headers", e.target.value)} /></Field>
                {f.http.method === "POST" && <Field label="Body" className="sm:col-span-2" hint="JSON or form text — values are escaped automatically"><Textarea rows={4} className="font-mono text-xs" value={f.http.body} onChange={(e) => set("http.body", e.target.value)} /></Field>}
                <Field label="API key / token" className="sm:col-span-2" hint={c.hasToken ? "A key is saved — leave empty to keep it" : "Inserted where you put {{token}}"}><Input type="password" value={token} onChange={(e) => setToken(e.target.value)} placeholder={c.hasToken ? "••••••••••••" : ""} /></Field>
                <Field label="Success text (optional)" className="sm:col-span-2" hint='Only count as sent when the response contains this, e.g. "success":true'><Input value={f.http.successMatch} onChange={(e) => set("http.successMatch", e.target.value)} /></Field>
              </div>
            )}
            <Field label="Default country code" hint="Added to 10-digit mobile numbers"><Input className="w-32" value={f.defaultCountryCode} onChange={(e) => set("defaultCountryCode", e.target.value.replace(/\D/g, ""))} /></Field>
          </div>
          <div className="mt-5 flex justify-end"><Button icon="save" loading={busy} onClick={save}>Save settings</Button></div>
        </Card>
      </div>
      <div className="space-y-6">
        <Card title="Send a test">
          <div className="space-y-3">
            <Field label="Mobile number"><Input value={to} onChange={(e) => setTo(e.target.value)} placeholder="98765 43210" /></Field>
            <Field label="Message"><Textarea rows={3} value={text} onChange={(e) => setText(e.target.value)} /></Field>
            <Button className="w-full !bg-emerald-600 !bg-none hover:!bg-emerald-700" icon="send" loading={testing} disabled={!to.trim()} onClick={test}>Send test</Button>
            <p className="text-xs text-mute">Save settings first. With Meta, free text only reaches a number that messaged your business in the last 24 hours — send yourself a WhatsApp first.</p>
          </div>
        </Card>
        <Card title="How it works">
          <ul className="space-y-2.5 text-[13px] leading-relaxed text-slate-600">
            <li className="flex gap-2"><Icon name="check_circle" className="mt-0.5 text-[17px] text-emerald-500" />Each notification you switch on goes out on WhatsApp whenever the matching email goes out.</li>
            <li className="flex gap-2"><Icon name="check_circle" className="mt-0.5 text-[17px] text-emerald-500" />Only clients with a mobile number who haven&apos;t switched WhatsApp off in their profile receive them.</li>
            <li className="flex gap-2"><Icon name="lock" className="mt-0.5 text-[17px] text-primary" />Passwords and sign-in links are never sent automatically.</li>
            <li className="flex gap-2"><Icon name="info" className="mt-0.5 text-[17px] text-sky-500" />Meta requires approved templates for business-initiated messages — add the template name per notification.</li>
          </ul>
        </Card>
      </div>
    </div>
  );
}

function Notifications({ c, events, onSaved }: { c: any; events: Record<string, any>; onSaved: () => void }) {
  const [ev, setEv] = useState<Record<string, any>>(() => structuredClone(c.events));
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const groups = [...new Set(Object.values(events).map((e: any) => e.group))];
  const upd = (k: string, patch: any) => setEv((x) => ({ ...x, [k]: { ...x[k], ...patch } }));
  async function save() {
    setBusy(true);
    try {
      await api("/admin/whatsapp", { method: "PUT", body: { events: ev } });
      toast.success("Notifications saved");
      onSaved();
    } catch (e: any) {
      toast.error(e.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="space-y-6">
      {!c.enabled && <Alert tone="warn">WhatsApp is switched off — notifications won&apos;t be sent until you turn it on in Setup.</Alert>}
      {groups.map((g) => (
        <Card key={g} title={g} pad={false}>
          <ul className="divide-y divide-line">
            {Object.entries(events).filter(([, e]: any) => e.group === g).map(([k, meta]: any) => {
              const e = ev[k];
              return (
                <li key={k} className="px-5 py-4">
                  <div className="flex flex-wrap items-center gap-3">
                    <Toggle checked={e.enabled} onChange={(v) => upd(k, { enabled: v })} />
                    <div className="min-w-0 flex-1"><div className="text-sm font-extrabold text-ink">{meta.name}</div><div className="truncate text-xs text-mute">{e.text}</div></div>
                    <Button size="sm" variant="ghost" icon={open === k ? "expand_less" : "edit"} onClick={() => setOpen(open === k ? null : k)}>{open === k ? "Close" : "Edit"}</Button>
                  </div>
                  {open === k && (
                    <div className="mt-4 grid gap-4 rounded-xl bg-[#fbf9ff] p-4 lg:grid-cols-2">
                      <Field label="Message" className="lg:col-span-2" hint="Used for gateways, and for Meta when no template is set">
                        <Textarea rows={3} value={e.text} onChange={(x) => upd(k, { text: x.target.value })} />
                      </Field>
                      <div className="flex flex-wrap gap-1.5 lg:col-span-2">
                        {[...meta.vars, "companyName", "clientAreaLink", ...(meta.vars.includes("invoiceNumber") ? ["payLink"] : [])].filter((v, i, a) => a.indexOf(v) === i).map((v: string) => (
                          <button key={v} type="button" onClick={() => upd(k, { text: `${e.text} {{${v}}}` })} className="rounded-md bg-white px-2 py-1 font-mono text-[11px] font-bold text-primary-dark ring-1 ring-[#e6dcf8] hover:bg-primary-soft">{`{{${v}}}`}</button>
                        ))}
                      </div>
                      {c.provider === "meta" && (
                        <>
                          <Field label="Meta template name" hint="Approved template — leave empty to send the text above"><Input value={e.metaTemplate ?? ""} onChange={(x) => upd(k, { metaTemplate: x.target.value.trim() })} placeholder={k.replace(".", "_")} /></Field>
                          <Field label="Template language"><Input value={e.metaLanguage ?? "en"} onChange={(x) => upd(k, { metaLanguage: x.target.value.trim() })} placeholder="en" /></Field>
                          <Field label="Template parameters, in order" className="lg:col-span-2" hint={`Variable names for {{1}}, {{2}}… e.g. ${meta.vars.slice(0, 3).join(", ")}`}><Input value={e.metaParams ?? ""} onChange={(x) => upd(k, { metaParams: x.target.value })} placeholder={meta.vars.join(", ")} /></Field>
                        </>
                      )}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        </Card>
      ))}
      <div className="sticky bottom-4 flex justify-end rounded-2xl border border-line bg-white/95 p-3 shadow-card backdrop-blur">
        <Button icon="save" loading={busy} onClick={save}>Save notifications</Button>
      </div>
    </div>
  );
}

function Messages() {
  const [status, setStatus] = useState("");
  const [page, setPage] = useState(1);
  useEffect(() => setPage(1), [status]);
  const { data, reload } = useApi(`/admin/whatsapp/messages?page=${page}${status ? `&status=${status}` : ""}`, [page, status]);
  return (
    <Card title="Message log" pad={false} action={<Select className="h-9 w-40" value={status} onChange={(e) => setStatus(e.target.value)}><option value="">All</option><option value="SENT">Sent</option><option value="FAILED">Failed</option><option value="QUEUED">Queued</option><option value="SKIPPED">Skipped</option></Select>}>
      {!data ? <Loading /> : !data.items.length ? <p className="p-5 text-sm text-mute">No messages yet.</p> : (
        <>
          <ul className="divide-y divide-line">
            {data.items.map((m: any) => (
              <li key={m.id} className="flex items-start gap-3 px-5 py-3">
                <span className={cx("mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-lg", m.status === "SENT" ? "bg-emerald-50 text-emerald-600" : m.status === "FAILED" ? "bg-rose-50 text-rose-600" : "bg-slate-100 text-slate-500")}><Icon name={m.status === "SENT" ? "done_all" : m.status === "FAILED" ? "error" : "schedule"} className="text-[17px]" /></span>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-x-2 text-[12.5px]">
                    {m.user ? <Link href={`/admin/clients/${m.user.id}`} className="font-bold text-primary-dark hover:underline">{`${m.user.firstName ?? ""} ${m.user.lastName ?? ""}`.trim() || m.user.email}</Link> : <span className="font-bold text-ink">+{m.to}</span>}
                    <span className="text-mute">+{m.to} · {m.event === "manual" ? "staff message" : m.event} · {date(m.createdAt, true)}</span>
                  </div>
                  <div className="mt-0.5 line-clamp-2 whitespace-pre-wrap break-words text-[13px] text-slate-700">{m.body}</div>
                  {m.error && <div className="mt-0.5 text-xs font-semibold text-rose-600">{m.error}</div>}
                </div>
                {m.status === "FAILED" && <Button size="sm" variant="ghost" icon="refresh" onClick={() => api(`/admin/whatsapp/messages/${m.id}/retry`, { body: {} }).then(() => { toast.success("Queued again"); reload(); }).catch((e) => toast.error(e.message))}>Retry</Button>}
              </li>
            ))}
          </ul>
          {data.pages > 1 && (
            <div className="flex items-center justify-between border-t border-line px-5 py-3 text-sm">
              <Button size="sm" variant="ghost" disabled={page <= 1} onClick={() => setPage(page - 1)}>Previous</Button>
              <span className="text-mute">Page {page} of {data.pages}</span>
              <Button size="sm" variant="ghost" disabled={page >= data.pages} onClick={() => setPage(page + 1)}>Next</Button>
            </div>
          )}
        </>
      )}
    </Card>
  );
}

export default function Page() {
  return <Suspense fallback={<Loading />}><WhatsAppPage /></Suspense>;
}
