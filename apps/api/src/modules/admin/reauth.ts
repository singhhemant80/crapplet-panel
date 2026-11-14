/**
 * Staff password re-confirmation ("sudo mode").
 *
 * Products, Servers and Setup, and critical actions anywhere (closing or deleting a customer, refunds,
 * terminating a service, changing settings …), need the staff member's password again. Confirming opens
 * a short window on that sign-in session only; it isn't granted by logging in.
 *
 * Enforced here on the server — the admin UI only asks for the password and retries.
 */
import { Router, type NextFunction, type Request, type Response } from "express";
import { z } from "zod";
import { prisma } from "../../db";
import { ah, clientIp, HttpError, parse } from "../../lib/http";
import { audit } from "../../lib/audit";
import { verifyPassword } from "../../lib/passwords";
import { requireStaff } from "../../middleware/auth";

export const REAUTH_MINUTES = Math.max(1, Math.min(120, Number(process.env.REAUTH_MINUTES) || 15));
const MAX_FAILURES = 5;

type Rule = { methods: "write" | "any" | string[]; path: RegExp; label: string; when?: (req: Request) => Promise<boolean> | boolean };

const CATALOGUE = /^\/(product-groups|products|addons|promo-codes|os-templates|domain-pricing|currencies)(\/|$)/;
const INFRA = /^\/(servers|proxmox|subnets|ips|locations|monitoring\/nodes)(\/|$)|^\/virtualizor\/(?!sync-all)[^/]+\/(sync-ips|sync-os)$/;
const SETUP = /^\/(gateways|settings|email-templates|roles|staff|email|backups|migration|automation|broker-latency)(\/|$)|^\/whatsapp(\/test)?$/;

const DANGEROUS_SERVICE_ACTIONS = new Set(["create", "terminate", "reinstall", "reset_password", "change_package"]);

/** Paths are relative to /api/admin. */
export const RULES: Rule[] = [
  // whole areas — every change
  { methods: "write", path: CATALOGUE, label: "Products & catalogue" },
  { methods: "write", path: INFRA, label: "Servers & infrastructure" },
  { methods: "write", path: SETUP, label: "Setup" },
  // areas whose pages show secrets or let you take the whole system with you
  { methods: ["GET"], path: /^\/(gateways|backups|migration|roles)(\/|$)|^\/settings(\/|$)|^\/email\/settings$|^\/whatsapp$|^\/automation\/settings$/, label: "Setup" },

  // customers
  { methods: ["POST"], path: /^\/clients\/[^/]+\/(close|merge|set-password|reset-2fa|credit)$/, label: "Customer account" },
  { methods: ["DELETE"], path: /^\/clients\/[^/]+$/, label: "Delete customer" },
  { methods: ["DELETE"], path: /^\/clients\/[^/]+\/pay-methods\/[^/]+$/, label: "Remove a saved payment method" },
  {
    methods: ["PUT"],
    path: /^\/clients\/[^/]+$/,
    label: "Change customer email or status",
    when: async (req) => {
      const b = (req.body ?? {}) as { email?: unknown; status?: unknown };
      if (b.email === undefined && b.status === undefined) return false;
      const id = req.path.split("/")[2];
      const u = await prisma.user.findUnique({ where: { id }, select: { email: true, status: true } });
      if (!u) return false;
      return (typeof b.email === "string" && b.email.trim().toLowerCase() !== u.email) || (b.status !== undefined && b.status !== u.status);
    },
  },

  // orders & services
  { methods: ["POST"], path: /^\/orders\/[^/]+\/(cancel|status)$/, label: "Cancel or change an order" },
  { methods: ["POST"], path: /^\/services\/[^/]+\/(recreate|replace-ips|hosting-password|cpanel-login|console)$/, label: "Service access" },
  { methods: ["PUT"], path: /^\/services\/[^/]+$/, label: "Edit a service" },
  { methods: ["POST"], path: /^\/services\/[^/]+\/action$/, label: "Service action", when: (req) => DANGEROUS_SERVICE_ACTIONS.has(String((req.body as { action?: unknown })?.action ?? "")) },

  // money
  { methods: ["POST"], path: /^\/invoices\/[^/]+\/(refund|cancel|credit-note|payment)$/, label: "Invoice payment, refund or cancellation" },
  { methods: ["PUT", "DELETE"], path: /^\/invoices\/[^/]+$/, label: "Edit or delete an invoice" },
  { methods: ["POST"], path: /^\/invoices\/(merge|[^/]+\/(split|status))$/, label: "Change an invoice" },
  { methods: ["POST"], path: /^\/invoices\/bulk$/, label: "Bulk invoice action", when: (req) => ["mark_paid", "cancel", "delete"].includes(String((req.body as { action?: unknown })?.action ?? "")) },
  { methods: ["DELETE"], path: /^\/quotes\/[^/]+$/, label: "Delete a quote" },
  { methods: ["POST"], path: /^\/services\/[^/]+\/change-plan$/, label: "Change a service's plan" },
  { methods: ["POST"], path: /^\/transactions\/[^/]+\/refund$/, label: "Refund" },
  { methods: ["POST"], path: /^\/payment-reviews\/[^/]+$/, label: "Approve a payment" },
  { methods: ["POST"], path: /^\/referrals\/[^/]+\/approve$/, label: "Affiliate payout" },

  // bulk email to customers
  { methods: ["POST"], path: /^\/campaigns\/[^/]+\/send$/, label: "Send an email campaign" },

  // other people's accounts
  { methods: ["PUT"], path: /^\/domains\/[^/]+$/, label: "Domain change" },
  { methods: ["PUT"], path: /^\/resellers\/[^/]+$/, label: "Reseller change" },
];

export async function reauthReason(req: Request): Promise<string | null> {
  const m = req.method.toUpperCase();
  for (const r of RULES) {
    const okMethod = r.methods === "any" ? true : r.methods === "write" ? !["GET", "HEAD", "OPTIONS"].includes(m) : r.methods.includes(m);
    if (!okMethod || !r.path.test(req.path)) continue;
    if (r.when && !(await r.when(req))) continue;
    return r.label;
  }
  return null;
}

async function sudoUntil(sessionId?: string) {
  if (!sessionId) return null;
  const s = await prisma.session.findUnique({ where: { id: sessionId }, select: { sudoUntil: true } });
  return s?.sudoUntil && s.sudoUntil > new Date() ? s.sudoUntil : null;
}

export const reauthRequired = (label: string) =>
  new HttpError(403, "Please confirm your password to continue", "REAUTH_REQUIRED", { label, minutes: REAUTH_MINUTES });

/** Mounted in front of the admin routers. Non-staff requests pass through (the routes themselves refuse them). */
export async function reauthGuard(req: Request, _res: Response, next: NextFunction) {
  try {
    if (!req.user || req.user.type !== "STAFF" || req.user.viaApiKey) return next();
    const label = await reauthReason(req);
    if (!label) return next();
    if (await sudoUntil(req.user.sessionId)) return next();
    next(reauthRequired(label));
  } catch (e) {
    next(e);
  }
}

/** For single routes outside /admin (e.g. "Login as customer"). */
export const requireReauth = (label: string) => async (req: Request, _res: Response, next: NextFunction) => {
  try {
    if (await sudoUntil(req.user?.sessionId)) return next();
    next(reauthRequired(label));
  } catch (e) {
    next(e);
  }
};

// ── /api/auth/reauth ──
export const reauthRouter = Router();

reauthRouter.get(
  "/reauth",
  requireStaff(),
  ah(async (req, res) => {
    const until = await sudoUntil(req.user!.sessionId);
    res.json({ active: !!until, until, minutes: REAUTH_MINUTES });
  }),
);

reauthRouter.post(
  "/reauth",
  requireStaff(),
  ah(async (req, res) => {
    const { password } = parse(z.object({ password: z.string().min(1).max(200) }), req.body);
    const sid = req.user!.sessionId;
    if (!sid) throw new HttpError(400, "Sign in again to continue");
    const u = await prisma.user.findUniqueOrThrow({ where: { id: req.user!.id } });
    if (!(await verifyPassword(u, password))) {
      const s = await prisma.session.update({ where: { id: sid }, data: { sudoFailures: { increment: 1 } }, select: { sudoFailures: true } });
      await audit({ actorId: u.id, userId: u.id, action: "auth.reauth_failed", ip: clientIp(req), details: { attempt: s.sudoFailures } });
      if (s.sudoFailures >= MAX_FAILURES) {
        await prisma.session.update({ where: { id: sid }, data: { revokedAt: new Date(), sudoUntil: null } });
        await audit({ actorId: u.id, userId: u.id, action: "auth.reauth_locked_out", ip: clientIp(req) });
        throw new HttpError(401, "Too many wrong passwords — you've been signed out", "UNAUTHENTICATED");
      }
      const left = MAX_FAILURES - s.sudoFailures;
      throw new HttpError(400, `Wrong password — ${left} ${left === 1 ? "try" : "tries"} left before you're signed out`, "BAD_PASSWORD");
    }
    const until = new Date(Date.now() + REAUTH_MINUTES * 60_000);
    await prisma.session.update({ where: { id: sid }, data: { sudoUntil: until, sudoFailures: 0 } });
    await audit({ actorId: u.id, userId: u.id, action: "auth.reauth", ip: clientIp(req), details: { minutes: REAUTH_MINUTES } });
    res.json({ active: true, until, minutes: REAUTH_MINUTES });
  }),
);

/** "Lock now" */
reauthRouter.delete(
  "/reauth",
  requireStaff(),
  ah(async (req, res) => {
    if (req.user!.sessionId) await prisma.session.update({ where: { id: req.user!.sessionId }, data: { sudoUntil: null } });
    res.json({ active: false });
  }),
);

/**
 * Every /admin/clients/:id/… route acts on a customer. Refuse when the id is a staff account, so the
 * client tools (edit email/status, set password, reset 2FA, credit, close, merge …) can't be turned on
 * an administrator by someone who only has client permissions.
 */
export async function customerTargetGuard(req: Request, _res: Response, next: NextFunction) {
  try {
    const m = /^\/clients\/([^/]+)/.exec(req.path);
    if (!m || !req.user || req.user.type !== "STAFF") return next();
    const u = await prisma.user.findUnique({ where: { id: m[1] }, select: { type: true } });
    if (u && u.type !== "CLIENT") return next(new HttpError(404, "Client not found"));
    // the merge target too
    const into = (req.body as { intoUserId?: unknown } | undefined)?.intoUserId;
    if (typeof into === "string") {
      const t = await prisma.user.findUnique({ where: { id: into }, select: { type: true } });
      if (t && t.type !== "CLIENT") return next(new HttpError(404, "Client not found"));
    }
    next();
  } catch (e) {
    next(e);
  }
}
