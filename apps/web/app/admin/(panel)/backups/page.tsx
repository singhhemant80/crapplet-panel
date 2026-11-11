"use client";
import { useEffect, useState } from "react";
import { api, date } from "@/lib/api";
import { Alert, Badge, Button, Card, Field, Icon, Input, Loading, PageHeader, Select, Textarea, Toggle, cx, toast, useApi } from "@/components/ui";

const FREQ: Record<string, string> = { daily: "Every day", every12h: "Every 12 hours", every6h: "Every 6 hours", weekly: "Once a week" };
const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const DEST: Record<string, [string, string]> = {
  none: ["This server only", "dns"],
  s3: ["S3-compatible storage", "cloud_upload"],
  sftp: ["SFTP server", "terminal"],
  ftp: ["FTP / FTPS server", "lan"],
};

const size = (b?: number | null) => {
  if (b == null) return "—";
  const u = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  let n = b;
  while (n >= 1024 && i < u.length - 1) (n /= 1024), i++;
  return `${n.toFixed(n >= 10 || i === 0 ? 0 : 1)} ${u[i]}`;
};
const when = (d?: string | null) => (d ? new Date(d).toLocaleString("en-IN", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "Asia/Kolkata" }) : "—");
const ago = (d?: string | null) => {
  if (!d) return "never";
  const m = Math.round((Date.now() - new Date(d).getTime()) / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m} min ago`;
  if (m < 48 * 60) return `${Math.round(m / 60)} h ago`;
  return `${Math.round(m / 1440)} days ago`;
};

export default function BackupsPage() {
  const { data, loading, reload } = useApi("/admin/backups");
  const [starting, setStarting] = useState(false);
  // keep the list fresh while a backup runs
  useEffect(() => {
    if (!data?.running) return;
    const t = setInterval(reload, 3000);
    return () => clearInterval(t);
  }, [data?.running, reload]);

  if (loading || !data) return <Loading />;
  const c = data.config;
  const stale = !data.lastSuccessAt || Date.now() - new Date(data.lastSuccessAt).getTime() > 2 * 86400_000;

  async function runNow() {
    setStarting(true);
    try {
      await api("/admin/backups/run", { method: "POST" });
      toast.success("Backup started — it will appear below when it's ready");
      reload();
    } catch (e: any) {
      toast.error(e.message);
    } finally {
      setStarting(false);
    }
  }

  return (
    <>
      <PageHeader
        icon="backup"
        title="Database Backups"
        subtitle="Automatic and on-demand backups of the database and uploaded files — kept on this server and copied to your offsite storage."
        badge={<Badge status={c.enabled ? "ACTIVE" : "CANCELLED"}>{c.enabled ? "Automatic on" : "Automatic off"}</Badge>}
        actions={
          <Button icon="backup" loading={starting || data.running} onClick={runNow} disabled={data.running}>
            {data.running ? "Backing up…" : "Back up now"}
          </Button>
        }
        stats={[
          ["Last backup", <span key="l" className={stale ? "text-rose-600" : ""}>{ago(data.lastSuccessAt)}</span>, data.lastSuccessAt ? when(data.lastSuccessAt) : "no backup yet"],
          ["Next automatic", c.enabled && data.nextAt ? when(data.nextAt) : "Off", c.enabled ? FREQ[c.frequency] : undefined],
          ["Offsite copy", DEST[c.destination.type][0], c.destination.type === "none" ? "add one below" : `keep last ${c.destination.keepRemote || "all"}`],
          ["Stored here", size(data.storedBytes), data.disk ? `${size(data.disk.free)} disk free` : undefined],
        ]}
      />
      {stale && !data.running && (
        <Alert tone="warn" className="mb-5">
          {data.lastSuccessAt ? `The last successful backup was ${ago(data.lastSuccessAt)}.` : "No backup has been made yet."} Click <b>Back up now</b> to make one, and check the worker is running (<code>pm2 status crapplet-worker</code>).
        </Alert>
      )}
      <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_420px]">
        <History data={data} reload={reload} />
        <div className="space-y-5">
          <Schedule c={c} onSaved={reload} />
          <Destination c={c} onSaved={reload} />
          <Restore dir={c.directory} />
        </div>
      </div>
    </>
  );
}

function History({ data, reload }: { data: any; reload: () => void }) {
  const [del, setDel] = useState<string | null>(null);
  async function download(r: any) {
    try {
      await api("/auth/me").catch(() => undefined); // refreshes the session cookie if it expired
      window.location.href = `/api/admin/backups/${r.id}/download`;
    } catch (e: any) {
      toast.error(e.message);
    }
  }
  async function remove(r: any) {
    if (del !== r.id) return setDel(r.id);
    try {
      await api(`/admin/backups/${r.id}`, { method: "DELETE" });
      toast.success("Backup deleted");
      setDel(null);
      reload();
    } catch (e: any) {
      toast.error(e.message);
    }
  }
  return (
    <Card title="Backups" pad={false} action={<span className="text-[12.5px] font-semibold text-slate-500">{data.runs.length} shown</span>}>
      {data.runs.length === 0 ? (
        <div className="px-5 py-12 text-center">
          <Icon name="cloud_off" className="text-[40px] text-slate-300" />
          <p className="mt-2 font-bold text-ink">No backups yet</p>
          <p className="mt-1 text-[13px] text-slate-500">Click “Back up now” to make the first one.</p>
        </div>
      ) : (
        <ul className="divide-y divide-line">
          {data.runs.map((r: any) => (
            <li key={r.id} className="flex flex-col gap-3 px-4 py-3.5 sm:flex-row sm:items-center sm:px-5">
              <div className={cx("grid h-10 w-10 shrink-0 place-items-center rounded-xl", r.status === "FAILED" ? "bg-rose-50 text-rose-600" : r.status === "RUNNING" ? "bg-sky-50 text-sky-600" : r.error ? "bg-amber-50 text-amber-600" : "bg-emerald-50 text-emerald-600")}>
                <Icon name={r.status === "FAILED" ? "error" : r.status === "RUNNING" ? "progress_activity" : r.error ? "warning" : "task_alt"} className={cx("text-[22px]", r.status === "RUNNING" && "animate-spin")} />
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-bold text-ink">{when(r.startedAt)}</span>
                  <Badge status={r.status} />
                  <span className="rounded-md bg-slate-100 px-1.5 py-0.5 text-[11px] font-bold uppercase text-slate-500">{r.trigger === "schedule" ? "automatic" : "manual"}</span>
                </div>
                <div className="mt-0.5 flex flex-wrap gap-x-3 gap-y-0.5 text-[12.5px] text-slate-500">
                  {r.fileName && <span className="truncate font-mono">{r.fileName}</span>}
                  {r.sizeBytes != null && <span>{size(r.sizeBytes)}</span>}
                  {r.status === "COMPLETED" && <span>{r.includesUploads ? "database + files" : "database only"}</span>}
                  {r.finishedAt && <span>took {Math.max(1, Math.round((new Date(r.finishedAt).getTime() - new Date(r.startedAt).getTime()) / 1000))}s</span>}
                </div>
                {(r.destinations ?? []).length > 0 && (
                  <div className="mt-1.5 flex flex-wrap gap-1.5">
                    {r.destinations.map((d: any, i: number) => (
                      <span key={i} title={d.error ?? d.location} className={cx("inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11.5px] font-bold", d.ok ? "bg-emerald-50 text-emerald-700" : "bg-rose-50 text-rose-700")}>
                        <Icon name={d.ok ? "check" : "close"} className="text-[14px]" />
                        {d.type === "local" ? (r.available ? "this server" : "this server (removed)") : d.type.toUpperCase()}
                      </span>
                    ))}
                  </div>
                )}
                {r.status === "FAILED" && r.error && <p className="mt-1.5 break-words rounded-lg bg-rose-50 px-2.5 py-1.5 font-mono text-[12px] text-rose-700">{r.error}</p>}
                {r.status === "COMPLETED" && (r.destinations ?? []).some((d: any) => !d.ok) && (
                  <p className="mt-1.5 break-words text-[12px] text-amber-700">{r.destinations.filter((d: any) => !d.ok).map((d: any) => `${d.type.toUpperCase()}: ${d.error}`).join(" · ")}</p>
                )}
              </div>
              <div className="flex shrink-0 gap-2">
                {r.available && (
                  <Button size="sm" icon="download" onClick={() => download(r)}>
                    Download
                  </Button>
                )}
                {r.status !== "RUNNING" && (
                  <Button size="sm" variant={del === r.id ? "danger" : "ghost"} icon="delete" onClick={() => remove(r)}>
                    {del === r.id ? "Confirm" : ""}
                  </Button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function Schedule({ c, onSaved }: { c: any; onSaved: () => void }) {
  const [f, setF] = useState({ enabled: c.enabled, frequency: c.frequency, runAt: c.runAt, weekday: c.weekday, includeUploads: c.includeUploads, keepLocal: c.keepLocal });
  const [busy, setBusy] = useState(false);
  async function save() {
    setBusy(true);
    try {
      await api("/admin/backups/settings", { method: "PUT", body: { ...f, keepLocal: Number(f.keepLocal) } });
      toast.success("Backup schedule saved");
      onSaved();
    } catch (e: any) {
      toast.error(e.message);
    } finally {
      setBusy(false);
    }
  }
  const timed = f.frequency === "daily" || f.frequency === "weekly";
  return (
    <Card title={<span className="inline-flex items-center gap-2"><Icon name="event_repeat" className="text-[20px] text-primary" />Automatic backups</span>}>
      <div className="space-y-4">
        <Toggle checked={f.enabled} onChange={(v) => setF({ ...f, enabled: v })} label="Make backups automatically" />
        <div className={cx("grid gap-3 sm:grid-cols-2", !f.enabled && "pointer-events-none opacity-50")}>
          <Field label="How often">
            <Select value={f.frequency} onChange={(e) => setF({ ...f, frequency: e.target.value })}>
              {Object.entries(FREQ).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </Select>
          </Field>
          {f.frequency === "weekly" && (
            <Field label="Day">
              <Select value={f.weekday} onChange={(e) => setF({ ...f, weekday: Number(e.target.value) })}>
                {DAYS.map((d, i) => <option key={d} value={i}>{d}</option>)}
              </Select>
            </Field>
          )}
          {timed && (
            <Field label="Time (IST)">
              <Input type="time" value={f.runAt} onChange={(e) => setF({ ...f, runAt: e.target.value })} />
            </Field>
          )}
        </div>
        <Field label="Keep on this server" hint="Older backups are deleted automatically.">
          <div className="flex items-center gap-2">
            <div className="w-24 shrink-0"><Input type="number" min={1} max={365} value={f.keepLocal} onChange={(e) => setF({ ...f, keepLocal: e.target.value as any })} /></div>
            <span className="whitespace-nowrap text-[13px] text-slate-500">latest backups</span>
          </div>
        </Field>
        <Toggle checked={f.includeUploads} onChange={(v) => setF({ ...f, includeUploads: v })} label="Include uploaded files (invoice PDFs, ticket attachments)" />
        <Button icon="save" loading={busy} onClick={save} className="w-full sm:w-auto">Save schedule</Button>
      </div>
    </Card>
  );
}

function Destination({ c, onSaved }: { c: any; onSaved: () => void }) {
  const [d, setD] = useState<any>(() => structuredClone(c.destination));
  const [sec, setSec] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);
  const set = (k: string, f: string, v: any) => setD((x: any) => ({ ...x, [k]: { ...x[k], [f]: v } }));
  const secret = (k: string) => (sec[k] !== undefined ? sec[k] : "");
  const savedHint = (k: string) => (c.saved[k] ? "Saved — leave blank to keep it" : undefined);

  async function save(andTest = false) {
    setBusy(true);
    setResult(null);
    try {
      const secrets = Object.fromEntries(Object.entries(sec).filter(([, v]) => v !== ""));
      await api("/admin/backups/settings", {
        method: "PUT",
        body: { destination: { ...d, keepRemote: Number(d.keepRemote), sftp: { ...d.sftp, port: Number(d.sftp.port) }, ftp: { ...d.ftp, port: Number(d.ftp.port) } }, ...(Object.keys(secrets).length ? { secrets } : {}) },
      });
      setSec({});
      onSaved();
      if (andTest && d.type !== "none") {
        setTesting(true);
        const r = await api("/admin/backups/test-destination", { method: "POST" });
        setResult(r);
      } else toast.success("Destination saved");
    } catch (e: any) {
      toast.error(e.message);
    } finally {
      setBusy(false);
      setTesting(false);
    }
  }

  return (
    <Card title={<span className="inline-flex items-center gap-2"><Icon name="cloud_sync" className="text-[20px] text-primary" />Offsite destination</span>}>
      <div className="space-y-4">
        <div className="grid grid-cols-2 gap-2">
          {Object.entries(DEST).map(([k, [label, icon]]) => (
            <button key={k} type="button" onClick={() => { setD({ ...d, type: k }); setResult(null); }} className={cx("flex items-center gap-2 rounded-xl px-3 py-2.5 text-left text-[13px] font-bold ring-1 transition", d.type === k ? "bg-primary/10 text-primary-dark ring-primary" : "bg-white text-slate-600 ring-line hover:ring-primary/50")}>
              <Icon name={icon} className="text-[19px]" />
              <span className="min-w-0 leading-tight">{label}</span>
            </button>
          ))}
        </div>

        {d.type === "none" && <p className="text-[13px] text-slate-500">Backups stay only on this server. Add an offsite copy so you can recover if the server itself is lost.</p>}

        {d.type === "s3" && (
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Endpoint" hint="Blank for AWS. e.g. https://s3.us-west-004.backblazeb2.com, https://s3.wasabisys.com, https://<account>.r2.cloudflarestorage.com" className="sm:col-span-2">
              <Input value={d.s3.endpoint} onChange={(e) => set("s3", "endpoint", e.target.value)} placeholder="https://…" />
            </Field>
            <Field label="Bucket"><Input value={d.s3.bucket} onChange={(e) => set("s3", "bucket", e.target.value)} /></Field>
            <Field label="Region"><Input value={d.s3.region} onChange={(e) => set("s3", "region", e.target.value)} placeholder="us-east-1 / auto" /></Field>
            <Field label="Folder (prefix)"><Input value={d.s3.prefix} onChange={(e) => set("s3", "prefix", e.target.value)} /></Field>
            <Field label="Access key ID"><Input value={d.s3.accessKeyId} onChange={(e) => set("s3", "accessKeyId", e.target.value)} autoComplete="off" /></Field>
            <Field label="Secret access key" hint={savedHint("s3Secret")} className="sm:col-span-2">
              <Input type="password" value={secret("s3Secret")} onChange={(e) => setSec({ ...sec, s3Secret: e.target.value })} autoComplete="new-password" placeholder={c.saved.s3Secret ? "••••••••" : ""} />
            </Field>
            <div className="sm:col-span-2"><Toggle checked={!!d.s3.forcePathStyle} onChange={(v) => set("s3", "forcePathStyle", v)} label="Path-style URLs (MinIO and some providers)" /></div>
          </div>
        )}

        {d.type === "sftp" && (
          <div className="grid gap-3 sm:grid-cols-[1fr_96px]">
            <Field label="Host"><Input value={d.sftp.host} onChange={(e) => set("sftp", "host", e.target.value)} placeholder="backup.example.com" /></Field>
            <Field label="Port"><Input type="number" value={d.sftp.port} onChange={(e) => set("sftp", "port", e.target.value)} /></Field>
            <Field label="Username" className="sm:col-span-2"><Input value={d.sftp.username} onChange={(e) => set("sftp", "username", e.target.value)} autoComplete="off" /></Field>
            <Field label="Password" hint={savedHint("sftpPassword")} className="sm:col-span-2">
              <Input type="password" value={secret("sftpPassword")} onChange={(e) => setSec({ ...sec, sftpPassword: e.target.value })} autoComplete="new-password" placeholder={c.saved.sftpPassword ? "••••••••" : ""} />
            </Field>
            <Field label="…or private key" hint={c.saved.sftpKey ? "A key is saved — paste a new one to replace it" : "Used instead of the password when set (OpenSSH format, no passphrase)"} className="sm:col-span-2">
              <Textarea rows={3} value={secret("sftpKey")} onChange={(e) => setSec({ ...sec, sftpKey: e.target.value })} placeholder="-----BEGIN OPENSSH PRIVATE KEY-----" className="font-mono text-[12px]" />
            </Field>
            <Field label="Remote folder" className="sm:col-span-2"><Input value={d.sftp.path} onChange={(e) => set("sftp", "path", e.target.value)} /></Field>
          </div>
        )}

        {d.type === "ftp" && (
          <div className="grid gap-3 sm:grid-cols-[1fr_96px]">
            <Field label="Host"><Input value={d.ftp.host} onChange={(e) => set("ftp", "host", e.target.value)} placeholder="ftp.example.com" /></Field>
            <Field label="Port"><Input type="number" value={d.ftp.port} onChange={(e) => set("ftp", "port", e.target.value)} /></Field>
            <Field label="Username" className="sm:col-span-2"><Input value={d.ftp.username} onChange={(e) => set("ftp", "username", e.target.value)} autoComplete="off" /></Field>
            <Field label="Password" hint={savedHint("ftpPassword")} className="sm:col-span-2">
              <Input type="password" value={secret("ftpPassword")} onChange={(e) => setSec({ ...sec, ftpPassword: e.target.value })} autoComplete="new-password" placeholder={c.saved.ftpPassword ? "••••••••" : ""} />
            </Field>
            <Field label="Remote folder" className="sm:col-span-2"><Input value={d.ftp.path} onChange={(e) => set("ftp", "path", e.target.value)} /></Field>
            <div className="sm:col-span-2"><Toggle checked={!!d.ftp.secure} onChange={(v) => set("ftp", "secure", v)} label="Use FTPS (TLS) — recommended" /></div>
          </div>
        )}

        {d.type !== "none" && (
          <Field label="Keep at destination" hint="0 keeps every backup there.">
            <div className="flex items-center gap-2">
              <div className="w-24 shrink-0"><Input type="number" min={0} value={d.keepRemote} onChange={(e) => setD({ ...d, keepRemote: e.target.value })} /></div>
              <span className="whitespace-nowrap text-[13px] text-slate-500">latest backups</span>
            </div>
          </Field>
        )}

        {result && <Alert tone={result.ok ? "success" : "error"}><span className="break-words">{result.ok ? `Connection works. ${result.message}` : result.message}</span></Alert>}

        <div className="flex flex-wrap gap-2">
          <Button icon="save" loading={busy && !testing} onClick={() => save(false)}>Save</Button>
          {d.type !== "none" && <Button variant="secondary" icon="network_check" loading={testing} onClick={() => save(true)}>Save &amp; test</Button>}
        </div>
      </div>
    </Card>
  );
}

function Restore({ dir }: { dir: string }) {
  const [open, setOpen] = useState(false);
  return (
    <Card title={<span className="inline-flex items-center gap-2"><Icon name="settings_backup_restore" className="text-[20px] text-primary" />Restoring a backup</span>} action={<button className="text-[12.5px] font-bold text-primary-dark" onClick={() => setOpen(!open)}>{open ? "Hide" : "Show steps"}</button>}>
      <p className="text-[13px] text-slate-600">
        Backups are saved in <code className="break-all rounded bg-slate-100 px-1">{dir}</code>. Each file holds <b>db.dump</b> (PostgreSQL), <b>uploads.tgz</b> and a manifest.
      </p>
      {open && (
        <pre className="mt-3 overflow-x-auto rounded-xl bg-slate-900 p-3 text-[11.5px] leading-relaxed text-slate-100">{`cd /tmp && mkdir restore && cd restore
tar -xf /path/to/crapplet-backup-XXXX.tar
pm2 stop crapplet-api crapplet-worker
set -a; . /opt/crapplet-panel/apps/api/.env; set +a
pg_restore --clean --if-exists --no-owner \\
  -d "\${DATABASE_URL%%\\?*}" db.dump
tar -xzf uploads.tgz -C "$UPLOAD_DIR"
pm2 start crapplet-api crapplet-worker`}</pre>
      )}
    </Card>
  );
}
