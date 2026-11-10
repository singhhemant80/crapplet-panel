"use client";
import { Fragment, useEffect, useState } from "react";
import { api } from "@/lib/api";
import { Alert, Badge, Button, Card, Copy, Empty, Field, Icon, Input, Loading, PageHeader, Pager, Select, Table, Td, Toggle, cx, toast, useApi } from "@/components/ui";

type Preset = { label: string; host: string; port: number; security: string; user?: string; spf: string[]; dkimSelector?: string; note: string };
type Cfg = {
  enabled: boolean; preset: string; host: string; port: number; security: "starttls" | "ssl" | "none"; user: string; pass: string;
  fromName: string; fromEmail: string; replyTo: string; returnPath: string; ehloName: string; allowSelfSigned: boolean;
  providerDkimSelector: string; sendingIp: string; dkim: { enabled: boolean; selector: string; privateKey: string; publicKey: string };
};
type Rec = { type: string; host: string; value: string; why: string };
type Check = { key: string; label: string; status: "ok" | "warn" | "error" | "info"; detail: string; found?: string; fix?: string; record?: Rec };

const TABS = [
  { k: "setup", label: "Mail server", icon: "dns" },
  { k: "check", label: "Deliverability check", icon: "verified" },
  { k: "log", label: "Delivery log", icon: "list_alt" },
] as const;

export default function EmailDelivery() {
  const [tab, setTab] = useState<(typeof TABS)[number]["k"]>("setup");
  return (
    <>
      <PageHeader title="Email Delivery" subtitle="Where invoices, welcome emails and VPS details are sent from — and what it takes for them to land in the inbox, not spam." />
      <div className="mb-5 flex gap-2 overflow-x-auto">
        {TABS.map((t) => (
          <button key={t.k} onClick={() => setTab(t.k)} className={cx("inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-4 py-2 text-sm font-bold", tab === t.k ? "bg-primary-dark text-white" : "bg-white text-slate-600 ring-1 ring-line")}>
            <Icon name={t.icon} className="text-[18px]" /> {t.label}
          </button>
        ))}
      </div>
      {tab === "setup" && <Setup onCheck={() => setTab("check")} />}
      {tab === "check" && <Deliverability onSetup={() => setTab("setup")} />}
      {tab === "log" && <DeliveryLog />}
    </>
  );
}

function Setup({ onCheck }: { onCheck: () => void }) {
  const { data, loading, reload } = useApi<{ config: Cfg; fromDb: boolean; presets: Record<string, Preset>; detectedIp: string }>("/admin/email/settings");
  const [c, setC] = useState<Cfg | null>(null);
  const [busy, setBusy] = useState("");
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [testTo, setTestTo] = useState("");
  const [dkimRec, setDkimRec] = useState<Rec | null>(null);
  useEffect(() => { if (data) setC(structuredClone(data.config)); }, [data]);
  if (loading || !c || !data) return <Loading />;
  const presets = data.presets;
  const preset = presets[c.preset] ?? presets.custom;
  const set = <K extends keyof Cfg>(k: K, v: Cfg[K]) => setC({ ...c, [k]: v });
  const own = c.preset === "local";

  function pickPreset(k: string) {
    const p = presets[k];
    setC({ ...c!, enabled: true, preset: k, host: p.host || c!.host, port: p.port, security: p.security as Cfg["security"], user: p.user ?? (presets[c!.preset]?.user ? "" : c!.user), providerDkimSelector: p.dkimSelector ?? "", allowSelfSigned: k === "local" });
    setResult(null);
  }
  const run = async (what: string, fn: () => Promise<any>) => {
    setBusy(what);
    setResult(null);
    try {
      const r = await fn();
      if (r && typeof r.ok === "boolean") setResult(r);
      return r;
    } catch (e: any) {
      setResult({ ok: false, message: e.message });
    } finally {
      setBusy("");
    }
  };
  const save = () => run("save", async () => {
    await api("/admin/email/settings", { method: "PUT", body: c });
    toast.success("Email settings saved");
    reload();
    return { ok: true, message: "Saved. Send a test email, then run the deliverability check." };
  });
  const genDkim = () => run("dkim", async () => {
    const r = await api("/admin/email/dkim/generate", { body: { selector: c!.dkim.selector || "crapplet" } });
    setDkimRec({ type: "TXT", host: r.record.host, value: r.record.value, why: `Add this to the DNS of ${r.record.domain || "your domain"}, wait for it to go live, then turn on signing and Save.` });
    setC({ ...c!, dkim: { ...r.config.dkim } });
    return { ok: true, message: "New DKIM key created. Add the DNS record below before turning signing on." };
  });

  return (
    <div className="grid gap-5 xl:grid-cols-[1fr_360px]">
      <div className="space-y-5">
        {!data.fromDb && (
          <Alert tone={c.host ? "info" : "warn"}>
            {c.host ? <>Using the SMTP settings from the server&apos;s .env file. Save this page once to manage them here instead.</> : <><b>No mail server is set up</b>, so emails are only written to the delivery log and never reach customers. Choose your provider below.</>}
          </Alert>
        )}
        <Card title="1 · Mail provider">
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {Object.entries(presets).map(([k, p]) => (
              <button key={k} type="button" onClick={() => pickPreset(k)} className={cx("rounded-xl border px-3.5 py-2.5 text-left text-sm font-bold transition", c.preset === k ? "border-primary bg-primary-tint text-primary-dark ring-2 ring-primary/20" : "border-line bg-white text-slate-700 hover:border-primary/40")}>
                {p.label}
              </button>
            ))}
          </div>
          <Alert className="mt-4" tone={own ? "warn" : "info"}>{preset.note}</Alert>
        </Card>

        <Card title="2 · SMTP login">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="SMTP host"><Input value={c.host} onChange={(e) => set("host", e.target.value)} placeholder="smtp.zoho.in" /></Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Port"><Input type="number" value={c.port} onChange={(e) => set("port", Number(e.target.value))} /></Field>
              <Field label="Encryption">
                <Select value={c.security} onChange={(e) => { const s = e.target.value as Cfg["security"]; setC({ ...c, security: s, port: s === "ssl" ? 465 : s === "starttls" && c.port === 465 ? 587 : c.port }); }}>
                  <option value="starttls">STARTTLS</option>
                  <option value="ssl">SSL/TLS</option>
                  <option value="none">None</option>
                </Select>
              </Field>
            </div>
            <Field label="Username"><Input value={c.user} onChange={(e) => set("user", e.target.value)} autoComplete="off" placeholder="billing@crapplet.co.in" /></Field>
            <Field label="Password / API key" hint={c.pass ? "Leave as is to keep the saved password" : undefined}><Input type="password" value={c.pass} onChange={(e) => set("pass", e.target.value)} autoComplete="new-password" /></Field>
          </div>
        </Card>

        <Card title="3 · Sender">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="From name" hint="Shown in the inbox — use your brand"><Input value={c.fromName} onChange={(e) => set("fromName", e.target.value)} placeholder="Crapplet Cloud" /></Field>
            <Field label="From email" hint="Must be on your own domain and allowed by your provider"><Input value={c.fromEmail} onChange={(e) => set("fromEmail", e.target.value)} placeholder="billing@crapplet.co.in" /></Field>
            <Field label="Reply-to (optional)" hint="Where customer replies go, e.g. your support desk"><Input value={c.replyTo} onChange={(e) => set("replyTo", e.target.value)} placeholder="support@crapplet.co.in" /></Field>
            <Field label="Bounce address (optional)" hint="Envelope sender; leave empty to use the From email"><Input value={c.returnPath} onChange={(e) => set("returnPath", e.target.value)} /></Field>
          </div>
        </Card>

        <Card title="4 · Authentication (DKIM)">
          {!own ? (
            <>
              <p className="mb-4 text-sm text-slate-600">{preset.label === presets.custom.label ? "Your provider" : preset.label} signs your emails with DKIM once you add its DKIM record to your domain&apos;s DNS. Enter its selector so the deliverability check can confirm the record is there.</p>
              <Field label="Provider DKIM selector" hint={`The part before ._domainkey in the record your provider shows${preset.dkimSelector ? ` (usually “${preset.dkimSelector}”)` : ""}`} className="max-w-sm">
                <Input value={c.providerDkimSelector} onChange={(e) => set("providerDkimSelector", e.target.value)} placeholder={preset.dkimSelector ?? "e.g. zmail"} />
              </Field>
            </>
          ) : (
            <Alert tone="warn" className="mb-4">Mail sent straight from this server must be signed by the panel, or Gmail and Outlook will send most of it to spam.</Alert>
          )}
          <details className="mt-4 rounded-xl border border-line p-4" open={own || c.dkim.enabled}>
            <summary className="cursor-pointer text-sm font-bold text-slate-700">Sign emails in the panel {own ? "" : "(only needed if your provider doesn't sign)"}</summary>
            <div className="mt-4 grid gap-4 sm:grid-cols-[180px_1fr] sm:items-end">
              <Field label="Selector"><Input value={c.dkim.selector} onChange={(e) => set("dkim", { ...c.dkim, selector: e.target.value })} /></Field>
              <div className="flex flex-wrap items-center gap-3">
                <Button variant="outline" icon="key" loading={busy === "dkim"} onClick={genDkim}>{c.dkim.publicKey ? "Create a new key" : "Create DKIM key"}</Button>
                <Toggle checked={c.dkim.enabled} onChange={(v) => { if (v && !c.dkim.publicKey) return toast.error("Create a key first"); set("dkim", { ...c.dkim, enabled: v }); }} label="Sign outgoing emails" />
              </div>
            </div>
            {(dkimRec || c.dkim.publicKey) && <RecordBox rec={dkimRec ?? { type: "TXT", host: `${c.dkim.selector}._domainkey`, value: `v=DKIM1; k=rsa; p=${c.dkim.publicKey}`, why: "Must be live in DNS before signing is turned on" }} />}
          </details>
          {own && (
            <div className="mt-4 grid gap-4 sm:grid-cols-2">
              <Field label="Sending IP" hint={data.detectedIp ? `Detected: ${data.detectedIp}` : "Public IPv4 of this server"}><Input value={c.sendingIp} onChange={(e) => set("sendingIp", e.target.value)} placeholder={data.detectedIp} /></Field>
              <Field label="HELO name" hint="Should match the IP's reverse DNS, e.g. mail.crapplet.co.in"><Input value={c.ehloName} onChange={(e) => set("ehloName", e.target.value)} /></Field>
            </div>
          )}
        </Card>

        <div className="flex flex-wrap items-center gap-3">
          <Button icon="save" loading={busy === "save"} onClick={save}>Save settings</Button>
          <Toggle checked={c.enabled} onChange={(v) => set("enabled", v)} label={c.enabled ? "Sending is on" : "Sending is off (log only)"} />
        </div>
        {result && <Alert tone={result.ok ? "success" : "error"}>{result.message}</Alert>}
      </div>

      <div className="space-y-5">
        <Card title="Test">
          <p className="mb-3 text-sm text-slate-600">Tests use what&apos;s on screen, even before you save.</p>
          <Button variant="outline" icon="lan" className="w-full" loading={busy === "conn"} onClick={() => run("conn", () => api("/admin/email/test-connection", { body: { config: c } }))}>Test connection &amp; login</Button>
          <div className="mt-4 flex gap-2">
            <Input value={testTo} onChange={(e) => setTestTo(e.target.value)} placeholder="you@gmail.com" type="email" />
            <Button icon="send" loading={busy === "send"} onClick={() => run("send", () => api("/admin/email/test-send", { body: { to: testTo, config: c } }))}>Send</Button>
          </div>
          <p className="mt-3 text-xs text-mute">Send to a Gmail and an Outlook address and check which folder it lands in. For a full score, send to the address shown on mail-tester.com.</p>
        </Card>
        <Card title="Inbox checklist">
          <ol className="list-decimal space-y-2 pl-5 text-sm text-slate-700">
            <li>Send from your own domain, never a Gmail/Yahoo address.</li>
            <li>Publish <b>SPF</b>, <b>DKIM</b> and <b>DMARC</b> records.</li>
            <li>Use a mail provider rather than this VPS&apos;s IP.</li>
            <li>Keep emails transactional — no bulk marketing from billing@.</li>
            <li>Watch the delivery log for bounces.</li>
          </ol>
          <Button variant="secondary" icon="verified" className="mt-4 w-full" onClick={onCheck}>Run deliverability check</Button>
        </Card>
      </div>
    </div>
  );
}

function RecordBox({ rec }: { rec: Rec }) {
  return (
    <div className="mt-3 overflow-hidden rounded-xl border border-[#e9d5ff] bg-[#fcfaff] text-sm">
      <div className="grid grid-cols-[70px_1fr] border-b border-[#f0e6ff]">
        <span className="px-3 py-2 text-xs font-bold uppercase text-mute">Type</span><span className="px-3 py-2 font-mono font-bold">{rec.type}</span>
      </div>
      <div className="grid grid-cols-[70px_1fr_auto] items-center border-b border-[#f0e6ff]">
        <span className="px-3 py-2 text-xs font-bold uppercase text-mute">Host</span><span className="break-all px-3 py-2 font-mono">{rec.host}</span><span className="pr-2"><Copy text={rec.host} /></span>
      </div>
      <div className="grid grid-cols-[70px_1fr_auto] items-start">
        <span className="px-3 py-2 text-xs font-bold uppercase text-mute">Value</span><span className="min-w-0 break-all px-3 py-2 font-mono text-[12.5px]">{rec.value}</span><span className="pr-2 pt-1"><Copy text={rec.value} /></span>
      </div>
      {rec.why && <div className="border-t border-[#f0e6ff] px-3 py-2 text-xs text-mute">{rec.why}</div>}
    </div>
  );
}

const TONE = {
  ok: { icon: "check_circle", cls: "text-emerald-600" },
  warn: { icon: "warning", cls: "text-amber-500" },
  error: { icon: "cancel", cls: "text-rose-600" },
  info: { icon: "info", cls: "text-primary-dark" },
};

function Deliverability({ onSetup }: { onSetup: () => void }) {
  const { data, loading, reload, error } = useApi<{ domain: string; checks: Check[]; ip: string; summary: { errors: number; warns: number; ok: number; verdict: string } }>("/admin/email/check");
  if (loading && !data) return <Loading label="Looking up your DNS records…" />;
  if (error || !data) return <Alert tone="error">{error}</Alert>;
  const s = data.summary;
  return (
    <div className="space-y-5">
      <div className={cx("flex flex-wrap items-center justify-between gap-4 rounded-2xl border p-5", s.errors ? "border-rose-200 bg-rose-50" : s.warns ? "border-amber-200 bg-amber-50" : "border-emerald-200 bg-emerald-50")}>
        <div className="flex items-center gap-3">
          <Icon name={s.errors ? "mark_email_unread" : s.warns ? "mark_email_read" : "verified"} className={cx("text-[36px]", s.errors ? "text-rose-600" : s.warns ? "text-amber-500" : "text-emerald-600")} />
          <div>
            <div className="text-lg font-extrabold text-ink">{s.verdict}</div>
            <div className="text-sm text-slate-600">{data.domain ? <>Domain <b>{data.domain}</b> · </> : null}{s.ok} passed · {s.warns} warnings · {s.errors} problems</div>
          </div>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" icon="tune" onClick={onSetup}>Mail server</Button>
          <Button icon="refresh" loading={loading} onClick={reload}>Re-check</Button>
        </div>
      </div>
      <Card pad={false}>
        <ul className="divide-y divide-[#f3effb]">
          {data.checks.map((c) => (
            <li key={c.key} className="flex gap-3 p-4 sm:p-5">
              <Icon name={TONE[c.status].icon} fill className={cx("mt-0.5 text-[22px]", TONE[c.status].cls)} />
              <div className="min-w-0 flex-1">
                <div className="font-extrabold text-ink">{c.label}</div>
                <p className="mt-0.5 text-sm text-slate-600">{c.detail}</p>
                {c.found && <pre className="mt-2 whitespace-pre-wrap break-all rounded-lg bg-slate-50 px-3 py-2 font-mono text-[12px] text-slate-600">{c.found}</pre>}
                {c.fix && <p className="mt-2 text-sm font-semibold text-slate-800">{c.fix}</p>}
                {c.record && <RecordBox rec={c.record} />}
              </div>
            </li>
          ))}
        </ul>
      </Card>
      <Alert>DNS changes can take from a few minutes up to a few hours to show here. Add records in the DNS panel of wherever your domain&apos;s nameservers are (Cloudflare, GoDaddy, Hostinger…). In &quot;Host&quot;, <b>@</b> means the domain itself.</Alert>
    </div>
  );
}

function DeliveryLog() {
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState("");
  const [q, setQ] = useState("");
  const [query, setQuery] = useState("");
  const { data, loading, reload } = useApi<any>(`/admin/email/log?page=${page}&status=${status}&q=${encodeURIComponent(query)}`);
  const [open, setOpen] = useState<string | null>(null);
  const stats = data?.last7Days ?? {};
  async function resend(id: string) {
    const r = await api(`/admin/email/log/${id}/resend`, { body: {} }).catch((e) => ({ ok: false, message: e.message }));
    r.ok ? toast.success(r.message) : toast.error(r.message);
    reload();
  }
  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
        {["SENT", "FAILED", "BOUNCED", "SUPPRESSED", "LOGGED"].map((k) => (
          <button key={k} onClick={() => { setStatus(status === k ? "" : k); setPage(1); }} className={cx("rounded-2xl border bg-white p-4 text-left transition", status === k ? "border-primary ring-2 ring-primary/20" : "border-line hover:border-primary/40")}>
            <div className="text-2xl font-extrabold text-ink">{stats[k] ?? 0}</div>
            <div className="mt-1"><Badge status={k} /></div>
            <div className="mt-1 text-[11px] text-mute">last 7 days</div>
          </button>
        ))}
      </div>
      <Card pad={false} title="Delivery log" action={
        <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); setQuery(q); setPage(1); }}>
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search email or subject" className="h-9 w-56" />
          <Button size="sm" variant="outline" icon="search">Search</Button>
        </form>
      }>
        {loading && !data ? <Loading /> : (
          <Table head={["When", "To", "Subject", "Status", ""]} empty={!data?.items?.length ? <Empty icon="outgoing_mail" title="No emails yet" /> : undefined}>
            {data?.items?.map((r: any) => (
              <Fragment key={r.id}>
                <tr className="cursor-pointer hover:bg-[#fcfaff]" onClick={() => setOpen(open === r.id ? null : r.id)}>
                  <Td className="whitespace-nowrap text-xs text-mute">{new Date(r.createdAt).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" })}</Td>
                  <Td className="font-semibold">{r.to}</Td>
                  <Td className="max-w-[320px] truncate">{r.subject}<div className="text-[11px] text-mute">{r.template}</div></Td>
                  <Td><Badge status={r.status} /></Td>
                  <Td className="text-right">
                    {r.canResend && r.status !== "SENT" && <Button size="sm" variant="outline" icon="send" onClick={(e) => { e.stopPropagation(); resend(r.id); }}>Resend</Button>}
                  </Td>
                </tr>
                {open === r.id && (
                  <tr>
                    <td colSpan={5} className="bg-[#fcfaff] px-4 py-3 text-xs">
                      {r.error && <div className="mb-1 font-semibold text-rose-700">{r.error}</div>}
                      {r.response && <div className="font-mono text-slate-600">Server reply: {r.response}</div>}
                      {r.messageId && <div className="font-mono text-slate-500">Message-ID: {r.messageId}</div>}
                      {!r.error && !r.response && <div className="text-mute">No server reply recorded.</div>}
                    </td>
                  </tr>
                )}
              </Fragment>
            ))}
          </Table>
        )}
        {data && <Pager page={data.page} pageSize={data.pageSize} total={data.total} onPage={setPage} />}
      </Card>
    </div>
  );
}
