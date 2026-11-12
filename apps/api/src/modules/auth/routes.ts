import { Router, type Request, type Response } from "express";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import rateLimit from "express-rate-limit";
import { authenticator } from "otplib";
import QRCode from "qrcode";
import { z } from "zod";
import { config } from "../../config";
import { prisma } from "../../db";
import { ah, badRequest, clientIp, HttpError, notFound, parse } from "../../lib/http";
import { decrypt, encrypt, randomToken, sha256 } from "../../lib/crypto";
import { getSettings } from "../../lib/settings";
import { audit } from "../../lib/audit";
import { requireAuth, requireStaff, signAccessToken } from "../../middleware/auth";
import { queueEmail } from "../email/mailer";
import { resolveStateCode } from "./states";
import { verifyPassword } from "../../lib/passwords";
import { requireReauth } from "../admin/reauth";
export { INDIAN_STATES, resolveStateCode } from "./states";

export const authRouter = Router();
authenticator.options = { window: 1 };
// used to keep login timing constant when the email does not exist
const DUMMY_HASH = bcrypt.hashSync("timing-equaliser", 12);

const limiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 30, standardHeaders: true, legacyHeaders: false });
const strictLimiter = rateLimit({ windowMs: 60 * 60 * 1000, limit: 10, standardHeaders: true, legacyHeaders: false });

const password = z.string().min(8, "Password must be at least 8 characters").max(128);
const GSTIN_RE = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;
const PAN_RE = /^[A-Z]{5}[0-9]{4}[A-Z]$/;

export const profileSchema = z.object({
  firstName: z.string().trim().min(1).max(80),
  lastName: z.string().trim().max(80).default(""),
  phone: z.string().trim().min(6).max(20),
  companyName: z.string().trim().max(160).optional().nullable(),
  gstin: z
    .string()
    .trim()
    .toUpperCase()
    .regex(GSTIN_RE, "Invalid GSTIN")
    .optional()
    .nullable()
    .or(z.literal("").transform(() => null)),
  pan: z
    .string()
    .trim()
    .toUpperCase()
    .regex(PAN_RE, "Invalid PAN")
    .optional()
    .nullable()
    .or(z.literal("").transform(() => null)),
  address1: z.string().trim().min(3).max(200),
  address2: z.string().trim().max(200).optional().nullable(),
  city: z.string().trim().min(2).max(80),
  state: z.string().trim().min(2).max(80),
  stateCode: z.string().trim().max(2).optional().nullable(),
  country: z.string().trim().length(2).default("IN"),
  postcode: z.string().trim().min(3).max(12),
});

const registerSchema = profileSchema.extend({
  email: z.string().trim().toLowerCase().email(),
  password,
  ref: z.string().trim().max(40).optional(),
});

function setAuthCookies(res: Response, access: string, refresh: string) {
  const secure = config.cookieSecure === "auto" ? !!res.req?.secure : config.cookieSecure;
  const base = { httpOnly: true, secure, sameSite: "lax" as const };
  res.cookie("cc_at", access, { ...base, path: "/", maxAge: config.accessTokenTtlSec * 1000 });
  res.cookie("cc_rt", refresh, { ...base, path: "/api/auth", maxAge: config.refreshTokenTtlDays * 86400 * 1000 });
}
function clearAuthCookies(res: Response) {
  res.clearCookie("cc_at", { path: "/" });
  res.clearCookie("cc_rt", { path: "/api/auth" });
}

async function startSession(req: Request, res: Response, user: { id: string; type: string }, opts: { impersonatedById?: string } = {}) {
  const refresh = randomToken(48);
  const session = await prisma.session.create({
    data: {
      userId: user.id,
      impersonatedById: opts.impersonatedById ?? null,
      refreshTokenHash: sha256(refresh),
      ip: clientIp(req),
      userAgent: String(req.headers["user-agent"] ?? "").slice(0, 300),
      expiresAt: new Date(Date.now() + config.refreshTokenTtlDays * 86400000),
    },
  });
  const access = signAccessToken({ id: user.id, type: user.type, sid: session.id });
  setAuthCookies(res, access, refresh);
  return { accessToken: access, sessionId: session.id };
}

export async function publicUser(userId: string) {
  const u = await prisma.user.findUniqueOrThrow({
    where: { id: userId },
    include: { profile: true, role: true, reseller: true, affiliate: true },
  });
  return {
    id: u.id,
    type: u.type,
    email: u.email,
    firstName: u.firstName,
    lastName: u.lastName,
    phone: u.phone,
    emailVerified: !!u.emailVerifiedAt,
    totpEnabled: u.totpEnabled,
    marketingEmails: u.marketingEmails,
    role: u.role ? { name: u.role.name, permissions: u.role.permissions } : null,
    profile: u.profile ? { ...u.profile } : null,
    reseller: u.reseller ? { id: u.reseller.id, status: u.reseller.status, brandName: u.reseller.brandName } : null,
    affiliate: u.affiliate ? { code: u.affiliate.code } : null,
    createdAt: u.createdAt,
  };
}

async function sendVerification(user: { id: string; email: string; firstName: string }) {
  const token = randomToken();
  await prisma.verificationToken.create({
    data: { userId: user.id, type: "EMAIL_VERIFY", tokenHash: sha256(token), expiresAt: new Date(Date.now() + 86400000) },
  });
  await queueEmail("auth.verify_email", user.email, { name: user.firstName, link: `${config.appUrl}/client/verify-email?token=${token}` }, user.id);
}

authRouter.post(
  "/register",
  strictLimiter,
  ah(async (req, res) => {
    const body = parse(registerSchema, req.body);
    const exists = await prisma.user.findUnique({ where: { email: body.email } });
    if (exists) throw new HttpError(409, "An account with this email already exists", "EMAIL_TAKEN");
    const settings = await getSettings();
    const stateCode = resolveStateCode(body.country, body.state, body.gstin, body.stateCode);
    const affiliate = body.ref ? await prisma.affiliate.findUnique({ where: { code: body.ref } }) : null;

    const user = await prisma.user.create({
      data: {
        email: body.email,
        passwordHash: await bcrypt.hash(body.password, 12),
        firstName: body.firstName,
        lastName: body.lastName,
        phone: body.phone,
        profile: {
          create: {
            companyName: body.companyName || null,
            gstin: body.gstin || null,
            pan: body.pan || null,
            address1: body.address1,
            address2: body.address2 || null,
            city: body.city,
            state: body.state,
            stateCode,
            country: body.country,
            postcode: body.postcode,
            currency: body.country === "IN" ? "INR" : "USD",
            affiliateRef: affiliate?.code ?? null,
          },
        },
      },
    });
    if (affiliate) await prisma.affiliate.update({ where: { id: affiliate.id }, data: { visitors: { increment: 0 } } });
    await sendVerification(user);
    await queueEmail("auth.welcome", user.email, { name: user.firstName }, user.id);
    await audit({ actorId: user.id, userId: user.id, action: "client.registered", ip: clientIp(req) });
    await startSession(req, res, user);
    res.status(201).json({ user: await publicUser(user.id), requireEmailVerification: settings.orders.requireEmailVerification });
  }),
);

const loginSchema = z.object({ email: z.string().trim().toLowerCase().email(), password: z.string().min(1), portal: z.enum(["client", "admin"]).default("client") });

authRouter.post(
  "/login",
  limiter,
  ah(async (req, res) => {
    const body = parse(loginSchema, req.body);
    const user = await prisma.user.findUnique({ where: { email: body.email } });
    const ok = user ? await verifyPassword(user, body.password) : await bcrypt.compare(body.password, DUMMY_HASH);
    const fail = async (reason: string) => {
      await prisma.loginHistory.create({
        data: { userId: user?.id, email: body.email, ip: clientIp(req), userAgent: String(req.headers["user-agent"] ?? "").slice(0, 300), success: false, reason },
      });
      throw new HttpError(401, "Invalid email or password", "INVALID_CREDENTIALS");
    };
    if (!user || !ok) return fail("bad_credentials");
    if (user.status !== "ACTIVE") return fail("inactive");
    if (body.portal === "admin" && user.type !== "STAFF") return fail("not_staff");

    if (user.totpEnabled) {
      const challenge = jwt.sign({ sub: user.id, purpose: "2fa" }, config.jwtSecret, { expiresIn: 300, issuer: "crapplet" });
      return res.json({ twoFactorRequired: true, challenge });
    }
    await prisma.loginHistory.create({
      data: { userId: user.id, email: user.email, ip: clientIp(req), userAgent: String(req.headers["user-agent"] ?? "").slice(0, 300), success: true },
    });
    await startSession(req, res, user);
    res.json({ user: await publicUser(user.id) });
  }),
);

authRouter.post(
  "/login/2fa",
  limiter,
  ah(async (req, res) => {
    const body = parse(z.object({ challenge: z.string(), code: z.string().regex(/^\d{6}$/) }), req.body);
    let payload: { sub: string; purpose: string };
    try {
      payload = jwt.verify(body.challenge, config.jwtSecret, { issuer: "crapplet" }) as typeof payload;
    } catch {
      throw new HttpError(401, "Login challenge expired, please sign in again");
    }
    if (payload.purpose !== "2fa") throw new HttpError(401, "Invalid challenge");
    const user = await prisma.user.findUniqueOrThrow({ where: { id: payload.sub } });
    if (!user.totpSecretEnc || !authenticator.verify({ token: body.code, secret: decrypt(user.totpSecretEnc) })) {
      await prisma.loginHistory.create({ data: { userId: user.id, email: user.email, ip: clientIp(req), success: false, reason: "bad_2fa" } });
      throw new HttpError(401, "Invalid authentication code", "INVALID_2FA");
    }
    await prisma.loginHistory.create({
      data: { userId: user.id, email: user.email, ip: clientIp(req), userAgent: String(req.headers["user-agent"] ?? "").slice(0, 300), success: true, reason: "2fa" },
    });
    await startSession(req, res, user);
    res.json({ user: await publicUser(user.id) });
  }),
);

authRouter.post(
  "/refresh",
  ah(async (req, res) => {
    const token = req.cookies?.cc_rt || req.body?.refreshToken;
    if (!token) throw new HttpError(401, "No refresh token");
    const session = await prisma.session.findUnique({ where: { refreshTokenHash: sha256(token) }, include: { user: true } });
    if (!session || session.revokedAt || session.expiresAt < new Date() || session.user.status !== "ACTIVE") {
      clearAuthCookies(res);
      throw new HttpError(401, "Session expired");
    }
    // rotate refresh token
    const next = randomToken(48);
    await prisma.session.update({ where: { id: session.id }, data: { refreshTokenHash: sha256(next), lastUsedAt: new Date(), ip: clientIp(req) } });
    setAuthCookies(res, signAccessToken({ id: session.userId, type: session.user.type, sid: session.id }), next);
    res.json({ ok: true });
  }),
);

authRouter.post(
  "/logout",
  ah(async (req, res) => {
    const token = req.cookies?.cc_rt;
    if (token) await prisma.session.updateMany({ where: { refreshTokenHash: sha256(token) }, data: { revokedAt: new Date() } });
    clearAuthCookies(res);
    res.json({ ok: true });
  }),
);

authRouter.get(
  "/me",
  requireAuth,
  ah(async (req, res) => {
    const sess = req.user!.sessionId ? await prisma.session.findUnique({ where: { id: req.user!.sessionId }, select: { impersonatedById: true } }) : null;
    const by = sess?.impersonatedById ? await prisma.user.findUnique({ where: { id: sess.impersonatedById }, select: { firstName: true, lastName: true, email: true } }) : null;
    res.json({ user: { ...(await publicUser(req.user!.id)), impersonatedBy: by ? { name: [by.firstName, by.lastName].filter(Boolean).join(" ") || by.email } : null } });
  }),
);

// ───── Login as client (staff) ─────
const IMP_KEY = (t: string) => `crapplet:imp:${t}`;

/** Staff open the client area as a customer. The staff session is set aside and restored by /impersonate/end. */
authRouter.post(
  "/impersonate",
  requireAuth,
  requireStaff("clients.manage"),
  requireReauth("Log in as customer"),
  ah(async (req, res) => {
    const { userId } = parse(z.object({ userId: z.string() }), req.body);
    const target = await prisma.user.findUnique({ where: { id: userId } });
    if (!target || target.type !== "CLIENT") throw badRequest("That account isn't a customer");
    if (target.status !== "ACTIVE") throw badRequest(`The customer's account is ${target.status.toLowerCase()}`);
    const staffId = req.user!.id;
    if (req.user!.sessionId) await prisma.session.update({ where: { id: req.user!.sessionId }, data: { revokedAt: new Date() } }).catch(() => null);
    await startSession(req, res, target, { impersonatedById: staffId });
    const ticket = randomToken(32);
    const { redis } = await import("../../jobs/queues");
    await redis().set(IMP_KEY(ticket), JSON.stringify({ staffId, clientId: target.id }), "EX", 12 * 3600);
    const secure = config.cookieSecure === "auto" ? !!req.secure : config.cookieSecure;
    res.cookie("cc_imp", ticket, { httpOnly: true, secure, sameSite: "lax", path: "/api/auth", maxAge: 12 * 3600 * 1000 });
    await audit({ actorId: staffId, userId: target.id, action: "client.login_as", entity: "user", entityId: target.id, ip: clientIp(req) });
    res.json({ ok: true, redirect: "/client" });
  }),
);

/** Leave the customer's area and return to the admin as the staff member who started it. */
authRouter.post(
  "/impersonate/end",
  requireAuth,
  ah(async (req, res) => {
    const sess = req.user!.sessionId ? await prisma.session.findUnique({ where: { id: req.user!.sessionId } }) : null;
    if (!sess?.impersonatedById) throw badRequest("You aren't signed in as a customer");
    const ticket = String(req.cookies?.cc_imp ?? "");
    const { redis } = await import("../../jobs/queues");
    const raw = ticket ? await redis().get(IMP_KEY(ticket)) : null;
    const data = raw ? (JSON.parse(raw) as { staffId: string; clientId: string }) : null;
    await prisma.session.update({ where: { id: sess.id }, data: { revokedAt: new Date() } });
    res.clearCookie("cc_imp", { path: "/api/auth" });
    if (ticket) await redis().del(IMP_KEY(ticket));
    const staff = data && data.staffId === sess.impersonatedById ? await prisma.user.findUnique({ where: { id: data.staffId } }) : null;
    if (!staff || staff.type !== "STAFF" || staff.status !== "ACTIVE") {
      clearAuthCookies(res);
      return res.json({ ok: true, redirect: "/admin/login" });
    }
    await startSession(req, res, staff);
    await audit({ actorId: staff.id, userId: sess.userId, action: "client.login_as_ended", entity: "user", entityId: sess.userId, ip: clientIp(req) });
    res.json({ ok: true, redirect: `/admin/clients/${sess.userId}` });
  }),
);

authRouter.post(
  "/verify-email",
  ah(async (req, res) => {
    const { token } = parse(z.object({ token: z.string().min(10) }), req.body);
    const t = await prisma.verificationToken.findUnique({ where: { tokenHash: sha256(token) } });
    if (!t || t.type !== "EMAIL_VERIFY" || t.usedAt || t.expiresAt < new Date()) throw badRequest("This verification link is invalid or has expired");
    await prisma.$transaction([
      prisma.verificationToken.update({ where: { id: t.id }, data: { usedAt: new Date() } }),
      prisma.user.update({ where: { id: t.userId }, data: { emailVerifiedAt: new Date() } }),
    ]);
    res.json({ ok: true });
  }),
);

authRouter.post(
  "/resend-verification",
  requireAuth,
  strictLimiter,
  ah(async (req, res) => {
    const u = await prisma.user.findUniqueOrThrow({ where: { id: req.user!.id } });
    if (u.emailVerifiedAt) return res.json({ ok: true, alreadyVerified: true });
    await sendVerification(u);
    res.json({ ok: true });
  }),
);

authRouter.post(
  "/forgot-password",
  strictLimiter,
  ah(async (req, res) => {
    const { email } = parse(z.object({ email: z.string().trim().toLowerCase().email() }), req.body);
    const user = await prisma.user.findUnique({ where: { email } });
    if (user && user.status === "ACTIVE") {
      const token = randomToken();
      await prisma.verificationToken.create({
        data: { userId: user.id, type: "PASSWORD_RESET", tokenHash: sha256(token), expiresAt: new Date(Date.now() + 3600000) },
      });
      const base = user.type === "STAFF" ? `${config.appUrl}/admin/reset-password` : `${config.appUrl}/client/reset-password`;
      await queueEmail("auth.password_reset", user.email, { name: user.firstName, link: `${base}?token=${token}` }, user.id);
    }
    // same response whether or not the account exists
    res.json({ ok: true });
  }),
);

authRouter.post(
  "/reset-password",
  limiter,
  ah(async (req, res) => {
    const body = parse(z.object({ token: z.string().min(10), password }), req.body);
    const t = await prisma.verificationToken.findUnique({ where: { tokenHash: sha256(body.token) } });
    if (!t || t.type !== "PASSWORD_RESET" || t.usedAt || t.expiresAt < new Date()) throw badRequest("This reset link is invalid or has expired");
    await prisma.$transaction([
      prisma.verificationToken.update({ where: { id: t.id }, data: { usedAt: new Date() } }),
      prisma.user.update({ where: { id: t.userId }, data: { passwordHash: await bcrypt.hash(body.password, 12) } }),
      prisma.session.updateMany({ where: { userId: t.userId, revokedAt: null }, data: { revokedAt: new Date() } }),
    ]);
    await audit({ actorId: t.userId, userId: t.userId, action: "auth.password_reset", ip: clientIp(req) });
    res.json({ ok: true });
  }),
);

authRouter.post(
  "/change-password",
  requireAuth,
  ah(async (req, res) => {
    const body = parse(z.object({ currentPassword: z.string(), newPassword: password }), req.body);
    const u = await prisma.user.findUniqueOrThrow({ where: { id: req.user!.id } });
    if (!(await verifyPassword(u, body.currentPassword))) throw badRequest("Current password is incorrect");
    await prisma.user.update({ where: { id: u.id }, data: { passwordHash: await bcrypt.hash(body.newPassword, 12) } });
    await prisma.session.updateMany({ where: { userId: u.id, revokedAt: null, NOT: { id: req.user!.sessionId } }, data: { revokedAt: new Date() } });
    await audit({ actorId: u.id, userId: u.id, action: "auth.password_changed", ip: clientIp(req) });
    res.json({ ok: true });
  }),
);

// ── Two-factor authentication ──
authRouter.post(
  "/2fa/setup",
  requireAuth,
  ah(async (req, res) => {
    const u = await prisma.user.findUniqueOrThrow({ where: { id: req.user!.id } });
    if (u.totpEnabled) throw badRequest("Two-factor authentication is already enabled");
    const secret = authenticator.generateSecret();
    await prisma.user.update({ where: { id: u.id }, data: { totpSecretEnc: encrypt(secret) } });
    const settings = await getSettings();
    const otpauth = authenticator.keyuri(u.email, settings.company.brand, secret);
    res.json({ secret, otpauth, qr: await QRCode.toDataURL(otpauth) });
  }),
);

authRouter.post(
  "/2fa/enable",
  requireAuth,
  ah(async (req, res) => {
    const { code } = parse(z.object({ code: z.string().regex(/^\d{6}$/) }), req.body);
    const u = await prisma.user.findUniqueOrThrow({ where: { id: req.user!.id } });
    if (!u.totpSecretEnc || !authenticator.verify({ token: code, secret: decrypt(u.totpSecretEnc) })) throw badRequest("Invalid code — check your authenticator app's time");
    await prisma.user.update({ where: { id: u.id }, data: { totpEnabled: true } });
    await audit({ actorId: u.id, userId: u.id, action: "auth.2fa_enabled", ip: clientIp(req) });
    res.json({ ok: true });
  }),
);

authRouter.post(
  "/2fa/disable",
  requireAuth,
  ah(async (req, res) => {
    const body = parse(z.object({ password: z.string(), code: z.string().regex(/^\d{6}$/) }), req.body);
    const u = await prisma.user.findUniqueOrThrow({ where: { id: req.user!.id } });
    if (!(await verifyPassword(u, body.password))) throw badRequest("Password is incorrect");
    if (!u.totpSecretEnc || !authenticator.verify({ token: body.code, secret: decrypt(u.totpSecretEnc) })) throw badRequest("Invalid code");
    await prisma.user.update({ where: { id: u.id }, data: { totpEnabled: false, totpSecretEnc: null } });
    await audit({ actorId: u.id, userId: u.id, action: "auth.2fa_disabled", ip: clientIp(req) });
    res.json({ ok: true });
  }),
);

// ── Sessions & history ──
authRouter.get(
  "/sessions",
  requireAuth,
  ah(async (req, res) => {
    const sessions = await prisma.session.findMany({
      where: { userId: req.user!.id, revokedAt: null, expiresAt: { gt: new Date() } },
      orderBy: { lastUsedAt: "desc" },
      select: { id: true, ip: true, userAgent: true, createdAt: true, lastUsedAt: true },
    });
    res.json({ sessions: sessions.map((s) => ({ ...s, current: s.id === req.user!.sessionId })) });
  }),
);

authRouter.delete(
  "/sessions/:id",
  requireAuth,
  ah(async (req, res) => {
    const r = await prisma.session.updateMany({ where: { id: req.params.id, userId: req.user!.id }, data: { revokedAt: new Date() } });
    if (!r.count) throw notFound();
    res.json({ ok: true });
  }),
);

authRouter.post(
  "/sessions/revoke-others",
  requireAuth,
  ah(async (req, res) => {
    await prisma.session.updateMany({ where: { userId: req.user!.id, revokedAt: null, NOT: { id: req.user!.sessionId } }, data: { revokedAt: new Date() } });
    res.json({ ok: true });
  }),
);

authRouter.get(
  "/login-history",
  requireAuth,
  ah(async (req, res) => {
    const rows = await prisma.loginHistory.findMany({ where: { userId: req.user!.id }, orderBy: { createdAt: "desc" }, take: 50 });
    res.json({ history: rows });
  }),
);

// ── API keys (resellers / automation) ──
authRouter.get(
  "/api-keys",
  requireAuth,
  ah(async (req, res) => {
    const keys = await prisma.apiKey.findMany({
      where: { userId: req.user!.id, revokedAt: null },
      select: { id: true, name: true, keyPrefix: true, scopes: true, allowedIps: true, lastUsedAt: true, createdAt: true },
    });
    res.json({ keys });
  }),
);

authRouter.post(
  "/api-keys",
  requireAuth,
  ah(async (req, res) => {
    if (req.user!.viaApiKey) throw new HttpError(403, "API keys cannot create API keys");
    const body = parse(
      z.object({ name: z.string().trim().min(1).max(60), scopes: z.array(z.string()).default(["*"]), allowedIps: z.array(z.string().ip()).default([]) }),
      req.body,
    );
    const prefix = randomToken(6).replace(/[-_]/g, "x").slice(0, 8);
    const secret = `ck_${prefix}_${randomToken(32)}`;
    await prisma.apiKey.create({ data: { userId: req.user!.id, name: body.name, keyPrefix: prefix, keyHash: sha256(secret), scopes: body.scopes, allowedIps: body.allowedIps } });
    res.status(201).json({ key: secret, note: "Store this key now — it will not be shown again." });
  }),
);

authRouter.delete(
  "/api-keys/:id",
  requireAuth,
  ah(async (req, res) => {
    const r = await prisma.apiKey.updateMany({ where: { id: req.params.id, userId: req.user!.id }, data: { revokedAt: new Date() } });
    if (!r.count) throw notFound();
    res.json({ ok: true });
  }),
);
