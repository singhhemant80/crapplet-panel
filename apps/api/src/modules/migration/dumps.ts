/**
 * Uploaded WHMCS database dumps (.sql / .sql.gz).
 *
 * The browser sends the file in pieces (each well under nginx's body limit), so files of any
 * size upload without server changes and a dropped connection can resume where it stopped.
 * When the last piece arrives the dump is prepared in the background (see prepareDump) and the
 * admin sees what's inside before running a dry run.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import express, { Router } from "express";
import { z } from "zod";
import { config } from "../../config";
import { ah, badRequest, conflict, notFound, parse } from "../../lib/http";
import { audit } from "../../lib/audit";
import { requireStaff } from "../../middleware/auth";
import { prepareDump, removeDump, type DumpMeta } from "./sqldump";

export const DUMP_DIR = path.resolve(config.uploadDir, "whmcs-dumps");
const CHUNK = 8 * 1024 * 1024;
const MAX = 20 * 1024 * 1024 * 1024; // 20 GB

export interface DumpState {
  id: string;
  name: string;
  size: number;
  received: number;
  status: "uploading" | "preparing" | "ready" | "error";
  error?: string;
  progress?: number; // bytes of SQL read while preparing
  meta?: DumpMeta;
  createdAt: string;
  createdById: string;
}

const ID = /^[a-f0-9]{24}$/;
export const dumpFile = (id: string) => {
  if (!ID.test(id)) throw notFound("Upload not found");
  return path.join(DUMP_DIR, `${id}.dump`);
};
const stateFile = (id: string) => path.join(DUMP_DIR, `${id}.json`);

export async function readState(id: string): Promise<DumpState> {
  if (!ID.test(id)) throw notFound("Upload not found");
  try {
    return JSON.parse(await fs.promises.readFile(stateFile(id), "utf8"));
  } catch {
    throw notFound("Upload not found — upload the file again");
  }
}
async function writeState(s: DumpState) {
  const tmp = `${stateFile(s.id)}.${process.pid}.tmp`;
  await fs.promises.writeFile(tmp, JSON.stringify(s));
  await fs.promises.rename(tmp, stateFile(s.id));
}

export const dumpRouter = Router();

dumpRouter.post(
  "/migration/whmcs/dumps",
  requireStaff("settings.manage"),
  ah(async (req, res) => {
    const b = parse(z.object({ name: z.string().min(1).max(255), size: z.number().int().positive().max(MAX) }), req.body);
    if (!/\.(sql|gz|sql\.gz)$/i.test(b.name)) throw badRequest("Upload the WHMCS database as a .sql or .sql.gz file (a .zip must be extracted first)");
    await fs.promises.mkdir(DUMP_DIR, { recursive: true });
    const free = await fs.promises.statfs(DUMP_DIR).then((s) => s.bavail * s.bsize).catch(() => Infinity);
    // the file plus its prepared tables (roughly the same size again)
    if (free < b.size * 2.2) throw badRequest(`Not enough disk space: the upload needs about ${Math.ceil((b.size * 2.2) / 1e9)} GB free, the server has ${Math.floor(free / 1e9)} GB`);
    const id = crypto.randomBytes(12).toString("hex");
    await fs.promises.writeFile(dumpFile(id), "");
    const s: DumpState = { id, name: path.basename(b.name), size: b.size, received: 0, status: "uploading", createdAt: new Date().toISOString(), createdById: req.user!.id };
    await writeState(s);
    res.status(201).json({ ...s, chunkSize: CHUNK });
  }),
);

dumpRouter.put(
  "/migration/whmcs/dumps/:id/chunk",
  requireStaff("settings.manage"),
  express.raw({ type: "application/octet-stream", limit: CHUNK + 1024 }),
  ah(async (req, res) => {
    const s = await readState(req.params.id);
    if (s.status !== "uploading") throw conflict("This upload is already complete");
    const offset = Number(req.query.offset);
    const file = dumpFile(s.id);
    const have = (await fs.promises.stat(file)).size;
    // resume: tell the browser where to continue from
    if (offset !== have) return void res.status(409).json({ error: "Upload is out of step", received: have });
    const body = req.body as Buffer;
    if (!Buffer.isBuffer(body) || !body.length) throw badRequest("Empty piece");
    if (have + body.length > s.size) throw badRequest("More data than the file size you started with");
    await fs.promises.appendFile(file, body);
    s.received = have + body.length;
    await writeState(s);
    res.json({ received: s.received });
  }),
);

dumpRouter.post(
  "/migration/whmcs/dumps/:id/finish",
  requireStaff("settings.manage"),
  ah(async (req, res) => {
    const s = await readState(req.params.id);
    const have = (await fs.promises.stat(dumpFile(s.id))).size;
    if (have !== s.size) throw badRequest(`Upload incomplete: ${have} of ${s.size} bytes received`);
    if (s.status === "preparing" || s.status === "ready") return void res.json(s);
    s.received = have;
    s.status = "preparing";
    s.progress = 0;
    s.error = undefined;
    await writeState(s);
    await audit({ actorId: req.user!.id, action: "migration.dump_uploaded", entity: "migrationDump", entityId: s.id, details: { name: s.name, size: s.size } });
    // prepare in the background; the page polls the state
    // state writes are chained so a late progress update can't overwrite the final status
    let chain: Promise<unknown> = Promise.resolve();
    const save = (st: DumpState) => (chain = chain.then(() => writeState(st)).catch(() => undefined));
    let last = 0;
    prepareDump(dumpFile(s.id), (bytes) => {
      if (bytes - last > 20 * 1024 * 1024) {
        last = bytes;
        void save({ ...s, progress: bytes });
      }
    })
      .then((meta) => save({ ...s, status: "ready", progress: undefined, meta }))
      .catch((e) => save({ ...s, status: "error", progress: undefined, error: String((e as Error).message ?? e).slice(0, 2000) }));
    res.status(202).json(s);
  }),
);

dumpRouter.get(
  "/migration/whmcs/dumps",
  requireStaff("settings.manage"),
  ah(async (_req, res) => {
    await fs.promises.mkdir(DUMP_DIR, { recursive: true });
    const files = (await fs.promises.readdir(DUMP_DIR)).filter((f) => /^[a-f0-9]{24}\.json$/.test(f));
    const items = (await Promise.all(files.map((f) => readState(f.slice(0, 24)).catch(() => null)))).filter(Boolean) as DumpState[];
    items.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    res.json({ items });
  }),
);

dumpRouter.get(
  "/migration/whmcs/dumps/:id",
  requireStaff("settings.manage"),
  ah(async (req, res) => {
    res.json(await readState(req.params.id));
  }),
);

dumpRouter.delete(
  "/migration/whmcs/dumps/:id",
  requireStaff("settings.manage"),
  ah(async (req, res) => {
    const s = await readState(req.params.id);
    await removeDump(dumpFile(s.id));
    await fs.promises.rm(stateFile(s.id), { force: true });
    await audit({ actorId: req.user!.id, action: "migration.dump_deleted", entity: "migrationDump", entityId: s.id, details: { name: s.name } });
    res.json({ ok: true });
  }),
);
