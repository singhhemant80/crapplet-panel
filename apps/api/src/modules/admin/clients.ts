/**
 * WHMCS-style client summary: billing / product stats, contacts, files, pay methods, recent emails,
 * account statement and the "Other actions" (add-funds invoice, generate due invoices, password reset,
 * affiliate, merge, close, delete, export, send email).
 */
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { Router } from "express";
import multer from "multer";
import { z } from "zod";
import { prisma } from "../../db";
import { config } from "../../config";
import { ah, badRequest, conflict, notFound, parse } from "../../lib/http";
import { audit } from "../../lib/audit";
import { encrypt, generatePassword, randomToken, sha256 } from "../../lib/crypto";
import { requireStaff } from "../../middleware/auth";
import { adjustCredit, createInvoice, invoiceEmailVars } from "../billing/invoices";
import { queueEmail } from "../email/mailer";
import { generateRenewalInvoices } from "../../jobs/billing";
import { getSettings } from "../../lib/settings";

export const adminClients = Router();

const FILES_DIR = path.resolve(config.uploadDir, "client-files");
fs.mkdirSync(FILES_DIR, { recursive: true });
const upload = multer({
  storage: multer.diskStorage({ destination: FILES_DIR, filename: (_req, _f, cb) => cb(null, crypto.randomBytes(16).toString("hex")) }),
  limits: { fileSize: 20 * 1024 * 1024, files: 1 },
  fileFilter: (_req, f, cb) => cb(null, /\.(png|jpe?g|gif|webp|pdf|txt|csv|zip|docx?|xlsx?|odt)$/i.test(f.originalname)),
});

async function client(id: string) {
  const u = await prisma.user.findUnique({ where: { id }, include: { profile: true, affiliate: true } });
  if (!u || u.type !== "CLIENT") throw notFound("Client not found");
  return u;
}

const SHARED = ["SHARED", "WORDPRESS"];
const RESELLER = ["RESELLER_HOSTING"];
const SERVER = ["VPS_LINUX", "VPS_WINDOWS", "VPS_FOREX", "TALLY", "VPS_N8N", "VPS_MINECRAFT", "VPS_GOLD", "DEDICATED", "GPU", "COLOCATION"];

// ───── Summary ─────
adminClients.get(
  "/clients/:id/summary",
  requireStaff("clients.view"),
  ah(async (req, res) => {
    const u = await client(req.params.id);
    const userId = u.id;
    const [invByStatus, services, domains, tickets, openTickets, payments, refunds, contacts, files, payMethods, emails, lastLogin, orders, referrals, activeSessions] = await Promise.all([
      prisma.invoice.groupBy({ by: ["status"], where: { userId }, _count: { _all: true }, _sum: { total: true } }),
      prisma.service.findMany({ where: { userId }, select: { status: true, product: { select: { type: true } } } }),
      prisma.domain.count({ where: { userId } }),
      prisma.ticket.count({ where: { userId } }),
      prisma.ticket.count({ where: { userId, status: { not: "CLOSED" } } }),
      prisma.transaction.aggregate({ where: { userId, type: { in: ["PAYMENT", "WALLET_TOPUP"] } }, _sum: { amount: true, fee: true } }),
      prisma.transaction.aggregate({ where: { userId, type: "REFUND" }, _sum: { amount: true } }),
      prisma.clientContact.findMany({ where: { userId }, orderBy: { createdAt: "asc" } }),
      prisma.clientFile.findMany({ where: { userId }, orderBy: { createdAt: "desc" } }),
      prisma.payMethod.findMany({ where: { userId }, orderBy: [{ isDefault: "desc" }, { createdAt: "desc" }], omit: { tokenEnc: true } }),
      prisma.emailLog.findMany({ where: { OR: [{ userId }, { to: { equals: u.email, mode: "insensitive" } }] }, orderBy: { createdAt: "desc" }, take: 6, select: { id: true, subject: true, status: true, createdAt: true, template: true } }),
      prisma.loginHistory.findFirst({ where: { userId, success: true }, orderBy: { createdAt: "desc" } }),
      prisma.order.count({ where: { userId } }),
      u.affiliate ? prisma.referral.count({ where: { affiliateId: u.affiliate.id } }) : Promise.resolve(0),
      prisma.session.count({ where: { userId, revokedAt: null, expiresAt: { gt: new Date() } } }),
    ]);
    const inv: Record<string, { count: number; total: number }> = {};
    for (const s of ["PAID", "DRAFT", "UNPAID", "CANCELLED", "REFUNDED", "COLLECTIONS"]) inv[s] = { count: 0, total: 0 };
    for (const g of invByStatus) inv[g.status] = { count: g._count._all, total: g._sum.total ?? 0 };
    const count = (types: string[]) => {
      const list = services.filter((s) => types.includes(s.product.type));
      return { active: list.filter((s) => s.status === "ACTIVE").length, total: list.length };
    };
    const known = [...SHARED, ...RESELLER, ...SERVER];
    const gross = (payments._sum.amount ?? 0) - Math.abs(refunds._sum.amount ?? 0);
    const fees = payments._sum.fee ?? 0;
    res.json({
      invoices: inv,
      income: { gross, fees, net: gross - fees, credit: u.profile?.creditBalance ?? 0, currency: u.profile?.currency ?? "INR" },
      products: {
        shared: count(SHARED),
        reseller: count(RESELLER),
        server: count(SERVER),
        other: { active: services.filter((s) => !known.includes(s.product.type) && s.status === "ACTIVE").length, total: services.filter((s) => !known.includes(s.product.type)).length },
        domains,
        tickets,
        openTickets,
        orders,
        affiliateSignups: referrals,
      },
      contacts,
      files,
      payMethods,
      emails,
      other: {
        status: u.status,
        signupDate: u.createdAt,
        clientForDays: Math.max(0, Math.floor((Date.now() - u.createdAt.getTime()) / 86400_000)),
        lastLogin: lastLogin ? { at: lastLogin.createdAt, ip: lastLogin.ip, userAgent: lastLogin.userAgent } : null,
        emailVerified: !!u.emailVerifiedAt,
        twoFactor: u.totpEnabled,
        activeSessions,
        affiliate: u.affiliate ? { code: u.affiliate.code, balance: u.affiliate.balance } : null,
      },
    });
  }),
);

// ───── Contacts ─────
const contactSchema = z.object({
  firstName: z.string().trim().min(1).max(80),
  lastName: z.string().trim().max(80).default(""),
  email: z.string().trim().toLowerCase().email(),
  phone: z.string().trim().max(20).optional().nullable(),
  companyName: z.string().trim().max(160).optional().nullable(),
  emails: z.array(z.enum(["general", "invoice", "support", "product", "domain"])).default([]),
});
adminClients.post(
  "/clients/:id/contacts",
  requireStaff("clients.manage"),
  ah(async (req, res) => {
    await client(req.params.id);
    const b = parse(contactSchema, req.body);
    const c = await prisma.clientContact.create({ data: { ...b, userId: req.params.id } });
    await audit({ actorId: req.user!.id, userId: req.params.id, action: "client.contact_added", entity: "contact", entityId: c.id });
    res.status(201).json({ contact: c });
  }),
);
adminClients.put(
  "/clients/:id/contacts/:cid",
  requireStaff("clients.manage"),
  ah(async (req, res) => {
    const b = parse(contactSchema.partial(), req.body);
    const r = await prisma.clientContact.updateMany({ where: { id: req.params.cid, userId: req.params.id }, data: b });
    if (!r.count) throw notFound();
    res.json({ ok: true });
  }),
);
adminClients.delete(
  "/clients/:id/contacts/:cid",
  requireStaff("clients.manage"),
  ah(async (req, res) => {
    await prisma.clientContact.deleteMany({ where: { id: req.params.cid, userId: req.params.id } });
    await audit({ actorId: req.user!.id, userId: req.params.id, action: "client.contact_removed", entity: "contact", entityId: req.params.cid });
    res.json({ ok: true });
  }),
);

// ───── Files ─────
adminClients.post(
  "/clients/:id/files",
  requireStaff("clients.manage"),
  upload.single("file"),
  ah(async (req, res) => {
    await client(req.params.id);
    const f = req.file;
    if (!f) throw badRequest("Choose a file (PDF, image, Office document, CSV, TXT or ZIP — up to 20 MB)");
    const b = parse(z.object({ title: z.string().trim().max(160).optional(), adminOnly: z.union([z.boolean(), z.enum(["true", "false"])]).optional() }), req.body);
    const row = await prisma.clientFile.create({
      data: { userId: req.params.id, title: b.title || f.originalname.slice(0, 160), filename: f.originalname.slice(0, 200), storedAs: f.filename, size: f.size, mime: f.mimetype, adminOnly: b.adminOnly === undefined ? true : b.adminOnly === true || b.adminOnly === "true", uploadedById: req.user!.id },
    });
    await audit({ actorId: req.user!.id, userId: req.params.id, action: "client.file_added", entity: "file", entityId: row.id, details: { filename: row.filename } });
    res.status(201).json({ file: row });
  }),
);
adminClients.get(
  "/clients/:id/files/:fid",
  requireStaff("clients.view"),
  ah(async (req, res) => {
    const f = await prisma.clientFile.findFirst({ where: { id: req.params.fid, userId: req.params.id } });
    if (!f) throw notFound();
    res.download(path.join(FILES_DIR, path.basename(f.storedAs)), f.filename);
  }),
);
adminClients.delete(
  "/clients/:id/files/:fid",
  requireStaff("clients.manage"),
  ah(async (req, res) => {
    const f = await prisma.clientFile.findFirst({ where: { id: req.params.fid, userId: req.params.id } });
    if (!f) throw notFound();
    await prisma.clientFile.delete({ where: { id: f.id } });
    fs.promises.unlink(path.join(FILES_DIR, path.basename(f.storedAs))).catch(() => null);
    await audit({ actorId: req.user!.id, userId: req.params.id, action: "client.file_removed", entity: "file", entityId: f.id, details: { filename: f.filename } });
    res.json({ ok: true });
  }),
);

// ───── Pay methods ─────
adminClients.post(
  "/clients/:id/pay-methods",
  requireStaff("billing.manage"),
  ah(async (req, res) => {
    await client(req.params.id);
    const b = parse(
      z.object({
        type: z.enum(["CARD", "UPI", "MANDATE", "BANK", "OTHER"]),
        gateway: z.string().trim().min(2).max(40),
        label: z.string().trim().min(2).max(120),
        brand: z.string().trim().max(40).optional().nullable(),
        last4: z.string().regex(/^\d{4}$/, "Last 4 digits only").optional().nullable().or(z.literal("").transform(() => null)),
        expiry: z.string().regex(/^(0[1-9]|1[0-2])\/\d{2}$/, "Expiry as MM/YY").optional().nullable().or(z.literal("").transform(() => null)),
        reference: z.string().trim().max(200).optional().nullable(), // gateway token / mandate id
        isDefault: z.boolean().default(false),
        autopay: z.boolean().default(false),
      }),
      req.body,
    );
    if (b.label.replace(/\D/g, "").length >= 12) throw badRequest("Don't type full card or account numbers — only a label and the last 4 digits");
    const { reference, ...data } = b;
    const pm = await prisma.$transaction(async (tx) => {
      const first = (await tx.payMethod.count({ where: { userId: req.params.id } })) === 0;
      if (b.isDefault || first) await tx.payMethod.updateMany({ where: { userId: req.params.id }, data: { isDefault: false } });
      return tx.payMethod.create({ data: { ...data, isDefault: b.isDefault || first, userId: req.params.id, tokenEnc: reference ? encrypt(reference) : null }, omit: { tokenEnc: true } });
    });
    await audit({ actorId: req.user!.id, userId: req.params.id, action: "client.paymethod_added", entity: "paymethod", entityId: pm.id, details: { type: pm.type, gateway: pm.gateway, label: pm.label } });
    res.status(201).json({ payMethod: pm });
  }),
);
adminClients.put(
  "/clients/:id/pay-methods/:pid",
  requireStaff("billing.manage"),
  ah(async (req, res) => {
    const b = parse(z.object({ isDefault: z.boolean().optional(), autopay: z.boolean().optional(), status: z.enum(["ACTIVE", "EXPIRED", "REVOKED"]).optional() }), req.body);
    if (b.status === "REVOKED") {
      // revoking a UPI AutoPay mandate also cancels it at the gateway
      const { cancelMandate } = await import("../payments/autopay");
      await cancelMandate(req.params.pid, req.params.id, req.user!.id);
    }
    const pm = await prisma.payMethod.findFirst({ where: { id: req.params.pid, userId: req.params.id } });
    if (!pm) throw notFound();
    await prisma.$transaction(async (tx) => {
      if (b.isDefault) await tx.payMethod.updateMany({ where: { userId: req.params.id }, data: { isDefault: false } });
      await tx.payMethod.update({ where: { id: pm.id }, data: b });
    });
    await audit({ actorId: req.user!.id, userId: req.params.id, action: "client.paymethod_updated", entity: "paymethod", entityId: pm.id, details: b });
    res.json({ ok: true });
  }),
);
adminClients.delete(
  "/clients/:id/pay-methods/:pid",
  requireStaff("billing.manage"),
  ah(async (req, res) => {
    const pm = await prisma.payMethod.findFirst({ where: { id: req.params.pid, userId: req.params.id } });
    if (!pm) throw notFound();
    if (pm.externalId && pm.status !== "REVOKED") {
      // a UPI AutoPay mandate is cancelled at the gateway before the record goes
      const { cancelMandate } = await import("../payments/autopay");
      await cancelMandate(pm.id, req.params.id, req.user!.id);
    }
    await prisma.payMethod.delete({ where: { id: pm.id } });
    await audit({ actorId: req.user!.id, userId: req.params.id, action: "client.paymethod_removed", entity: "paymethod", entityId: pm.id, details: { label: pm.label } });
    res.json({ ok: true });
  }),
);

// ───── Billing actions ─────
adminClients.post(
  "/clients/:id/add-funds-invoice",
  requireStaff("billing.manage"),
  ah(async (req, res) => {
    const u = await client(req.params.id);
    const { amount } = parse(z.object({ amount: z.number().int().min(100).max(100_000_000) }), req.body);
    const inv = await prisma.$transaction((tx) => createInvoice(tx, { userId: u.id, isWalletTopup: true, currency: u.profile?.currency, items: [{ type: "WALLET", description: "Account credit / add funds", unitPrice: amount, taxable: false }] }));
    await queueEmail("invoice.created", u.email, invoiceEmailVars(inv, u.firstName), u.id);
    await audit({ actorId: req.user!.id, userId: u.id, action: "client.add_funds_invoice", entity: "invoice", entityId: inv.id, details: { amount } });
    res.status(201).json({ invoiceId: inv.id });
  }),
);
adminClients.post(
  "/clients/:id/generate-due",
  requireStaff("billing.manage"),
  ah(async (req, res) => {
    await client(req.params.id);
    const created = await generateRenewalInvoices({ userId: req.params.id });
    await audit({ actorId: req.user!.id, userId: req.params.id, action: "client.generate_due_invoices", details: { created } });
    res.json({ created });
  }),
);

/** Running account statement: invoices raise the balance, payments lower it. */
adminClients.get(
  "/clients/:id/statement",
  requireStaff("clients.view"),
  ah(async (req, res) => {
    const u = await client(req.params.id);
    const [invoices, txns] = await Promise.all([
      prisma.invoice.findMany({ where: { userId: u.id, status: { notIn: ["DRAFT", "CANCELLED"] } }, select: { id: true, number: true, proformaNumber: true, issueDate: true, total: true, status: true, isWalletTopup: true } }),
      prisma.transaction.findMany({ where: { userId: u.id }, select: { id: true, createdAt: true, amount: true, type: true, gateway: true, gatewayTxnId: true, invoiceId: true } }),
    ]);
    type Row = { date: Date; kind: "invoice" | "payment" | "refund"; ref: string; description: string; debit: number; credit: number; id: string };
    const rows: Row[] = [
      ...invoices.map((i) => ({ date: i.issueDate, kind: "invoice" as const, ref: i.number ?? i.proformaNumber, description: i.isWalletTopup ? "Add funds invoice" : `Invoice (${i.status.toLowerCase()})`, debit: i.total, credit: 0, id: i.id })),
      ...txns.map((t) =>
        t.type === "REFUND"
          ? { date: t.createdAt, kind: "refund" as const, ref: t.gatewayTxnId, description: `Refund via ${t.gateway}`, debit: Math.abs(t.amount), credit: 0, id: t.id }
          : { date: t.createdAt, kind: "payment" as const, ref: t.gatewayTxnId, description: t.type === "CREDIT_APPLIED" ? "Paid from account credit" : `Payment via ${t.gateway}`, debit: 0, credit: Math.abs(t.amount), id: t.id },
      ),
    ].sort((a, b) => a.date.getTime() - b.date.getTime());
    let balance = 0;
    const out = rows.map((r) => ({ ...r, balance: (balance += r.debit - r.credit) }));
    res.json({ rows: out, balance, currency: u.profile?.currency ?? "INR" });
  }),
);

// ───── Account actions ─────
/** Staff sets a new password for a client who can't log in (typed or generated), optionally sending it. */
adminClients.post(
  "/clients/:id/set-password",
  requireStaff("clients.manage"),
  ah(async (req, res) => {
    const b = parse(
      z.object({
        password: z.string().min(8, "Password must be at least 8 characters").max(128).optional(),
        sendEmail: z.boolean().default(false),
        sendWhatsapp: z.boolean().default(false),
        signOut: z.boolean().default(true),
      }),
      req.body,
    );
    const u = await client(req.params.id);
    const password = b.password ?? generatePassword(14);
    const bcrypt = (await import("bcryptjs")).default;
    await prisma.$transaction([
      prisma.user.update({ where: { id: u.id }, data: { passwordHash: await bcrypt.hash(password, 12) } }),
      ...(b.signOut ? [prisma.session.updateMany({ where: { userId: u.id, revokedAt: null }, data: { revokedAt: new Date() } })] : []),
    ]);
    const sent: string[] = [];
    if (b.sendEmail) {
      await queueEmail("auth.password_set", u.email, { name: u.firstName, email: u.email, password }, u.id);
      sent.push("email");
    }
    if (b.sendWhatsapp) {
      const { sendManualWhatsapp } = await import("../whatsapp/service");
      try {
        const s = await getSettings();
        await sendManualWhatsapp({ userId: u.id, actorId: req.user!.id, event: "manual", text: `Hi ${u.firstName}, your ${s.company.brand} password has been reset.\nEmail: ${u.email}\nNew password: ${password}\nSign in: ${config.appUrl}/client/login — please change it after signing in.` });
        sent.push("whatsapp");
      } catch (e) {
        sent.push(`whatsapp failed: ${(e as Error).message}`);
      }
    }
    await audit({ actorId: req.user!.id, userId: u.id, action: "client.password_set", details: { generated: !b.password, signedOut: b.signOut, sent } });
    // the password is returned once so staff can copy it; it's never stored in plain text or logged
    res.json({ ok: true, password, generated: !b.password, sent });
  }),
);

adminClients.post(
  "/clients/:id/password-reset",
  requireStaff("clients.manage"),
  ah(async (req, res) => {
    const u = await client(req.params.id);
    if (u.status !== "ACTIVE") throw badRequest(`The account is ${u.status.toLowerCase()}`);
    const token = randomToken();
    await prisma.verificationToken.create({ data: { userId: u.id, type: "PASSWORD_RESET", tokenHash: sha256(token), expiresAt: new Date(Date.now() + 3600_000) } });
    await queueEmail("auth.password_reset", u.email, { name: u.firstName, link: `${config.appUrl}/client/reset-password?token=${token}` }, u.id);
    await audit({ actorId: req.user!.id, userId: u.id, action: "client.password_reset_sent" });
    res.json({ ok: true });
  }),
);

adminClients.post(
  "/clients/:id/affiliate",
  requireStaff("clients.manage"),
  ah(async (req, res) => {
    const u = await client(req.params.id);
    if (u.affiliate) return res.json({ code: u.affiliate.code });
    const s = await getSettings();
    const a = await prisma.affiliate.create({ data: { userId: u.id, code: randomToken(5).replace(/[-_]/g, "x").toUpperCase(), commissionPct: s.affiliates.defaultCommissionPct } });
    await audit({ actorId: req.user!.id, userId: u.id, action: "client.affiliate_activated" });
    res.json({ code: a.code });
  }),
);

adminClients.post(
  "/clients/:id/email",
  requireStaff("clients.manage"),
  ah(async (req, res) => {
    const u = await client(req.params.id);
    const b = parse(z.object({ subject: z.string().trim().min(2).max(200), message: z.string().trim().min(2).max(20000), cc: z.array(z.string().email()).max(10).default([]) }), req.body);
    const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
    const messageHtml = b.message.split(/\n{2,}/).map((p) => `<p>${esc(p).replace(/\n/g, "<br>")}</p>`).join("");
    for (const to of [u.email, ...b.cc]) await queueEmail("staff.message", to, { name: u.firstName, subject: b.subject, messageHtml }, u.id);
    await audit({ actorId: req.user!.id, userId: u.id, action: "client.email_sent", details: { subject: b.subject, cc: b.cc.length } });
    res.json({ ok: true });
  }),
);

/** Close: account can't sign in, unpaid invoices are cancelled. Services are left for staff to handle. */
adminClients.post(
  "/clients/:id/close",
  requireStaff("clients.manage"),
  ah(async (req, res) => {
    const u = await client(req.params.id);
    const { cancelInvoices } = parse(z.object({ cancelInvoices: z.boolean().default(true) }), req.body);
    const cancelled = cancelInvoices ? (await prisma.invoice.updateMany({ where: { userId: u.id, status: { in: ["UNPAID", "DRAFT"] } }, data: { status: "CANCELLED" } })).count : 0;
    await prisma.user.update({ where: { id: u.id }, data: { status: "CLOSED" } });
    await prisma.session.updateMany({ where: { userId: u.id, revokedAt: null }, data: { revokedAt: new Date() } });
    const live = await prisma.service.count({ where: { userId: u.id, status: { in: ["ACTIVE", "SUSPENDED", "PROVISIONING", "PENDING"] } } });
    await audit({ actorId: req.user!.id, userId: u.id, action: "client.closed", details: { cancelledInvoices: cancelled } });
    res.json({ ok: true, cancelledInvoices: cancelled, liveServices: live });
  }),
);

/** Delete is only allowed for accounts with no billing history (GST records must be kept) — close those instead. */
adminClients.delete(
  "/clients/:id",
  requireStaff("clients.manage"),
  ah(async (req, res) => {
    const u = await client(req.params.id);
    const [orders, services, invoices, txns, domains, tickets] = await Promise.all([
      prisma.order.count({ where: { userId: u.id } }),
      prisma.service.count({ where: { userId: u.id } }),
      prisma.invoice.count({ where: { userId: u.id } }),
      prisma.transaction.count({ where: { userId: u.id } }),
      prisma.domain.count({ where: { userId: u.id } }),
      prisma.ticket.count({ where: { userId: u.id } }),
    ]);
    const has = Object.entries({ orders, services, invoices, payments: txns, domains, tickets }).filter(([, n]) => n > 0);
    if (has.length) throw conflict(`This customer has ${has.map(([k, n]) => `${n} ${k}`).join(", ")} — tax and billing records must be kept, so close the account instead of deleting it`);
    const files = await prisma.clientFile.findMany({ where: { userId: u.id }, select: { storedAs: true } });
    await prisma.$transaction([
      prisma.activityLog.updateMany({ where: { userId: u.id }, data: { userId: null } }),
      prisma.loginHistory.deleteMany({ where: { userId: u.id } }),
      prisma.creditLedger.deleteMany({ where: { userId: u.id } }),
      prisma.paymentIntent.deleteMany({ where: { userId: u.id } }),
      prisma.referral.deleteMany({ where: { referredUserId: u.id } }),
      prisma.user.delete({ where: { id: u.id } }),
    ]);
    for (const f of files) fs.promises.unlink(path.join(FILES_DIR, path.basename(f.storedAs))).catch(() => null);
    await audit({ actorId: req.user!.id, action: "client.deleted", entity: "user", entityId: u.id, details: { email: u.email } });
    res.json({ ok: true });
  }),
);

/** Merge this account INTO another: everything moves to the target, this one is closed. */
adminClients.post(
  "/clients/:id/merge",
  requireStaff("clients.manage"),
  ah(async (req, res) => {
    const src = await client(req.params.id);
    const { intoUserId } = parse(z.object({ intoUserId: z.string() }), req.body);
    if (intoUserId === src.id) throw badRequest("Choose a different customer to merge into");
    const dst = await client(intoUserId);
    if ((src.profile?.currency ?? "INR") !== (dst.profile?.currency ?? "INR")) throw badRequest(`The accounts are billed in different currencies (${src.profile?.currency} vs ${dst.profile?.currency})`);
    const where = { userId: src.id };
    const data = { userId: dst.id };
    const moved = await prisma.$transaction(async (tx) => {
      const r = {
        orders: (await tx.order.updateMany({ where, data })).count,
        services: (await tx.service.updateMany({ where, data })).count,
        invoices: (await tx.invoice.updateMany({ where, data })).count,
        transactions: (await tx.transaction.updateMany({ where, data })).count,
        tickets: (await tx.ticket.updateMany({ where, data })).count,
        domains: (await tx.domain.updateMany({ where, data })).count,
        paymentIntents: (await tx.paymentIntent.updateMany({ where, data })).count,
        creditNotes: (await tx.creditNote.updateMany({ where, data })).count,
        contacts: (await tx.clientContact.updateMany({ where, data })).count,
        files: (await tx.clientFile.updateMany({ where, data })).count,
        payMethods: (await tx.payMethod.updateMany({ where, data: { ...data, isDefault: false } })).count,
        emails: (await tx.emailLog.updateMany({ where, data })).count,
        credit: 0,
      };
      const bal = src.profile?.creditBalance ?? 0;
      if (bal > 0) {
        await adjustCredit(tx, { userId: src.id, amount: -bal, description: `Moved to ${dst.email} (account merge)`, refType: "merge", refId: dst.id });
        await adjustCredit(tx, { userId: dst.id, amount: bal, description: `Moved from ${src.email} (account merge)`, refType: "merge", refId: src.id });
        r.credit = bal;
      }
      await tx.user.update({ where: { id: src.id }, data: { status: "CLOSED" } });
      await tx.session.updateMany({ where: { userId: src.id, revokedAt: null }, data: { revokedAt: new Date() } });
      return r;
    });
    await audit({ actorId: req.user!.id, userId: dst.id, action: "client.merged", details: { from: src.email, ...moved } });
    res.json({ ok: true, moved, into: dst.id });
  }),
);

/** Everything held about the customer, as JSON (WHMCS "Export client data"). */
adminClients.get(
  "/clients/:id/export",
  requireStaff("clients.view"),
  ah(async (req, res) => {
    const u = await client(req.params.id);
    const id = u.id;
    const [orders, services, invoices, transactions, tickets, domains, ledger, contacts, files, payMethods, logins] = await Promise.all([
      prisma.order.findMany({ where: { userId: id } }),
      prisma.service.findMany({ where: { userId: id }, omit: { passwordEnc: true }, include: { ips: { select: { address: true } }, product: { select: { name: true } } } }),
      prisma.invoice.findMany({ where: { userId: id }, include: { items: true } }),
      prisma.transaction.findMany({ where: { userId: id }, omit: { raw: true } }),
      prisma.ticket.findMany({ where: { userId: id }, include: { messages: { where: { isNote: false }, select: { body: true, isStaff: true, createdAt: true } } } }),
      prisma.domain.findMany({ where: { userId: id } }),
      prisma.creditLedger.findMany({ where: { userId: id } }),
      prisma.clientContact.findMany({ where: { userId: id } }),
      prisma.clientFile.findMany({ where: { userId: id }, select: { title: true, filename: true, size: true, createdAt: true } }),
      prisma.payMethod.findMany({ where: { userId: id }, omit: { tokenEnc: true } }),
      prisma.loginHistory.findMany({ where: { userId: id }, orderBy: { createdAt: "desc" }, take: 200 }),
    ]);
    const { passwordHash: _p, totpSecretEnc: _t, ...account } = u;
    await audit({ actorId: req.user!.id, userId: id, action: "client.data_exported" });
    res.setHeader("Content-Disposition", `attachment; filename="client-${id}.json"`);
    res.json({ exportedAt: new Date(), account, orders, services, invoices, transactions, tickets, domains, creditLedger: ledger, contacts, files, payMethods, logins });
  }),
);
