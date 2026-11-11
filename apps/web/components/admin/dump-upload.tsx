"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { api, date } from "@/lib/api";
import { Alert, Button, Icon, cx, toast } from "@/components/ui";

export type DumpState = {
  id: string;
  name: string;
  size: number;
  received: number;
  status: "uploading" | "preparing" | "ready" | "error";
  error?: string;
  progress?: number;
  meta?: { version: string; company: string; counts: Record<string, number>; tables: string[] };
  createdAt: string;
};

const SHOW = ["tblclients", "tblproducts", "tblhosting", "tbldomains", "tblinvoices", "tblaccounts", "tbltickets", "tblticketreplies", "tblservers", "tbladmins"];
export const size = (b: number) => (b >= 1e9 ? `${(b / 1e9).toFixed(2)} GB` : b >= 1e6 ? `${(b / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1e3))} KB`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Upload a WHMCS .sql / .sql.gz dump in pieces, then wait while the server prepares it. */
export function DumpUpload({ value, onChange }: { value: DumpState | null; onChange: (d: DumpState | null) => void }) {
  const [list, setList] = useState<DumpState[]>([]);
  const [up, setUp] = useState<{ name: string; sent: number; total: number; speed: number } | null>(null);
  const [drag, setDrag] = useState(false);
  const cancel = useRef(false);
  const input = useRef<HTMLInputElement>(null);

  const load = useCallback(() => api<{ items: DumpState[] }>("/admin/migration/whmcs/dumps").then((r) => setList(r.items)).catch(() => {}), []);
  useEffect(() => {
    load();
  }, [load]);

  // poll while the selected dump is being prepared
  useEffect(() => {
    if (!value || value.status !== "preparing") return;
    const t = setInterval(async () => {
      try {
        const s = await api<DumpState>(`/admin/migration/whmcs/dumps/${value.id}`);
        if (s.status !== value.status || s.progress !== value.progress) onChange(s);
        if (s.status === "ready") toast.success("File ready — run a dry run to see exactly what will be imported");
        if (s.status !== "preparing") load();
      } catch {}
    }, 2000);
    return () => clearInterval(t);
  }, [value, onChange, load]);

  async function upload(file: File) {
    if (!/\.(sql|gz)$/i.test(file.name)) return toast.error("Choose the WHMCS database export: a .sql or .sql.gz file");
    cancel.current = false;
    try {
      const s = await api<DumpState & { chunkSize: number }>("/admin/migration/whmcs/dumps", { body: { name: file.name, size: file.size } });
      let offset = 0;
      let fails = 0;
      const started = Date.now();
      setUp({ name: file.name, sent: 0, total: file.size, speed: 0 });
      while (offset < file.size) {
        if (cancel.current) throw new Error("Upload cancelled");
        const piece = file.slice(offset, offset + s.chunkSize);
        let res: Response;
        try {
          res = await fetch(`/api/admin/migration/whmcs/dumps/${s.id}/chunk?offset=${offset}`, {
            method: "PUT",
            headers: { "X-Requested-With": "crapplet", "Content-Type": "application/octet-stream" },
            body: piece,
            credentials: "include",
          });
        } catch {
          if (++fails > 8) throw new Error("Lost connection to the server during upload — choose the file again to retry");
          await sleep(1000 * fails);
          continue;
        }
        if (res.status === 401) {
          await api(`/admin/migration/whmcs/dumps/${s.id}`); // refreshes the session
          continue;
        }
        const body = await res.json().catch(() => ({}));
        if (res.status === 409 && typeof body.received === "number") {
          offset = body.received; // server already has more (or less) — continue from there
          continue;
        }
        if (!res.ok) {
          if (res.status >= 500 && ++fails <= 8) {
            await sleep(1000 * fails);
            continue;
          }
          throw new Error(body.error ?? `Upload failed (${res.status})`);
        }
        fails = 0;
        offset = body.received;
        const secs = (Date.now() - started) / 1000;
        setUp({ name: file.name, sent: offset, total: file.size, speed: offset / Math.max(secs, 0.5) });
      }
      const done = await api<DumpState>(`/admin/migration/whmcs/dumps/${s.id}/finish`, { body: {} });
      onChange(done);
      load();
    } catch (e: any) {
      toast.error(e.message);
    } finally {
      setUp(null);
      if (input.current) input.current.value = "";
    }
  }

  async function remove(d: DumpState) {
    if (!confirm(`Delete the uploaded file ${d.name}?`)) return;
    await api(`/admin/migration/whmcs/dumps/${d.id}`, { method: "DELETE" }).catch((e) => toast.error(e.message));
    if (value?.id === d.id) onChange(null);
    load();
  }

  const pct = up ? Math.floor((up.sent / up.total) * 100) : 0;
  return (
    <div className="space-y-4">
      <Alert>
        Export the WHMCS database from <b>phpMyAdmin</b> (Export → SQL), <b>cPanel → Backup</b> (MySQL database), or <code className="text-xs">mysqldump whmcs | gzip &gt; whmcs.sql.gz</code>.
        Upload the <b>.sql</b> or <b>.sql.gz</b> file — any size; large files upload in pieces and resume if the connection drops.
      </Alert>

      {up ? (
        <div className="rounded-2xl border border-line bg-[#fbf9ff] p-5">
          <div className="flex items-center justify-between gap-3 text-sm">
            <span className="flex min-w-0 items-center gap-2 font-bold text-ink"><Icon name="upload_file" className="text-primary-dark" /><span className="truncate">{up.name}</span></span>
            <span className="shrink-0 font-bold text-primary-dark">{pct}%</span>
          </div>
          <div className="mt-3 h-2.5 overflow-hidden rounded-full bg-[#ece4fb]"><div className="h-full rounded-full bg-gradient-to-r from-primary to-primary-dark transition-all" style={{ width: `${pct}%` }} /></div>
          <div className="mt-2 flex flex-wrap justify-between gap-2 text-xs text-mute">
            <span>{size(up.sent)} of {size(up.total)} · {size(up.speed)}/s{up.speed > 0 && ` · about ${Math.max(1, Math.ceil((up.total - up.sent) / up.speed / 60))} min left`}</span>
            <button className="font-bold text-rose-600 hover:underline" onClick={() => (cancel.current = true)}>Cancel</button>
          </div>
        </div>
      ) : (
        <label
          onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
          onDragLeave={() => setDrag(false)}
          onDrop={(e) => { e.preventDefault(); setDrag(false); const f = e.dataTransfer.files?.[0]; if (f) upload(f); }}
          className={cx("flex cursor-pointer flex-col items-center justify-center gap-2 rounded-2xl border-2 border-dashed px-6 py-8 text-center transition", drag ? "border-primary bg-primary-tint" : "border-[#dccafb] bg-[#fdfbff] hover:border-primary hover:bg-primary-tint")}
        >
          <span className="grid h-12 w-12 place-items-center rounded-xl bg-gradient-to-br from-primary to-primary-dark text-white shadow-glow"><Icon name="upload_file" className="text-[26px]" /></span>
          <span className="text-sm font-extrabold text-ink">Drop the WHMCS .sql file here, or click to choose</span>
          <span className="text-xs text-mute">.sql or .sql.gz · stays on this server · delete it when the migration is done</span>
          <input ref={input} type="file" accept=".sql,.gz,application/sql,application/gzip" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) upload(f); }} />
        </label>
      )}

      {value && <DumpStatus d={value} />}

      {list.length > 0 && (
        <div>
          <div className="mb-2 text-[11px] font-bold uppercase tracking-wider text-mute">Uploaded files</div>
          <ul className="divide-y divide-line overflow-hidden rounded-xl border border-line">
            {list.map((d) => (
              <li key={d.id} className={cx("flex flex-wrap items-center gap-3 px-4 py-3 text-sm", value?.id === d.id && "bg-primary-tint")}>
                <Icon name="description" className="text-primary-dark" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-bold text-ink">{d.name}</span>
                  <span className="text-xs text-mute">{size(d.size)} · {date(d.createdAt, true)} · {d.status === "ready" ? `WHMCS ${d.meta?.version ?? ""} · ${d.meta?.counts.tblclients ?? 0} clients` : d.status === "uploading" ? `upload incomplete (${size(d.received)})` : d.status}</span>
                </span>
                {d.status === "ready" && value?.id !== d.id && <Button size="sm" variant="outline" onClick={() => onChange(d)}>Use this file</Button>}
                {d.status === "preparing" && value?.id !== d.id && <Button size="sm" variant="ghost" onClick={() => onChange(d)}>Show</Button>}
                <Button size="sm" variant="ghost" icon="delete" onClick={() => remove(d)}>Delete</Button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function DumpStatus({ d }: { d: DumpState }) {
  if (d.status === "preparing")
    return (
      <div className="flex items-center gap-3 rounded-xl bg-[#fbf9ff] p-4 text-sm">
        <span className="h-5 w-5 shrink-0 animate-spin rounded-full border-2 border-[#e4d8fb] border-t-primary" />
        <span><b className="text-ink">Reading {d.name}…</b> <span className="text-mute">{d.progress ? `${size(d.progress)} of SQL read` : "starting"} — large files take a minute or two.</span></span>
      </div>
    );
  if (d.status === "error") return <Alert tone="error"><b>{d.name} couldn&apos;t be read.</b> {d.error}</Alert>;
  if (d.status !== "ready" || !d.meta) return null;
  return (
    <div className="rounded-xl bg-[#fbf9ff] p-4 text-sm">
      <div className="flex items-center gap-2 font-bold text-ink"><Icon name="check_circle" className="text-emerald-600" />{d.name} — WHMCS {d.meta.version}{d.meta.company && ` · ${d.meta.company}`}</div>
      <div className="mt-2 grid grid-cols-2 gap-x-6 gap-y-1 sm:grid-cols-5">
        {SHOW.map((t) => <div key={t}><span className="text-mute">{t.replace("tbl", "")}</span> <b>{d.meta!.counts[t] ?? 0}</b></div>)}
      </div>
    </div>
  );
}
