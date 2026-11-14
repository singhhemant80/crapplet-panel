/** Admin: change a service's plan / billing cycle (upgrade or downgrade). */
import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../db";
import { ah, conflict, notFound, parse } from "../../lib/http";
import { audit } from "../../lib/audit";
import { requireStaff } from "../../middleware/auth";
import { enqueueProvision } from "../../jobs/queues";
import { BillingCycle } from "../../generated/prisma/enums";
import { cancelUpgrade, startUpgrade, upgradeOptions } from "../billing/upgrades";

export const adminUpgrades = Router();

adminUpgrades.get(
  "/services/:id/upgrade-options",
  requireStaff("services.view"),
  ah(async (req, res) => {
    const o = await upgradeOptions(req.params.id);
    const history = await prisma.serviceUpgrade.findMany({ where: { serviceId: req.params.id }, orderBy: { createdAt: "desc" }, take: 20 });
    const names = Object.fromEntries((await prisma.product.findMany({ where: { id: { in: history.flatMap((h) => [h.fromProductId, h.toProductId]) } }, select: { id: true, name: true } })).map((p) => [p.id, p.name]));
    const unpaidRenewal = await prisma.invoiceItem.count({ where: { relId: req.params.id, type: "SERVICE", invoice: { status: "UNPAID" } } });
    res.json({ ...o, unpaidRenewal, history: history.map((h) => ({ ...h, fromName: names[h.fromProductId] ?? "—", toName: names[h.toProductId] ?? "—" })) });
  }),
);

adminUpgrades.post(
  "/services/:id/change-plan",
  requireStaff("services.manage"),
  ah(async (req, res) => {
    const b = parse(
      z.object({
        productId: z.string(),
        cycle: z.nativeEnum(BillingCycle),
        billing: z.enum(["invoice", "free"]).default("invoice"),
        recurringOverride: z.number().int().min(0).max(1_000_000_000).nullish(),
        applyOnServer: z.boolean().default(true),
        creditRefund: z.boolean().default(true),
        sendEmail: z.boolean().default(true),
      }),
      req.body,
    );
    const r = await startUpgrade({ serviceId: req.params.id, toProductId: b.productId, toCycle: b.cycle, byClient: false, actorId: req.user!.id, billing: b.billing, recurringOverride: b.recurringOverride ?? null, applyOnServer: b.applyOnServer, creditRefund: b.creditRefund, sendEmail: b.sendEmail });
    res.status(201).json(r);
  }),
);

adminUpgrades.post(
  "/upgrades/:id/retry",
  requireStaff("services.manage"),
  ah(async (req, res) => {
    const up = await prisma.serviceUpgrade.findUnique({ where: { id: req.params.id } });
    if (!up) throw notFound();
    if (up.status !== "FAILED") throw conflict("Only a failed server change can be retried");
    await prisma.serviceUpgrade.update({ where: { id: up.id }, data: { status: "PROVISIONING", message: "Retrying…" } });
    await enqueueProvision({ serviceId: up.serviceId, action: "change_plan", params: { upgradeId: up.id }, actorId: req.user!.id });
    await audit({ actorId: req.user!.id, userId: up.userId, action: "service.plan_change_retry", entity: "service", entityId: up.serviceId });
    res.json({ ok: true });
  }),
);

/** The server was changed by hand — close the failed step. */
adminUpgrades.post(
  "/upgrades/:id/resolve",
  requireStaff("services.manage"),
  ah(async (req, res) => {
    const up = await prisma.serviceUpgrade.findUnique({ where: { id: req.params.id } });
    if (!up) throw notFound();
    if (up.status !== "FAILED" && up.status !== "PROVISIONING") throw conflict("Nothing to resolve");
    await prisma.serviceUpgrade.update({ where: { id: up.id }, data: { status: "DONE", message: `${up.message ?? ""} — marked done by staff`.trim() } });
    await audit({ actorId: req.user!.id, userId: up.userId, action: "service.plan_change_resolved", entity: "service", entityId: up.serviceId });
    res.json({ ok: true });
  }),
);

adminUpgrades.post(
  "/upgrades/:id/cancel",
  requireStaff("services.manage"),
  ah(async (req, res) => {
    await cancelUpgrade(req.params.id, req.user!.id);
    res.json({ ok: true });
  }),
);
