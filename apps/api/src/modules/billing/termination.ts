/**
 * When a service ends (terminated or cancelled), its unpaid invoices shouldn't keep chasing the customer.
 *
 *   - invoice only for this service (its renewal / setup / addons, plus any late fee)  → cancelled
 *   - invoice that also bills other things                                            → this service's lines are removed,
 *                                                                                       the rest stays due (totals and GST recomputed)
 *   - invoice with a part-payment                                                     → left alone and flagged for staff
 *     (the money has to be refunded or moved to credit by a person)
 */
import { prisma } from "../../db";
import { audit } from "../../lib/audit";
import { getSettings } from "../../lib/settings";
import { cancelInvoice, recomputeInvoiceTx } from "./invoices";

/** Lines that are tied to nothing else and simply follow the rest of the invoice. */
const FOLLOWERS = new Set(["LATE_FEE", "PROMO"]);

export async function cancelServiceInvoices(serviceId: string, opts: { reason?: string; actorId?: string | null; force?: boolean } = {}) {
  const s = await getSettings();
  if (!opts.force && (s.automation as { cancelInvoicesOnTerminate?: boolean }).cancelInvoicesOnTerminate === false) return { cancelled: [], trimmed: [], skipped: [] };
  const svc = await prisma.service.findUnique({ where: { id: serviceId }, select: { id: true, userId: true, hostname: true, status: true, addons: { select: { id: true } } } });
  if (!svc) return { cancelled: [], trimmed: [], skipped: [] };
  const addonIds = svc.addons.map((a) => a.id);
  const mine = (it: { type: string; relId: string | null }) =>
    (it.relId === svc.id && (it.type === "SERVICE" || it.type === "SETUP")) || (it.type === "ADDON" && !!it.relId && addonIds.includes(it.relId));
  const reason = opts.reason ?? `Service ${svc.hostname ?? svc.id} ${svc.status === "CANCELLED" ? "cancelled" : "terminated"}`;

  const invoices = await prisma.invoice.findMany({
    where: {
      userId: svc.userId,
      status: { in: ["UNPAID", "DRAFT"] },
      isWalletTopup: false,
      items: { some: { OR: [{ relId: svc.id, type: { in: ["SERVICE", "SETUP"] } }, ...(addonIds.length ? [{ type: "ADDON" as const, relId: { in: addonIds } }] : [])] } },
    },
    include: { items: true },
  });

  const cancelled: string[] = [];
  const trimmed: string[] = [];
  const skipped: string[] = [];
  for (const inv of invoices) {
    try {
      if (inv.amountPaid > 0) {
        skipped.push(inv.id);
        await audit({ actorId: opts.actorId ?? null, userId: inv.userId, action: "invoice.termination_needs_review", entity: "invoice", entityId: inv.id, details: { serviceId: svc.id, amountPaid: inv.amountPaid, note: "Part-paid — refund or credit the payment, then cancel" } });
        continue;
      }
      const others = inv.items.filter((it) => !mine(it) && !FOLLOWERS.has(it.type));
      if (!others.length) {
        await cancelInvoice(inv.id, reason);
        cancelled.push(inv.id);
        await audit({ actorId: opts.actorId ?? null, userId: inv.userId, action: "invoice.cancelled_on_termination", entity: "invoice", entityId: inv.id, details: { serviceId: svc.id, total: inv.total } });
      } else {
        const drop = inv.items.filter(mine).map((it) => it.id);
        await prisma.$transaction(async (tx) => {
          await tx.$queryRaw`SELECT id FROM "Invoice" WHERE id = ${inv.id} FOR UPDATE`;
          const fresh = await tx.invoice.findUniqueOrThrow({ where: { id: inv.id } });
          if (!["UNPAID", "DRAFT"].includes(fresh.status) || fresh.amountPaid > 0) return;
          await tx.invoiceItem.deleteMany({ where: { id: { in: drop }, invoiceId: inv.id } });
          await tx.invoice.update({ where: { id: inv.id }, data: { notes: [fresh.notes, `${reason} — its charges were removed from this invoice`].filter(Boolean).join("\n") } });
          await recomputeInvoiceTx(tx, inv.id);
        });
        trimmed.push(inv.id);
        await audit({ actorId: opts.actorId ?? null, userId: inv.userId, action: "invoice.trimmed_on_termination", entity: "invoice", entityId: inv.id, details: { serviceId: svc.id, removedLines: drop.length } });
      }
    } catch (e) {
      skipped.push(inv.id);
      console.error("[termination] couldn't cancel invoice", inv.id, (e as Error).message);
    }
  }
  return { cancelled, trimmed, skipped };
}

/** Daily: services that already ended (incl. before this feature, or ended outside the panel) but still have unpaid invoices. */
export async function sweepEndedServiceInvoices() {
  const s = await getSettings();
  if ((s.automation as { cancelInvoicesOnTerminate?: boolean }).cancelInvoicesOnTerminate === false) return { services: 0, cancelled: 0, trimmed: 0 };
  const rows = await prisma.$queryRaw<{ id: string }[]>`
    SELECT DISTINCT s.id FROM "Service" s
    JOIN "InvoiceItem" it ON it."relId" = s.id AND it.type IN ('SERVICE', 'SETUP')
    JOIN "Invoice" i ON i.id = it."invoiceId"
    WHERE s.status IN ('TERMINATED', 'CANCELLED') AND i.status IN ('UNPAID', 'DRAFT') AND i."amountPaid" = 0 AND i."isWalletTopup" = false
    LIMIT 500`;
  let cancelled = 0;
  let trimmed = 0;
  for (const r of rows) {
    const x = await cancelServiceInvoices(r.id);
    cancelled += x.cancelled.length;
    trimmed += x.trimmed.length;
  }
  return { services: rows.length, cancelled, trimmed };
}
