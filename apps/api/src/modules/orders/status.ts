/**
 * Order status follows what was actually delivered — it is worked out from the order's services and
 * domains, never set by the payment alone:
 *
 *   anything not delivered yet (pending / provisioning / failed)  → PENDING
 *   otherwise anything running                                    → ACTIVE
 *   otherwise anything suspended                                  → SUSPENDED
 *   otherwise anything terminated / expired / transferred away    → TERMINATED
 *   otherwise (everything cancelled)                              → CANCELLED
 *
 * An order with nothing in it follows its invoice (paid → ACTIVE, cancelled → CANCELLED, else PENDING).
 * FRAUD, or a status staff pinned by hand (statusLocked), is left alone until staff release it.
 */
import { prisma, type OrderStatus } from "../../db";

type Kind = "pending" | "active" | "suspended" | "ended" | "cancelled";

const SERVICE: Record<string, Kind> = { PENDING: "pending", PROVISIONING: "pending", FAILED: "pending", ACTIVE: "active", SUSPENDED: "suspended", TERMINATED: "ended", CANCELLED: "cancelled" };
const DOMAIN: Record<string, Kind> = { PENDING: "pending", PENDING_TRANSFER: "pending", ACTIVE: "active", EXPIRED: "ended", TRANSFERRED_AWAY: "ended", CANCELLED: "cancelled" };

export function deriveOrderStatus(o: { services: { status: string }[]; domains: { status: string }[]; invoice?: { status: string } | null }): OrderStatus {
  const kinds = [...o.services.map((s) => SERVICE[s.status] ?? "pending"), ...o.domains.map((d) => DOMAIN[d.status] ?? "pending")];
  if (!kinds.length) return o.invoice?.status === "PAID" ? "ACTIVE" : o.invoice?.status === "CANCELLED" ? "CANCELLED" : "PENDING";
  if (kinds.includes("pending")) {
    // nothing delivered and the invoice was cancelled → the order is dead, not waiting
    if (o.invoice?.status === "CANCELLED" && !kinds.some((k) => k === "active" || k === "suspended")) return "CANCELLED";
    return "PENDING";
  }
  if (kinds.includes("active")) return "ACTIVE";
  if (kinds.includes("suspended")) return "SUSPENDED";
  if (kinds.includes("ended")) return "TERMINATED";
  return "CANCELLED";
}

/** Recompute one order's status. Returns the new status (or null when unchanged / locked). */
export async function syncOrderStatus(orderId: string | null | undefined): Promise<OrderStatus | null> {
  if (!orderId) return null;
  const o = await prisma.order.findUnique({ where: { id: orderId }, select: { id: true, status: true, statusLocked: true, services: { select: { status: true } }, domains: { select: { status: true } }, invoice: { select: { status: true } } } });
  if (!o || o.statusLocked || o.status === "FRAUD") return null;
  const next = deriveOrderStatus(o);
  if (next === o.status) return null;
  await prisma.order.update({ where: { id: o.id }, data: { status: next } });
  return next;
}

/** After a service changed: recompute the order it belongs to. Never throws (callers are mid-flow). */
export async function syncOrderForService(serviceId: string) {
  try {
    const s = await prisma.service.findUnique({ where: { id: serviceId }, select: { orderId: true } });
    return await syncOrderStatus(s?.orderId);
  } catch (e) {
    console.error("[orders] status sync failed", e);
    return null;
  }
}

export async function syncOrderForDomain(domainId: string) {
  try {
    const d = await prisma.domain.findUnique({ where: { id: domainId }, select: { orderId: true } });
    return await syncOrderStatus(d?.orderId);
  } catch (e) {
    console.error("[orders] status sync failed", e);
    return null;
  }
}

/** Safety net (worker, every few minutes, and once at start-up): fix any order whose status drifted. */
export async function reconcileOrderStatuses() {
  let cursor: string | undefined;
  let fixed = 0;
  let checked = 0;
  for (;;) {
    const batch = await prisma.order.findMany({
      where: { statusLocked: false, status: { not: "FRAUD" } },
      orderBy: { id: "asc" },
      take: 500,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
      select: { id: true, status: true, services: { select: { status: true } }, domains: { select: { status: true } }, invoice: { select: { status: true } } },
    });
    if (!batch.length) break;
    for (const o of batch) {
      checked++;
      const next = deriveOrderStatus(o);
      if (next !== o.status) {
        await prisma.order.update({ where: { id: o.id }, data: { status: next } });
        fixed++;
      }
    }
    cursor = batch[batch.length - 1].id;
  }
  return { checked, fixed };
}
