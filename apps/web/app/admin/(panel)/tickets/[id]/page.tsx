"use client";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useRef, useState } from "react";
import { api, date } from "@/lib/api";
import { Badge, Button, Card, Icon, Loading, PageHeader, Select, Textarea, Toggle, cx, toast, useApi } from "@/components/ui";

export default function AdminTicket() {
  const { id } = useParams<{ id: string }>();
  const { data, loading, reload } = useApi(`/admin/tickets/${id}`);
  const depts = useApi("/admin/ticket-departments");
  const staff = useApi("/admin/staff");
  const canned = useApi("/admin/canned-responses");
  const [note, setNote] = useState(false);
  const [status, setStatus] = useState("ANSWERED");
  const [busy, setBusy] = useState(false);
  const ta = useRef<HTMLTextAreaElement>(null);
  const form = useRef<HTMLFormElement>(null);
  if (loading || !data) return <Loading />;
  const t = data.ticket;
  const upd = (body: any) => api(`/admin/tickets/${id}`, { method: "PUT", body }).then(() => { toast.success("Updated"); reload(); });
  return (
    <>
      <PageHeader icon="support_agent" badge={<Badge status={t.status} />}
        stats={[
          ["Status", <Badge key="s" status={t.status} />],
          ["Priority", <Badge key="p" status={t.priority} />],
          ["Department", t.department?.name ?? "—"],
          ["Customer", t.user ? `${t.user.firstName ?? ""} ${t.user.lastName ?? ""}`.trim() || t.user.email : t.fromEmail ?? "—", t.user?.email],
          ["Replies", `${t.messages.length}`, t.messages.length ? `last ${date(t.messages[t.messages.length - 1].createdAt, true)}` : undefined],
        ]}
        back="/admin/tickets" title={t.subject} subtitle={<span className="flex flex-wrap items-center gap-2">#{t.number} · opened {date(t.createdAt, true)} {t.slaDueAt && !t.firstResponseAt && <span className={new Date(t.slaDueAt) < new Date() ? "font-bold text-rose-600" : ""}>· first response due {date(t.slaDueAt, true)}</span>}</span>} />
      <div className="grid gap-6 xl:grid-cols-[1fr_320px]">
        <div className="space-y-4">
          {t.messages.map((m: any) => (
            <div key={m.id} className={cx("rounded-2xl border p-5", m.isNote ? "border-amber-200 bg-amber-50" : m.isStaff ? "border-[#e9d5ff] bg-primary-tint" : "border-line bg-white")}>
              <div className="mb-2 flex items-center justify-between text-sm">
                <span className="flex items-center gap-2 font-extrabold text-ink"><Icon name={m.isNote ? "sticky_note_2" : m.isStaff ? "support_agent" : "person"} />{m.author ? `${m.author.firstName} ${m.author.lastName}` : m.fromEmail}{m.isNote && <Badge>internal note</Badge>}</span>
                <span className="text-mute">{date(m.createdAt, true)}</span>
              </div>
              <div className="whitespace-pre-wrap text-[14.5px] text-slate-700">{m.body}</div>
              {m.attachments.length > 0 && <div className="mt-3 flex flex-wrap gap-2">{m.attachments.map((a: any) => <a key={a.id} href={`/api/admin/attachments/${a.id}`} className="rounded-lg bg-white px-3 py-1.5 text-xs font-bold text-primary-dark ring-1 ring-line">📎 {a.filename}</a>)}</div>}
            </div>
          ))}
          <Card title={note ? "Add internal note" : "Reply to customer"}>
            <form ref={form} onSubmit={async (e) => {
              e.preventDefault(); setBusy(true);
              const fd = new FormData(e.currentTarget); fd.set("note", String(note)); if (!note) fd.set("status", status);
              try { await api(`/admin/tickets/${id}/reply`, { method: "POST", form: fd }); form.current?.reset(); toast.success(note ? "Note added" : "Reply sent"); reload(); } catch (err: any) { toast.error(err.message); } finally { setBusy(false); }
            }} className="space-y-3">
              {canned.data?.items?.length > 0 && <Select className="h-9" defaultValue="" onChange={(e) => { const c = canned.data.items.find((x: any) => x.id === e.target.value); if (c && ta.current) ta.current.value = (ta.current.value ? ta.current.value + "\n\n" : "") + c.body.replace("{{name}}", t.user.firstName); e.target.value = ""; }}><option value="">Insert canned response…</option>{canned.data.items.map((c: any) => <option key={c.id} value={c.id}>{c.title}</option>)}</Select>}
              <Textarea ref={ta} name="message" rows={7} required placeholder={`Hi ${t.user.firstName},`} />
              <div className="flex flex-wrap items-center gap-3">
                <input type="file" name="attachments" multiple className="text-sm" />
                <Toggle checked={note} onChange={setNote} label="Internal note" />
                {!note && <Select className="h-9 w-48" value={status} onChange={(e) => setStatus(e.target.value)}><option value="ANSWERED">Set: Answered</option><option value="IN_PROGRESS">Set: In progress</option><option value="ON_HOLD">Set: On hold</option><option value="CLOSED">Set: Closed</option></Select>}
                <Button type="submit" loading={busy} icon="send" className="ml-auto">{note ? "Add note" : "Send reply"}</Button>
              </div>
            </form>
          </Card>
        </div>
        <div className="space-y-4">
          <Card title="Ticket">
            <div className="space-y-3">
              <Select value={t.status} onChange={(e) => upd({ status: e.target.value })}>{["OPEN", "CUSTOMER_REPLY", "ANSWERED", "IN_PROGRESS", "ON_HOLD", "CLOSED"].map((s) => <option key={s}>{s}</option>)}</Select>
              <Select value={t.priority} onChange={(e) => upd({ priority: e.target.value })}>{["LOW", "MEDIUM", "HIGH", "URGENT"].map((s) => <option key={s}>{s}</option>)}</Select>
              <Select value={t.departmentId} onChange={(e) => upd({ departmentId: e.target.value })}>{depts.data?.items?.map((d: any) => <option key={d.id} value={d.id}>{d.name}</option>)}</Select>
              <Select value={t.assignedToId ?? ""} onChange={(e) => upd({ assignedToId: e.target.value || null })}><option value="">Unassigned</option>{staff.data?.staff?.map((s: any) => <option key={s.id} value={s.id}>{s.firstName} {s.lastName}</option>)}</Select>
            </div>
          </Card>
          <Card title="Customer">
            <Link href={`/admin/clients/${t.user.id}`} className="font-bold text-primary-dark">{t.user.firstName} {t.user.lastName}</Link>
            <div className="text-sm text-mute">{t.user.email}<br />{t.user.phone}<br />{t.user.profile?.companyName}</div>
            <div className="mt-3 text-xs font-bold uppercase text-mute">Related service</div>
            <Select className="mt-1 h-9" value={t.serviceId ?? ""} onChange={(e) => upd({ serviceId: e.target.value || null })}><option value="">None</option>{data.clientServices.map((s: any) => <option key={s.id} value={s.id}>{s.product} {s.hostname ?? ""}</option>)}</Select>
            {t.service && <Link href={`/admin/services/${t.service.id}`} className="mt-2 block text-sm font-bold text-primary-dark">{t.service.product.name} · {t.service.ips.map((i: any) => i.address).join(", ")} →</Link>}
          </Card>
        </div>
      </div>
    </>
  );
}
