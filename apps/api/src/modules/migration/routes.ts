import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../db";
import { ah, conflict, notFound, parse, badRequest } from "../../lib/http";
import { encryptJson } from "../../lib/crypto";
import { audit } from "../../lib/audit";
import { requireStaff } from "../../middleware/auth";
import { migrationQueue } from "../../jobs/queues";
import { DEFAULT_ENTITIES, ENTITIES, ENTITY_DEPENDS, inspectSource, mysqlSource } from "./whmcs";
import { dumpRouter, readState } from "./dumps";

export const migrationRouter = Router();
migrationRouter.use(dumpRouter);

const connSchema = z.object({
  host: z.string().min(1),
  port: z.coerce.number().int().default(3306),
  database: z.string().min(1),
  user: z.string().min(1),
  password: z.string().default(""),
  ssl: z.boolean().default(false),
});

migrationRouter.post(
  "/migration/whmcs/test",
  requireStaff("settings.manage"),
  ah(async (req, res) => {
    const { connection } = parse(z.object({ connection: connSchema }), req.body);
    let src;
    try {
      src = await mysqlSource(connection);
      res.json({ ok: true, ...(await inspectSource(src)) });
    } catch (e) {
      throw badRequest(`Could not read the WHMCS database: ${(e as Error).message}`);
    } finally {
      await src?.close().catch(() => undefined);
    }
  }),
);

migrationRouter.post(
  "/migration/whmcs/runs",
  requireStaff("settings.manage"),
  ah(async (req, res) => {
    const b = parse(
      z.object({
        // either a live database connection or an uploaded .sql dump
        connection: connSchema.optional(),
        dumpId: z.string().regex(/^[a-f0-9]{24}$/).optional(),
        ccEncryptionHash: z.string().max(200).optional(),
        entities: z.array(z.enum(ENTITIES)).min(1).default(DEFAULT_ENTITIES),
        dryRun: z.boolean().default(true),
        overwritePricing: z.boolean().default(false),
        historySince: z.string().nullable().optional(),
      }),
      req.body,
    );
    if (!b.connection === !b.dumpId) throw badRequest("Choose a source: upload a .sql file or connect to the WHMCS database");
    const dump = b.dumpId ? await readState(b.dumpId) : null;
    if (dump && dump.status !== "ready") throw badRequest(dump.status === "error" ? `The uploaded file couldn't be read: ${dump.error}` : "The uploaded file is still being prepared — wait until it shows as ready");
    if (await prisma.migrationRun.count({ where: { status: { in: ["QUEUED", "RUNNING"] } } })) throw conflict("Another import is already running");
    const { dryRun, entities, ...stored } = b;
    const run = await prisma.migrationRun.create({ data: { dryRun, entities, createdById: req.user!.id, optionsEnc: encryptJson({ ...stored, entities }) } });
    await migrationQueue().add("whmcs", { runId: run.id }, { jobId: run.id, attempts: 1 });
    await audit({ actorId: req.user!.id, action: dryRun ? "migration.dry_run" : "migration.import", entity: "migrationRun", entityId: run.id, details: { entities, ...(dump ? { file: dump.name } : { host: b.connection!.host, database: b.connection!.database }) } });
    res.status(202).json({ id: run.id });
  }),
);

migrationRouter.get(
  "/migration/runs",
  requireStaff("settings.manage"),
  ah(async (_req, res) => {
    const runs = await prisma.migrationRun.findMany({ orderBy: { createdAt: "desc" }, take: 30, select: { id: true, status: true, dryRun: true, entities: true, summary: true, error: true, createdAt: true, startedAt: true, finishedAt: true, progress: true } });
    const mapped = await prisma.legacyMap.groupBy({ by: ["entity"], where: { source: "whmcs" }, _count: true });
    res.json({ runs, mapped: Object.fromEntries(mapped.map((m) => [m.entity, m._count])), entities: ENTITIES, defaults: DEFAULT_ENTITIES, depends: ENTITY_DEPENDS });
  }),
);

migrationRouter.get(
  "/migration/runs/:id",
  requireStaff("settings.manage"),
  ah(async (req, res) => {
    const run = await prisma.migrationRun.findUnique({ where: { id: req.params.id } });
    if (!run) throw notFound();
    const { optionsEnc, ...rest } = run;
    res.json({ run: rest });
  }),
);
