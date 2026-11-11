"use client";
import { useParams } from "next/navigation";
import { useRef, useState } from "react";
import { api, date } from "@/lib/api";
import { Badge, Button, Card, Icon, Loading, PageHeader, Textarea, cx, toast, useApi } from "@/components/ui";

export default function TicketView() {
  const { id } = useParams<{ id: string }>();
  const { data, loading, reload } = useApi(`/client/tickets/${id}`);
  const [busy, setBusy] = useState(false);
  const form = useRef<HTMLFormElement>(null);
  if (loading || !data) return <Loading />;
  const t = data.ticket;
  return (
    <>
      <PageHeader icon="support_agent"
        stats={[
          ["Status", <Badge key="s" status={t.status} />],
          ["Priority", <Badge key="p" status={t.priority} />],
          ["Department", t.department?.name ?? "—"],
          ["Opened", date(t.createdAt)],
          ["Replies", `${t.messages.length}`],
        ]}
        back="/client/tickets" title={t.subject} subtitle={<span className="flex flex-wrap items-center gap-2">#{t.number} · {t.department.name} · <Badge status={t.status} /> <Badge status={t.priority} /></span>}
        actions={t.status !== "CLOSED" && <Button variant="outline" size="sm" onClick={() => api(`/client/tickets/${id}/close`, { body: {} }).then(reload)}>Close ticket</Button>} />
      <div className="space-y-4">
        {t.messages.map((m: any) => (
          <div key={m.id} className={cx("rounded-2xl border p-5", m.isStaff ? "border-[#e9d5ff] bg-primary-tint" : "border-line bg-white")}>
            <div className="mb-2 flex items-center justify-between text-sm">
              <span className="flex items-center gap-2 font-extrabold text-ink">
                <Icon name={m.isStaff ? "support_agent" : "person"} className="text-primary-dark" />
                {m.isStaff ? `${m.author?.firstName ?? "Crapplet"} · Crapplet Support` : `${m.author?.firstName ?? "You"}`}
              </span>
              <span className="text-mute">{date(m.createdAt, true)}</span>
            </div>
            <div className="whitespace-pre-wrap text-[14.5px] leading-relaxed text-slate-700">{m.body}</div>
            {m.attachments.length > 0 && (
              <div className="mt-3 flex flex-wrap gap-2">
                {m.attachments.map((a: any) => (
                  <a key={a.id} href={`/api/client/attachments/${a.id}`} className="inline-flex items-center gap-1.5 rounded-lg bg-white px-3 py-1.5 text-xs font-bold text-primary-dark ring-1 ring-line">
                    <Icon name="attach_file" className="text-[16px]" /> {a.filename}
                  </a>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>
      <Card title="Reply" className="mt-6">
        <form ref={form} className="space-y-3" onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          try {
            await api(`/client/tickets/${id}/reply`, { method: "POST", form: new FormData(e.currentTarget) });
            form.current?.reset();
            toast.success("Reply sent");
            reload();
          } catch (err: any) { toast.error(err.message); } finally { setBusy(false); }
        }}>
          <Textarea name="message" rows={5} required placeholder="Write your reply…" />
          <div className="flex flex-wrap items-center justify-between gap-3">
            <input type="file" name="attachments" multiple className="text-sm file:mr-3 file:rounded-lg file:border-0 file:bg-primary-soft file:px-3 file:py-1.5 file:font-bold file:text-primary-dark" />
            <Button type="submit" loading={busy} icon="send">Send reply</Button>
          </div>
        </form>
      </Card>
    </>
  );
}
