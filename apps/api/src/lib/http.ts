import type { NextFunction, Request, Response, RequestHandler } from "express";
import { ZodError, type ZodTypeAny, type z } from "zod";

export class HttpError extends Error {
  constructor(public status: number, message: string, public code?: string, public details?: unknown) {
    super(message);
  }
}
export const badRequest = (m: string, details?: unknown) => new HttpError(400, m, "BAD_REQUEST", details);
export const notFound = (m = "Not found") => new HttpError(404, m, "NOT_FOUND");
export const forbidden = (m = "Forbidden") => new HttpError(403, m, "FORBIDDEN");
export const conflict = (m: string) => new HttpError(409, m, "CONFLICT");

export const ah =
  (fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>): RequestHandler =>
  (req, res, next) => {
    fn(req, res, next).catch(next);
  };

export function parse<S extends ZodTypeAny>(schema: S, data: unknown): z.output<S> {
  const r = schema.safeParse(data);
  if (!r.success) throw badRequest("Validation failed", r.error.flatten());
  return r.data;
}

export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction) {
  if (err instanceof HttpError) {
    return res.status(err.status).json({ error: err.message, code: err.code, details: err.details });
  }
  if (err instanceof ZodError) return res.status(400).json({ error: "Validation failed", details: err.flatten() });
  const anyErr = err as { code?: string; meta?: unknown; message?: string };
  if (anyErr?.code === "P2002") return res.status(409).json({ error: "A record with these details already exists", code: "CONFLICT" });
  if (anyErr?.code === "P2025") return res.status(404).json({ error: "Not found", code: "NOT_FOUND" });
  console.error(`[api] ${req.method} ${req.originalUrl}`, err);
  // hypervisor / provisioning failures carry a message meant for staff — show it instead of a bare 500
  const name = (err as { constructor?: { name?: string } })?.constructor?.name ?? "";
  if (["VirtualizorError", "ProvisionError", "ProxmoxError"].includes(name) && anyErr.message) {
    return res.status(502).json({ error: anyErr.message, code: "UPSTREAM" });
  }
  res.status(500).json({ error: "Internal server error" });
}

export function pageParams(q: Record<string, unknown>) {
  const page = Math.max(1, parseInt(String(q.page ?? "1"), 10) || 1);
  const pageSize = Math.min(200, Math.max(1, parseInt(String(q.pageSize ?? "25"), 10) || 25));
  return { page, pageSize, skip: (page - 1) * pageSize, take: pageSize };
}

export function clientIp(req: Request): string {
  return (req.ip ?? "").replace(/^::ffff:/, "");
}
