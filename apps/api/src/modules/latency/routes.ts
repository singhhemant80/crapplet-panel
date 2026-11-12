import { Router } from "express";
import { z } from "zod";
import { ah, parse } from "../../lib/http";
import { audit } from "../../lib/audit";
import { requireStaff } from "../../middleware/auth";
import { adminView, measure, measureAll, publicView, saveLatencyConfig } from "./service";

/** GET /api/public/broker-latency — for the Forex VPS page (no sign-in, cached briefly). */
export const publicLatency = Router();
let cache: { at: number; body: unknown } | null = null;
publicLatency.get(
  "/public/broker-latency",
  ah(async (_req, res) => {
    if (!cache || Date.now() - cache.at > 10_000) cache = { at: Date.now(), body: await publicView() };
    res.setHeader("cache-control", "public, max-age=15");
    res.json(cache.body);
  }),
);

const host = z
  .string()
  .trim()
  .toLowerCase()
  .min(1, "Enter the trade server's address")
  .max(253)
  .regex(/^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9-]{2,63}$|^\d{1,3}(\.\d{1,3}){3}$|^[0-9a-f:]+$/, "Use a hostname like mt5.broker.com or an IP address");

export const adminLatency = Router();
adminLatency.get("/broker-latency", requireStaff("settings.manage"), ah(async (_req, res) => res.json(await adminView())));

adminLatency.put(
  "/broker-latency",
  requireStaff("settings.manage"),
  ah(async (req, res) => {
    const b = parse(
      z.object({
        enabled: z.boolean().optional(),
        measuredFrom: z.string().trim().max(80).optional(),
        brokers: z.array(z.object({ id: z.string().max(64).optional(), name: z.string().trim().min(1, "Name the broker").max(60), host: host.or(z.literal("")), port: z.number().int().min(1).max(65535).default(443), region: z.string().trim().max(40).optional(), enabled: z.boolean().default(true) })).max(30).optional(),
      }),
      req.body,
    );
    await saveLatencyConfig(b as never);
    cache = null;
    await audit({ actorId: req.user!.id, action: "broker_latency.settings", entity: "Setting", entityId: "brokerLatency", details: { brokers: b.brokers?.length } });
    res.json(await adminView());
  }),
);

/** Measure everything now (instead of waiting for the next minute). */
adminLatency.post(
  "/broker-latency/measure",
  requireStaff("settings.manage"),
  ah(async (_req, res) => {
    const r = await measureAll();
    cache = null;
    res.json({ ...r, ...(await adminView()) });
  }),
);

/** Try one address before saving it. */
adminLatency.post(
  "/broker-latency/test",
  requireStaff("settings.manage"),
  ah(async (req, res) => {
    const b = parse(z.object({ host, port: z.number().int().min(1).max(65535).default(443) }), req.body);
    res.json(await measure(b.host, b.port, 3));
  }),
);
