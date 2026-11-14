/**
 * Before the fix in settleVerified, a gateway convenience fee paid by the customer (Cashfree charges e.g.
 * ₹5,900 + ₹135.76) was recorded as an overpayment and added to the customer's account credit.
 * This finds those credits and takes back what hasn't been spent yet.
 */
import { prisma } from "../../db";
import { adjustCredit } from "./invoices";

export type SurchargeCredit = { ledgerId: string; invoiceId: string; gateway: string; gatewayTxnId: string; amount: number; at: Date; unspent?: number };
export type SurchargeCustomer = { userId: string; email: string; name: string; currency: string; entries: SurchargeCredit[]; total: number; balance: number; removable: number; alreadySpent: number };

const NOTE = "Gateway convenience fee wrongly added as credit — reversed";

export async function findSurchargeCredits(): Promise<SurchargeCustomer[]> {
  const rows = await prisma.creditLedger.findMany({ where: { description: "Overpayment on invoice", refType: "invoice", amount: { gt: 0 } }, orderBy: { createdAt: "asc" } });
  if (!rows.length) return [];
  const fixed = new Set((await prisma.creditLedger.findMany({ where: { refType: "surchargeFix" }, select: { refId: true } })).map((r) => r.refId));
  const out = new Map<string, SurchargeCustomer>();
  for (const l of rows) {
    if (!l.refId || fixed.has(l.id)) continue;
    // the gateway payment on that invoice whose excess over what we asked for is exactly this credit
    const txns = await prisma.transaction.findMany({
      where: { invoiceId: l.refId, type: "PAYMENT", gateway: { notIn: ["credit", "manual"] }, createdAt: { gte: new Date(l.createdAt.getTime() - 120_000), lte: new Date(l.createdAt.getTime() + 120_000) } },
    });
    let hit: SurchargeCredit | null = null;
    for (const t of txns) {
      const asked = t.amount - l.amount;
      const intent = await prisma.paymentIntent.findFirst({ where: { invoiceId: l.refId, gateway: t.gateway, amount: { gte: asked - 1, lte: asked + 1 } } });
      if (intent) hit = { ledgerId: l.id, invoiceId: l.refId, gateway: t.gateway, gatewayTxnId: t.gatewayTxnId, amount: l.amount, at: l.createdAt };
    }
    if (!hit) continue;
    let c = out.get(l.userId);
    if (!c) {
      const u = await prisma.user.findUniqueOrThrow({ where: { id: l.userId }, select: { email: true, firstName: true, lastName: true, profile: { select: { creditBalance: true, currency: true } } } });
      c = { userId: l.userId, email: u.email, name: `${u.firstName ?? ""} ${u.lastName ?? ""}`.trim(), currency: u.profile?.currency ?? "INR", entries: [], total: 0, balance: u.profile?.creditBalance ?? 0, removable: 0, alreadySpent: 0 };
      out.set(l.userId, c);
    }
    c.entries.push(hit);
    c.total += hit.amount;
  }
  // what's still unspent of each fee credit: spending uses the oldest credit first (FIFO over the ledger)
  for (const c of out.values()) {
    const fee = new Set(c.entries.map((e) => e.ledgerId));
    const lots: { id: string; left: number }[] = [];
    for (const l of await prisma.creditLedger.findMany({ where: { userId: c.userId }, orderBy: [{ createdAt: "asc" }, { id: "asc" }] })) {
      if (l.amount > 0) lots.push({ id: l.id, left: l.amount });
      else {
        let debit = -l.amount;
        for (const lot of lots) {
          if (!debit) break;
          const t = Math.min(lot.left, debit);
          lot.left -= t;
          debit -= t;
        }
      }
    }
    const left = new Map(lots.filter((x) => fee.has(x.id)).map((x) => [x.id, x.left]));
    for (const e of c.entries) e.unspent = Math.min(left.get(e.ledgerId) ?? 0, e.amount);
    c.removable = Math.min(c.balance, c.entries.reduce((a, e) => a + (e.unspent ?? 0), 0));
    c.alreadySpent = c.total - c.removable;
  }
  return [...out.values()].sort((a, b) => b.total - a.total);
}

/** Take back the unspent part (never more than the current balance). Already-spent credit is only reported. */
export async function reverseSurchargeCredits(userIds?: string[]) {
  const found = (await findSurchargeCredits()).filter((c) => !userIds || userIds.includes(c.userId));
  const done: { userId: string; email: string; removed: number; alreadySpent: number }[] = [];
  for (const c of found) {
    let left = c.removable;
    await prisma.$transaction(async (tx) => {
      for (const e of c.entries) {
        const take = Math.min(e.unspent ?? 0, left);
        // one marker per credit, even when nothing is left to take back, so it isn't reported again
        if (take > 0) await adjustCredit(tx, { userId: c.userId, amount: -take, description: NOTE, refType: "surchargeFix", refId: e.ledgerId });
        else await tx.creditLedger.create({ data: { userId: c.userId, amount: 0, balanceAfter: (await tx.clientProfile.findUniqueOrThrow({ where: { userId: c.userId } })).creditBalance, description: `${NOTE} (already spent)`, refType: "surchargeFix", refId: e.ledgerId } });
        left -= take;
      }
    });
    done.push({ userId: c.userId, email: c.email, removed: c.removable, alreadySpent: c.alreadySpent });
  }
  return done;
}
