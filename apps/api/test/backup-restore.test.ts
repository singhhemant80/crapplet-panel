/**
 * Restore from a backup: the database goes back to the backup, a safety copy is taken first,
 * everyone is signed out, and a backup file can be uploaded from a computer.
 *   npx tsx --test test/backup-restore.test.ts
 */
import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "crapplet-restore-test-"));
process.env.BACKUP_DIR = dir;

const RUN = Date.now().toString(36);
let prisma: typeof import("../src/db").prisma;

before(async () => {
  ({ prisma } = await import("../src/db"));
});
after(async () => {
  await prisma.productGroup.deleteMany({ where: { slug: { startsWith: `qa-restore-${RUN}` } } });
  const { closeQueues } = await import("../src/jobs/queues");
  await closeQueues().catch(() => undefined);
  await prisma.$disconnect();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("restoring puts the database back as it was in the backup and keeps a safety copy", async () => {
  const { createBackup } = await import("../src/modules/backup/service");
  const { startRestore, runRestore, readRestore } = await import("../src/modules/backup/restore");
  const keep = await prisma.productGroup.create({ data: { name: "Kept", slug: `qa-restore-${RUN}-kept` } });
  const b = await createBackup({ trigger: "manual" });
  const later = await prisma.productGroup.create({ data: { name: "Later", slug: `qa-restore-${RUN}-later` } });

  await assert.rejects(startRestore({ runId: "nope", withFiles: false, actor: { id: "x", email: "qa@t.test" } }), /no longer on this server/);
  await startRestore({ runId: b.id, withFiles: true, actor: { id: "x", email: "qa@t.test" } });
  await assert.rejects(startRestore({ runId: b.id, withFiles: true, actor: { id: "x", email: "qa@t.test" } }), /already running/);
  const r = await runRestore();
  assert.equal(r?.status, "done", r?.error);
  assert.ok(await prisma.productGroup.findUnique({ where: { id: keep.id } }), "data in the backup is there");
  assert.equal(await prisma.productGroup.findUnique({ where: { id: later.id } }), null, "data made after the backup is gone");
  assert.equal(await prisma.session.count({ where: { revokedAt: null } }), 0, "everyone signed out");
  assert.ok(r?.safetyBackup && r.safetyBackup !== b.fileName && fs.existsSync(path.join(dir, r.safetyBackup)), "safety copy has its own file");
  const runs = await prisma.backupRun.findMany({ where: { fileName: { in: [b.fileName!, r!.safetyBackup!] } } });
  assert.deepEqual(runs.map((x) => x.trigger).sort(), ["file", "pre-restore"]);
  assert.equal(await prisma.backupRun.count({ where: { status: "RUNNING" } }), 0, "no half-finished rows from inside the dump");
  assert.equal((await readRestore())?.status, "done");
});

test("a backup file uploaded in pieces is checked and added to the list; other files are refused", async () => {
  const { startUpload, uploadChunk, finishUpload } = await import("../src/modules/backup/restore");
  await assert.rejects(startUpload("notes.zip", 10, "x"), /backup file/);
  const src = fs.readdirSync(dir).find((f) => /^crapplet-backup-.*\.tar$/.test(f))!;
  const buf = fs.readFileSync(path.join(dir, src));
  const u = await startUpload("my-backup.tar", buf.length, "x");
  const half = Math.floor(buf.length / 2);
  assert.deepEqual(await uploadChunk(u.id, 0, buf.subarray(0, half)), { received: half });
  assert.deepEqual(await uploadChunk(u.id, 0, buf.subarray(0, 10)), { outOfStep: true, received: half }, "resumes from where the server is");
  await uploadChunk(u.id, half, buf.subarray(half));
  const done = await finishUpload(u.id);
  assert.equal(done.row.trigger, "upload");
  assert.ok(fs.existsSync(path.join(dir, done.row.fileName!)));

  const junk = Buffer.from("this is not a tar file at all");
  const j = await startUpload("fake.tar", junk.length, "x");
  await uploadChunk(j.id, 0, junk);
  await assert.rejects(finishUpload(j.id), /isn't a backup|isn't a panel backup/);
});
