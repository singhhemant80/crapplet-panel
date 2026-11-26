/** Aadhaar KYC — customer endpoints (/client/kyc…) and staff endpoints (/admin/kyc…). See kyc.ts. */
import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../db";
import { ah, badRequest, notFound, pageParams, parse } from "../../lib/http";
import { audit } from "../../lib/audit";
import { requireClient, requireStaff } from "../../middleware/auth";
import { queueEmail } from "../email/mailer";
import { getKycSettings, kycSummary, publicKycSettings, refreshKyc, saveKycSettings, startKyc, testKycConnection } from "./kyc";

export const clientKyc = Router();
export const adminKyc = Router();

// ───── customer ─────
clientKyc.get(
  "/kyc",
  requireClient,
  ah(async (req, res) => {
    res.json(await kycSummary(req.user!.id));
  }),
);

clientKyc.post(
  "/kyc/start",
  requireClient,
  ah(async (req, res) => {
    const r = await startKyc(req.user!.id);
    await audit({ actorId: req.user!.id, userId: req.user!.id, action: "kyc.started", entity: "kyc", entityId: r.verificationId });
    res.json({ url: r.url });
  }),
);

/** after DigiLocker sends the customer back (or "check again"): fetch the result */
clientKyc.post(
  "/kyc/check",
  requireClient,
  ah(async (req, res) => {
    const b = parse(z.object({ verificationId: z.string().max(80).optional() }), req.body ?? {});
    const vid = b.verificationId ?? (await prisma.kycVerification.findFirst({ where: { userId: req.user!.id }, orderBy: { createdAt: "desc" }, select: { verificationId: true } }))?.verificationId;
    if (!vid) throw notFound("No verification started yet");
    const before = await prisma.kycVerification.findUnique({ where: { verificationId: vid }, select: { status: true } });
    const v = await refreshKyc(req.user!.id, vid);
    if (before?.status === "PENDING" && v.status !== "PENDING") {
      await audit({ actorId: req.user!.id, userId: req.user!.id, action: `kyc.${v.status.toLowerCase()}`, entity: "kyc", entityId: vid, details: { last4: v.aadhaarLast4, nameScore: v.nameScore } });
      if (v.status === "REVIEW") {
        const { alertStaffLater, alertKycReview } = await import("../email/staff-alerts");
        alertStaffLater(() => alertKycReview(req.user!.id, v.message ?? ""));
      }
    }
    res.json({ ...(await kycSummary(req.user!.id)), result: { status: v.status, message: v.status === "REVIEW" ? "Your Aadhaar name is a little different from your account name, so our team will check it shortly." : v.status === "VERIFIED" ? "Verified" : v.status === "PENDING" ? "Waiting for DigiLocker" : v.status === "EXPIRED" ? "The DigiLocker link expired — please try again." : v.status === "CONSENT_DENIED" ? "Sharing your Aadhaar was declined in DigiLocker — please try again and allow it." : "We couldn't verify your Aadhaar — please try again or contact support." } });
  }),
);

// ───── staff ─────
adminKyc.get(
  "/kyc/settings",
  requireStaff("settings.manage"),
  ah(async (_req, res) => {
    const s = await getKycSettings();
    const [verified, review, pending] = await Promise.all([
      prisma.clientProfile.count({ where: { kycStatus: "VERIFIED" } }),
      prisma.clientProfile.count({ where: { kycStatus: "REVIEW" } }),
      prisma.clientProfile.count({ where: { kycStatus: "PENDING" } }),
    ]);
    res.json({ settings: publicKycSettings(s), counts: { verified, review, pending } });
  }),
);

adminKyc.put(
  "/kyc/settings",
  requireStaff("settings.manage"),
  ah(async (req, res) => {
    const b = parse(
      z.object({
        enabled: z.boolean(),
        sandbox: z.boolean(),
        clientId: z.string().trim().max(200),
        clientSecret: z.string().trim().max(300),
        require: z.enum(["optional", "all_orders", "servers"]),
        onMismatch: z.enum(["review", "accept"]),
      }).partial(),
      req.body,
    );
    const s = await saveKycSettings(b);
    await audit({ actorId: req.user!.id, action: "kyc.settings_updated", entity: "setting", entityId: "kyc", details: { enabled: s.enabled, sandbox: s.sandbox, require: s.require, onMismatch: s.onMismatch, secretChanged: !!b.clientSecret && !b.clientSecret.startsWith("••") } });
    res.json({ settings: publicKycSettings(s) });
  }),
);

adminKyc.post(
  "/kyc/test",
  requireStaff("settings.manage"),
  ah(async (_req, res) => {
    res.json(await testKycConnection());
  }),
);

/** recent checks, newest first (filter by status) */
adminKyc.get(
  "/kyc/checks",
  requireStaff("clients.view"),
  ah(async (req, res) => {
    const { skip, take } = pageParams(req.query);
    const status = typeof req.query.status === "string" && req.query.status ? req.query.status : undefined;
    const where = status ? { status } : {};
    const [rows, total] = await Promise.all([
      prisma.kycVerification.findMany({ where, orderBy: { createdAt: "desc" }, skip, take, include: { user: { select: { id: true, firstName: true, lastName: true, email: true, profile: { select: { companyName: true } } } } } }),
      prisma.kycVerification.count({ where }),
    ]);
    res.json({ checks: rows, total });
  }),
);

adminKyc.get(
  "/clients/:id/kyc",
  requireStaff("clients.view"),
  ah(async (req, res) => {
    const p = await prisma.clientProfile.findUnique({ where: { userId: req.params.id }, select: { kycStatus: true, kycVerifiedAt: true, kycExempt: true, kycRequired: true } });
    if (!p) throw notFound("Customer not found");
    const checks = await prisma.kycVerification.findMany({ where: { userId: req.params.id }, orderBy: { createdAt: "desc" }, take: 10 });
    const s = await getKycSettings();
    res.json({ enabled: s.enabled, require: s.require, ...p, checks });
  }),
);

/**
 * Staff actions on one customer: approve / reject a check in review, mark verified by hand (e.g. KYC
 * done offline), reset (ask again), exempt from verification, or require it before any order.
 */
adminKyc.post(
  "/clients/:id/kyc",
  requireStaff("clients.manage"),
  ah(async (req, res) => {
    const b = parse(z.object({ action: z.enum(["approve", "reject", "verify", "reset", "exempt", "unexempt", "require", "unrequire"]), note: z.string().trim().max(300).optional() }), req.body);
    const userId = req.params.id;
    const u = await prisma.user.findUnique({ where: { id: userId }, select: { id: true, type: true, email: true, firstName: true, ownerResellerId: true, profile: { select: { kycStatus: true } } } });
    if (!u || u.type !== "CLIENT" || !u.profile) throw notFound("Customer not found");
    const last = await prisma.kycVerification.findFirst({ where: { userId }, orderBy: { createdAt: "desc" } });
    const now = new Date();
    switch (b.action) {
      case "approve":
      case "reject": {
        if (!last || last.status !== "REVIEW") throw badRequest("There's no verification waiting for review");
        const ok = b.action === "approve";
        await prisma.kycVerification.update({ where: { id: last.id }, data: { status: ok ? "VERIFIED" : "REJECTED", reviewedById: req.user!.id, reviewNote: b.note ?? null } });
        await prisma.clientProfile.update({ where: { userId }, data: ok ? { kycStatus: "VERIFIED", kycVerifiedAt: now, kycRequired: false } : { kycStatus: "REJECTED" } });
        if (!u.ownerResellerId) await queueEmail(ok ? "kyc.verified" : "kyc.rejected", u.email, { name: u.firstName, reason: b.note ?? "" }, userId);
        break;
      }
      case "verify":
        if (!b.note) throw badRequest("Add a note — how was this customer verified?");
        await prisma.clientProfile.update({ where: { userId }, data: { kycStatus: "VERIFIED", kycVerifiedAt: now, kycRequired: false } });
        break;
      case "reset":
        await prisma.clientProfile.update({ where: { userId }, data: { kycStatus: "NONE", kycVerifiedAt: null } });
        break;
      case "exempt":
      case "unexempt":
        await prisma.clientProfile.update({ where: { userId }, data: { kycExempt: b.action === "exempt" } });
        break;
      case "require":
      case "unrequire":
        await prisma.clientProfile.update({ where: { userId }, data: { kycRequired: b.action === "require" } });
        break;
    }
    await audit({ actorId: req.user!.id, userId, action: `kyc.${b.action}`, entity: "user", entityId: userId, details: { note: b.note } });
    res.json({ ok: true });
  }),
);
