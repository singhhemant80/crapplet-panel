/**
 * Database backups — automatic (daily / every N hours) and "Back up now", kept on this server and
 * optionally copied to S3-compatible storage (AWS S3, Backblaze B2, Wasabi, DigitalOcean Spaces,
 * Cloudflare R2), SFTP or FTP.
 *
 * Each backup is one file: crapplet-backup-YYYYMMDD-HHMM.tar containing
 *   db.dump        pg_dump custom format (restore with pg_restore)
 *   uploads.tgz    uploaded files (invoices, ticket attachments, client files) — optional
 *   manifest.json  what's inside, app version, sizes
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { prisma } from "../../db";
import { config } from "../../config";
import { decrypt, encrypt } from "../../lib/crypto";
import { istDayStart } from "../../lib/money";

export const BACKUP_DIR = process.env.BACKUP_DIR ?? (fs.existsSync("/var/backups/crapplet") ? "/var/backups/crapplet" : path.resolve(config.uploadDir, "..", "backups"));
export const FILE_RE = /^crapplet-backup-\d{8}-\d{4,6}\.tar$/;

export type DestType = "none" | "s3" | "sftp" | "ftp";
export type Frequency = "times" | "daily" | "every1h" | "every2h" | "every3h" | "every4h" | "every6h" | "every12h" | "weekly";
export const EVERY_HOURS: Partial<Record<Frequency, number>> = { every1h: 1, every2h: 2, every3h: 3, every4h: 4, every6h: 6, every12h: 12 };
export interface BackupConfig {
  enabled: boolean;
  frequency: Frequency;
  runAt: string; // HH:MM IST (daily / weekly)
  /** HH:MM IST, several a day (frequency "times") */
  times: string[];
  weekday: number; // 0 = Sunday (weekly)
  includeUploads: boolean;
  keepLocal: number;
  destination: {
    type: DestType;
    keepRemote: number;
    s3: { endpoint: string; region: string; bucket: string; prefix: string; accessKeyId: string; forcePathStyle: boolean };
    sftp: { host: string; port: number; username: string; path: string };
    ftp: { host: string; port: number; username: string; path: string; secure: boolean };
  };
  /** also email each backup (encrypted) — on top of this server and the offsite destination */
  email: { enabled: boolean; to: string; maxMb: number };
  /** encrypted { s3Secret?, sftpPassword?, sftpKey?, ftpPassword?, emailPassphrase? } */
  secretsEnc?: string | null;
}
type Secrets = { s3Secret?: string; sftpPassword?: string; sftpKey?: string; ftpPassword?: string; emailPassphrase?: string };

const DEFAULTS: BackupConfig = {
  enabled: true,
  frequency: "daily",
  runAt: "03:00",
  times: ["03:00", "15:00"],
  weekday: 0,
  includeUploads: true,
  keepLocal: 14,
  destination: {
    type: "none",
    keepRemote: 30,
    s3: { endpoint: "", region: "us-east-1", bucket: "", prefix: "crapplet-backups/", accessKeyId: "", forcePathStyle: false },
    sftp: { host: "", port: 22, username: "", path: "/backups/crapplet" },
    ftp: { host: "", port: 21, username: "", path: "/backups/crapplet", secure: true },
  },
  email: { enabled: false, to: "", maxMb: 18 },
};

export async function getBackupConfig(): Promise<BackupConfig> {
  const row = await prisma.setting.findUnique({ where: { key: "backup" } });
  const v = (row?.value ?? {}) as Partial<BackupConfig>;
  const d = (v.destination ?? {}) as Partial<BackupConfig["destination"]>;
  return {
    ...DEFAULTS,
    ...v,
    times: normTimes(v.times ?? DEFAULTS.times),
    email: { ...DEFAULTS.email, ...(v.email ?? {}) },
    destination: { ...DEFAULTS.destination, ...d, s3: { ...DEFAULTS.destination.s3, ...(d.s3 ?? {}) }, sftp: { ...DEFAULTS.destination.sftp, ...(d.sftp ?? {}) }, ftp: { ...DEFAULTS.destination.ftp, ...(d.ftp ?? {}) } },
  };
}
/** "9:5" / duplicates / junk → sorted unique "HH:MM" */
export function normTimes(list: unknown): string[] {
  const out = new Set<string>();
  for (const t of Array.isArray(list) ? list : []) {
    const m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(String(t).trim());
    if (m) out.add(`${m[1].padStart(2, "0")}:${m[2]}`);
  }
  return [...out].sort().slice(0, 24);
}
const secretsOf = (c: BackupConfig): Secrets => (c.secretsEnc ? JSON.parse(decrypt(c.secretsEnc)) : {});

export async function saveBackupConfig(patch: Partial<BackupConfig> & { secrets?: Partial<Record<keyof Secrets, string | null>> }) {
  const cur = await getBackupConfig();
  const { secrets, ...rest } = patch;
  const d = (rest.destination ?? {}) as Partial<BackupConfig["destination"]>;
  const s = secretsOf(cur);
  // undefined = keep, "" / null = clear
  for (const [k, v] of Object.entries(secrets ?? {})) if (v !== undefined) (s as Record<string, string | undefined>)[k] = v || undefined;
  const next: BackupConfig = {
    ...cur,
    ...rest,
    times: rest.times ? normTimes(rest.times) : cur.times,
    email: { ...cur.email, ...(rest.email ?? {}) },
    destination: { ...cur.destination, ...d, s3: { ...cur.destination.s3, ...(d.s3 ?? {}) }, sftp: { ...cur.destination.sftp, ...(d.sftp ?? {}) }, ftp: { ...cur.destination.ftp, ...(d.ftp ?? {}) } },
    secretsEnc: Object.values(s).some(Boolean) ? encrypt(JSON.stringify(s)) : null,
  };
  await prisma.setting.upsert({ where: { key: "backup" }, update: { value: next as never }, create: { key: "backup", value: next as never } });
  return next;
}

export function redactBackup(c: BackupConfig) {
  const { secretsEnc, ...rest } = c;
  const s = secretsOf(c);
  return { ...rest, saved: { s3Secret: !!s.s3Secret, sftpPassword: !!s.sftpPassword, sftpKey: !!s.sftpKey, ftpPassword: !!s.ftpPassword, emailPassphrase: !!s.emailPassphrase }, directory: BACKUP_DIR };
}

// ───────────────────────── making a backup ─────────────────────────

export function run(cmd: string, args: string[], opts: { env?: NodeJS.ProcessEnv; cwd?: string } = {}) {
  return new Promise<void>((resolve, reject) => {
    const p = spawn(cmd, args, { env: opts.env ?? process.env, cwd: opts.cwd, stdio: ["ignore", "ignore", "pipe"] });
    let err = "";
    p.stderr.on("data", (d) => (err += d));
    p.on("error", (e) => reject(new Error(`${cmd}: ${e.message}`)));
    p.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} failed (${code}): ${err.trim().slice(-600)}`))));
  });
}

/** postgres://user:pass@host:port/db?schema=… → pieces pg_dump understands (password via env, not argv) */
export function pgArgs(url: string) {
  const u = new URL(url);
  const args = ["--format=custom", "--no-owner", "--no-privileges", "-h", u.hostname || "localhost", "-p", u.port || "5432", "-U", decodeURIComponent(u.username), "-d", decodeURIComponent(u.pathname.replace(/^\//, ""))];
  const schema = u.searchParams.get("schema");
  if (schema && schema !== "public") args.push("-n", schema);
  return { args, env: { ...process.env, PGPASSWORD: decodeURIComponent(u.password), PGSSLMODE: u.searchParams.get("sslmode") ?? process.env.PGSSLMODE ?? "prefer" } };
}

export const stamp = (d = new Date()) => {
  const x = new Date(d.getTime() + 330 * 60_000).toISOString();
  return `${x.slice(0, 10).replace(/-/g, "")}-${x.slice(11, 19).replace(/:/g, "")}`;
};

export async function createBackup(opts: { trigger: "schedule" | "manual" | "pre-restore"; actorId?: string; runId?: string }) {
  const cfg = await getBackupConfig();
  const runRow = opts.runId
    ? await prisma.backupRun.update({ where: { id: opts.runId }, data: { status: "RUNNING" } })
    : await prisma.backupRun.create({ data: { trigger: opts.trigger, triggeredBy: opts.actorId } });
  const work = await fs.promises.mkdtemp(path.join(os.tmpdir(), "crapplet-backup-"));
  try {
    await fs.promises.mkdir(BACKUP_DIR, { recursive: true });
    // never reuse a name — two backups in the same second (e.g. the safety copy before a restore) would overwrite
    let name = `crapplet-backup-${stamp()}.tar`;
    for (let i = 1; fs.existsSync(path.join(BACKUP_DIR, name)) || fs.existsSync(path.join(BACKUP_DIR, `.${name}.part`)); i++) name = `crapplet-backup-${stamp(new Date(Date.now() + i * 1000))}.tar`;
    // 1. database
    const pg = pgArgs(config.databaseUrl);
    await run("pg_dump", [...pg.args, "-f", path.join(work, "db.dump")], { env: pg.env });
    // 2. uploads (skip WHMCS dumps and anything huge that isn't the business's files)
    const uploads = path.resolve(config.uploadDir);
    let withUploads = false;
    if (cfg.includeUploads && fs.existsSync(uploads)) {
      await run("tar", ["-czf", path.join(work, "uploads.tgz"), "--exclude=./whmcs-dumps", "--exclude=./virtualizor-sync-all.json", "-C", uploads, "."]);
      withUploads = true;
    }
    // 3. manifest + one archive
    const sizes = Object.fromEntries(await Promise.all(["db.dump", "uploads.tgz"].filter((f) => fs.existsSync(path.join(work, f))).map(async (f) => [f, (await fs.promises.stat(path.join(work, f))).size])));
    await fs.promises.writeFile(path.join(work, "manifest.json"), JSON.stringify({ app: "crapplet-panel", createdAt: new Date().toISOString(), host: os.hostname(), files: sizes, restore: "pg_restore --clean --if-exists --no-owner -d \"$DATABASE_URL\" db.dump ; tar -xzf uploads.tgz -C \"$UPLOAD_DIR\"" }, null, 2));
    const tmpOut = path.join(BACKUP_DIR, `.${name}.part`);
    await run("tar", ["-cf", tmpOut, "-C", work, ...Object.keys(sizes), "manifest.json"]);
    await fs.promises.rename(tmpOut, path.join(BACKUP_DIR, name));
    const size = (await fs.promises.stat(path.join(BACKUP_DIR, name))).size;

    // 4. remote copy
    const destinations: { type: string; ok: boolean; location?: string; error?: string }[] = [{ type: "local", ok: true, location: path.join(BACKUP_DIR, name) }];
    if (cfg.destination.type !== "none") {
      try {
        const loc = await uploadRemote(cfg, path.join(BACKUP_DIR, name), name);
        destinations.push({ type: cfg.destination.type, ok: true, location: loc });
        await pruneRemote(cfg).catch((e) => destinations.push({ type: `${cfg.destination.type} cleanup`, ok: false, error: (e as Error).message }));
      } catch (e) {
        destinations.push({ type: cfg.destination.type, ok: false, error: (e as Error).message.slice(0, 500) });
      }
    }
    if (cfg.email.enabled) {
      try {
        destinations.push({ type: "email", ok: true, location: await emailBackup(cfg, path.join(BACKUP_DIR, name), name, work) });
      } catch (e) {
        destinations.push({ type: "email", ok: false, error: (e as Error).message.slice(0, 500) });
      }
    }
    const remoteFailed = destinations.some((d) => !d.ok);
    const done = await prisma.backupRun.update({
      where: { id: runRow.id },
      data: { status: "COMPLETED", fileName: name, sizeBytes: BigInt(size), includesUploads: withUploads, destinations, finishedAt: new Date(), error: remoteFailed ? `Saved on this server, but ${destinations.filter((d) => !d.ok).map((d) => (d.type === "email" ? "the email copy" : "the remote copy")).join(" and ")} failed` : null },
    });
    await pruneLocal(cfg.keepLocal);
    return done;
  } catch (e) {
    await prisma.backupRun.update({ where: { id: runRow.id }, data: { status: "FAILED", error: String((e as Error).message).slice(0, 2000), finishedAt: new Date() } });
    throw e;
  } finally {
    await fs.promises.rm(work, { recursive: true, force: true });
  }
}

/** keep the newest N backup files on this server */
async function pruneLocal(keep: number) {
  if (!(keep > 0)) return;
  const files = (await fs.promises.readdir(BACKUP_DIR)).filter((f) => FILE_RE.test(f)).sort().reverse();
  for (const f of files.slice(keep)) {
    await fs.promises.rm(path.join(BACKUP_DIR, f), { force: true });
    await prisma.backupRun.updateMany({ where: { fileName: f }, data: { deletedAt: new Date() } });
  }
}

export function backupPath(fileName: string) {
  if (!FILE_RE.test(fileName)) throw new Error("Bad backup name");
  return path.join(BACKUP_DIR, fileName);
}

// ───────────────────────── destinations ─────────────────────────

const joinRemote = (dir: string, name: string) => `${dir.replace(/\/+$/, "")}/${name}`;

async function s3Client(cfg: BackupConfig) {
  const { S3Client } = await import("@aws-sdk/client-s3");
  const s = cfg.destination.s3;
  return new S3Client({ region: s.region || "us-east-1", ...(s.endpoint ? { endpoint: s.endpoint } : {}), forcePathStyle: s.forcePathStyle, credentials: { accessKeyId: s.accessKeyId, secretAccessKey: secretsOf(cfg).s3Secret ?? "" } });
}
async function sftpClient(cfg: BackupConfig) {
  const Sftp = (await import("ssh2-sftp-client")).default;
  const c = new Sftp();
  const s = cfg.destination.sftp;
  const sec = secretsOf(cfg);
  await c.connect({ host: s.host, port: s.port || 22, username: s.username, ...(sec.sftpKey ? { privateKey: sec.sftpKey } : { password: sec.sftpPassword }), readyTimeout: 20_000 });
  return c;
}
async function ftpClient(cfg: BackupConfig) {
  const { Client } = await import("basic-ftp");
  const c = new Client(30_000);
  const f = cfg.destination.ftp;
  await c.access({ host: f.host, port: f.port || 21, user: f.username, password: secretsOf(cfg).ftpPassword, secure: f.secure, secureOptions: { rejectUnauthorized: false } });
  return c;
}

async function uploadRemote(cfg: BackupConfig, file: string, name: string): Promise<string> {
  const d = cfg.destination;
  if (d.type === "s3") {
    const { Upload } = await import("@aws-sdk/lib-storage");
    const key = `${d.s3.prefix ?? ""}${name}`;
    await new Upload({ client: await s3Client(cfg), params: { Bucket: d.s3.bucket, Key: key, Body: fs.createReadStream(file), ContentType: "application/x-tar" }, partSize: 16 * 1024 * 1024, queueSize: 2 }).done();
    return `s3://${d.s3.bucket}/${key}`;
  }
  if (d.type === "sftp") {
    const c = await sftpClient(cfg);
    try {
      await c.mkdir(d.sftp.path, true).catch(() => undefined);
      await c.fastPut(file, joinRemote(d.sftp.path, name));
    } finally {
      await c.end().catch(() => undefined);
    }
    return `sftp://${d.sftp.host}${joinRemote(d.sftp.path, name)}`;
  }
  if (d.type === "ftp") {
    const c = await ftpClient(cfg);
    try {
      await c.ensureDir(d.ftp.path);
      await c.uploadFrom(file, name);
    } finally {
      c.close();
    }
    return `ftp://${d.ftp.host}${joinRemote(d.ftp.path, name)}`;
  }
  throw new Error("No remote destination");
}

/** keep the newest N backups at the remote destination */
async function pruneRemote(cfg: BackupConfig) {
  const d = cfg.destination;
  const keep = d.keepRemote;
  if (!(keep > 0)) return;
  if (d.type === "s3") {
    const { ListObjectsV2Command, DeleteObjectCommand } = await import("@aws-sdk/client-s3");
    const c = await s3Client(cfg);
    const r = await c.send(new ListObjectsV2Command({ Bucket: d.s3.bucket, Prefix: d.s3.prefix ?? "" }));
    const keys = (r.Contents ?? []).map((o) => o.Key!).filter((k) => FILE_RE.test(k.split("/").pop() ?? "")).sort().reverse();
    for (const k of keys.slice(keep)) await c.send(new DeleteObjectCommand({ Bucket: d.s3.bucket, Key: k }));
  } else if (d.type === "sftp") {
    const c = await sftpClient(cfg);
    try {
      const names = (await c.list(d.sftp.path)).map((x) => x.name).filter((n) => FILE_RE.test(n)).sort().reverse();
      for (const n of names.slice(keep)) await c.delete(joinRemote(d.sftp.path, n));
    } finally {
      await c.end().catch(() => undefined);
    }
  } else if (d.type === "ftp") {
    const c = await ftpClient(cfg);
    try {
      await c.cd(d.ftp.path);
      const names = (await c.list()).map((x) => x.name).filter((n) => FILE_RE.test(n)).sort().reverse();
      for (const n of names.slice(keep)) await c.remove(n);
    } finally {
      c.close();
    }
  }
}

/** Check the remote destination works: upload, then delete, a small file. */
export async function testDestination() {
  const cfg = await getBackupConfig();
  if (cfg.destination.type === "none") throw new Error("Choose a destination first");
  const tmp = path.join(os.tmpdir(), `crapplet-backup-test-${Date.now()}.txt`);
  await fs.promises.writeFile(tmp, `Crapplet backup destination test ${new Date().toISOString()}\n`);
  const name = path.basename(tmp);
  try {
    const d = cfg.destination;
    if (d.type === "s3") {
      const { Upload } = await import("@aws-sdk/lib-storage");
      const { DeleteObjectCommand } = await import("@aws-sdk/client-s3");
      const c = await s3Client(cfg);
      const key = `${d.s3.prefix ?? ""}${name}`;
      await new Upload({ client: c, params: { Bucket: d.s3.bucket, Key: key, Body: fs.createReadStream(tmp) } }).done();
      await c.send(new DeleteObjectCommand({ Bucket: d.s3.bucket, Key: key }));
      return `Wrote and removed s3://${d.s3.bucket}/${key}`;
    }
    if (d.type === "sftp") {
      const c = await sftpClient(cfg);
      try {
        await c.mkdir(d.sftp.path, true).catch(() => undefined);
        await c.put(tmp, joinRemote(d.sftp.path, name));
        await c.delete(joinRemote(d.sftp.path, name));
      } finally {
        await c.end().catch(() => undefined);
      }
      return `Wrote and removed ${joinRemote(d.sftp.path, name)} on ${d.sftp.host}`;
    }
    const c = await ftpClient(cfg);
    try {
      await c.ensureDir(d.ftp.path);
      await c.uploadFrom(tmp, name);
      await c.remove(name);
    } finally {
      c.close();
    }
    return `Wrote and removed ${joinRemote(d.ftp.path, name)} on ${d.ftp.host}`;
  } finally {
    await fs.promises.rm(tmp, { force: true });
  }
}

// ───────────────────────── schedule ─────────────────────────

/** When the next automatic backup is due (null = off). */
export async function nextBackupAt(cfg?: BackupConfig, now = new Date()): Promise<Date | null> {
  const c = cfg ?? (await getBackupConfig());
  if (!c.enabled) return null;
  const last = await prisma.backupRun.findFirst({ where: { trigger: "schedule", status: "COMPLETED" }, orderBy: { startedAt: "desc" }, select: { startedAt: true } });
  return nextSlot(c, last, now);
}

/** Pure: given the schedule and the last automatic backup, when the next one is due. */
export function nextSlot(c: Pick<BackupConfig, "enabled" | "frequency" | "runAt" | "times" | "weekday">, last: { startedAt: Date } | null, now = new Date()): Date | null {
  if (!c.enabled) return null;
  const every = EVERY_HOURS[c.frequency];
  if (every) return last ? new Date(last.startedAt.getTime() + every * 3600_000) : now;
  const mins = (t: string) => {
    const [hh, mm] = (/^(\d{1,2}):(\d{2})$/.exec(t) ?? ["", "3", "0"]).slice(1).map(Number);
    return hh * 60 + mm;
  };
  const today = istDayStart(now);
  if (c.frequency === "times") {
    const slots = (c.times.length ? c.times : [c.runAt]).map(mins);
    const all = [-1, 0, 1].flatMap((d) => slots.map((m) => today.getTime() + d * 86400_000 + m * 60_000)).sort((a, b) => a - b);
    const latestPast = all.filter((t) => t <= now.getTime()).pop();
    // the most recent slot hasn't been done yet (server was busy / down) → now
    if (latestPast !== undefined && (!last || last.startedAt.getTime() < latestPast - 2 * 60_000)) return new Date(latestPast);
    return new Date(all.find((t) => t > now.getTime())!);
  }
  let at = new Date(today.getTime() + mins(c.runAt) * 60_000);
  if (c.frequency === "weekly") {
    const dow = new Date(today.getTime() + 330 * 60_000).getUTCDay();
    at = new Date(at.getTime() + (((c.weekday - dow) + 7) % 7) * 86400_000);
  }
  // already done for this slot → the next one
  const step = c.frequency === "weekly" ? 7 * 86400_000 : 86400_000;
  while (last && last.startedAt >= new Date(at.getTime() - 60 * 60_000)) at = new Date(at.getTime() + step);
  return at;
}

/** Worker tick: make the automatic backup when it's due. */
export async function maybeBackup() {
  const cfg = await getBackupConfig();
  const due = await nextBackupAt(cfg);
  if (!due || due > new Date()) return { skipped: "not due" };
  const running = await prisma.backupRun.count({ where: { status: "RUNNING", startedAt: { gt: new Date(Date.now() - 3 * 3600_000) } } });
  if (running) return { skipped: "a backup is running" };
  const { readRestore, restoreRunning } = await import("./restore");
  if (restoreRunning(await readRestore())) return { skipped: "a restore is running" };
  const r = await createBackup({ trigger: "schedule" });
  return { id: r.id, file: r.fileName };
}

// ───────────────────────── email copy ─────────────────────────

/** openssl is on every Ubuntu server; the file opens anywhere with the same command (see emailBackup). */
export const DECRYPT_CMD = (file: string) => `openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -in ${file} -out ${file.replace(/\.enc$/, "")}`;

export async function encryptFile(src: string, dest: string, passphrase: string) {
  await run("openssl", ["enc", "-aes-256-cbc", "-pbkdf2", "-iter", "200000", "-salt", "-in", src, "-out", dest, "-pass", "env:CRAPPLET_BACKUP_PASS"], { env: { ...process.env, CRAPPLET_BACKUP_PASS: passphrase } });
}
export async function decryptFile(src: string, dest: string, passphrase: string) {
  try {
    await run("openssl", ["enc", "-d", "-aes-256-cbc", "-pbkdf2", "-iter", "200000", "-in", src, "-out", dest, "-pass", "env:CRAPPLET_BACKUP_PASS"], { env: { ...process.env, CRAPPLET_BACKUP_PASS: passphrase } });
  } catch {
    await fs.promises.rm(dest, { force: true });
    throw new Error("Couldn't unlock this file — the passphrase doesn't match the one it was encrypted with");
  }
}
export const emailPassphrase = async () => secretsOf(await getBackupConfig()).emailPassphrase ?? null;

const fmtMb = (b: number) => `${(b / 1024 / 1024).toFixed(b < 10 * 1024 * 1024 ? 1 : 0)} MB`;

async function sendBackupMail(cfg: BackupConfig, subject: string, bodyHtml: string, attachment?: { path: string; filename: string }) {
  const { parseRecipients } = await import("../email/staff-alerts");
  const to = parseRecipients(cfg.email.to);
  if (!to.length) throw new Error("Add the email address to send backups to");
  const { getMailConfig } = await import("../email/mail-config");
  const { makeTransport, buildMessage, layout, friendlySmtpError } = await import("../email/mailer");
  const { getSettings } = await import("../../lib/settings");
  const mc = await getMailConfig();
  if (!mc.enabled || !mc.host) throw new Error("Email sending isn't set up or is turned off (Email Delivery → Mail server)");
  const settings = await getSettings();
  const t = makeTransport(mc);
  try {
    const info = await t.sendMail(buildMessage(mc, { to: to.join(", "), subject, html: layout(bodyHtml, settings.company, subject), attachments: attachment ? [{ filename: attachment.filename, path: attachment.path, contentType: "application/octet-stream" }] : undefined }));
    for (const r of to) await prisma.emailLog.create({ data: { to: r, subject, template: "backup", status: "SENT", messageId: info.messageId, response: info.response?.slice(0, 500) } });
    return to;
  } catch (e) {
    const msg = friendlySmtpError(e);
    for (const r of to) await prisma.emailLog.create({ data: { to: r, subject, template: "backup", status: "FAILED", error: msg.slice(0, 1000) } }).catch(() => undefined);
    throw new Error(`Email not sent: ${msg}`);
  } finally {
    t.close();
  }
}

/**
 * Email the backup, encrypted with the saved passphrase. If the full backup is over the size limit,
 * send the database only (the most important part); if even that's too big, send a notice instead.
 */
async function emailBackup(cfg: BackupConfig, file: string, name: string, work: string): Promise<string> {
  const pass = secretsOf(cfg).emailPassphrase;
  if (!pass) throw new Error("Set an encryption passphrase for emailed backups");
  const limit = Math.max(1, cfg.email.maxMb || 18) * 1024 * 1024;
  const fullSize = (await fs.promises.stat(file)).size;
  let src = file;
  let what = "the full backup (database and uploaded files)";
  if (fullSize > limit) {
    // database only
    const dbOnly = path.join(work, name.replace(/\.tar$/, "-database.tar"));
    await run("tar", ["-cf", dbOnly, "-C", work, "db.dump", "manifest.json"]);
    src = dbOnly;
    what = `the database only — the full backup (${fmtMb(fullSize)}) is over your ${cfg.email.maxMb} MB email limit; the full file stays on this server${cfg.destination.type !== "none" ? " and your offsite storage" : ""}`;
  }
  const enc = path.join(work, `${path.basename(src)}.enc`);
  await encryptFile(src, enc, pass);
  const encSize = (await fs.promises.stat(enc)).size;
  const when = new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata", day: "2-digit", month: "short", year: "numeric", hour: "numeric", minute: "2-digit", hour12: true });
  const host = os.hostname();
  if (encSize > limit) {
    await sendBackupMail(cfg, `Backup ${when} — too large to email`, `<p>Your automatic backup finished at <b>${when} IST</b> on <b>${host}</b>, but even the database alone is <b>${fmtMb(encSize)}</b>, over your ${cfg.email.maxMb} MB email limit, so it isn't attached.</p><p>It's saved on the server (Admin → Database Backups). Raise the limit, or add S3 / SFTP storage for offsite copies.</p>`);
    return `notice sent to ${cfg.email.to} (backup ${fmtMb(encSize)} too large to attach)`;
  }
  const fname = path.basename(enc);
  await sendBackupMail(
    cfg,
    `Backup ${when} — ${fmtMb(encSize)}`,
    `<p>Attached is ${what}, made at <b>${when} IST</b> on <b>${host}</b>.</p>
<p>It's <b>encrypted</b> with the passphrase you set under Admin → Database Backups → Email copy. Keep this email somewhere safe.</p>
<p><b>To restore:</b> upload the <code>.enc</code> file under Admin → Database Backups → Restore from your computer — the panel unlocks it with the saved passphrase. On any other computer, unlock it first with:</p>
<pre style="white-space:pre-wrap;background:#f1f5f9;padding:10px;border-radius:8px;font-size:12px">${DECRYPT_CMD(fname)}</pre>`,
    { path: enc, filename: fname },
  );
  return `emailed to ${cfg.email.to} (${fname}, ${fmtMb(encSize)}${src !== file ? ", database only" : ""})`;
}

/** "Send test" — a small encrypted file, so the address, mail server and attachment size path are all checked. */
export async function testEmailBackup() {
  const cfg = await getBackupConfig();
  if (!cfg.email.to.trim()) throw new Error("Add the email address to send backups to");
  const pass = secretsOf(cfg).emailPassphrase;
  if (!pass) throw new Error("Set an encryption passphrase first");
  const work = await fs.promises.mkdtemp(path.join(os.tmpdir(), "crapplet-backup-mailtest-"));
  try {
    const plain = path.join(work, "crapplet-backup-test.txt");
    await fs.promises.writeFile(plain, `Crapplet backup email test ${new Date().toISOString()}\nIf you can unlock this file, your passphrase works.\n`);
    await encryptFile(plain, `${plain}.enc`, pass);
    const to = await sendBackupMail(cfg, "Test: backup email copy", `<p>This is a test from Admin → Database Backups. Real backups will arrive like this, encrypted with your passphrase.</p><p>To check your passphrase, unlock the attached test file with:</p><pre style="white-space:pre-wrap;background:#f1f5f9;padding:10px;border-radius:8px;font-size:12px">${DECRYPT_CMD("crapplet-backup-test.txt.enc")}</pre>`, { path: `${plain}.enc`, filename: "crapplet-backup-test.txt.enc" });
    return `Test sent to ${to.join(", ")} — check the inbox (and spam folder).`;
  } finally {
    await fs.promises.rm(work, { recursive: true, force: true });
  }
}
