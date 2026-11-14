/**
 * Plan changes — upgrade, downgrade and billing-cycle change of a running service (WHMCS-style).
 *
 * Proration (the current period runs from nextDueDate − cycle to nextDueDate):
 *   credit = old price × (days left / days in period)          what the customer already paid and won't use
 *   same billing cycle → charge = new price × (days left / days in period); the due date stays
 *   new billing cycle  → charge = full new-cycle price; a new period starts today
 *   amount due = charge − credit  (+ GST on the invoice).  ≤ 0 → applied straight away;
 *   a negative amount (downgrade) goes to account credit when that's switched on.
 *
 * Paying the upgrade invoice → the service moves to the new plan, its price and cycle change, and the
 * server is resized (cPanel package / Virtualizor / Proxmox) by the provisioning worker.
 */
import { prisma } from "../../db";
import type { BillingCycle } from "../../generated/prisma/enums";
import { badRequest, conflict, notFound } from "../../lib/http";
import { getSettings } from "../../lib/settings";
import { CYCLE_LABEL, CYCLE_MONTHS, addCycle, addMonths, formatMoney } from "../../lib/money";
import { audit } from "../../lib/audit";
import { queueEmail } from "../email/mailer";
import { enqueueProvision } from "../../jobs/queues";
import { adjustCredit, cancelInvoice, createInvoice, invoiceEmailVars } from "./invoices";

const DAY = 86400_000;
const AUTOMATED = new Set(["CPANEL", "VIRTUALIZOR", "PROXMOX"]);
const OPEN = ["PENDING", "PROVISIONING"];

type Svc = NonNullable<Awaited<ReturnType<typeof loadSvc>>>;
const loadSvc = (id: string) => prisma.service.findUnique({ where: { id }, include: { product: { include: { pricing: true } }, upgrades: { where: { status: { in: OPEN } } } } });

const specOf = (p: { cpuCores: number | null; ramMb: number | null; diskGb: number | null; bandwidthGb: number | null; ipv4Count: number }) => ({ cpuCores: p.cpuCores, ramMb: p.ramMb, diskGb: p.diskGb, bandwidthGb: p.bandwidthGb, ipv4Count: p.ipv4Count });
const fmtDate = (d: Date) => d.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "Asia/Kolkata" });

export function priceOf(product: { pricing: { currency: string; cycle: BillingCycle; price: number; enabled: boolean }[] }, currency: string, cycle: BillingCycle) {
  return product.pricing.find((x) => x.currency === currency && x.cycle === cycle && x.enabled)?.price ?? null;
}

/** The numbers for moving a service to `to` on `cycle` — nothing is saved. */
export function quote(svc: { billingCycle: BillingCycle; recurringAmount: number; nextDueDate: Date | null; currency: string }, newPrice: number, cycle: BillingCycle, now = new Date()) {
  const months = CYCLE_MONTHS[svc.billingCycle];
  let daysLeft = 0;
  let periodDays = 0;
  if (months > 0 && svc.nextDueDate) {
    const end = svc.nextDueDate;
    const start = addMonths(end, -months);
    periodDays = Math.max(1, Math.round((end.getTime() - start.getTime()) / DAY));
    daysLeft = Math.min(periodDays, Math.max(0, Math.ceil((end.getTime() - now.getTime()) / DAY)));
  }
  const ratio = periodDays ? daysLeft / periodDays : 0;
  const credit = Math.round(svc.recurringAmount * ratio);
  const sameCycle = cycle === svc.billingCycle && daysLeft > 0;
  const charge = sameCycle ? Math.round(newPrice * ratio) : newPrice;
  const newNextDueDate = sameCycle ? svc.nextDueDate : cycle === "ONETIME" ? null : addCycle(now, cycle);
  return { daysLeft, periodDays, credit, charge, amountDue: charge - credit, newNextDueDate, sameCycle, newRecurring: newPrice };
}

/** Plans a service can move to: same group, same kind of product and the same provisioning module. */
export async function upgradeOptions(serviceId: string, opts: { forClient?: boolean } = {}) {
  const svc = await loadSvc(serviceId);
  if (!svc) throw notFound("Service not found");
  const s = (await getSettings()).automation;
  const products = await prisma.product.findMany({
    where: {
      enabled: true,
      ...(opts.forClient ? { groupId: svc.product.groupId, type: svc.product.type, provisioner: svc.product.provisioner, virtType: svc.product.virtType, hidden: false } : {}),
    },
    include: { pricing: true, group: { select: { name: true } } },
    orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
  });
  const cur = priceOf(svc.product, svc.currency, svc.billingCycle) ?? svc.recurringAmount;
  const plans = products
    .map((p) => {
      const cycles = p.pricing.filter((x) => x.currency === svc.currency && x.enabled && x.cycle !== "ONETIME").map((x) => {
        const q = quote(svc, x.price, x.cycle);
        return { cycle: x.cycle, label: CYCLE_LABEL[x.cycle], price: x.price, ...q, newNextDueDate: q.newNextDueDate?.toISOString() ?? null };
      });
      const samePrice = priceOf(p, svc.currency, svc.billingCycle);
      const direction = p.id === svc.productId ? "current" : samePrice == null ? "other" : samePrice > cur ? "upgrade" : samePrice < cur ? "downgrade" : "same";
      return {
        id: p.id,
        name: p.name,
        group: p.group.name,
        tagline: p.tagline,
        provisioner: p.provisioner,
        sameModule: p.provisioner === svc.product.provisioner && p.type === svc.product.type,
        outOfStock: p.outOfStock,
        spec: specOf(p),
        direction,
        cycles,
      };
    })
    .filter((p) => p.cycles.length && (!opts.forClient || (p.direction !== "current" || p.cycles.length > 1)))
    .filter((p) => !opts.forClient || s.clientDowngrades !== false || p.direction !== "downgrade");
  const blocked = opts.forClient ? await clientBlock(svc) : null;
  return {
    service: { id: svc.id, status: svc.status, productId: svc.productId, productName: svc.product.name, billingCycle: svc.billingCycle, recurringAmount: svc.recurringAmount, currency: svc.currency, nextDueDate: svc.nextDueDate, spec: specOf(svc.product), provisioner: svc.product.provisioner },
    pending: svc.upgrades[0] ?? null,
    plans,
    blocked,
    downgradeCredit: s.downgradeCredit !== false,
  };
}

/** Why a customer can't change this plan themselves right now (null = they can). */
async function clientBlock(svc: Svc) {
  const s = (await getSettings()).automation;
  if (s.clientUpgrades === false) return "Plan changes are handled by our team — please open a support ticket.";
  if (svc.resellerId) return "This service is managed by your reseller.";
  if (!["ACTIVE"].includes(svc.status)) return `Plan changes are available while the service is active (it's ${svc.status.toLowerCase()}).`;
  if (svc.billingCycle === "ONETIME") return "One-time services can't change plan.";
  const unpaid = await prisma.invoiceItem.count({ where: { relId: svc.id, type: "SERVICE", invoice: { status: "UNPAID" } } });
  if (unpaid) return "Please pay the open renewal invoice for this service first, then change the plan.";
  return null;
}

/** A pending upgrade whose invoice was cancelled or deleted is dead — clear it so a new one can start. */
async function clearStale(serviceId: string) {
  const open = await prisma.serviceUpgrade.findMany({ where: { serviceId, status: "PENDING" } });
  for (const u of open) {
    const inv = u.invoiceId ? await prisma.invoice.findUnique({ where: { id: u.invoiceId }, select: { status: true } }) : null;
    if (!inv || inv.status === "CANCELLED" || inv.status === "REFUNDED") await prisma.serviceUpgrade.update({ where: { id: u.id }, data: { status: "CANCELLED", message: "Invoice cancelled" } });
  }
}

export async function startUpgrade(args: {
  serviceId: string;
  toProductId: string;
  toCycle: BillingCycle;
  byClient: boolean;
  actorId: string;
  /** staff: "invoice" = charge the prorated difference, "free" = change without charging */
  billing?: "invoice" | "free";
  /** staff: new recurring price instead of the plan's list price */
  recurringOverride?: number | null;
  applyOnServer?: boolean;
  creditRefund?: boolean;
  sendEmail?: boolean;
}) {
  await clearStale(args.serviceId);
  const svc = await loadSvc(args.serviceId);
  if (!svc) throw notFound("Service not found");
  if (args.byClient && svc.userId !== args.actorId) throw notFound("Service not found");
  if (svc.upgrades.length) throw conflict("A plan change for this service is already in progress — pay or cancel it first");
  if (["TERMINATED", "CANCELLED"].includes(svc.status)) throw conflict("This service has ended");
  const to = await prisma.product.findUnique({ where: { id: args.toProductId }, include: { pricing: true } });
  if (!to || !to.enabled) throw notFound("Plan not found");
  const listPrice = priceOf(to, svc.currency, args.toCycle);
  if (listPrice == null) throw badRequest(`${to.name} has no ${CYCLE_LABEL[args.toCycle].toLowerCase()} price in ${svc.currency}`);
  const s = (await getSettings()).automation;

  if (args.byClient) {
    const why = await clientBlock(svc);
    if (why) throw conflict(why);
    if (to.groupId !== svc.product.groupId || to.type !== svc.product.type || to.provisioner !== svc.product.provisioner || to.virtType !== svc.product.virtType || to.hidden) throw badRequest("That plan isn't available for this service");
    if (to.id === svc.productId && args.toCycle === svc.billingCycle) throw badRequest("That's your current plan");
    if (to.outOfStock && to.id !== svc.productId) throw conflict(`${to.name} is out of stock right now`);
  }
  const newPrice = args.recurringOverride ?? listPrice;
  const q = quote(svc, newPrice, args.toCycle);
  if (args.byClient && q.amountDue < 0 && s.clientDowngrades === false) throw conflict("Downgrades are handled by our team — please open a support ticket");
  const free = args.billing === "free";
  const amountDue = free ? 0 : q.amountDue;

  const up = await prisma.serviceUpgrade.create({
    data: {
      serviceId: svc.id,
      userId: svc.userId,
      fromProductId: svc.productId,
      toProductId: to.id,
      fromCycle: svc.billingCycle,
      toCycle: args.toCycle,
      currency: svc.currency,
      oldRecurring: svc.recurringAmount,
      newRecurring: newPrice,
      credit: free ? 0 : q.credit,
      charge: free ? 0 : q.charge,
      amountDue,
      newNextDueDate: q.newNextDueDate,
      creditRefund: args.creditRefund ?? s.downgradeCredit !== false,
      applyOnServer: args.applyOnServer ?? true,
      byClient: args.byClient,
      createdById: args.actorId,
    },
  });
  await audit({ actorId: args.actorId, userId: svc.userId, action: args.byClient ? "service.upgrade_requested" : "service.plan_change", entity: "service", entityId: svc.id, details: { upgradeId: up.id, from: `${svc.product.name} ${svc.billingCycle}`, to: `${to.name} ${args.toCycle}`, amountDue, free } });

  if (amountDue > 0) {
    const label = `${svc.product.name} → ${to.name}${args.toCycle !== svc.billingCycle ? ` (${CYCLE_LABEL[args.toCycle]})` : ""}`;
    const period = q.sameCycle && svc.nextDueDate ? `${fmtDate(new Date())} – ${fmtDate(svc.nextDueDate)}` : q.newNextDueDate ? `${fmtDate(new Date())} – ${fmtDate(q.newNextDueDate)}` : "";
    const inv = await prisma.$transaction(async (tx) => {
      const inv = await createInvoice(tx, {
        userId: svc.userId,
        currency: svc.currency,
        dueDate: new Date(),
        notes: q.credit ? `Includes ${formatMoney(q.credit, svc.currency)} credit for the unused part of ${svc.product.name}.` : undefined,
        items: [{ type: "UPGRADE", relId: up.id, description: `Plan change: ${label}${svc.hostname ? ` — ${svc.hostname}` : ""}${period ? ` (${period})` : ""}`, hsnSac: to.hsnSac, unitPrice: amountDue, taxable: to.taxable }],
      });
      await tx.serviceUpgrade.update({ where: { id: up.id }, data: { invoiceId: inv.id } });
      return inv;
    });
    if (args.sendEmail !== false) {
      const u = await prisma.user.findUniqueOrThrow({ where: { id: svc.userId } });
      await queueEmail("invoice.created", u.email, invoiceEmailVars(inv, u.firstName), u.id);
    }
    // credit balance may have paid it already (createInvoice applies credit when that's switched on)
    const fresh = await prisma.serviceUpgrade.findUniqueOrThrow({ where: { id: up.id } });
    return { upgrade: fresh, invoiceId: inv.id, applied: fresh.status !== "PENDING" };
  }
  const done = await applyUpgrade(up.id, args.actorId);
  return { upgrade: done, invoiceId: null, applied: true };
}

/** Move the service to the new plan (after payment, or straight away when nothing is due). Idempotent. */
export async function applyUpgrade(upgradeId: string, actorId: string | null = null) {
  const r = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "ServiceUpgrade" WHERE id = ${upgradeId} FOR UPDATE`;
    const up = await tx.serviceUpgrade.findUniqueOrThrow({ where: { id: upgradeId } });
    if (up.status !== "PENDING") return { up, changed: false };
    const svc = await tx.service.findUniqueOrThrow({ where: { id: up.serviceId }, include: { product: true } });
    const to = await tx.product.findUniqueOrThrow({ where: { id: up.toProductId } });
    await tx.service.update({
      where: { id: svc.id },
      data: {
        productId: to.id,
        billingCycle: up.toCycle,
        recurringAmount: up.newRecurring,
        ...(up.newNextDueDate && up.toCycle !== up.fromCycle ? { nextDueDate: up.newNextDueDate, nextInvoiceDate: up.newNextDueDate } : {}),
        ...(up.toCycle === "ONETIME" ? { nextDueDate: null, nextInvoiceDate: null } : {}),
      },
    });
    if (up.amountDue < 0 && up.creditRefund) {
      await adjustCredit(tx, { userId: up.userId, amount: -up.amountDue, description: `Credit for changing ${svc.product.name} → ${to.name}${svc.hostname ? ` (${svc.hostname})` : ""}`, refType: "serviceUpgrade", refId: up.id });
    }
    const built = to.provisioner === "CPANEL" ? !!svc.username && !!svc.serverId : !!svc.remoteId;
    const serverChange = up.applyOnServer && AUTOMATED.has(to.provisioner) && to.provisioner === svc.product.provisioner && built && ["ACTIVE", "SUSPENDED"].includes(svc.status);
    const next = await tx.serviceUpgrade.update({
      where: { id: up.id },
      data: {
        status: serverChange ? "PROVISIONING" : "DONE",
        appliedAt: new Date(),
        message: serverChange ? "Changing the server…" : AUTOMATED.has(to.provisioner) && up.applyOnServer ? "Billing changed — the server wasn't changed (not built yet, or a different module): change it by hand" : "Billing changed",
      },
    });
    return { up: next, changed: true, serverChange, from: svc.product.name, to: to.name, hostname: svc.hostname };
  });
  if (!r.changed) return r.up;
  await audit({ actorId, userId: r.up.userId, action: "service.plan_changed", entity: "service", entityId: r.up.serviceId, details: { upgradeId: r.up.id, from: r.from, to: r.to } });
  if (r.serverChange) await enqueueProvision({ serviceId: r.up.serviceId, action: "change_plan", params: { upgradeId: r.up.id }, actorId: actorId ?? undefined });
  else await notifyDone(r.up.id);
  const { syncOrderForService } = await import("../orders/status");
  await syncOrderForService(r.up.serviceId).catch(() => undefined);
  return r.up;
}

/** Tell the customer their plan changed. */
export async function notifyDone(upgradeId: string) {
  const up = await prisma.serviceUpgrade.findUniqueOrThrow({ where: { id: upgradeId } });
  const [u, svc, to] = await Promise.all([
    prisma.user.findUniqueOrThrow({ where: { id: up.userId } }),
    prisma.service.findUniqueOrThrow({ where: { id: up.serviceId } }),
    prisma.product.findUniqueOrThrow({ where: { id: up.toProductId } }),
  ]);
  const esc = (x: string) => x.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
  const vps = to.provisioner === "VIRTUALIZOR" || to.provisioner === "PROXMOX";
  await queueEmail("staff.message", u.email, {
    name: u.firstName,
    subject: `Your plan is now ${to.name}`,
    messageHtml: `<p>Your service${svc.hostname ? ` <b>${esc(svc.hostname)}</b>` : ""} is now on <b>${esc(to.name)}</b> — ${formatMoney(up.newRecurring, up.currency)} ${CYCLE_LABEL[up.toCycle].toLowerCase()}${svc.nextDueDate ? `, next due ${fmtDate(svc.nextDueDate)}` : ""}.</p>${up.amountDue < 0 && up.creditRefund ? `<p>${formatMoney(-up.amountDue, up.currency)} for the unused part of your old plan was added to your account credit.</p>` : ""}${vps && up.status === "DONE" && up.applyOnServer ? "<p>Restart your VPS from the client area so it starts using the new CPU and memory. If the disk grew, extend the partition inside the OS (most Linux images do this on reboot).</p>" : ""}`,
  }, u.id);
}

export async function cancelUpgrade(upgradeId: string, actorId: string, userId?: string) {
  const up = await prisma.serviceUpgrade.findUnique({ where: { id: upgradeId } });
  if (!up || (userId && up.userId !== userId)) throw notFound("Plan change not found");
  if (up.status !== "PENDING") throw conflict("This plan change has already been applied");
  if (up.invoiceId) {
    const inv = await prisma.invoice.findUnique({ where: { id: up.invoiceId } });
    if (inv && inv.amountPaid > 0) throw conflict("Part of the invoice is paid — ask us to cancel it");
    if (inv && (inv.status === "UNPAID" || inv.status === "DRAFT")) await cancelInvoice(inv.id, "Plan change cancelled");
  }
  await prisma.serviceUpgrade.update({ where: { id: up.id }, data: { status: "CANCELLED", message: "Cancelled" } });
  await audit({ actorId, userId: up.userId, action: "service.upgrade_cancelled", entity: "service", entityId: up.serviceId, details: { upgradeId: up.id } });
}

export const serverResources = async (product: { provisioner: string; cpuCores: number | null; ramMb: number | null; diskGb: number | null; bandwidthGb: number | null; moduleConfig: unknown }, client?: { plans(): Promise<{ plans: Record<string, Record<string, unknown>> }> }) => {
  let r = { cores: product.cpuCores, ramMb: product.ramMb, diskGb: product.diskGb, bandwidthGb: product.bandwidthGb };
  const planId = ((product.moduleConfig ?? {}) as { virtualizor?: { planId?: number } }).virtualizor?.planId;
  if (client && planId && (!r.cores || !r.ramMb || !r.diskGb)) {
    const p = ((await client.plans().catch(() => null))?.plans ?? {})[String(planId)];
    if (p) r = { cores: r.cores ?? (Number(p.cores) || null), ramMb: r.ramMb ?? (Number(p.ram) || null), diskGb: r.diskGb ?? (Number(p.space) || null), bandwidthGb: r.bandwidthGb ?? (Number(p.bandwidth) || null) };
  }
  return r;
};
