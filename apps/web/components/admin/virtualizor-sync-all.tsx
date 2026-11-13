"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { api, date } from "@/lib/api";
import { Alert, Button, Icon, Modal, toast } from "@/components/ui";

type State = {
  status: "never" | "running" | "done" | "error";
  startedAt?: string;
  finishedAt?: string;
  phase?: string;
  servers?: { name: string; vps: number; error?: string }[];
  checked?: number;
  total?: number;
  updated?: number;
  unchanged?: number;
  missing?: { serviceId: string; hostname: string | null; remoteId: string; server: string }[];
  duplicates?: { remoteId: string; server: string; services: { serviceId: string; hostname: string | null }[] }[];
  changes?: { serviceId: string; hostname: string | null; before: string[]; after: string[]; node?: string; os?: string; linked?: string }[];
  linked?: number;
  notLinked?: { serviceId: string; hostname: string | null; reason: string }[];
  startedBy?: string;
  error?: string;
};

/** "Sync all from Virtualizor" button + progress / results dialog. */
export function VirtualizorSyncAll({ onDone, label = "Sync all from Virtualizor", size = "sm" as const, variant = "outline" as const }: { onDone?: () => void; label?: string; size?: "sm" | "md"; variant?: "outline" | "primary" }) {
  const [open, setOpen] = useState(false);
  const [st, setSt] = useState<State | null>(null);
  const [busy, setBusy] = useState(false);

  const load = () => api<State>("/admin/virtualizor/sync-all").then(setSt).catch(() => {});
  useEffect(() => {
    if (!open) return;
    load();
  }, [open]);
  useEffect(() => {
    if (st?.status !== "running") return;
    const t = setInterval(async () => {
      const s = await api<State>("/admin/virtualizor/sync-all").catch(() => null);
      if (!s) return;
      setSt(s);
      if (s.status === "done") {
        toast.success(`Virtualizor sync finished — ${s.updated} service${s.updated === 1 ? "" : "s"} updated`);
        onDone?.();
      }
    }, 1500);
    return () => clearInterval(t);
  }, [st?.status, onDone]);

  async function start() {
    setBusy(true);
    try {
      setSt(await api<State>("/admin/virtualizor/sync-all", { body: {} }));
    } catch (e: any) {
      toast.error(e.message);
    } finally {
      setBusy(false);
    }
  }

  const running = st?.status === "running";
  const pct = st?.total ? Math.floor(((st.checked ?? 0) / st.total) * 100) : 0;
  return (
    <>
      <Button size={size} variant={variant} icon="sync" onClick={() => setOpen(true)}>{label}</Button>
      <Modal open={open} onClose={() => setOpen(false)} title="Sync all services from Virtualizor" wide>
        <p className="mb-4 text-sm text-slate-600">
          Reads every VPS from your Virtualizor masters and updates each service&apos;s <b>IP addresses</b>, <b>operating system</b>, <b>node</b> and <b>hostname</b> to match, and links services that have no VPS yet (imported ones) by their IP or hostname. It also runs by itself every 30 minutes. Only services that differ are changed, and each change is written to the service&apos;s activity log. Nothing is changed in Virtualizor.
        </p>

        {running || st?.status === "done" || st?.status === "error" ? (
          <div className="rounded-2xl border border-line bg-[#fbf9ff] p-5">
            <div className="flex items-center justify-between gap-3 text-sm">
              <span className="flex items-center gap-2 font-bold text-ink">
                {running ? <span className="h-4 w-4 animate-spin rounded-full border-2 border-[#e4d8fb] border-t-primary" /> : st?.status === "done" ? <Icon name="check_circle" className="text-emerald-600" /> : <Icon name="error" className="text-rose-600" />}
                {running ? st?.phase : st?.status === "done" ? `Finished ${st.finishedAt ? date(st.finishedAt, true) : ""}${st.startedBy === "automatic" ? " · automatic run" : ""}` : "Sync failed"}
              </span>
              {st?.total ? <span className="font-bold text-primary-dark">{st.checked} / {st.total}</span> : null}
            </div>
            {running && <div className="mt-3 h-2.5 overflow-hidden rounded-full bg-[#ece4fb]"><div className="h-full rounded-full bg-gradient-to-r from-primary to-primary-dark transition-all" style={{ width: `${pct}%` }} /></div>}
            <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
              {([["Updated", (st?.updated ?? 0) + (st?.linked ?? 0), "text-emerald-700"], ["Already correct", st?.unchanged ?? 0, "text-ink"], ["Need attention", (st?.missing?.length ?? 0) + (st?.duplicates?.length ?? 0) + (st?.notLinked?.length ?? 0), (st?.missing?.length ?? 0) + (st?.duplicates?.length ?? 0) + (st?.notLinked?.length ?? 0) ? "text-amber-700" : "text-ink"], ["Services checked", st?.checked ?? 0, "text-ink"]] as const).map(([l, v, c]) => (
                <div key={l} className="rounded-xl border border-line bg-white p-3"><div className="text-[11px] font-bold uppercase tracking-wider text-mute">{l}</div><div className={`mt-1 text-xl font-extrabold ${c}`}>{v}</div></div>
              ))}
            </div>
            {st?.servers?.some((s) => s.error) && <Alert tone="error" className="mt-4">{st.servers.filter((s) => s.error).map((s) => <div key={s.name}><b>{s.name}:</b> {s.error}</div>)}</Alert>}
            {st?.error && <Alert tone="error" className="mt-4">{st.error}</Alert>}
          </div>
        ) : null}

        {!!st?.changes?.length && !running && (
          <div className="mt-4">
            <div className="mb-2 text-[11px] font-bold uppercase tracking-wider text-mute">Changed ({st.changes.length})</div>
            <ul className="max-h-60 divide-y divide-line overflow-y-auto rounded-xl border border-line text-[13px]">
              {st.changes.map((c) => (
                <li key={c.serviceId} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2">
                  <Link href={`/admin/services/${c.serviceId}`} className="font-bold text-primary-dark hover:underline">{c.hostname ?? c.serviceId}</Link>
                  <span className="font-mono text-xs text-mute">{c.linked && <span className="mr-1 rounded bg-sky-50 px-1.5 py-0.5 font-sans font-bold text-sky-700">linked to {c.linked}</span>}{c.before.join(", ") || "no IP"} → <span className="text-emerald-700">{c.after.join(", ") || "no IP"}</span>{c.os && <> · <span className="text-emerald-700">{c.os}</span></>}{c.node && ` · node ${c.node}`}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
        {!!st?.notLinked?.length && !running && (
          <div className="mt-4">
            <div className="mb-2 text-[11px] font-bold uppercase tracking-wider text-mute">Not linked to a VPS ({st.notLinked.length}) — open the service and set its Virtualizor VPS id</div>
            <ul className="max-h-48 divide-y divide-line overflow-y-auto rounded-xl border border-line text-[13px]">
              {st.notLinked.map((m) => (
                <li key={m.serviceId} className="flex flex-wrap items-center gap-x-3 px-4 py-2">
                  <Link href={`/admin/services/${m.serviceId}`} className="font-bold text-primary-dark hover:underline">{m.hostname ?? m.serviceId}</Link>
                  <span className="text-xs text-mute">{m.reason}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
        {!!st?.missing?.length && !running && (
          <div className="mt-4">
            <div className="mb-2 text-[11px] font-bold uppercase tracking-wider text-mute">Not found in Virtualizor ({st.missing.length}) — the VPS id on these services doesn&apos;t exist on their master</div>
            <ul className="max-h-48 divide-y divide-line overflow-y-auto rounded-xl border border-line text-[13px]">
              {st.missing.map((m) => (
                <li key={m.serviceId} className="flex flex-wrap items-center gap-x-3 px-4 py-2">
                  <Link href={`/admin/services/${m.serviceId}`} className="font-bold text-primary-dark hover:underline">{m.hostname ?? m.serviceId}</Link>
                  <span className="text-xs text-mute">VPS #{m.remoteId} · {m.server}</span>
                </li>
              ))}
            </ul>
          </div>
        )}

        {!!st?.duplicates?.length && !running && (
          <div className="mt-4">
            <div className="mb-2 text-[11px] font-bold uppercase tracking-wider text-mute">Same VPS id on several services ({st.duplicates.length}) — left unchanged; terminate the wrong one or correct its VPS id</div>
            <ul className="max-h-48 divide-y divide-line overflow-y-auto rounded-xl border border-amber-200 bg-amber-50/40 text-[13px]">
              {st.duplicates.map((d) => (
                <li key={d.server + d.remoteId} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2">
                  <span className="text-xs font-bold text-amber-800">VPS #{d.remoteId} · {d.server}:</span>
                  {d.services.map((x) => <Link key={x.serviceId} href={`/admin/services/${x.serviceId}`} className="font-bold text-primary-dark hover:underline">{x.hostname ?? x.serviceId}</Link>)}
                </li>
              ))}
            </ul>
          </div>
        )}

        <div className="mt-5 flex justify-end gap-2">
          <Button variant="ghost" onClick={() => setOpen(false)}>Close</Button>
          <Button icon="sync" loading={busy} disabled={running} onClick={start}>{st?.status === "done" ? "Sync again" : running ? "Syncing…" : "Start sync"}</Button>
        </div>
      </Modal>
    </>
  );
}
