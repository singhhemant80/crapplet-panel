import fs from "node:fs";
import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../db";
import { ah, badRequest, notFound, parse } from "../../lib/http";
import { audit } from "../../lib/audit";
import { requireStaff } from "../../middleware/auth";
import { backupQueue } from "../../jobs/queues";
import { BACKUP_DIR, backupPath, getBackupConfig, nextBackupAt, redactBackup, saveBackupConfig, testDestination } from "./service";

export const adminBackups = Router();

const toJson = (r: { sizeBytes: bigint | null } & Record<string, unknown>) => ({ ...r, sizeBytes: r.sizeBytes == null ? null : Number(r.sizeBytes) });

adminBackups.get(
  "/backups",
  requireStaff("settings.manage"),
  ah(async (_req, res) => {
    const cfg = await getBackupConfig();
    const runs = await prisma.backupRun.findMany({ orderBy: { startedAt: "desc" }, take: 100 });
    const rows = runs.map((r) => ({ ...toJson(r), available: !!r.fileName && !r.deletedAt && fs.existsSync(backupPath(r.fileName)) }));
    let disk: { free: number; total: number } | null = null;
    try {
      const s = await fs.promises.statfs(fs.existsSync(BACKUP_DIR) ? BACKUP_DIR : "/");
      disk = { free: s.bavail * s.bsize, total: s.blocks * s.bsize };
    } catch {
      /* not supported */
    }
    const lastOk = runs.find((r) => r.status === "COMPLETED");
    res.json({
      config: redactBackup(cfg),
      runs: rows,
      nextAt: await nextBackupAt(cfg),
      running: runs.some((r) => r.status === "RUNNING" && r.startedAt.getTime() > Date.now() - 3 * 3600_000),
      lastSuccessAt: lastOk?.finishedAt ?? null,
      storedBytes: rows.filter((r) => r.available).reduce((a, r) => a + (r.sizeBytes ?? 0), 0),
      disk,
    });
  }),
);

const nonEmpty = z.string().max(500);
adminBackups.put(
  "/backups/settings",
  requireStaff("settings.manage"),
  ah(async (req, res) => {
    const b = parse(
      z.object({
        enabled: z.boolean().optional(),
        frequency: z.enum(["daily", "every6h", "every12h", "weekly"]).optional(),
        runAt: z.string().regex(/^([01]?\d|2[0-3]):[0-5]\d$/, "Use HH:MM").optional(),
        weekday: z.number().int().min(0).max(6).optional(),
        includeUploads: z.boolean().optional(),
        keepLocal: z.number().int().min(1).max(365).optional(),
        destination: z
          .object({
            type: z.enum(["none", "s3", "sftp", "ftp"]).optional(),
            keepRemote: z.number().int().min(0).max(3650).optional(),
            s3: z.object({ endpoint: z.string().max(300).refine((v) => !v || /^https?:\/\//.test(v), "Endpoint must start with https://"), region: nonEmpty, bucket: nonEmpty, prefix: nonEmpty, accessKeyId: nonEmpty, forcePathStyle: z.boolean() }).partial().optional(),
            sftp: z.object({ host: nonEmpty, port: z.number().int().min(1).max(65535), username: nonEmpty, path: nonEmpty }).partial().optional(),
            ftp: z.object({ host: nonEmpty, port: z.number().int().min(1).max(65535), username: nonEmpty, path: nonEmpty, secure: z.boolean() }).partial().optional(),
          })
          .optional(),
        secrets: z.object({ s3Secret: z.string().max(500).nullable(), sftpPassword: z.string().max(500).nullable(), sftpKey: z.string().max(20000).nullable(), ftpPassword: z.string().max(500).nullable() }).partial().optional(),
      }),
      req.body,
    );
    const next = await saveBackupConfig(b as never);
    await audit({ actorId: req.user!.id, action: "backup.settings", entity: "Setting", entityId: "backup", details: { enabled: next.enabled, frequency: next.frequency, destination: next.destination.type } });
    res.json({ config: redactBackup(next), nextAt: await nextBackupAt(next) });
  }),
);

adminBackups.post(
  "/backups/run",
  requireStaff("settings.manage"),
  ah(async (req, res) => {
    const busy = await prisma.backupRun.count({ where: { status: "RUNNING", startedAt: { gt: new Date(Date.now() - 3 * 3600_000) } } });
    if (busy) throw badRequest("A backup is already running — wait for it to finish");
    const run = await prisma.backupRun.create({ data: { trigger: "manual", triggeredBy: req.user!.id } });
    await backupQueue().add("backup-now", { runId: run.id }, { removeOnComplete: 50, removeOnFail: 50 });
    await audit({ actorId: req.user!.id, action: "backup.run", entity: "BackupRun", entityId: run.id });
    res.status(202).json({ run: toJson(run) });
  }),
);

adminBackups.post(
  "/backups/test-destination",
  requireStaff("settings.manage"),
  ah(async (_req, res) => {
    try {
      res.json({ ok: true, message: await testDestination() });
    } catch (e) {
      res.json({ ok: false, message: (e as Error).message });
    }
  }),
);

adminBackups.get(
  "/backups/:id/download",
  requireStaff("settings.manage"),
  ah(async (req, res) => {
    const run = await prisma.backupRun.findUnique({ where: { id: req.params.id } });
    if (!run?.fileName || run.deletedAt) throw notFound("Backup file not found");
    const file = backupPath(run.fileName);
    if (!fs.existsSync(file)) throw notFound("This backup is no longer on the server");
    await audit({ actorId: req.user!.id, action: "backup.download", entity: "BackupRun", entityId: run.id, details: { file: run.fileName } });
    res.setHeader("content-type", "application/x-tar");
    res.setHeader("content-disposition", `attachment; filename="${run.fileName}"`);
    res.setHeader("content-length", String((await fs.promises.stat(file)).size));
    res.setHeader("cache-control", "no-store");
    res.setHeader("x-accel-buffering", "no"); // stream big files straight through nginx
    fs.createReadStream(file).pipe(res);
  }),
);

adminBackups.delete(
  "/backups/:id",
  requireStaff("settings.manage"),
  ah(async (req, res) => {
    const run = await prisma.backupRun.findUnique({ where: { id: req.params.id } });
    if (!run) throw notFound("Backup not found");
    if (run.status === "RUNNING" && run.startedAt.getTime() > Date.now() - 3 * 3600_000) throw badRequest("This backup is still running");
    if (run.fileName) await fs.promises.rm(backupPath(run.fileName), { force: true });
    await prisma.backupRun.delete({ where: { id: run.id } });
    await audit({ actorId: req.user!.id, action: "backup.delete", entity: "BackupRun", entityId: run.id, details: { file: run.fileName } });
    res.json({ ok: true });
  }),
);
