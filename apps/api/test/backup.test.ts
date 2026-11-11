/**
 * Database backups: the archive holds a restorable pg_dump + uploads + manifest, old files are pruned,
 * secrets are stored encrypted and never returned, and the schedule picks the right time.
 *   npx tsx --test test/backup.test.ts
 */
import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "crapplet-backup-test-"));
process.env.BACKUP_DIR = DIR;

const { prisma } = await import("../src/db");
const { closeQueues } = await import("../src/jobs/queues");
const svc = await import("../src/modules/backup/service");

let saved: unknown;
before(async () => {
  saved = (await prisma.setting.findUnique({ where: { key: "backup" } }))?.value ?? null;
});
after(async () => {
  if (saved) await prisma.setting.update({ where: { key: "backup" }, data: { value: saved as never } });
  else await prisma.setting.deleteMany({ where: { key: "backup" } });
  await prisma.backupRun.deleteMany({ where: { fileName: { in: fs.readdirSync(DIR) } } });
  fs.rmSync(DIR, { recursive: true, force: true });
  await closeQueues().catch(() => undefined);
  await prisma.$disconnect();
});

test("secrets are stored encrypted, never returned, and kept when not re-sent", async () => {
  await svc.saveBackupConfig({ destination: { type: "sftp", sftp: { host: "backup.example", port: 22, username: "u", path: "/b" } }, secrets: { sftpPassword: "Sup3r-secret" } } as never);
  const row = await prisma.setting.findUniqueOrThrow({ where: { key: "backup" } });
  assert.ok(!JSON.stringify(row.value).includes("Sup3r-secret"), "plain password stored");
  const red = svc.redactBackup(await svc.getBackupConfig());
  assert.ok(!JSON.stringify(red).includes("Sup3r-secret"));
  assert.equal(red.saved.sftpPassword, true);
  await svc.saveBackupConfig({ keepLocal: 3 } as never); // secrets untouched
  assert.equal(svc.redactBackup(await svc.getBackupConfig()).saved.sftpPassword, true);
  await svc.saveBackupConfig({ secrets: { sftpPassword: "" }, destination: { type: "none" } } as never);
  assert.equal(svc.redactBackup(await svc.getBackupConfig()).saved.sftpPassword, false);
});

test("backup archive contains a restorable database dump and a manifest", async () => {
  await svc.saveBackupConfig({ includeUploads: false, keepLocal: 2, destination: { type: "none" } } as never);
  const run = await svc.createBackup({ trigger: "manual" });
  assert.equal(run.status, "COMPLETED");
  const file = path.join(DIR, run.fileName!);
  assert.ok(fs.existsSync(file));
  assert.equal(Number(run.sizeBytes), fs.statSync(file).size);
  const list = execFileSync("tar", ["-tf", file]).toString().split("\n").filter(Boolean);
  assert.deepEqual(list.sort(), ["db.dump", "manifest.json"]);
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "crapplet-restore-"));
  execFileSync("tar", ["-xf", file, "-C", out]);
  const toc = execFileSync("pg_restore", ["-l", path.join(out, "db.dump")]).toString();
  assert.match(toc, /TABLE DATA public "?User"?/);
  assert.match(toc, /TABLE DATA public "?Invoice"?/);
  const manifest = JSON.parse(fs.readFileSync(path.join(out, "manifest.json"), "utf8"));
  assert.equal(manifest.app, "crapplet-panel");
  assert.ok(manifest.files["db.dump"] > 0);
  fs.rmSync(out, { recursive: true, force: true });
});

test("only the newest N backups are kept on the server", async () => {
  // fake older files so retention has something to remove
  for (const n of ["crapplet-backup-20200101-0300.tar", "crapplet-backup-20200102-0300.tar"]) fs.writeFileSync(path.join(DIR, n), "x");
  await svc.saveBackupConfig({ keepLocal: 2 } as never);
  await new Promise((r) => setTimeout(r, 1100)); // distinct timestamp
  await svc.createBackup({ trigger: "manual" });
  const left = fs.readdirSync(DIR).filter((f) => f.endsWith(".tar")).sort();
  assert.equal(left.length, 2);
  assert.ok(!left.includes("crapplet-backup-20200101-0300.tar"));
});

test("a failing remote copy still keeps the local backup and says why", async () => {
  await svc.saveBackupConfig({ destination: { type: "ftp", ftp: { host: "127.0.0.1", port: 1, username: "x", path: "/b", secure: false } } } as never);
  const run = await svc.createBackup({ trigger: "manual" });
  assert.equal(run.status, "COMPLETED");
  assert.match(run.error ?? "", /remote copy failed/);
  const d = run.destinations as { type: string; ok: boolean; error?: string }[];
  assert.ok(d.find((x) => x.type === "local")?.ok);
  assert.equal(d.find((x) => x.type === "ftp")?.ok, false);
  assert.ok(fs.existsSync(path.join(DIR, run.fileName!)));
  await svc.saveBackupConfig({ destination: { type: "none" } } as never);
});

test("schedule: off, every N hours, daily at the set time", async () => {
  await svc.saveBackupConfig({ enabled: false } as never);
  assert.equal(await svc.nextBackupAt(), null);
  await svc.saveBackupConfig({ enabled: true, frequency: "every6h" } as never);
  const last = await prisma.backupRun.findFirst({ where: { trigger: "schedule", status: "COMPLETED" }, orderBy: { startedAt: "desc" } });
  const n6 = (await svc.nextBackupAt())!;
  if (last) assert.equal(n6.getTime(), last.startedAt.getTime() + 6 * 3600_000);
  else assert.ok(n6.getTime() <= Date.now() + 1000, "first automatic backup is due straight away");
  await svc.saveBackupConfig({ frequency: "daily", runAt: "02:30" } as never);
  const nd = (await svc.nextBackupAt())!;
  const ist = new Date(nd.getTime() + 330 * 60_000);
  assert.equal(`${ist.getUTCHours()}:${ist.getUTCMinutes()}`, "2:30");
});
