import { prisma } from "../../db";
import { enqueueProvision } from "../../jobs/queues";
import { addCycle, formatMoney } from "../../lib/money";
import { getSettings } from "../../lib/settings";
import { queueEmail } from "../email/mailer";
import { adjustCredit, invoiceEmailVars, invoiceLabel } from "./invoices";

/** Everything that should happen once an invoice is fully paid. Safe to call more than once. */
export async function onInvoicePaid(invoiceId: string) {
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
        const automated = svc.product.provisioner === "PROXMOX" || svc.product.provisioner === "VIRTUALIZOR";
        if (automated && svc.product.autoSetup !== "MANUAL") {
          await prisma.service.update({ where: { id: svc.id }, data: { status: "PROVISIONING", nextDueDate: due, nextInvoiceDate: due } });
          await enqueueProvision({ serviceId: svc.id, action: "create" });
        } else {
          // manual products stay PENDING until staff activates them (Admin → Orders)
          await prisma.service.update({ where: { id: svc.id }, data: { nextDueDate: due, nextInvoiceDate: due } });
        }
      } else if (item.periodEnd) {
        const newDue = item.periodEnd > (svc.nextDueDate ?? new Date(0)) ? item.periodEnd : svc.nextDueDate;
        await prisma.service.update({ where: { id: svc.id }, data: { nextDueDate: newDue, nextInvoiceDate: newDue } });
        if (svc.status === "SUSPENDED" && settings.automation.autoUnsuspend && (svc.suspendReason ?? "").startsWith("Overdue")) {
          const stillOverdue = await prisma.invoiceItem.count({
            where: { relId: svc.id, type: "SERVICE", invoice: { status: "UNPAID", dueDate: { lt: new Date() } } },
          });
          if (!stillOverdue) await enqueueProvision({ serviceId: svc.id, action: "unsuspend" });
        }
      }
    }
    if (item.type === "ADDON" && item.relId) {
      await prisma.serviceAddon.updateMany({ where: { id: item.relId, status: "PENDING" }, data: { status: "ACTIVE" } });
    }
    if (item.type === "DOMAIN" && item.relId) {
      const { onDomainPaid } = await import("../domains/service");
      await onDomainPaid(item.relId, item.periodStart ? "renew" : "initial").catch((e) => console.error("[domains] post-payment action failed", e));
    }
  }

  if (inv.order && inv.order.status === "PENDING") await prisma.order.update({ where: { id: inv.order.id }, data: { status: "ACTIVE" } });

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
