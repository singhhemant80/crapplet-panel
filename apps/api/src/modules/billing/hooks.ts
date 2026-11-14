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
        if (svc.status !== "PENDING") continue;
        const due = svc.billingCycle === "ONETIME" ? null : addCycle(new Date(), svc.billingCycle);
        const automated = svc.product.provisioner === "PROXMOX" || svc.product.provisioner === "VIRTUALIZOR" || svc.product.provisioner === "CPANEL";
        if (automated && svc.product.autoSetup !== "MANUAL") {
          await prisma.service.update({ where: { id: svc.id }, data: { status: "PROVISIONING", nextDueDate: due, nextInvoiceDate: due } });
          await enqueueProvision({ serviceId: svc.id, action: "create" });
        } else {
          // manual products stay PENDING until staff activates them (Admin → Orders) — tell staff it's paid
          await prisma.service.update({ where: { id: svc.id }, data: { nextDueDate: due, nextInvoiceDate: due } });
          const to = settings.company.billingEmail;
          if (to) {
            const u = await prisma.user.findUnique({ where: { id: svc.userId }, select: { email: true } });
            const { config } = await import("../../config");
            await queueEmail("admin.manual_setup", to, { productName: svc.product.name, clientEmail: u?.email ?? "", hostname: svc.hostname ?? "", adminUrl: `${config.appUrl}/admin/services/${svc.id}` }).catch(() => undefined);
          }
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
      await onDomainPaid(item.relId, item.periodStart ? "renew" : "initial").catch((e) => console.error("[domains] post-payment action failed", e));
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
