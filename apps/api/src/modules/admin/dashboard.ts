/**
 * Admin dashboard overview — what the WHMCS admin home shows, in one call:
 * income (today / month / FY / all time), a to-do list, clients & services at a glance, automation
 * status, a 12-month chart, and the latest orders, tickets, clients and staff activity.
 * Money is reported in INR (foreign payments converted at the invoice's exchange rate).
 */
import { Router } from "express";
import { prisma, Prisma } from "../../db";
import { ah } from "../../lib/http";
import { requireStaff } from "../../middleware/auth";
import { addDays, istDayStart } from "../../lib/money";
import { getSettings } from "../../lib/settings";
import { scheduledTimeToday } from "../../jobs/billing";

export const adminDashboard = Router();

const IST = 330 * 60_000;
/** first instant of the IST month containing d (offset by `add` months) */
function istMonthStart(d = new Date(), add = 0) {
  const x = new Date(d.getTime() + IST);
  return new Date(Date.UTC(x.getUTCFullYear(), x.getUTCMonth() + add, 1) - IST);
}
/** Indian financial year start (1 April, IST) */
function fyStart(d = new Date()) {
  const x = new Date(d.getTime() + IST);
  const y = x.getUTCMonth() >= 3 ? x.getUTCFullYear() : x.getUTCFullYear() - 1;
  return new Date(Date.UTC(y, 3, 1) - IST);
}

async function sumTxn(type: "PAYMENT" | "REFUND", from?: Date, to?: Date) {
  const r = await prisma.$queryRaw<{ total: number | null; n: bigint }[]>(Prisma.sql`
    SELECT SUM(t."amount" * COALESCE(i."exchangeRate", 1)) AS total, COUNT(*) AS n
    FROM "Transaction" t LEFT JOIN "Invoice" i ON i."id" = t."invoiceId"
    WHERE t."type" = ${type}::"TransactionType"
      ${from ? Prisma.sql`AND t."createdAt" >= ${from}` : Prisma.empty}
      ${to ? Prisma.sql`AND t."createdAt" < ${to}` : Prisma.empty}`);
  return { total: Math.round(Math.abs(Number(r[0]?.total ?? 0))), count: Number(r[0]?.n ?? 0) };
}

adminDashboard.get(
  "/dashboard/overview",
  requireStaff(),
  ah(async (_req, res) => {
    const now = new Date();
    const today = istDayStart(now);
    const yesterday = addDays(today, -1);
    const month = istMonthStart(now);
    const lastMonth = istMonthStart(now, -1);
    const fy = fyStart(now);
    const online = new Date(Date.now() - ONLINE_MINUTES * 60_000);

    const [incToday, incYesterday, incMonth, incLastMonth, incFy, incAll, refMonth] = await Promise.all([
      sumTxn("PAYMENT", today),
      sumTxn("PAYMENT", yesterday, today),
      sumTxn("PAYMENT", month),
      sumTxn("PAYMENT", lastMonth, month),
      sumTxn("PAYMENT", fy),
      sumTxn("PAYMENT"),
      sumTxn("REFUND", month),
    ]);

    const [
      ordersToday, ordersMonth, pendingOrders, fraudOrders,
      overdue, dueToday, unpaidAll,
      awaitingReply, inProgress, failedSetup, provisioning, paymentReviews, cancelRequests,
      clientsTotal, clientsActive, clientsToday, clientsMonth, clientsOnline, staffOnline,
      svcByStatus, domainsActive, domainsExpiring,
    ] = await Promise.all([
      prisma.order.count({ where: { createdAt: { gte: today } } }),
      prisma.order.count({ where: { createdAt: { gte: month } } }),
      prisma.order.count({ where: { status: "PENDING" } }),
      prisma.order.count({ where: { status: "FRAUD" } }),
      prisma.$queryRaw<{ n: bigint; due: number | null }[]>`SELECT COUNT(*) AS n, SUM(("total" - "amountPaid") * "exchangeRate") AS due FROM "Invoice" WHERE "status" = 'UNPAID' AND "isWalletTopup" = false AND "dueDate" < ${today}`,
      prisma.$queryRaw<{ n: bigint; due: number | null }[]>`SELECT COUNT(*) AS n, SUM(("total" - "amountPaid") * "exchangeRate") AS due FROM "Invoice" WHERE "status" = 'UNPAID' AND "isWalletTopup" = false AND "dueDate" >= ${today} AND "dueDate" < ${addDays(today, 1)}`,
      prisma.$queryRaw<{ n: bigint; due: number | null }[]>`SELECT COUNT(*) AS n, SUM(("total" - "amountPaid") * "exchangeRate") AS due FROM "Invoice" WHERE "status" = 'UNPAID' AND "isWalletTopup" = false`,
      prisma.ticket.count({ where: { status: { in: ["OPEN", "CUSTOMER_REPLY"] } } }),
      prisma.ticket.count({ where: { status: "IN_PROGRESS" } }),
      prisma.service.count({ where: { status: "FAILED" } }),
      prisma.service.count({ where: { status: "PROVISIONING" } }),
      prisma.paymentIntent.count({ where: { status: "PENDING_REVIEW" } }),
      prisma.ticket.count({ where: { status: { not: "CLOSED" }, subject: { contains: "cancel", mode: "insensitive" } } }),
      prisma.user.count({ where: { type: "CLIENT" } }),
      prisma.user.count({ where: { type: "CLIENT", services: { some: { status: "ACTIVE" } } } }),
      prisma.user.count({ where: { type: "CLIENT", createdAt: { gte: today } } }),
      prisma.user.count({ where: { type: "CLIENT", createdAt: { gte: month } } }),
      prisma.user.count({ where: { type: "CLIENT", sessions: { some: { lastSeenAt: { gte: online }, revokedAt: null, impersonatedById: null } } } }),
      prisma.user.findMany({ where: { type: "STAFF", sessions: { some: { lastSeenAt: { gte: online }, revokedAt: null } } }, select: { id: true, firstName: true, lastName: true, email: true } }),
      prisma.service.groupBy({ by: ["status"], _count: true }),
      prisma.domain.count({ where: { status: "ACTIVE" } }),
      prisma.domain.findMany({ where: { status: "ACTIVE", expiryDate: { gte: now, lte: addDays(now, 30) } }, orderBy: { expiryDate: "asc" }, take: 6, select: { id: true, name: true, expiryDate: true, autoRenew: true, user: { select: { id: true, email: true } } } }),
    ]);

    // services by kind (active)
    const kinds = await prisma.$queryRaw<{ kind: string; n: bigint }[]>`
      SELECT CASE WHEN p."provisioner" IN ('PROXMOX','VIRTUALIZOR') THEN 'vps' WHEN p."provisioner" = 'CPANEL' THEN 'hosting' ELSE 'other' END AS kind, COUNT(*) AS n
      FROM "Service" s JOIN "Product" p ON p."id" = s."productId" WHERE s."status" = 'ACTIVE' GROUP BY 1`;

    // 12 months: income, orders, new clients
    const from12 = istMonthStart(now, -11);
    const [incSeries, orderSeries, clientSeries] = await Promise.all([
      prisma.$queryRaw<{ m: string; v: number }[]>`SELECT to_char(date_trunc('month', t."createdAt" AT TIME ZONE 'Asia/Kolkata'), 'YYYY-MM') AS m, SUM(t."amount" * COALESCE(i."exchangeRate", 1)) AS v FROM "Transaction" t LEFT JOIN "Invoice" i ON i."id" = t."invoiceId" WHERE t."type" = 'PAYMENT' AND t."createdAt" >= ${from12} GROUP BY 1`,
      prisma.$queryRaw<{ m: string; v: bigint }[]>`SELECT to_char(date_trunc('month', "createdAt" AT TIME ZONE 'Asia/Kolkata'), 'YYYY-MM') AS m, COUNT(*) AS v FROM "Order" WHERE "createdAt" >= ${from12} GROUP BY 1`,
      prisma.$queryRaw<{ m: string; v: bigint }[]>`SELECT to_char(date_trunc('month', "createdAt" AT TIME ZONE 'Asia/Kolkata'), 'YYYY-MM') AS m, COUNT(*) AS v FROM "User" WHERE "type" = 'CLIENT' AND "createdAt" >= ${from12} GROUP BY 1`,
    ]);
    const months = Array.from({ length: 12 }, (_, i) => new Date(istMonthStart(now, i - 11).getTime() + IST).toISOString().slice(0, 7));
    const pick = (rows: { m: string; v: unknown }[], m: string) => Math.round(Number(rows.find((r) => r.m === m)?.v ?? 0));
    const chart = months.map((m) => ({ month: m, income: pick(incSeries, m), orders: pick(orderSeries, m), clients: pick(clientSeries, m) }));

    // automation
    const s = await getSettings();
    const lastSched = await prisma.automationRun.findFirst({ where: { trigger: "schedule" }, orderBy: { startedAt: "desc" } });
    const lastRun = await prisma.automationRun.findFirst({ orderBy: { startedAt: "desc" } });
    const autoToday = await prisma.automationEvent.groupBy({ by: ["action"], where: { createdAt: { gte: today } }, _count: true });
    const todayAt = scheduledTimeToday(s.automation.runAt, now);

    // lists
    const [recentOrders, tickets, newClients, topProducts, activity, servers] = await Promise.all([
      prisma.order.findMany({ orderBy: { createdAt: "desc" }, take: 7, include: { user: { select: { id: true, firstName: true, lastName: true, email: true } }, invoice: { select: { status: true } }, services: { take: 1, select: { product: { select: { name: true } } } } } }),
      prisma.ticket.findMany({ where: { status: { in: ["OPEN", "CUSTOMER_REPLY"] } }, orderBy: [{ lastReplyAt: "asc" }], take: 6, select: { id: true, number: true, subject: true, status: true, priority: true, lastReplyAt: true, createdAt: true, user: { select: { firstName: true, lastName: true, email: true } }, department: { select: { name: true } } } }),
      prisma.user.findMany({ where: { type: "CLIENT" }, orderBy: { createdAt: "desc" }, take: 6, select: { id: true, firstName: true, lastName: true, email: true, createdAt: true, profile: { select: { city: true, state: true, companyName: true } } } }),
      prisma.$queryRaw<{ id: string; name: string; n: bigint; mrr: number | null }[]>`
        SELECT p."id", p."name", COUNT(*) AS n, SUM(s."recurringAmount") AS mrr FROM "Service" s JOIN "Product" p ON p."id" = s."productId"
        WHERE s."status" = 'ACTIVE' GROUP BY p."id", p."name" ORDER BY n DESC LIMIT 6`,
      prisma.activityLog.findMany({ orderBy: { createdAt: "desc" }, take: 8 }),
      prisma.server.findMany({ select: { id: true, name: true, type: true, enabled: true, lastStatus: true, lastCheckAt: true, _count: { select: { services: { where: { status: "ACTIVE" } } } } } }),
    ]);
    const actorIds = [...new Set(activity.map((a) => a.actorId).filter(Boolean) as string[])];
    const actors = new Map((await prisma.user.findMany({ where: { id: { in: actorIds } }, select: { id: true, firstName: true, lastName: true, email: true, type: true } })).map((u) => [u.id, u]));
    const st = (x: { lastStatus: unknown }) => (x.lastStatus ?? {}) as { ok?: boolean; error?: string; nodes?: number; online?: number; latencyMs?: number };
    const serversDown = servers.filter((x) => x.enabled && st(x).ok === false).length;

    const n = (r: { n: bigint; due: number | null }[]) => ({ count: Number(r[0]?.n ?? 0), amount: Math.round(Number(r[0]?.due ?? 0)) });
    const status = Object.fromEntries(svcByStatus.map((x) => [x.status, x._count]));
    res.json({
      income: { today: incToday, yesterday: incYesterday, month: incMonth, lastMonth: incLastMonth, fy: incFy, all: incAll, refundsMonth: refMonth },
      orders: { today: ordersToday, month: ordersMonth, pending: pendingOrders, fraud: fraudOrders },
      invoices: { overdue: n(overdue), dueToday: n(dueToday), unpaid: n(unpaidAll) },
      todo: { pendingOrders, overdueInvoices: Number(overdue[0]?.n ?? 0), awaitingReply, inProgress, failedSetup, provisioning, paymentReviews, cancelRequests, domainsExpiring: domainsExpiring.length, serversDown },
      clients: { total: clientsTotal, active: clientsActive, today: clientsToday, month: clientsMonth, online: clientsOnline },
      staffOnline,
      services: { byStatus: status, active: status.ACTIVE ?? 0, suspended: status.SUSPENDED ?? 0, pending: (status.PENDING ?? 0) + (status.PROVISIONING ?? 0), byKind: Object.fromEntries(kinds.map((k) => [k.kind, Number(k.n)])), domains: domainsActive },
      automation: {
        enabled: s.automation.enabled,
        runAt: s.automation.runAt,
        healthy: !s.automation.enabled || (!!lastSched && now.getTime() - lastSched.startedAt.getTime() < 26 * 3600_000),
        lastRun: lastRun ? { startedAt: lastRun.startedAt, trigger: lastRun.trigger, durationMs: lastRun.durationMs } : null,
        nextRunAt: !s.automation.enabled ? null : now < todayAt ? todayAt : new Date(todayAt.getTime() + 86400_000),
        today: Object.fromEntries(autoToday.map((a) => [a.action, a._count])),
      },
      chart,
      recentOrders: recentOrders.map((o) => ({ id: o.id, number: o.number, client: `${o.user.firstName ?? ""} ${o.user.lastName ?? ""}`.trim() || o.user.email, clientId: o.user.id, product: o.services[0]?.product.name ?? null, total: o.total, currency: o.currency, status: o.status, paid: o.invoice?.status === "PAID", createdAt: o.createdAt })),
      tickets,
      newClients,
      topProducts: topProducts.map((p) => ({ id: p.id, name: p.name, active: Number(p.n), recurring: Math.round(Number(p.mrr ?? 0)) })),
      domainsExpiring,
      activity: activity.map((a) => {
        const u = a.actorId ? actors.get(a.actorId) : null;
        return { id: a.id, action: a.action, entity: a.entity, entityId: a.entityId, createdAt: a.createdAt, actor: u ? `${u.firstName ?? ""} ${u.lastName ?? ""}`.trim() || u.email : "System", staff: u?.type === "STAFF" };
      }),
      servers: servers.filter((x) => x.enabled).map((x) => ({ id: x.id, name: x.name, type: x.type, ok: st(x).ok ?? null, error: st(x).error ?? null, nodes: st(x).nodes ?? null, nodesOnline: st(x).online ?? null, latencyMs: st(x).latencyMs ?? null, lastCheckAt: x.lastCheckAt, active: x._count.services })),
    });
  }),
);

/** Small numbers for the sidebar badges — cheap enough to poll every minute. */
adminDashboard.get(
  "/nav-counts",
  requireStaff(),
  ah(async (_req, res) => {
    const [orders, tickets, paymentReviews, failedSetup] = await Promise.all([
      prisma.order.count({ where: { status: "PENDING" } }),
      prisma.ticket.count({ where: { status: { in: ["OPEN", "CUSTOMER_REPLY"] } } }),
      prisma.paymentIntent.count({ where: { status: "PENDING_REVIEW" } }),
      prisma.service.count({ where: { status: "FAILED" } }),
    ]);
    res.json({ orders, tickets, paymentReviews, failedSetup });
  }),
);


// ───────────── Clients online now ─────────────
const ONLINE_MINUTES = 5;

function deviceOf(ua: string | null) {
  if (!ua) return null;
  const browser = /Edg\//.test(ua) ? "Edge" : /OPR\/|Opera/.test(ua) ? "Opera" : /Chrome\//.test(ua) ? "Chrome" : /Firefox\//.test(ua) ? "Firefox" : /Safari\//.test(ua) ? "Safari" : "Browser";
  const os = /iPhone|iPad/.test(ua) ? "iOS" : /Android/.test(ua) ? "Android" : /Windows/.test(ua) ? "Windows" : /Mac OS X|Macintosh/.test(ua) ? "macOS" : /Linux/.test(ua) ? "Linux" : "";
  return { label: os ? `${browser} on ${os}` : browser, mobile: /Mobile|iPhone|Android/.test(ua) };
}
const PAGE_NAMES: [RegExp, string][] = [
  [/^\/client\/?$/, "Dashboard"], [/^\/client\/services\/[^/]+\/console/, "VPS console"], [/^\/client\/services\/[^/]+\/upgrade/, "Upgrade / downgrade"], [/^\/client\/services\/[^/]+/, "A service"], [/^\/client\/services/, "My services"],
  [/^\/client\/invoices\/[^/]+/, "An invoice"], [/^\/client\/invoices/, "Invoices"], [/^\/client\/quotes/, "Quotes"], [/^\/client\/payments/, "Payments"], [/^\/client\/wallet/, "Wallet"],
  [/^\/client\/tickets\/new/, "Opening a ticket"], [/^\/client\/tickets/, "Support tickets"], [/^\/client\/domains/, "Domains"], [/^\/client\/knowledgebase/, "Knowledgebase"], [/^\/client\/profile/, "Profile"], [/^\/client\/security/, "Security"],
  [/^\/client\/reseller/, "Reseller dashboard"], [/^\/client\/affiliates/, "Affiliates"], [/^\/order\/checkout|^\/order\/cart|^\/cart/, "Checkout"], [/^\/order/, "Ordering"],
];
const pageName = (p: string | null) => (p ? PAGE_NAMES.find(([re]) => re.test(p))?.[1] ?? p : null);

adminDashboard.get(
  "/dashboard/online",
  requireStaff("clients.view"),
  ah(async (_req, res) => {
    const since = new Date(Date.now() - ONLINE_MINUTES * 60_000);
    const sessions = await prisma.session.findMany({
      where: { lastSeenAt: { gte: since }, revokedAt: null, expiresAt: { gt: new Date() }, user: { type: "CLIENT" } },
      orderBy: { lastSeenAt: "desc" },
      take: 500,
      select: { userId: true, ip: true, userAgent: true, lastSeenAt: true, lastPath: true, impersonatedById: true, user: { select: { id: true, firstName: true, lastName: true, email: true, profile: { select: { companyName: true, city: true, country: true } }, _count: { select: { services: { where: { status: "ACTIVE" } } } } } } },
    });
    // one row per client (their most recent tab); staff "login as client" sessions are flagged, not counted
    const seen = new Set<string>();
    const clients = [];
    let viewedByStaff = 0;
    for (const s of sessions) {
      if (s.impersonatedById) {
        viewedByStaff++;
        continue;
      }
      if (seen.has(s.userId)) continue;
      seen.add(s.userId);
      clients.push({
        id: s.user.id,
        name: `${s.user.firstName ?? ""} ${s.user.lastName ?? ""}`.trim() || s.user.email,
        email: s.user.email,
        company: s.user.profile?.companyName ?? null,
        location: [s.user.profile?.city, s.user.profile?.country].filter(Boolean).join(", ") || null,
        activeServices: s.user._count.services,
        lastSeenAt: s.lastSeenAt,
        page: pageName(s.lastPath),
        path: s.lastPath,
        ip: s.ip,
        device: deviceOf(s.userAgent),
      });
    }
    res.json({ windowMinutes: ONLINE_MINUTES, count: clients.length, clients, viewedByStaff });
  }),
);
