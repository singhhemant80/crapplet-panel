import { prisma } from "../../db";
import { enqueueProvision } from "../../jobs/queues";
import { addCycle, formatMoney } from "../../lib/money";
import { getSettings } from "../../lib/settings";
import { queueEmail } from "../email/mailer";
import { adjustCredit, invoiceEmailVars, invoiceLabel } from "./invoices";

/** Everything that should happen once an invoice is fully paid. Safe to call more than once. */
export async function onInvoicePaid(invoiceId: string) {
  // resellers: their website hears about every paid invoice (renewals, new orders, top-ups)
  void (async () => {
    const inv0 = await prisma.invoice.findUnique({ where: { id: invoiceId }, select: { id: true, number: true, proformaNumber: true, total: true, currency: true, userId: true, paidAt: true, items: { select: { relId: true, type: true, description: true } } } });
    const r = inv0 ? await prisma.reseller.findUnique({ where: { userId: inv0.userId }, select: { id: true } }) : null;
    if (inv0 && r) {
      const { notifyReseller } = await import("../reseller/webhooks");
      await notifyReseller(r.id, "invoice.paid", { id: inv0.id, number: inv0.number ?? inv0.proformaNumber, total: inv0.total, currency: inv0.currency, paidAt: inv0.paidAt, serviceIds: [...new Set(inv0.items.filter((x) => x.relId && x.type === "SERVICE").map((x) => x.relId))] });
    }
  })().catch(() => undefined);
  const inv = await prisma.invoice.findUniqueOrThrow({ where: { id: invoiceId }, include: { items: true, user: true, order: true } });
  if (inv.status !== "PAID") return;
  const settings = await getSettings();

  for (const item of inv.items) {
    if (item.type === "WALLET") {
      // idempotency: the ledger entry is keyed by invoice id
      const done = await prisma.creditLedger.findFirst({ where: { refType: "walletTopup", refId: inv.id } });
      if (!done) await adjustCredit(prisma, { userId: inv.userId, amount: item.amount, description: `Wallet top-up (${invoiceLabel(inv)})`, refType: "walletTopup", refId: inv.id });
      continue;
    }
    if (item.type === "SERVICE" && item.relId) {
      const svc = await prisma.service.findUnique({ where: { id: item.relId }, include: { product: true } });
      if (!svc) continue;
      const isRenewal = !!item.periodStart && svc.status !== "PENDING";
      if (!isRenewal) {
        if (svc.status !== "PENDING") {
          // first invoice paid after staff had already activated it: the paid period runs from the order,
          // so the next due date moves on from the placeholder (the unpaid invoice's due date) or the gap
          if (svc.billingCycle !== "ONETIME" && !["CANCELLED", "TERMINATED"].includes(svc.status)) {
            const due = addCycle(svc.createdAt, svc.billingCycle);
            if (!svc.nextDueDate || svc.nextDueDate < due) await prisma.service.update({ where: { id: svc.id }, data: { nextDueDate: due, nextInvoiceDate: due } });
          }
          continue;
        }
        const due = svc.billingCycle === "ONETIME" ? null : addCycle(new Date(), svc.billingCycle);
        const automated = svc.product.provisioner === "PROXMOX" || svc.product.provisioner === "VIRTUALIZOR" || svc.product.provisioner === "CPANEL";
        if (automated && svc.product.autoSetup !== "MANUAL") {
          await prisma.service.update({ where: { id: svc.id }, data: { status: "PROVISIONING", nextDueDate: due, nextInvoiceDate: due } });
          await enqueueProvision({ serviceId: svc.id, action: "create" });
        } else {
          // manual products stay PENDING until staff activates them (Admin → Orders) — tell staff it's paid
          await prisma.service.update({ where: { id: svc.id }, data: { nextDueDate: due, nextInvoiceDate: due } });
          const u = await prisma.user.findUnique({ where: { id: svc.userId }, select: { email: true } });
          const { alertStaff, adminLink } = await import("../email/staff-alerts");
          await alertStaff("service.manual_setup", { vars: { productName: svc.product.name, clientEmail: u?.email ?? "", hostname: svc.hostname ?? "" }, link: adminLink(`/admin/services/${svc.id}`) });
        }
      } else if (item.periodEnd) {
        const newDue = item.periodEnd > (svc.nextDueDate ?? new Date(0)) ? item.periodEnd : svc.nextDueDate;
        await prisma.service.update({ where: { id: svc.id }, data: { nextDueDate: newDue, nextInvoiceDate: newDue } });
        if (svc.status === "SUSPENDED" && settings.automation.autoUnsuspend && (svc.suspendReason ?? "").startsWith("Overdue")) {
          const stillOverdue = await prisma.invoiceItem.count({
            where: { relId: svc.id, type: "SERVICE", invoice: { status: "UNPAID", dueDate: { lt: new Date() } } },
          });
          if (!stillOverdue) {
            await enqueueProvision({ serviceId: svc.id, action: "unsuspend", params: { notify: settings.automation.unsuspendEmail } });
            const { recordEvent } = await import("../../jobs/billing");
            await recordEvent({ action: "unsuspended", entity: "service", entityId: svc.id, userId: svc.userId, label: svc.hostname ?? svc.product.name, message: `Overdue invoices paid (${inv.number ?? inv.proformaNumber})` });
          }
        }
      }
    }
    if (item.type === "UPGRADE" && item.relId) {
      const { applyUpgrade } = await import("./upgrades");
      await applyUpgrade(item.relId).catch((e) => console.error("[upgrade] couldn't apply after payment", item.relId, e));
      continue;
    }
    if (item.type === "ADDON" && item.relId) {
      await prisma.serviceAddon.updateMany({ where: { id: item.relId, status: "PENDING" }, data: { status: "ACTIVE" } });
    }
    if (item.type === "DOMAIN" && item.relId) {
      const { onDomainPaid } = await import("../domains/service");
      await onDomainPaid(item.relId, item.periodStart ? "renew" : "initial").catch(async (e) => {
        // a paid domain the registrar refused must reach staff — it used to only reach the server log
        console.error("[domains] post-payment action failed", e);
        const d = await prisma.domain.findUnique({ where: { id: item.relId! }, select: { id: true, name: true, registrar: true, userId: true } });
        const { explainProvisionError } = await import("../provisioning/explain");
        const x = explainProvisionError((e as Error).message, { kind: "domain" });
        const what = item.periodStart ? "renewal" : "registration";
        await prisma.automationEvent.create({ data: { action: "error", entity: "domain", entityId: item.relId, userId: inv.userId, label: d?.name ?? item.description, success: false, message: `Domain ${what} failed at ${d?.registrar ?? "the registrar"}: ${x.cause}` } }).catch(() => undefined);
        const { audit } = await import("../../lib/audit");
        await audit({ userId: inv.userId, action: `domain.${what}_failed`, entity: "domain", entityId: item.relId ?? undefined, details: { error: (e as Error).message } });
        const { alertStaff } = await import("../email/staff-alerts");
        await alertStaff("service.provisioning_failed", { vars: { serviceId: item.relId, productName: `Domain ${what}: ${d?.name ?? item.description}`, clientEmail: inv.user.email, error: `${x.title}. Why: ${x.cause} — What to do: complete the ${what} at ${d?.registrar ?? "the registrar"} (or fix the registrar settings) and mark the domain active.` } });
      });
    }
  }

  // payment alone doesn't make an order Active — it becomes Active once its services are delivered
  if (inv.order) {
    const { syncOrderStatus } = await import("../orders/status");
    await syncOrderStatus(inv.order.id);
  }

  // affiliate commission on first payment of referred clients
  if (settings.affiliates.enabled && !inv.isWalletTopup) {
    const profile = await prisma.clientProfile.findUnique({ where: { userId: inv.userId } });
    if (profile?.affiliateRef) {
      const aff = await prisma.affiliate.findUnique({ where: { code: profile.affiliateRef } });
      if (aff && aff.userId !== inv.userId) {
        // commissions are paid out in INR — convert foreign-currency invoices at the invoice's rate
        const amount = Math.round(((inv.total - inv.taxTotal) * (inv.exchangeRate || 1) * aff.commissionPct) / 100);
        await prisma.referral
          .create({ data: { affiliateId: aff.id, referredUserId: inv.userId, invoiceId: inv.id, amount, status: "PENDING" } })
          .catch(() => undefined); // unique(invoiceId) → already recorded
      }
    }
  }

  await queueEmail(
    "invoice.paid",
    inv.user.email,
    { ...invoiceEmailVars(inv, inv.user.firstName), amount: formatMoney(inv.total, inv.currency) },
    inv.userId,
    inv.isWalletTopup ? undefined : [{ filename: `${invoiceLabel(inv).replace(/\//g, "-")}.pdf`, invoiceId: inv.id }],
  );
}

/**
 * Safety net (worker, every few minutes): a live service must always have a next due date. Fills it in for
 * services that were activated before their first invoice was paid (older versions left it empty):
 * paid → one billing cycle from the payment; unpaid → the invoice's due date; no invoice → one cycle from the order.
 */
export async function fillMissingDueDates() {
  const svcs = await prisma.service.findMany({
    where: { nextDueDate: null, billingCycle: { not: "ONETIME" }, status: { in: ["ACTIVE", "SUSPENDED", "PROVISIONING"] } },
    select: { id: true, createdAt: true, billingCycle: true },
    take: 500,
  });
  let fixed = 0;
  for (const s of svcs) {
    const first = await prisma.invoiceItem.findFirst({
      where: { relId: s.id, type: "SERVICE", invoice: { status: { in: ["PAID", "UNPAID"] } } },
      orderBy: { invoice: { createdAt: "asc" } },
      select: { invoice: { select: { status: true, paidAt: true, dueDate: true } } },
    });
    const inv = first?.invoice;
    const due = inv?.status === "PAID" ? addCycle(inv.paidAt ?? s.createdAt, s.billingCycle) : inv?.status === "UNPAID" && inv.dueDate ? inv.dueDate : addCycle(s.createdAt, s.billingCycle);
    await prisma.service.update({ where: { id: s.id }, data: { nextDueDate: due, nextInvoiceDate: due } });
    fixed++;
  }
  return { fixed };
}
