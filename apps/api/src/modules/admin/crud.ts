import type { Router } from "express";
import type { ZodObject, ZodRawShape } from "zod";
import { prisma } from "../../db";
import { ah, notFound, parse } from "../../lib/http";
import { audit } from "../../lib/audit";
import { requireStaff } from "../../middleware/auth";

type Delegate = {
  findMany: (args?: unknown) => Promise<unknown[]>;
  findUnique: (args: unknown) => Promise<unknown>;
  create: (args: unknown) => Promise<{ [k: string]: unknown }>;
  update: (args: unknown) => Promise<unknown>;
  delete: (args: unknown) => Promise<unknown>;
};

/** Registers list/get/create/update/delete routes for a simple model. */
export function crud<S extends ZodRawShape>(
  router: Router,
  path: string,
  model: keyof typeof prisma,
  schema: ZodObject<S>,
  perm: string,
  opts: { orderBy?: unknown; idField?: string; include?: unknown; transform?: (data: Record<string, unknown>) => Record<string, unknown> } = {},
) {
  const d = prisma[model] as unknown as Delegate;
  const idf = opts.idField ?? "id";
  const tf = opts.transform ?? ((x) => x);
  router.get(
    path,
    requireStaff(perm),
    ah(async (_req, res) => {
      res.json({ items: await d.findMany({ orderBy: opts.orderBy, include: opts.include }) });
    }),
  );
  router.get(
    `${path}/:id`,
    requireStaff(perm),
    ah(async (req, res) => {
      const item = await d.findUnique({ where: { [idf]: req.params.id }, include: opts.include });
      if (!item) throw notFound();
      res.json({ item });
    }),
  );
  router.post(
    path,
    requireStaff(perm),
    ah(async (req, res) => {
      const data = tf(parse(schema, req.body) as Record<string, unknown>);
      const item = await d.create({ data });
      await audit({ actorId: req.user!.id, action: `${String(model)}.created`, entity: String(model), entityId: String(item[idf]) });
      res.status(201).json({ item });
    }),
  );
  router.put(
    `${path}/:id`,
    requireStaff(perm),
    ah(async (req, res) => {
      const data = tf(parse(schema.partial(), req.body) as Record<string, unknown>);
      const item = await d.update({ where: { [idf]: req.params.id }, data });
      await audit({ actorId: req.user!.id, action: `${String(model)}.updated`, entity: String(model), entityId: req.params.id });
      res.json({ item });
    }),
  );
  router.delete(
    `${path}/:id`,
    requireStaff(perm),
    ah(async (req, res) => {
      await d.delete({ where: { [idf]: req.params.id } });
      await audit({ actorId: req.user!.id, action: `${String(model)}.deleted`, entity: String(model), entityId: req.params.id });
      res.json({ ok: true });
    }),
  );
}
