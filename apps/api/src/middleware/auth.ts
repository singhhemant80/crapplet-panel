import type { NextFunction, Request, Response } from "express";
import jwt from "jsonwebtoken";
import { config } from "../config";
import { prisma } from "../db";
import { HttpError, forbidden } from "../lib/http";
import { sha256 } from "../lib/crypto";

export interface AuthUser {
  id: string;
  type: "CLIENT" | "STAFF";
  email: string;
  sessionId?: string;
  permissions: string[];
  resellerId?: string | null;
  viaApiKey?: boolean;
  scopes?: string[];
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: AuthUser;
      rawBody?: Buffer;
    }
  }
}

export const PERMISSIONS = [
  "clients.view", "clients.manage",
  "orders.view", "orders.manage",
  "products.manage",
  "servers.manage",
  "ips.view", "ips.manage",
  "services.view", "services.manage",
  "billing.view", "billing.manage",
  "payments.manage",
  "tickets.view", "tickets.manage",
  "domains.manage",
  "resellers.manage",
  "content.manage",
  "reports.view",
  "campaigns.manage",
  "settings.manage",
  "staff.manage",
] as const;

export function signAccessToken(u: { id: string; type: string; sid: string }) {
  return jwt.sign({ sub: u.id, typ: u.type, sid: u.sid }, config.jwtSecret, { expiresIn: config.accessTokenTtlSec, issuer: "crapplet", algorithm: "HS256" });
}

async function loadUser(userId: string, sessionId?: string): Promise<AuthUser | null> {
  const [user, session] = await Promise.all([
    prisma.user.findUnique({ where: { id: userId }, include: { role: true, reseller: true } }),
    sessionId ? prisma.session.findUnique({ where: { id: sessionId }, select: { revokedAt: true, expiresAt: true } }) : null,
  ]);
  // staff must be active; customers can use the client area unless their account is closed
  if (!user || user.status === "CLOSED" || (user.type === "STAFF" && user.status !== "ACTIVE")) return null;
  // signed out (logout, password reset, "sign out everywhere") takes effect at once, not when the token expires
  if (sessionId && (!session || session.revokedAt || session.expiresAt < new Date())) return null;
  return {
    id: user.id,
    type: user.type,
    email: user.email,
    sessionId,
    permissions: user.type === "STAFF" ? user.role?.permissions ?? [] : [],
    resellerId: user.reseller?.status === "APPROVED" ? user.reseller.id : null,
  };
}

/** Populates req.user from the access-token cookie, Bearer JWT, or `ck_` API key. Never throws. */
export async function authenticate(req: Request, _res: Response, next: NextFunction) {
  try {
    const header = req.headers.authorization ?? "";
    const bearer = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
    if (bearer.startsWith("ck_")) {
      const [, prefix] = bearer.split("_");
      const key = await prisma.apiKey.findUnique({ where: { keyPrefix: prefix } });
      if (key && !key.revokedAt && key.keyHash === sha256(bearer)) {
        const ip = (req.ip ?? "").replace(/^::ffff:/, "");
        if (key.allowedIps.length === 0 || key.allowedIps.includes(ip)) {
          const u = await loadUser(key.userId);
          if (u) {
            req.user = { ...u, viaApiKey: true, scopes: key.scopes };
            prisma.apiKey.update({ where: { id: key.id }, data: { lastUsedAt: new Date() } }).catch(() => {});
          }
        }
      }
      return next();
    }
    const token = bearer || req.cookies?.cc_at;
    if (token) {
      const payload = jwt.verify(token, config.jwtSecret, { issuer: "crapplet", algorithms: ["HS256"] }) as { sub: string; sid: string; purpose?: string };
      if (!payload.purpose) {
        const u = await loadUser(payload.sub, payload.sid);
        if (u) req.user = u;
      }
    }
  } catch {
    /* invalid / expired token → anonymous */
  }
  next();
}

/** Cookie-authenticated state-changing requests must carry a custom header (blocked cross-site by CORS). */
export function csrfGuard(req: Request, _res: Response, next: NextFunction) {
  if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return next();
  if (req.path.startsWith("/webhooks") || req.path.startsWith("/payments/callback")) return next();
  // email unsubscribe (a form in the email's landing page, and Gmail/Yahoo one-click) — token-protected, no cookies needed
  if (/^(\/api)?\/e\/u\/[A-Za-z0-9_-]+$/.test(req.path)) return next();
  const usesCookie = !req.headers.authorization && (req.cookies?.cc_at || req.cookies?.cc_rt);
  if (usesCookie && req.headers["x-requested-with"] !== "crapplet") return next(new HttpError(403, "CSRF check failed"));
  next();
}

export function requireAuth(req: Request, _res: Response, next: NextFunction) {
  if (!req.user) return next(new HttpError(401, "Authentication required", "UNAUTHENTICATED"));
  next();
}

export function requireClient(req: Request, _res: Response, next: NextFunction) {
  if (!req.user) return next(new HttpError(401, "Authentication required", "UNAUTHENTICATED"));
  if (req.user.type !== "CLIENT") return next(forbidden("Client account required"));
  next();
}

export function hasPerm(user: AuthUser | undefined, perm: string) {
  if (!user || user.type !== "STAFF") return false;
  if (user.permissions.includes("*")) return true;
  if (user.permissions.includes(perm)) return true;
  // "x.manage" implies "x.view"
  if (perm.endsWith(".view") && user.permissions.includes(perm.replace(/\.view$/, ".manage"))) return true;
  return false;
}

export const requireStaff =
  (perm?: string) =>
  (req: Request, _res: Response, next: NextFunction) => {
    if (!req.user) return next(new HttpError(401, "Authentication required", "UNAUTHENTICATED"));
    if (req.user.type !== "STAFF" || req.user.viaApiKey) return next(forbidden("Staff access required"));
    if (perm && !hasPerm(req.user, perm)) return next(forbidden(`Missing permission: ${perm}`));
    next();
  };

export function requireReseller(req: Request, _res: Response, next: NextFunction) {
  if (!req.user) return next(new HttpError(401, "Authentication required", "UNAUTHENTICATED"));
  if (!req.user.resellerId) return next(forbidden("Approved reseller account required"));
  next();
}

export const requireScope =
  (scope: string) =>
  (req: Request, _res: Response, next: NextFunction) => {
    if (req.user?.viaApiKey && !(req.user.scopes ?? []).some((s) => s === "*" || s === scope))
      return next(forbidden(`API key missing scope: ${scope}`));
    next();
  };
