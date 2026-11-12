"use client";
/** Email campaign editor (drafts & scheduled) and report (sending & sent). */
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { api } from "@/lib/api";
import { useSession } from "@/lib/session";
import { CTA, VARIABLES } from "@/lib/campaign-templates";
import { Alert, Badge, Button, Card, Field, Icon, Input, Modal, PageHeader, Pager, Select, Toggle, cx, toast, useApi } from "@/components/ui";
import { Ago, Avatar, SearchBox, StatusTabs, initialsOf, type Tab } from "@/components/admin/list-kit";

type Audience = { clients: "all" | "with_active" | "without_active"; productTypes: string[]; productIds: string[]; country: "all" | "IN" | "intl"; includeInactive: boolean; signedUpWithinDays: number | null; userIds: string[] };
type Form = { name: string; kind: "OFFER" | "INFO"; subject: string; preheader: string; body: string; audience: Audience; perMinute: number };

const AUD0: Audience = { clients: "all", productTypes: [], productIds: [], country: "all", includeInactive: false, signedUpWithinDays: null, userIds: [] };
const TYPE_LABEL: Record<string, string> = { VPS: "VPS", VDS: "VDS", DEDICATED: "Dedicated", SHARED_HOSTING: "Shared hosting", RESELLER_HOSTING: "Reseller hosting", WORDPRESS_HOSTING: "WordPress hosting", FOREX_VPS: "Forex VPS", GPU: "GPU", TALLY: "Tally on cloud", COLOCATION: "Colocation", EMAIL: "Email", SSL: "SSL", DOMAIN: "Domains", WINDOWS_VPS: "Windows VPS" };
const typeLabel = (t: string) => TYPE_LABEL[t] ?? t.replace(/_/g, " ").toLowerCase().replace(/^./, (c) => c.toUpperCase());
const fmt = (n: number) => n.toLocaleString("en-IN");
const ist = (d: string | Date) => new Date(d).toLocaleString("en-IN", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "Asia/Kolkata" });

function useDebounced<T>(value: T, ms: number) {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

// ───────────────────────────── editor ─────────────────────────────

export function CampaignEditor({ initial, onChanged }: { initial: any; onChanged: () => void }) {
  const router = useRouter();
  const [f, setF] = useState<Form>(() => ({
    name: initial.name,
    kind: initial.kind,
    subject: initial.subject === "(no subject yet)" ? "" : initial.subject,
    preheader: initial.preheader ?? "",
    body: initial.body,
    audience: { ...AUD0, ...(initial.audience ?? {}) },
    perMinute: initial.perMinute ?? 60,
  }));
  const set = <K extends keyof Form>(k: K, v: Form[K]) => setF((x) => ({ ...x, [k]: v }));
  const [save, setSave] = useState<"saved" | "saving" | "dirty" | "error">("saved");
  const first = useRef(true);
  const latest = useRef(f);
  latest.current = f;

  const persist = useCallback(async () => {
    const x = latest.current;
    setSave("saving");
    try {
      await api(`/admin/campaigns/${initial.id}`, { method: "PUT", body: { ...x, subject: x.subject || "(no subject yet)", preheader: x.preheader || null } });
      setSave("saved");
      return true;
    } catch (e: any) {
      setSave("error");
      toast.error(e.message);
      return false;
    }
  }, [initial.id]);

  // autosave
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    setSave("dirty");
    const t = setTimeout(persist, 1200);
    return () => clearTimeout(t);
  }, [f, persist]);

  // live preview
  const previewIn = useDebounced({ kind: f.kind, subject: f.subject, preheader: f.preheader, body: f.body }, 500);
  const [preview, setPreview] = useState<{ subject: string; html: string } | null>(null);
  useEffect(() => {
    api<{ subject: string; html: string }>("/admin/campaigns/preview", { body: { ...previewIn, preheader: previewIn.preheader || null } }).then(setPreview).catch(() => undefined);
  }, [previewIn]);

  // audience size
  const audIn = useDebounced({ kind: f.kind, audience: f.audience }, 400);
  const [aud, setAud] = useState<{ count: number; optedOut: number; sample: any[] } | null>(null);
  useEffect(() => {
    api("/admin/campaigns/audience", { body: audIn }).then(setAud).catch(() => setAud(null));
  }, [audIn]);

  const [modal, setModal] = useState<null | "test" | "schedule" | "send" | "delete">(null);
  const scheduled = initial.status === "SCHEDULED";
  const ready = !!f.subject.trim() && f.body.replace(/<[^>]+>/g, "").trim().length > 0 && (aud?.count ?? 0) > 0;

  async function act(path: string, body?: unknown, ok?: string) {
    if (!(await persist())) return;
    try {
      await api(`/admin/campaigns/${initial.id}/${path}`, { body: body ?? {} });
      if (ok) toast.success(ok);
      setModal(null);
      onChanged();
    } catch (e: any) {
      toast.error(e.message);
    }
  }

  return (
    <>
      <PageHeader
        back="/admin/campaigns"
        icon={f.kind === "OFFER" ? "sell" : "info"}
        title={f.name || "Untitled campaign"}
        subtitle={scheduled ? <>Scheduled to send on <b>{ist(initial.scheduledAt)}</b>. You can still make changes.</> : "Draft — changes are saved automatically."}
        badge={<Badge status={initial.status} />}
        meta={<SaveState s={save} />}
        actions={
          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" icon="send" onClick={() => setModal("test")}>Send test</Button>
            {scheduled ? (
              <Button variant="secondary" icon="event_busy" onClick={() => act("unschedule", {}, "Back to draft")}>Unschedule</Button>
            ) : (
              <Button variant="secondary" icon="schedule_send" disabled={!ready} onClick={() => setModal("schedule")}>Schedule</Button>
            )}
            <Button icon="rocket_launch" disabled={!ready} onClick={() => setModal("send")}>Send now</Button>
          </div>
        }
      />

      <div className="grid items-start gap-5 xl:grid-cols-[minmax(0,1fr)_minmax(0,460px)]">
        <div className="min-w-0 space-y-5">
          <Card title={<Title icon="tune">Campaign</Title>}>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Name" hint="Only you see this">
                <Input value={f.name} onChange={(e) => set("name", e.target.value)} maxLength={120} />
              </Field>
              <Field label="Type">
                <div className="grid grid-cols-2 gap-1 rounded-xl bg-slate-100 p-1">
                  {(["OFFER", "INFO"] as const).map((k) => (
                    <button key={k} type="button" onClick={() => set("kind", k)} className={cx("flex h-9 items-center justify-center gap-1.5 rounded-lg text-[13px] font-bold transition", f.kind === k ? "bg-white text-ink shadow-sm" : "text-slate-500 hover:text-ink")}>
                      <Icon name={k === "OFFER" ? "sell" : "info"} className="text-[17px]" />
                      {k === "OFFER" ? "Offer / news" : "Information"}
                    </button>
                  ))}
                </div>
              </Field>
            </div>
            <p className="mt-2 text-[12.5px] leading-relaxed text-slate-500">
              {f.kind === "OFFER" ? (
                <><b className="text-slate-700">Offers</b> go only to customers who accept offers, and include an unsubscribe link.</>
              ) : (
                <><b className="text-slate-700">Information</b> is for service matters — maintenance, policy or account changes — and reaches every customer you choose, including those who turned offers off. Don&apos;t use it for promotions.</>
              )}
            </p>
          </Card>

          <Card title={<Title icon="mail">Email</Title>}>
            <div className="space-y-4">
              <Field label="Subject line" hint={<span className={f.subject.length > 70 ? "text-amber-600" : ""}>{f.subject.length}/70 characters show in most inboxes</span>}>
                <VarInput value={f.subject} onChange={(v) => set("subject", v)} placeholder="e.g. {{firstName}}, 25% off your next server" />
              </Field>
              <Field label="Preview text" hint="The grey line next to the subject in the inbox. Leave empty to use the first line of the email.">
                <VarInput value={f.preheader} onChange={(v) => set("preheader", v)} placeholder="e.g. This week only — use code FESTIVE25" />
              </Field>
              <div>
                <div className="mb-1.5 text-[13px] font-bold text-ink">Message</div>
                <RichEditor value={f.body} onChange={(v) => set("body", v)} />
              </div>
            </div>
          </Card>

          <Card title={<Title icon="groups">Audience</Title>}>
            <AudienceBuilder kind={f.kind} value={f.audience} onChange={(a) => set("audience", a)} />
            <AudienceSize aud={aud} kind={f.kind} />
          </Card>

          <Card title={<Title icon="speed">Sending speed</Title>}>
            <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
              <Field label="Emails per minute" className="sm:w-56">
                <Select value={String(f.perMinute)} onChange={(e) => set("perMinute", Number(e.target.value))}>
                  {[10, 30, 60, 120, 300, 600].map((n) => <option key={n} value={n}>{n} per minute</option>)}
                </Select>
              </Field>
              <p className="pb-2 text-[12.5px] leading-relaxed text-slate-500">
                {aud?.count ? <>About <b className="text-slate-700">{Math.max(1, Math.ceil(aud.count / f.perMinute))} min</b> for {fmt(aud.count)} emails. </> : null}
                Slower is gentler on your mail server&apos;s limits (Gmail/Workspace ≈ 2,000 a day, Zoho and others vary).
              </p>
            </div>
          </Card>

          <div className="flex justify-end">
            <Button variant="ghost" icon="delete" className="text-rose-600 hover:!bg-rose-50 hover:!text-rose-700" onClick={() => setModal("delete")} disabled={scheduled}>Delete draft</Button>
          </div>
        </div>

        <div className="min-w-0">
          <div className="xl:sticky xl:top-20">
            <PreviewPane subject={preview?.subject ?? f.subject} preheader={f.preheader} html={preview?.html} />
          </div>
        </div>
      </div>

      <TestModal open={modal === "test"} onClose={() => setModal(null)} id={initial.id} persist={persist} />
      <ScheduleModal open={modal === "schedule"} onClose={() => setModal(null)} count={aud?.count ?? 0} onSchedule={(at) => act("send", { scheduledAt: at }, `Scheduled for ${ist(at)}`)} />
      <Modal open={modal === "send"} onClose={() => setModal(null)} title="Send this campaign now?">
        <div className="space-y-4">
          <div className="flex items-center gap-3 rounded-xl bg-[#faf7ff] p-4">
            <div className="grid h-12 w-12 place-items-center rounded-xl bg-primary text-white"><Icon name="rocket_launch" className="text-[24px]" /></div>
            <div>
              <div className="text-2xl font-extrabold tabular-nums text-ink">{fmt(aud?.count ?? 0)}</div>
              <div className="text-[13px] text-slate-500">customers will receive “{f.subject}”</div>
            </div>
          </div>
          <p className="text-[13px] text-slate-600">Sending starts right away at {f.perMinute} per minute. You can pause or cancel while it&apos;s going out, but emails already sent can&apos;t be recalled.</p>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setModal(null)}>Cancel</Button>
            <SendButton onClick={() => act("send", {}, "Sending started")} label={`Send to ${fmt(aud?.count ?? 0)}`} />
          </div>
        </div>
      </Modal>
      <Modal open={modal === "delete"} onClose={() => setModal(null)} title="Delete this draft?">
        <p className="text-[13.5px] text-slate-600">“{f.name}” will be removed. This can&apos;t be undone.</p>
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="ghost" onClick={() => setModal(null)}>Keep it</Button>
          <Button variant="danger" icon="delete" onClick={async () => { try { await api(`/admin/campaigns/${initial.id}`, { method: "DELETE" }); toast.success("Draft deleted"); router.push("/admin/campaigns"); } catch (e: any) { toast.error(e.message); } }}>Delete</Button>
        </div>
      </Modal>
    </>
  );
}

function SendButton({ onClick, label }: { onClick: () => Promise<void>; label: string }) {
  const [busy, setBusy] = useState(false);
  return <Button icon="send" loading={busy} onClick={async () => { setBusy(true); try { await onClick(); } finally { setBusy(false); } }}>{label}</Button>;
}

const Title = ({ icon, children }: { icon: string; children: ReactNode }) => (
  <span className="inline-flex items-center gap-2"><Icon name={icon} className="text-[20px] text-primary" />{children}</span>
);

function SaveState({ s }: { s: string }) {
  const m: Record<string, [string, string, string]> = { saved: ["cloud_done", "Saved", "text-emerald-200"], saving: ["sync", "Saving…", "text-violet-100"], dirty: ["edit", "Editing…", "text-violet-100"], error: ["error", "Not saved", "text-rose-200"] };
  const [i, t, c] = m[s];
  return <span className={cx("inline-flex items-center gap-1 text-[12.5px] font-bold", c)}><Icon name={i} className={cx("text-[16px]", s === "saving" && "animate-spin")} />{t}</span>;
}

/** Text input with an "insert variable" menu. */
function VarInput({ value, onChange, placeholder }: { value: string; onChange: (v: string) => void; placeholder?: string }) {
  const ref = useRef<HTMLInputElement>(null);
  const insert = (v: string) => {
    const el = ref.current;
    const at = el?.selectionStart ?? value.length;
    const end = el?.selectionEnd ?? at;
    onChange(value.slice(0, at) + v + value.slice(end));
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(at + v.length, at + v.length);
    });
  };
  return (
    <div className="flex gap-2">
      <input ref={ref} value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} maxLength={200} className="h-11 min-w-0 flex-1 rounded-xl border border-[#e6dcf8] bg-white px-3.5 text-[14.5px] text-ink outline-none transition placeholder:text-slate-400 focus:border-primary focus:ring-4 focus:ring-primary/15" />
      <VarMenu onPick={insert} />
    </div>
  );
}

function VarMenu({ onPick, compact }: { onPick: (v: string) => void; compact?: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="relative">
      <button type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => setOpen((o) => !o)} title="Insert a personal detail" className={cx("inline-flex items-center gap-1 rounded-xl border border-[#e6dcf8] bg-white px-3 text-[13px] font-bold text-primary-dark hover:border-primary", compact ? "h-8 rounded-lg px-2" : "h-11")}>
        <Icon name="data_object" className="text-[18px]" />{!compact && <span className="hidden sm:inline">Personalise</span>}
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute right-0 z-50 mt-1 w-60 overflow-hidden rounded-xl border border-line bg-white py-1 shadow-xl">
            {VARIABLES.map(([v, label]) => (
              <button key={v} type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => { onPick(v); setOpen(false); }} className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-[13px] hover:bg-primary-tint">
                <span className="font-semibold text-ink">{label}</span>
                <code className="text-[11px] text-slate-400">{v}</code>
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

// ───────────────────────────── rich text editor ─────────────────────────────

type InsertKind = "link" | "button" | "image";

function RichEditor({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const [mode, setMode] = useState<"visual" | "html">("visual");
  const ref = useRef<HTMLDivElement>(null);
  const range = useRef<Range | null>(null);
  const [ins, setIns] = useState<{ kind: InsertKind; text: string; url: string } | null>(null);
  const [, force] = useState(0);

  // load content into the editable area only when switching into it (never while typing — that moves the cursor)
  useEffect(() => {
    if (mode === "visual" && ref.current && ref.current.innerHTML !== value) ref.current.innerHTML = value;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode]);

  const emit = () => ref.current && onChange(ref.current.innerHTML);
  const keep = () => {
    const s = window.getSelection();
    if (s && s.rangeCount && ref.current?.contains(s.anchorNode)) range.current = s.getRangeAt(0).cloneRange();
  };
  const restore = () => {
    ref.current?.focus();
    const s = window.getSelection();
    if (range.current && s) {
      s.removeAllRanges();
      s.addRange(range.current);
    }
  };
  const exec = (cmd: string, arg?: string) => {
    restore();
    document.execCommand(cmd, false, arg);
    emit();
    keep();
    force((n) => n + 1);
  };
  const on = (cmd: string) => {
    try {
      return document.queryCommandState(cmd);
    } catch {
      return false;
    }
  };
  const openInsert = (kind: InsertKind) => {
    keep();
    const sel = window.getSelection()?.toString() ?? "";
    setIns({ kind, text: kind === "image" ? "" : sel || (kind === "button" ? "Order now" : ""), url: kind === "image" ? "https://" : "{{appUrl}}/order" });
  };
  const doInsert = () => {
    if (!ins) return;
    const url = ins.url.trim();
    if (!url) return;
    const safe = url.replace(/"/g, "&quot;");
    const text = (ins.text.trim() || url).replace(/</g, "&lt;");
    if (ins.kind === "link") exec("insertHTML", `<a href="${safe}" style="color:#7c3aed">${text}</a>`);
    if (ins.kind === "button") exec("insertHTML", CTA(text, safe));
    if (ins.kind === "image") exec("insertHTML", `<p><img src="${safe}" alt="${(ins.text || "").replace(/"/g, "&quot;")}" style="max-width:100%;height:auto;border-radius:12px" /></p>`);
    setIns(null);
  };

  const Btn = ({ icon, title, active, onClick }: { icon: string; title: string; active?: boolean; onClick: () => void }) => (
    <button type="button" title={title} aria-label={title} onMouseDown={(e) => { e.preventDefault(); onClick(); }} className={cx("grid h-8 w-8 shrink-0 place-items-center rounded-lg transition", active ? "bg-primary-tint text-primary-dark" : "text-slate-600 hover:bg-slate-100 hover:text-ink")}>
      <Icon name={icon} className="text-[19px]" />
    </button>
  );
  const Sep = () => <span className="mx-0.5 h-5 w-px shrink-0 bg-slate-200" />;

  return (
    <div className="overflow-hidden rounded-xl border border-[#e6dcf8] bg-white focus-within:border-primary focus-within:ring-4 focus-within:ring-primary/15">
      <div className="flex flex-wrap items-center gap-0.5 border-b border-line bg-[#fbf9ff] px-1.5 py-1">
        {mode === "visual" ? (
          <>
            <Btn icon="format_bold" title="Bold" active={on("bold")} onClick={() => exec("bold")} />
            <Btn icon="format_italic" title="Italic" active={on("italic")} onClick={() => exec("italic")} />
            <Btn icon="format_underlined" title="Underline" active={on("underline")} onClick={() => exec("underline")} />
            <Sep />
            <Btn icon="title" title="Heading" onClick={() => exec("formatBlock", "<h2>")} />
            <Btn icon="notes" title="Normal text" onClick={() => exec("formatBlock", "<p>")} />
            <Btn icon="format_list_bulleted" title="Bulleted list" active={on("insertUnorderedList")} onClick={() => exec("insertUnorderedList")} />
            <Btn icon="format_list_numbered" title="Numbered list" active={on("insertOrderedList")} onClick={() => exec("insertOrderedList")} />
            <Btn icon="format_align_center" title="Centre" active={on("justifyCenter")} onClick={() => exec(on("justifyCenter") ? "justifyLeft" : "justifyCenter")} />
            <Sep />
            <Btn icon="link" title="Link" onClick={() => openInsert("link")} />
            <Btn icon="smart_button" title="Button" onClick={() => openInsert("button")} />
            <Btn icon="image" title="Image (from a web address)" onClick={() => openInsert("image")} />
            <Btn icon="horizontal_rule" title="Divider" onClick={() => exec("insertHTML", '<hr style="border:0;border-top:1px solid #ece4fb;margin:20px 0" />')} />
            <Btn icon="format_clear" title="Clear formatting" onClick={() => exec("removeFormat")} />
            <Sep />
            <VarMenu compact onPick={(v) => exec("insertText", v)} />
          </>
        ) : (
          <span className="px-2 text-[12px] font-semibold text-slate-500">HTML — for pasting a design made elsewhere</span>
        )}
        <div className="ml-auto flex rounded-lg bg-slate-100 p-0.5">
          {(["visual", "html"] as const).map((m) => (
            <button key={m} type="button" onClick={() => { if (mode === "visual") emit(); setMode(m); }} className={cx("rounded-md px-2.5 py-1 text-[12px] font-bold", mode === m ? "bg-white text-ink shadow-sm" : "text-slate-500")}>{m === "visual" ? "Visual" : "HTML"}</button>
          ))}
        </div>
      </div>
      {ins && (
        <div className="flex flex-col gap-2 border-b border-line bg-[#faf7ff] p-2.5 sm:flex-row sm:items-center">
          <Icon name={ins.kind === "button" ? "smart_button" : ins.kind === "image" ? "image" : "link"} className="hidden text-[20px] text-primary sm:block" />
          <input autoFocus value={ins.kind === "image" ? ins.url : ins.text} onChange={(e) => setIns({ ...ins, ...(ins.kind === "image" ? { url: e.target.value } : { text: e.target.value }) })} placeholder={ins.kind === "image" ? "Image address (https://…)" : ins.kind === "button" ? "Button text" : "Link text"} className="h-9 min-w-0 flex-1 rounded-lg border border-[#e6dcf8] px-3 text-[13.5px] outline-none focus:border-primary" onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), doInsert())} />
          <input value={ins.kind === "image" ? ins.text : ins.url} onChange={(e) => setIns({ ...ins, ...(ins.kind === "image" ? { text: e.target.value } : { url: e.target.value }) })} placeholder={ins.kind === "image" ? "Description (for screen readers)" : "Web address"} className="h-9 min-w-0 flex-1 rounded-lg border border-[#e6dcf8] px-3 text-[13.5px] outline-none focus:border-primary" onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), doInsert())} />
          <div className="flex gap-1.5">
            <Button size="sm" onClick={doInsert}>Insert</Button>
            <Button size="sm" variant="ghost" onClick={() => setIns(null)}>Cancel</Button>
          </div>
        </div>
      )}
      {mode === "visual" ? (
        <div
          ref={ref}
          contentEditable
          suppressContentEditableWarning
          onInput={emit}
          onKeyUp={keep}
          onMouseUp={() => { keep(); force((n) => n + 1); }}
          onBlur={keep}
          className="min-h-[300px] px-5 py-4 text-[15px] leading-relaxed text-ink outline-none [&_a]:text-primary-dark [&_h2]:mb-2 [&_h2]:mt-1 [&_h2]:text-[22px] [&_h2]:font-extrabold [&_img]:max-w-full [&_ol]:list-decimal [&_ol]:pl-6 [&_p]:my-2.5 [&_ul]:list-disc [&_ul]:pl-6"
        />
      ) : (
        <textarea value={value} onChange={(e) => onChange(e.target.value)} spellCheck={false} className="block min-h-[300px] w-full resize-y px-4 py-3 font-mono text-[12.5px] leading-relaxed text-ink outline-none" />
      )}
    </div>
  );
}

// ───────────────────────────── preview ─────────────────────────────

function PreviewPane({ subject, preheader, html, title = "Preview" }: { subject: string; preheader?: string; html?: string; title?: string }) {
  const { me } = useSession();
  const [device, setDevice] = useState<"desktop" | "mobile">("desktop");
  return (
    <Card
      pad={false}
      title={<Title icon="visibility">{title}</Title>}
      action={
        <div className="flex rounded-lg bg-slate-100 p-0.5">
          {(["desktop", "mobile"] as const).map((d) => (
            <button key={d} type="button" onClick={() => setDevice(d)} title={d === "desktop" ? "Desktop" : "Phone"} className={cx("grid h-7 w-9 place-items-center rounded-md", device === d ? "bg-white text-primary-dark shadow-sm" : "text-slate-500")}>
              <Icon name={d === "desktop" ? "desktop_windows" : "smartphone"} className="text-[17px]" />
            </button>
          ))}
        </div>
      }
    >
      <div className="border-b border-line px-4 py-3">
        <div className="flex items-center gap-3">
          <div className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-primary text-[13px] font-extrabold text-white">C</div>
          <div className="min-w-0 flex-1">
            <div className="truncate text-[13.5px] font-extrabold text-ink">{subject || <span className="text-slate-400">No subject yet</span>}</div>
            <div className="truncate text-[12.5px] text-slate-500">{preheader || "To: " + (me ? `${me.firstName} (you)` : "customer")}</div>
          </div>
        </div>
      </div>
      <div className="bg-slate-100 p-3">
        <ScaledFrame html={html} width={device === "mobile" ? 375 : 640} />
        <p className="mt-2 text-center text-[11.5px] text-slate-500">Shown with your own name in place of each customer&apos;s.</p>
      </div>
    </Card>
  );
}

/** Shows the email at its real width (640px desktop / 375px phone), scaled down to fit the panel. */
function ScaledFrame({ html, width }: { html?: string; width: number }) {
  const box = useRef<HTMLDivElement>(null);
  const [avail, setAvail] = useState(width);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setAvail(el.clientWidth));
    ro.observe(el);
    setAvail(el.clientWidth);
    return () => ro.disconnect();
  }, []);
  const H = 760;
  const scale = Math.min(1, avail / width);
  return (
    <div ref={box} className="w-full">
      <div className="mx-auto overflow-hidden rounded-xl bg-white shadow-sm" style={{ width: width * scale, height: H * scale }}>
        {html ? (
          <iframe title="Email preview" srcDoc={html} sandbox="" className="block border-0" style={{ width, height: H, transform: `scale(${scale})`, transformOrigin: "0 0" }} />
        ) : (
          <div className="grid h-full place-items-center text-sm text-slate-400">Loading preview…</div>
        )}
      </div>
    </div>
  );
}

// ───────────────────────────── audience ─────────────────────────────

function AudienceBuilder({ kind, value: a, onChange }: { kind: string; value: Audience; onChange: (a: Audience) => void }) {
  const opts = useApi<{ types: string[]; products: { id: string; name: string; type: string; group: string | null }[] }>("/admin/campaigns/options");
  const set = (p: Partial<Audience>) => onChange({ ...a, ...p });
  const picked = a.userIds.length > 0;
  const [mode, setMode] = useState<"filter" | "pick">(picked ? "pick" : "filter");
  const [planQ, setPlanQ] = useState("");
  const types = opts.data?.types ?? [];
  const products = (opts.data?.products ?? []).filter((p) => !planQ || `${p.name} ${p.group ?? ""}`.toLowerCase().includes(planQ.toLowerCase()));
  const toggle = (arr: string[], v: string) => (arr.includes(v) ? arr.filter((x) => x !== v) : [...arr, v]);

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-1 rounded-xl bg-slate-100 p-1 sm:w-[420px]">
        {(["filter", "pick"] as const).map((m) => (
          <button key={m} type="button" onClick={() => { setMode(m); if (m === "filter") set({ userIds: [] }); }} className={cx("flex h-9 items-center justify-center gap-1.5 rounded-lg text-[13px] font-bold", mode === m ? "bg-white text-ink shadow-sm" : "text-slate-500")}>
            <Icon name={m === "filter" ? "filter_alt" : "person_search"} className="text-[17px]" />{m === "filter" ? "Customers who match" : "Choose customers"}
          </button>
        ))}
      </div>

      {mode === "pick" ? (
        <CustomerPicker ids={a.userIds} onChange={(userIds) => set({ userIds })} />
      ) : (
        <>
          <Field label="Customers">
            <div className="grid gap-2 sm:grid-cols-3">
              {([["all", "All customers", "group"], ["with_active", "With an active service", "verified"], ["without_active", "Without an active service", "person_off"]] as const).map(([k, label, icon]) => (
                <button key={k} type="button" onClick={() => set({ clients: k })} className={cx("flex items-center gap-2 rounded-xl border px-3 py-2.5 text-left text-[13px] font-bold transition", a.clients === k ? "border-primary bg-[#faf7ff] text-primary-dark ring-2 ring-primary/15" : "border-line text-slate-600 hover:border-primary/50")}>
                  <Icon name={icon} className="text-[19px]" />{label}
                </button>
              ))}
            </div>
          </Field>

          {types.length > 0 && (
            <Field label="Who use" hint="Customers with a live service of any ticked kind. Leave empty for everyone.">
              <div className="flex flex-wrap gap-1.5">
                {types.map((t) => (
                  <button key={t} type="button" onClick={() => set({ productTypes: toggle(a.productTypes, t) })} className={cx("inline-flex items-center gap-1 rounded-full border px-3 py-1.5 text-[12.5px] font-bold transition", a.productTypes.includes(t) ? "border-primary bg-primary text-white" : "border-line bg-white text-slate-600 hover:border-primary/60")}>
                    {a.productTypes.includes(t) && <Icon name="check" className="text-[15px]" />}{typeLabel(t)}
                  </button>
                ))}
              </div>
            </Field>
          )}

          <details className="group rounded-xl border border-line" open={a.productIds.length > 0}>
            <summary className="flex cursor-pointer list-none items-center gap-2 px-3.5 py-2.5 text-[13px] font-bold text-ink">
              <Icon name="inventory_2" className="text-[18px] text-primary" />Specific plans
              {a.productIds.length > 0 && <span className="rounded-md bg-primary-tint px-1.5 text-[11.5px] text-primary-dark">{a.productIds.length} chosen</span>}
              <Icon name="expand_more" className="ml-auto text-[20px] text-slate-400 transition group-open:rotate-180" />
            </summary>
            <div className="border-t border-line p-3">
              <Input value={planQ} onChange={(e) => setPlanQ(e.target.value)} placeholder="Search plans…" className="!h-9 text-[13px]" />
              <div className="mt-2 max-h-56 space-y-0.5 overflow-y-auto">
                {products.map((p) => (
                  <label key={p.id} className="flex cursor-pointer items-center gap-2.5 rounded-lg px-2 py-1.5 text-[13px] hover:bg-slate-50">
                    <input type="checkbox" className="h-4 w-4 accent-[#7c3aed]" checked={a.productIds.includes(p.id)} onChange={() => set({ productIds: toggle(a.productIds, p.id) })} />
                    <span className="min-w-0 flex-1 truncate font-semibold text-ink">{p.name}</span>
                    <span className="shrink-0 text-[11.5px] text-slate-400">{typeLabel(p.type)}</span>
                  </label>
                ))}
                {!products.length && <p className="px-2 py-3 text-[12.5px] text-slate-400">No plans found.</p>}
              </div>
            </div>
          </details>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Country">
              <Select value={a.country} onChange={(e) => set({ country: e.target.value as Audience["country"] })}>
                <option value="all">Anywhere</option>
                <option value="IN">India</option>
                <option value="intl">Outside India</option>
              </Select>
            </Field>
            <Field label="Signed up">
              <Select value={String(a.signedUpWithinDays ?? "")} onChange={(e) => set({ signedUpWithinDays: e.target.value ? Number(e.target.value) : null })}>
                <option value="">Any time</option>
                <option value="7">In the last 7 days</option>
                <option value="30">In the last 30 days</option>
                <option value="90">In the last 3 months</option>
                <option value="365">In the last year</option>
              </Select>
            </Field>
          </div>
          <Toggle checked={a.includeInactive} onChange={(v) => set({ includeInactive: v })} label="Also include inactive accounts" />
        </>
      )}
      {kind === "OFFER" && <p className="text-[12px] text-slate-500"><Icon name="info" className="mr-1 align-[-3px] text-[15px]" />Offers skip customers who turned offers off. Closed accounts never receive campaigns.</p>}
    </div>
  );
}

function AudienceSize({ aud, kind }: { aud: { count: number; optedOut: number; sample: any[] } | null; kind: string }) {
  return (
    <div className={cx("mt-5 flex flex-col gap-3 rounded-2xl p-4 sm:flex-row sm:items-center", aud?.count ? "bg-[linear-gradient(135deg,#f5f0ff,#ede4ff)]" : "bg-amber-50")}>
      <div className="flex items-center gap-3">
        <div className={cx("grid h-12 w-12 place-items-center rounded-xl text-white", aud?.count ? "bg-primary" : "bg-amber-500")}><Icon name={aud?.count ? "groups" : "group_off"} className="text-[24px]" /></div>
        <div>
          <div className="text-2xl font-extrabold tabular-nums text-ink">{aud ? fmt(aud.count) : "…"}</div>
          <div className="text-[12.5px] font-semibold text-slate-600">{aud?.count === 0 ? "No customers match — widen the audience" : "customers will receive this"}</div>
        </div>
      </div>
      <div className="flex min-w-0 flex-1 items-center gap-3 sm:justify-end">
        {kind === "OFFER" && !!aud?.optedOut && <span className="text-[12px] text-slate-500">{fmt(aud.optedOut)} left out (offers off)</span>}
        <div className="flex -space-x-2">
          {(aud?.sample ?? []).slice(0, 5).map((u: any) => (
            <span key={u.id} title={`${u.firstName ?? ""} ${u.lastName ?? ""} · ${u.email}`} className="rounded-full ring-2 ring-white"><Avatar name={initialsOf(u.firstName, u.lastName, u.email)} seed={u.id} size={30} className="!rounded-full text-[11px]" /></span>
          ))}
        </div>
      </div>
    </div>
  );
}

function CustomerPicker({ ids, onChange }: { ids: string[]; onChange: (ids: string[]) => void }) {
  const [q, setQ] = useState("");
  const dq = useDebounced(q, 300);
  const [found, setFound] = useState<any[]>([]);
  const [known, setKnown] = useState<Record<string, any>>({});
  useEffect(() => {
    if (!ids.length) return;
    const missing = ids.filter((i) => !known[i]);
    if (!missing.length) return;
    api<{ customers: any[] }>(`/admin/campaigns/customers?ids=${missing.join(",")}`).then((r) => setKnown((k) => ({ ...k, ...Object.fromEntries(r.customers.map((c) => [c.id, c])) }))).catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ids.join(",")]);
  useEffect(() => {
    if (!dq.trim()) return setFound([]);
    api<{ customers: any[] }>(`/admin/campaigns/customers?q=${encodeURIComponent(dq)}`).then((r) => setFound(r.customers)).catch(() => setFound([]));
  }, [dq]);
  const add = (c: any) => {
    setKnown((k) => ({ ...k, [c.id]: c }));
    if (!ids.includes(c.id)) onChange([...ids, c.id]);
  };
  return (
    <div>
      <div className="relative">
        <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search by name, email or company…" />
        {found.length > 0 && (
          <div className="absolute inset-x-0 z-20 mt-1 max-h-72 overflow-y-auto rounded-xl border border-line bg-white py-1 shadow-xl">
            {found.map((c) => (
              <button key={c.id} type="button" onClick={() => { add(c); setQ(""); }} className="flex w-full items-center gap-3 px-3 py-2 text-left hover:bg-primary-tint">
                <Avatar name={initialsOf(c.firstName, c.lastName, c.email)} seed={c.id} size={30} />
                <span className="min-w-0 flex-1"><span className="block truncate text-[13px] font-bold text-ink">{c.firstName} {c.lastName}</span><span className="block truncate text-[12px] text-slate-500">{c.email}</span></span>
                {ids.includes(c.id) ? <Icon name="check_circle" className="text-[18px] text-emerald-600" fill /> : <Icon name="add_circle" className="text-[18px] text-primary" />}
              </button>
            ))}
          </div>
        )}
      </div>
      <div className="mt-3 flex flex-wrap gap-1.5">
        {ids.map((i) => {
          const c = known[i];
          return (
            <span key={i} className="inline-flex max-w-full items-center gap-1.5 rounded-full border border-line bg-white py-1 pl-1 pr-2 text-[12.5px] font-semibold text-ink">
              <Avatar name={c ? initialsOf(c.firstName, c.lastName, c.email) : "?"} seed={i} size={22} className="!rounded-full" />
              <span className="truncate">{c ? `${c.firstName ?? ""} ${c.lastName ?? ""}`.trim() || c.email : "…"}</span>
              <button type="button" onClick={() => onChange(ids.filter((x) => x !== i))} className="text-slate-400 hover:text-rose-600" aria-label="Remove"><Icon name="close" className="text-[15px]" /></button>
            </span>
          );
        })}
        {!ids.length && <p className="text-[12.5px] text-slate-500">Search above and click customers to add them.</p>}
      </div>
    </div>
  );
}

// ───────────────────────────── modals ─────────────────────────────

function TestModal({ open, onClose, id, persist }: { open: boolean; onClose: () => void; id: string; persist: () => Promise<boolean> }) {
  const { me } = useSession();
  const [to, setTo] = useState("");
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState<{ to: string; ok: boolean; error?: string }[] | null>(null);
  useEffect(() => {
    if (open) {
      setTo(me?.email ?? "");
      setRes(null);
    }
  }, [open, me?.email]);
  const list = to.split(/[\s,;]+/).map((x) => x.trim()).filter(Boolean);
  return (
    <Modal open={open} onClose={onClose} title="Send a test email">
      <div className="space-y-4">
        <Field label="Send to" hint="Up to 5 addresses, separated by commas. Personal details are filled in with your own name.">
          <Input value={to} onChange={(e) => setTo(e.target.value)} placeholder="you@example.com" />
        </Field>
        {res && (
          <div className="space-y-1.5">
            {res.map((r) => (
              <div key={r.to} className={cx("flex items-start gap-2 rounded-lg px-3 py-2 text-[13px]", r.ok ? "bg-emerald-50 text-emerald-800" : "bg-rose-50 text-rose-800")}>
                <Icon name={r.ok ? "check_circle" : "error"} className="mt-px text-[17px]" />
                <span className="min-w-0 break-words"><b>{r.to}</b> {r.ok ? "— sent, check the inbox (and spam folder)" : `— ${r.error}`}</span>
              </div>
            ))}
          </div>
        )}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>Close</Button>
          <Button
            icon="send"
            loading={busy}
            disabled={!list.length || list.length > 5}
            onClick={async () => {
              setBusy(true);
              try {
                if (!(await persist())) return;
                const r = await api<{ results: any[] }>(`/admin/campaigns/${id}/test`, { body: { to: list } });
                setRes(r.results);
              } catch (e: any) {
                toast.error(e.message);
              } finally {
                setBusy(false);
              }
            }}
          >
            Send test
          </Button>
        </div>
      </div>
    </Modal>
  );
}

function ScheduleModal({ open, onClose, count, onSchedule }: { open: boolean; onClose: () => void; count: number; onSchedule: (at: string) => Promise<void> }) {
  const tomorrow10 = useMemo(() => {
    const d = new Date(Date.now() + 86400_000);
    d.setHours(10, 0, 0, 0);
    const p = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T10:00`;
  }, []);
  const [at, setAt] = useState(tomorrow10);
  const [busy, setBusy] = useState(false);
  const when = at ? new Date(at) : null;
  const valid = !!when && when.getTime() > Date.now() + 2 * 60_000;
  return (
    <Modal open={open} onClose={onClose} title="Schedule this campaign">
      <div className="space-y-4">
        <Field label="Send on" hint="Your computer's time zone. Tuesday–Thursday mornings usually get the most opens.">
          <Input type="datetime-local" value={at} onChange={(e) => setAt(e.target.value)} />
        </Field>
        {when && !valid && <Alert tone="warn">Pick a time at least a few minutes from now.</Alert>}
        {valid && <p className="text-[13px] text-slate-600">Customers who match the audience on <b>{ist(when!)}</b> (about {fmt(count)} today) will receive it.</p>}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button icon="schedule_send" disabled={!valid} loading={busy} onClick={async () => { setBusy(true); try { await onSchedule(when!.toISOString()); } finally { setBusy(false); } }}>Schedule</Button>
        </div>
      </div>
    </Modal>
  );
}

// ───────────────────────────── report ─────────────────────────────

const R_TABS: Tab[] = [
  { key: "", label: "All" },
  { key: "SENT", label: "Delivered", tone: "green" },
  { key: "OPENED", label: "Opened", tone: "purple" },
  { key: "QUEUED", label: "Waiting", tone: "sky" },
  { key: "FAILED", label: "Failed", tone: "rose" },
  { key: "SKIPPED", label: "Skipped", tone: "slate" },
  { key: "UNSUBSCRIBED", label: "Unsubscribed", tone: "amber" },
];

export function CampaignReport({ id, data, reload }: { id: string; data: any; reload: () => void }) {
  const router = useRouter();
  const c = data.campaign;
  const [rs, setRs] = useState("");
  const [q, setQ] = useState("");
  const [page, setPage] = useState(1);
  const list = useApi<any>(`/admin/campaigns/${id}?rstatus=${rs}&q=${encodeURIComponent(q)}&page=${page}&pageSize=25`, [rs, q, page, c.sent, c.failed, c.opened]);
  const [preview, setPreview] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<null | "cancel" | "delete">(null);
  useEffect(() => {
    api<{ html: string }>("/admin/campaigns/preview", { body: { kind: c.kind, subject: c.subject, preheader: c.preheader, body: c.body } }).then((r) => setPreview(r.html)).catch(() => undefined);
  }, [c.kind, c.subject, c.preheader, c.body]);

  const done = c.sent + c.failed + c.skipped;
  const progress = c.total ? Math.min(100, Math.round((done / c.total) * 100)) : 0;
  const openRate = c.sent ? c.opened / c.sent : null;
  const left = data.queued ?? Math.max(0, c.total - done);
  const counts = { all: c.total, SENT: c.sent, OPENED: c.opened, QUEUED: left, FAILED: c.failed, SKIPPED: c.skipped, UNSUBSCRIBED: c.unsubscribed };

  async function act(path: string, ok: string) {
    try {
      const r = await api<any>(`/admin/campaigns/${id}/${path}`, { body: {} });
      toast.success(ok);
      setConfirm(null);
      if (path === "duplicate") router.push(`/admin/campaigns/${r.campaign.id}`);
      else reload();
    } catch (e: any) {
      toast.error(e.message);
    }
  }

  return (
    <>
      <PageHeader
        back="/admin/campaigns"
        icon={c.kind === "OFFER" ? "sell" : "info"}
        title={c.name}
        subtitle={c.subject}
        badge={<Badge status={c.status} />}
        meta={<span className="text-[12.5px] text-violet-100/80">{c.startedAt ? <>Started {ist(c.startedAt)}</> : null}{c.finishedAt ? <> · finished {ist(c.finishedAt)}</> : null}{data.createdBy ? <> · by {data.createdBy.firstName || data.createdBy.email}</> : null}</span>}
        actions={
          <div className="flex flex-wrap gap-2">
            {c.status === "SENDING" && <Button variant="secondary" icon="pause" onClick={() => act("pause", "Paused")}>Pause</Button>}
            {c.status === "PAUSED" && <Button icon="play_arrow" onClick={() => act("resume", "Sending again")}>Resume</Button>}
            {["SENDING", "PAUSED"].includes(c.status) && <Button variant="secondary" icon="cancel" onClick={() => setConfirm("cancel")}>Cancel</Button>}
            <Button variant="secondary" icon="content_copy" onClick={() => act("duplicate", "Copied — edit and send the copy")}>Duplicate</Button>
            {["SENT", "CANCELLED"].includes(c.status) && <Button variant="secondary" icon="delete" onClick={() => setConfirm("delete")}>Delete</Button>}
          </div>
        }
        stats={[
          ["Recipients", fmt(c.total), c.kind === "OFFER" ? "accept offers" : "service information"],
          ["Delivered", fmt(c.sent), c.total ? `${Math.round((c.sent / c.total) * 100)}% of recipients` : undefined],
          ["Opened", openRate == null ? "—" : `${Math.round(openRate * 1000) / 10}%`, `${fmt(c.opened)} people`],
          ["Unsubscribed", fmt(c.unsubscribed), c.failed ? `${fmt(c.failed)} failed` : "from offers"],
        ]}
      />

      {c.lastError && ["PAUSED", "SENDING"].includes(c.status) && (
        <Alert tone="warn" className="mb-5">
          <b>{c.lastError}</b>
          <div className="mt-1">Check <a className="font-bold underline" href="/admin/email">Email Delivery</a>, then press Resume — nobody who&apos;s waiting is skipped.</div>
        </Alert>
      )}
      {["SENDING", "PAUSED"].includes(c.status) && (
        <Card className="mb-5">
          <div className="flex flex-wrap items-end justify-between gap-2">
            <div>
              <div className="text-[13px] font-bold text-slate-500">{c.status === "PAUSED" ? "Paused" : "Sending…"}</div>
              <div className="text-xl font-extrabold tabular-nums text-ink">{fmt(done)} <span className="text-[14px] font-semibold text-slate-500">of {fmt(c.total)}</span></div>
            </div>
            <div className="text-right text-[12.5px] text-slate-500">{left > 0 && c.status === "SENDING" ? <>About {Math.max(1, Math.ceil(left / c.perMinute))} min left at {c.perMinute}/min</> : null}</div>
          </div>
          <div className="mt-3 h-3 overflow-hidden rounded-full bg-slate-100">
            <div className={cx("h-full rounded-full transition-all", c.status === "PAUSED" ? "bg-amber-500" : "bg-[linear-gradient(90deg,#a365fe,#7c3aed)]")} style={{ width: `${progress}%` }} />
          </div>
        </Card>
      )}

      <div className="grid items-start gap-5 xl:grid-cols-[minmax(0,1fr)_minmax(0,420px)]">
        <Card pad={false} title={<Title icon="group">Recipients</Title>}>
          <div className="flex flex-col gap-3 border-b border-line px-4 py-3 lg:flex-row lg:items-center">
            <div className="min-w-0 flex-1"><StatusTabs tabs={R_TABS} value={rs} onChange={(v) => { setRs(v); setPage(1); }} counts={counts} /></div>
            <SearchBox value={q} onSearch={(v) => { setQ(v); setPage(1); }} placeholder="Find an email…" className="lg:w-56" />
          </div>
          <ul className="divide-y divide-line">
            {(list.data?.recipients ?? []).map((r: any) => (
              <li key={r.id} className="flex items-center gap-3 px-4 py-3">
                <Avatar name={initialsOf(r.name?.split(" ")[0], r.name?.split(" ").slice(1).join(" "), r.email)} seed={r.userId ?? r.email} size={34} />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-x-2">
                    {r.userId ? <a href={`/admin/clients/${r.userId}`} className="truncate text-[13.5px] font-bold text-ink hover:text-primary-dark">{r.name || r.email}</a> : <span className="truncate text-[13.5px] font-bold text-ink">{r.name || r.email}</span>}
                    {r.openedAt && <span className="inline-flex items-center gap-0.5 rounded-md bg-violet-50 px-1.5 text-[11px] font-bold text-violet-700"><Icon name="drafts" className="text-[13px]" />opened</span>}
                    {r.unsubscribedAt && <span className="rounded-md bg-amber-50 px-1.5 text-[11px] font-bold text-amber-700">unsubscribed</span>}
                  </div>
                  <div className="truncate text-[12px] text-slate-500">{r.email}{r.error ? <span className={r.status === "FAILED" ? "text-rose-600" : ""}> · {r.error}</span> : null}</div>
                </div>
                <div className="shrink-0 text-right">
                  <Badge status={r.status} />
                  <div className="mt-0.5 text-[11.5px] text-slate-400">{r.sentAt ? <Ago at={r.sentAt} /> : null}</div>
                </div>
              </li>
            ))}
            {list.data && !list.data.recipients.length && <li className="px-4 py-10 text-center text-[13px] text-slate-500">Nobody here.</li>}
          </ul>
          {list.data && list.data.recipientTotal > 25 && <div className="border-t border-line px-4 py-3"><Pager page={page} pageSize={25} total={list.data.recipientTotal} onPage={setPage} /></div>}
        </Card>
        <div className="min-w-0">
          <div className="xl:sticky xl:top-20"><PreviewPane title="The email" subject={c.subject} preheader={c.preheader ?? ""} html={preview ?? undefined} /></div>
        </div>
      </div>

      <Modal open={confirm === "cancel"} onClose={() => setConfirm(null)} title="Cancel this campaign?">
        <p className="text-[13.5px] text-slate-600">The {fmt(left)} customers who haven&apos;t been sent it yet won&apos;t get it. Emails already sent stay sent.</p>
        <div className="mt-4 flex justify-end gap-2"><Button variant="ghost" onClick={() => setConfirm(null)}>Keep sending</Button><Button variant="danger" icon="cancel" onClick={() => act("cancel", "Campaign cancelled")}>Cancel campaign</Button></div>
      </Modal>
      <Modal open={confirm === "delete"} onClose={() => setConfirm(null)} title="Delete this campaign?">
        <p className="text-[13.5px] text-slate-600">Its report and recipient list are removed. Customers&apos; unsubscribe choices are kept.</p>
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="ghost" onClick={() => setConfirm(null)}>Keep it</Button>
          <Button variant="danger" icon="delete" onClick={async () => { try { await api(`/admin/campaigns/${id}`, { method: "DELETE" }); toast.success("Deleted"); router.push("/admin/campaigns"); } catch (e: any) { toast.error(e.message); } }}>Delete</Button>
        </div>
      </Modal>
    </>
  );
}
