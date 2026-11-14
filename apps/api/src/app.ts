import express, { Router } from "express";
import helmet from "helmet";
import cors from "cors";
import cookieParser from "cookie-parser";
import { z } from "zod";
import { config } from "./config";
import { prisma } from "./db";
import { ah, errorHandler, notFound, parse } from "./lib/http";
import { safeEqual } from "./lib/crypto";
import { authenticate, csrfGuard } from "./middleware/auth";
import { authRouter } from "./modules/auth/routes";
import { catalogRouter } from "./modules/catalog/routes";
import { clientRouter } from "./modules/client/routes";
import { paymentsRouter, webhooksRouter } from "./modules/payments/routes";
import { resellerRouter } from "./modules/reseller/routes";
import { adminCore } from "./modules/admin/core";
import { adminClients } from "./modules/admin/clients";
import { adminCatalog } from "./modules/admin/catalog";
import { adminInfra } from "./modules/admin/infra";
import { adminEmail } from "./modules/email/routes";
import { adminSupport } from "./modules/admin/support";
import { migrationRouter } from "./modules/migration/routes";
import { adminAutomation } from "./modules/admin/automation";
import { adminDashboard } from "./modules/admin/dashboard";
import { adminWhatsapp, clientWhatsapp } from "./modules/whatsapp/routes";
import { adminBackups, publicRestore } from "./modules/backup/routes";
import { adminCampaigns, publicCampaigns } from "./modules/campaigns/routes";
import { adminLatency, publicLatency } from "./modules/latency/routes";
import { adminInvoices } from "./modules/admin/invoices";
import { adminUpgrades } from "./modules/admin/upgrades";
import { adminBillingExtras } from "./modules/admin/billing-extras";
import { customerTargetGuard, reauthGuard, reauthRouter } from "./modules/admin/reauth";
import { replyTicket } from "./modules/tickets/service";
import { openTicket } from "./modules/tickets/service";

export function createApp() {
  const app = express();
  app.set("trust proxy", "loopback"); // behind Nginx on the same host
  app.disable("x-powered-by");
  app.use(helmet({ contentSecurityPolicy: false, crossOriginResourcePolicy: { policy: "same-site" } }));
  app.use(cors({ origin: [config.appUrl], credentials: true }));
  const keepRaw = (req: express.Request, _res: express.Response, buf: Buffer) => {
    req.rawBody = buf;
  };
  app.use(express.json({ limit: "3mb", verify: keepRaw }));
  app.use(express.urlencoded({ extended: false, limit: "1mb", verify: keepRaw }));
  app.use(cookieParser());
  app.use(authenticate);
  app.use(csrfGuard);

  const api = Router();
  api.get("/health", ah(async (_req, res) => {
    await prisma.$queryRaw`SELECT 1`;
    res.json({ ok: true, time: new Date().toISOString() });
  }));
  api.use("/auth", authRouter, reauthRouter);
  api.use("/catalog", catalogRouter);
  api.use(publicLatency);
  api.use(publicRestore);
  api.use(publicCampaigns);
  api.use("/client", clientRouter, clientWhatsapp);
  api.use("/payments", paymentsRouter);
  api.use("/webhooks", webhooksRouter);
  api.use("/reseller", resellerRouter);
  api.use("/v1/reseller", resellerRouter); // API-key access for resellers
  api.use("/admin", reauthGuard, customerTargetGuard, adminInvoices, adminUpgrades, adminBillingExtras, adminCore, adminClients, adminCatalog, adminInfra, adminEmail, adminSupport, migrationRouter, adminAutomation, adminDashboard, adminWhatsapp, adminBackups, adminLatency, adminCampaigns);

  // public content
  api.get("/content/announcements", ah(async (_req, res) => {
    res.json({ items: await prisma.announcement.findMany({ where: { published: true, publishedAt: { lte: new Date() } }, orderBy: { publishedAt: "desc" }, take: 30 }) });
  }));
  api.get("/content/kb", ah(async (req, res) => {
    const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
    const cats = await prisma.kbCategory.findMany({ include: { articles: { where: { published: true, ...(q ? { OR: [{ title: { contains: q, mode: "insensitive" } }, { body: { contains: q, mode: "insensitive" } }] } : {}) }, select: { id: true, title: true, slug: true, updatedAt: true } } } });
    res.json({ categories: cats.filter((c) => c.articles.length || !q) });
  }));
  api.get("/content/kb/:slug", ah(async (req, res) => {
    const a = await prisma.kbArticle.findUnique({ where: { slug: req.params.slug }, include: { category: true } });
    if (!a || !a.published) throw notFound();
    await prisma.kbArticle.update({ where: { id: a.id }, data: { views: { increment: 1 } } });
    res.json({ article: a });
  }));

  /**
   * Email piping: point your mail provider's inbound webhook (or a small procmail/postfix pipe script)
   * here with header X-Inbound-Secret. Replies with "[CC-123456]" in the subject thread onto tickets.
   */
  api.post("/webhooks/email/inbound", ah(async (req, res) => {
    if (!config.inboundEmailSecret || !safeEqual(String(req.headers["x-inbound-secret"] ?? ""), config.inboundEmailSecret)) return res.status(401).json({ error: "unauthorised" });
    const b = parse(z.object({ from: z.string(), subject: z.string(), text: z.string(), to: z.string().optional() }), req.body);
    const email = (b.from.match(/<([^>]+)>/)?.[1] ?? b.from).trim().toLowerCase();
    const user = await prisma.user.findUnique({ where: { email } });
    if (!user) return res.json({ ignored: "unknown sender" });
    const num = b.subject.match(/\[(CC-\d+)\]/)?.[1];
    const body = b.text.split(/\n>|\nOn .+wrote:/)[0].trim().slice(0, 20000);
    if (num) {
      const t = await prisma.ticket.findUnique({ where: { number: num } });
      if (t && t.userId === user.id) {
        await replyTicket({ ticketId: t.id, authorId: user.id, isStaff: false, message: body });
        return res.json({ threaded: t.number });
      }
    }
    const dept = (b.to && (await prisma.ticketDepartment.findFirst({ where: { email: b.to.toLowerCase() } }))) || (await prisma.ticketDepartment.findFirst({ orderBy: { sortOrder: "asc" } }));
    if (!dept) return res.json({ ignored: "no departments" });
    const t = await openTicket({ userId: user.id, authorId: user.id, isStaff: false, departmentId: dept.id, subject: b.subject.slice(0, 200), message: body, priority: "MEDIUM" });
    res.json({ opened: t.number });
  }));

  // why a console connection failed — the random ticket is the only key
  api.get("/console/status", ah(async (req, res) => {
    const { consoleError } = await import("./modules/console");
    res.json({ error: await consoleError(String(req.query.t ?? "")) });
  }));

  app.use("/api", api);
  app.use("/api", (_req, res) => res.status(404).json({ error: "Not found" }));
  app.use(errorHandler);
  return app;
}
