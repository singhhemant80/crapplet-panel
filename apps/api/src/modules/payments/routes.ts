import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../db";
import { config } from "../../config";
import { ah, parse } from "../../lib/http";
import { requireAuth } from "../../middleware/auth";
import { GATEWAYS, gatewayCurrencies } from "./gateways";
import { handleWebhook, startPayment, submitOfflineReference, verifyReturn, gatewayConfig } from "./service";

export const paymentsRouter = Router();
export const webhooksRouter = Router();

paymentsRouter.get(
  "/methods",
  ah(async (req, res) => {
    // ?currency=USD → only methods that can charge that currency
    const cur = typeof req.query.currency === "string" ? req.query.currency.toUpperCase() : null;
    const rows = await prisma.paymentGateway.findMany({ where: { enabled: true }, orderBy: { sortOrder: "asc" } });
    res.json({
      methods: rows
        .filter((r) => GATEWAYS[r.code])
        .map((r) => ({ code: r.code, name: r.name, offline: !!GATEWAYS[r.code].offline, currencies: gatewayCurrencies(r.code, r.publicConfig) }))
        .filter((m) => !cur || m.currencies.includes(cur)),
    });
  }),
);

paymentsRouter.post(
  "/start",
  requireAuth,
  ah(async (req, res) => {
    const body = parse(z.object({ invoiceId: z.string(), gateway: z.string(), amount: z.number().int().positive().optional() }), req.body);
    res.json(await startPayment({ userId: req.user!.id, ...body }));
  }),
);

paymentsRouter.post(
  "/:intentId/verify",
  requireAuth,
  ah(async (req, res) => {
    res.json(await verifyReturn({ userId: req.user!.id, intentId: req.params.intentId, body: req.body ?? {} }));
  }),
);

/** Lookup by gateway order id (Stripe session id / Cashfree order id from the return URL). */
paymentsRouter.post(
  "/verify-return",
  requireAuth,
  ah(async (req, res) => {
    const body = parse(z.object({ gateway: z.string(), orderId: z.string() }).passthrough(), req.body);
    const intent = await prisma.paymentIntent.findFirst({ where: { gateway: body.gateway, OR: [{ gatewayOrderId: body.orderId }, { id: body.orderId }], userId: req.user!.id } });
    if (!intent) return res.status(404).json({ error: "Payment not found" });
    res.json(await verifyReturn({ userId: req.user!.id, intentId: intent.id, body: { ...req.body, session_id: body.orderId } }));
  }),
);

paymentsRouter.post(
  "/:intentId/reference",
  requireAuth,
  ah(async (req, res) => {
    const { reference } = parse(z.object({ reference: z.string().trim().min(6).max(40) }), req.body);
    res.json(await submitOfflineReference({ userId: req.user!.id, intentId: req.params.intentId, reference }));
  }),
);

/** PayU posts the browser back here (surl/furl). The hash is verified server-side before anything is applied. */
paymentsRouter.post(
  "/callback/payu",
  ah(async (req, res) => {
    const body = req.body as Record<string, string>;
    const intent = await prisma.paymentIntent.findUnique({ where: { id: String(body.txnid ?? "") } });
    if (!intent) return res.redirect(303, `${config.appUrl}/client/invoices?payment=unknown`);
    try {
      const r = await verifyReturn({ intentId: intent.id, body });
      res.redirect(303, `${config.appUrl}/client/invoices/${intent.invoiceId}?payment=${r.paid ? "success" : "failed"}`);
    } catch (e) {
      console.error("[payu] callback rejected", e);
      res.redirect(303, `${config.appUrl}/client/invoices/${intent.invoiceId}?payment=failed`);
    }
  }),
);

webhooksRouter.post(
  "/:gateway",
  ah(async (req, res) => {
    const code = req.params.gateway;
    if (code === "payu") {
      // PayU webhooks use the same signed form as the browser callback
      const body = req.body as Record<string, string>;
      await gatewayConfig("payu");
      const r = await verifyReturn({ intentId: String(body.txnid ?? ""), body });
      return res.json(r);
    }
    if (!GATEWAYS[code]) return res.status(404).json({ error: "Unknown gateway" });
    const raw = req.rawBody ?? Buffer.from(JSON.stringify(req.body ?? {}));
    res.json(await handleWebhook(code, raw, req.headers));
  }),
);
