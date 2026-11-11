import { prisma, Prisma } from "../../db";
import { decryptJson } from "../../lib/crypto";
import { mysqlSource, runWhmcsImport, type Entity, type MysqlConn } from "./whmcs";
import { dumpSource } from "./sqldump";
import { dumpFile } from "./dumps";

export interface StoredRunOptions {
  connection?: MysqlConn;
  /** an uploaded .sql dump instead of a live connection */
  dumpId?: string;
  ccEncryptionHash?: string;
  entities: Entity[];
  overwritePricing?: boolean;
  historySince?: string | null;
}

/** Executed by the worker (queue "migration"). */
export async function executeMigrationRun(runId: string) {
  const run = await prisma.migrationRun.findUniqueOrThrow({ where: { id: runId } });
  if (run.status !== "QUEUED") return { skipped: run.status };
  const opts = decryptJson<StoredRunOptions>(run.optionsEnc);
  await prisma.migrationRun.update({ where: { id: runId }, data: { status: "RUNNING", startedAt: new Date() } });
  const progress: Record<string, { done: number; total: number }> = {};
  let src;
  try {
    src = opts.dumpId ? await dumpSource(dumpFile(opts.dumpId)) : await mysqlSource(opts.connection!);
    const result = await runWhmcsImport(src, { entities: opts.entities, dryRun: run.dryRun, ccEncryptionHash: opts.ccEncryptionHash, overwritePricing: opts.overwritePricing, historySince: opts.historySince }, async (p) => {
      progress[p.entity] = { done: p.done, total: p.total };
      await prisma.migrationRun.update({ where: { id: runId }, data: { progress: progress as Prisma.InputJsonValue } }).catch(() => undefined);
    });
    await prisma.migrationRun.update({
      where: { id: runId },
      data: { status: "COMPLETED", finishedAt: new Date(), summary: JSON.parse(JSON.stringify({ counts: result.counts, ms: result.ms })), warnings: JSON.parse(JSON.stringify(result.warnings)), optionsEnc: null },
    });
    return result.counts;
  } catch (e) {
    await prisma.migrationRun.update({ where: { id: runId }, data: { status: "FAILED", finishedAt: new Date(), error: String((e as Error).message ?? e).slice(0, 4000), optionsEnc: null } });
    throw e;
  } finally {
    await src?.close().catch(() => undefined);
  }
}
