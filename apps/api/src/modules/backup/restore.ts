/**
 * Restore the panel from a backup made by Database Backups (or a backup file uploaded from your computer).
 *
 *   1. a safety backup of the database as it is now (always)
 *   2. the database is replaced by the one in the backup (all-or-nothing)
 *   3. if that fails, the safety backup is put back — nothing is lost
 *   4. uploaded files (invoices, ticket attachments …) are put back, if chosen
 *   5. any panel updates newer than the backup are applied to it, so it matches this version
 *   6. everyone is signed out (the restored sign-ins can't be trusted)
 *
 * Runs in the worker. Progress is kept in a small file next to the backups, not in the database —
 * the database is the thing being replaced.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { config } from "../../config";
import { prisma } from "../../db";
import { audit } from "../../lib/audit";
import { randomToken } from "../../lib/crypto";
import { BACKUP_DIR, FILE_RE, backupPath, createBackup, pgArgs, run, stamp } from "./service";

export interface RestoreState {
  token: string;
  status: "queued" | "running" | "done" | "failed";
  phase: string;
  fileName: string;
  backupCreatedAt?: string | null;
  withFiles: boolean;
  startedBy?: string;
  startedAt: string;
  finishedAt?: string;
  safetyBackup?: string;
  warnings: string[];
  error?: string;
  rolledBack?: boolean;
}

const STATE = () => path.join(BACKUP_DIR, "restore-status.json");
export async function readRestore(): Promise<RestoreState | null> {
  try {
    return JSON.parse(await fs.promises.readFile(STATE(), "utf8"));
  } catch {
    return null;
  }
}
async function saveRestore(s: RestoreState) {
  await fs.promises.mkdir(BACKUP_DIR, { recursive: true });
  const tmp = `${STATE()}.${process.pid}.tmp`;
  await fs.promises.writeFile(tmp, JSON.stringify(s), { mode: 0o600 });
  await fs.promises.rename(tmp, STATE());
}
export const restoreRunning = (s: RestoreState | null) => !!s && (s.status === "queued" || s.status === "running") && Date.now() - new Date(s.startedAt).getTime() < 3 * 3600_000;

function capture(cmd: string, args: string[], env?: NodeJS.ProcessEnv) {
  return new Promise<string>((resolve, reject) => {
    const p = spawn(cmd, args, { env: env ?? process.env, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    p.on("error", (e) => reject(new Error(`${cmd}: ${e.message}`)));
    p.on("close", (code) => (code === 0 ? resolve(out) : reject(new Error(`${cmd} failed (${code}): ${err.trim().slice(-600)}`))));
  });
}

/** Checks a backup file is one of ours and says what's in it. */
export async function inspectBackup(file: string) {
  let list: string[];
  try {
    list = (await capture("tar", ["-tf", file])).split("\n").map((l) => l.replace(/^\.\//, "").trim()).filter(Boolean);
  } catch {
    throw new Error("This isn't a backup file from the panel (it can't be opened as a .tar archive)");
  }
  if (!list.includes("db.dump") || !list.includes("manifest.json")) throw new Error("This archive isn't a panel backup — it has no database inside");
  let manifest: { app?: string; createdAt?: string } = {};
  try {
    manifest = JSON.parse(await capture("tar", ["-xOf", file, "manifest.json"]));
  } catch {
    /* tolerated: an old manifest */
  }
  if (manifest.app && manifest.app !== "crapplet-panel") throw new Error("This backup is from a different application");
  return { createdAt: manifest.createdAt ?? null, hasFiles: list.includes("uploads.tgz") };
}

/** Called from the API: checks and queues. */
export async function startRestore(args: { runId: string; withFiles: boolean; actor: { id: string; email: string } }) {
  if (restoreRunning(await readRestore())) throw new Error("A restore is already running");
  const busy = await prisma.backupRun.count({ where: { status: "RUNNING", startedAt: { gt: new Date(Date.now() - 3 * 3600_000) } } });
  if (busy) throw new Error("A backup is running — wait for it to finish, then restore");
  const row = await prisma.backupRun.findUnique({ where: { id: args.runId } });
  if (!row?.fileName || row.deletedAt || !fs.existsSync(backupPath(row.fileName))) throw new Error("That backup file is no longer on this server");
  const info = await inspectBackup(backupPath(row.fileName));
  const s: RestoreState = {
    token: randomToken(24),
    status: "queued",
    phase: "Waiting to start",
    fileName: row.fileName,
    backupCreatedAt: info.createdAt ?? row.startedAt.toISOString(),
    withFiles: args.withFiles && info.hasFiles,
    startedBy: args.actor.email,
    startedAt: new Date().toISOString(),
    warnings: [],
  };
  await saveRestore(s);
  await audit({ actorId: args.actor.id, action: "backup.restore_started", entity: "BackupRun", entityId: row.id, details: { file: row.fileName, withFiles: s.withFiles } });
  return s;
}

function psqlArgs(url: string) {
  const u = new URL(url);
  return {
    schema: u.searchParams.get("schema") || "public",
    args: ["-v", "ON_ERROR_STOP=1", "-q", "-h", u.hostname || "localhost", "-p", u.port || "5432", "-U", decodeURIComponent(u.username), "-d", decodeURIComponent(u.pathname.replace(/^\//, ""))],
    env: { ...process.env, PGPASSWORD: decodeURIComponent(u.password), PGSSLMODE: u.searchParams.get("sslmode") ?? process.env.PGSSLMODE ?? "prefer" },
  };
}

/** Empty the schema and load a db.dump into it in one transaction. */
async function loadDump(dump: string) {
  const ps = psqlArgs(config.databaseUrl);
  const q = `"${ps.schema.replace(/"/g, '""')}"`;
  await run("psql", [...ps.args, "-c", `DROP SCHEMA IF EXISTS ${q} CASCADE; CREATE SCHEMA ${q};`], { env: ps.env });
  const pg = pgArgs(config.databaseUrl);
  await run("pg_restore", [...pg.args, "--single-transaction", "--exit-on-error", dump], { env: pg.env });
}

async function extract(file: string, members: string[], dir: string) {
  await run("tar", ["-xf", file, "-C", dir, ...members]);
}

/** Migrations this code has that the restored database doesn't, and the other way round. */
async function migrationGap() {
  const dir = path.resolve(process.cwd(), "prisma", "migrations");
  const local = fs.existsSync(dir) ? (await fs.promises.readdir(dir, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name) : [];
  let applied: string[] = [];
  try {
    applied = (await prisma.$queryRawUnsafe<{ migration_name: string }[]>(`SELECT migration_name FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL`)).map((r) => r.migration_name);
  } catch {
    /* table missing → everything is "missing" */
  }
  return { missing: local.filter((m) => !applied.includes(m)).sort(), unknown: applied.filter((m) => !local.includes(m)) };
}

/** Called in the worker. */
export async function runRestore() {
  const s = await readRestore();
  if (!s || s.status !== "queued") return null;
  const step = async (phase: string) => {
    s.phase = phase;
    await saveRestore(s);
  };
  s.status = "running";
  const work = await fs.promises.mkdtemp(path.join(os.tmpdir(), "crapplet-restore-"));
  let safetyFile: string | null = null;
  try {
    const file = backupPath(s.fileName);
    await step("Taking a safety backup of the current database");
    const safety = await createBackup({ trigger: "pre-restore" });
    if (!safety.fileName) throw new Error("The safety backup couldn't be made, so nothing was restored");
    safetyFile = backupPath(safety.fileName);
    s.safetyBackup = safety.fileName;

    await step("Unpacking the backup");
    await extract(file, ["db.dump", ...(s.withFiles ? ["uploads.tgz"] : [])], work);

    await step("Restoring the database");
    try {
      await prisma.$disconnect().catch(() => undefined);
      await loadDump(path.join(work, "db.dump"));
    } catch (e) {
      // put the database back the way it was
      s.error = `The backup couldn't be restored: ${(e as Error).message}`;
      await step("Restore failed — putting the database back as it was");
      const back = path.join(work, "safety");
      await fs.promises.mkdir(back);
      await extract(safetyFile, ["db.dump"], back);
      await loadDump(path.join(back, "db.dump"));
      s.rolledBack = true;
      throw new Error(s.error);
    }

    if (s.withFiles) {
      await step("Restoring uploaded files");
      const dir = path.resolve(config.uploadDir);
      await fs.promises.mkdir(dir, { recursive: true });
      await run("tar", ["-xzf", path.join(work, "uploads.tgz"), "-C", dir]).catch((e) => s.warnings.push(`Uploaded files: ${(e as Error).message}`));
    }

    await step("Bringing the database up to this panel version");
    const gap = await migrationGap();
    if (gap.unknown.length) s.warnings.push(`This backup was made by a newer panel version (${gap.unknown.length} update${gap.unknown.length === 1 ? "" : "s"} this panel doesn't have). Update the panel, then restore again if anything looks wrong.`);
    if (gap.missing.length) {
      try {
        await run("npx", ["prisma", "migrate", "deploy"], { cwd: process.cwd() });
      } catch (e) {
        s.warnings.push(`Panel updates newer than the backup (${gap.missing.length}) couldn't be applied: ${(e as Error).message.slice(0, 300)} — run the panel update to finish.`);
      }
    }

    await tidyRuns(s);
    await step("Signing everyone out");
    await prisma.session.updateMany({ where: { revokedAt: null }, data: { revokedAt: new Date(), sudoUntil: null } }).catch(() => undefined);
    await reconcileBackupFiles(s.safetyBackup ? { [s.safetyBackup]: "pre-restore" } : {}).catch(() => undefined);
    await audit({ action: "backup.restored", entity: "BackupRun", entityId: s.fileName, details: { file: s.fileName, by: s.startedBy, withFiles: s.withFiles, safetyBackup: s.safetyBackup, warnings: s.warnings } }).catch(() => undefined);

    s.status = "done";
    s.phase = "Finished";
  } catch (e) {
    s.status = "failed";
    s.error = s.error ?? (e as Error).message;
    s.phase = s.rolledBack ? "Nothing changed — the database was put back as it was" : "Stopped";
    if (s.rolledBack) await tidyRuns(s).catch(() => undefined);
    await reconcileBackupFiles(s.safetyBackup ? { [s.safetyBackup]: "pre-restore" } : {}).catch(() => undefined);
    await audit({ action: "backup.restore_failed", entity: "BackupRun", entityId: s.fileName, details: { file: s.fileName, by: s.startedBy, error: s.error.slice(0, 500), rolledBack: !!s.rolledBack } }).catch(() => undefined);
  } finally {
    s.finishedAt = new Date().toISOString();
    await saveRestore(s);
    await fs.promises.rm(work, { recursive: true, force: true });
  }
  return s;
}

/** A loaded dump can carry backups that were "running" when it was made — they'll never finish. */
async function tidyRuns(s: RestoreState) {
  // (every dump holds its own backup's row half-way through) — the files themselves are listed again from disk
  await prisma.backupRun.deleteMany({ where: { status: "RUNNING", OR: [{ trigger: "pre-restore" }, { startedAt: { lt: new Date(s.startedAt) } }] } });
}

/**
 * The backups list lives in the database, the files on disk. After a restore (or a file copied in by hand)
 * they disagree — list every file that's there, and mark rows whose file is gone.
 */
export async function reconcileBackupFiles(labels: Record<string, string> = {}) {
  if (!fs.existsSync(BACKUP_DIR)) return;
  const files = (await fs.promises.readdir(BACKUP_DIR)).filter((f) => FILE_RE.test(f));
  const rows = await prisma.backupRun.findMany({ where: { fileName: { not: null } }, select: { id: true, fileName: true, deletedAt: true } });
  const known = new Set(rows.map((r) => r.fileName));
  for (const f of files) {
    if (known.has(f)) continue;
    const st = await fs.promises.stat(path.join(BACKUP_DIR, f));
    const info = await inspectBackup(path.join(BACKUP_DIR, f)).catch(() => null);
    if (!info) continue;
    await prisma.backupRun.create({ data: { trigger: labels[f] ?? "file", status: "COMPLETED", fileName: f, sizeBytes: BigInt(st.size), includesUploads: info.hasFiles, startedAt: info.createdAt ? new Date(info.createdAt) : st.mtime, finishedAt: st.mtime, destinations: [{ type: "local", ok: true }] } });
  }
  const present = new Set(files);
  const gone = rows.filter((r) => r.fileName && !r.deletedAt && !present.has(r.fileName)).map((r) => r.id);
  if (gone.length) await prisma.backupRun.updateMany({ where: { id: { in: gone } }, data: { deletedAt: new Date() } });
}

// ───────────────────────── uploading a backup file from your computer ─────────────────────────

export const UPLOAD_CHUNK = 8 * 1024 * 1024;
export const MAX_UPLOAD = 50 * 1024 * 1024 * 1024;
type UploadMeta = { id: string; name: string; size: number; by: string; startedAt: string };
const upPart = (id: string) => path.join(BACKUP_DIR, `.upload-${id}.part`);
const upMeta = (id: string) => path.join(BACKUP_DIR, `.upload-${id}.json`);

export async function startUpload(name: string, size: number, by: string) {
  if (!/\.tar$/i.test(name)) throw new Error("Choose a backup file made by the panel (crapplet-backup-….tar)");
  if (!(size > 0) || size > MAX_UPLOAD) throw new Error("That file is too large");
  await fs.promises.mkdir(BACKUP_DIR, { recursive: true });
  // forget abandoned uploads older than a day
  for (const f of await fs.promises.readdir(BACKUP_DIR)) {
    if (!/^\.upload-/.test(f)) continue;
    const st = await fs.promises.stat(path.join(BACKUP_DIR, f)).catch(() => null);
    if (st && Date.now() - st.mtimeMs > 86400_000) await fs.promises.rm(path.join(BACKUP_DIR, f), { force: true });
  }
  const meta: UploadMeta = { id: randomToken(12).replace(/[^a-zA-Z0-9]/g, ""), name, size, by, startedAt: new Date().toISOString() };
  await fs.promises.writeFile(upMeta(meta.id), JSON.stringify(meta));
  await fs.promises.writeFile(upPart(meta.id), "");
  return { id: meta.id, chunkSize: UPLOAD_CHUNK };
}

async function readUpload(id: string): Promise<UploadMeta> {
  if (!/^[a-zA-Z0-9]{6,40}$/.test(id)) throw new Error("Unknown upload");
  try {
    return JSON.parse(await fs.promises.readFile(upMeta(id), "utf8"));
  } catch {
    throw new Error("Unknown upload — start again");
  }
}

export async function uploadChunk(id: string, offset: number, body: Buffer) {
  const m = await readUpload(id);
  const have = (await fs.promises.stat(upPart(id))).size;
  if (offset !== have) return { outOfStep: true as const, received: have };
  if (have + body.length > m.size) throw new Error("More data than the file size you started with");
  await fs.promises.appendFile(upPart(id), body);
  return { received: have + body.length };
}

/** Checks the uploaded file and adds it to the backups list. */
export async function finishUpload(id: string) {
  const m = await readUpload(id);
  const have = (await fs.promises.stat(upPart(id))).size;
  if (have !== m.size) throw new Error(`Upload incomplete: ${have} of ${m.size} bytes received`);
  let info;
  try {
    info = await inspectBackup(upPart(id));
  } catch (e) {
    await fs.promises.rm(upPart(id), { force: true });
    await fs.promises.rm(upMeta(id), { force: true });
    throw e;
  }
  let name = `crapplet-backup-${stamp()}.tar`;
  for (let i = 1; fs.existsSync(path.join(BACKUP_DIR, name)); i++) name = `crapplet-backup-${stamp(new Date(Date.now() + i * 1000))}.tar`;
  await fs.promises.rename(upPart(id), path.join(BACKUP_DIR, name));
  await fs.promises.rm(upMeta(id), { force: true });
  const row = await prisma.backupRun.create({
    data: { trigger: "upload", triggeredBy: m.by, status: "COMPLETED", fileName: name, sizeBytes: BigInt(m.size), includesUploads: info.hasFiles, finishedAt: new Date(), destinations: [{ type: "local", ok: true, location: `uploaded: ${m.name.slice(0, 120)}` }] },
  });
  return { row, createdAt: info.createdAt };
}
