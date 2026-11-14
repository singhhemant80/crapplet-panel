/**
 * A gateway convenience fee the customer pays (Cashfree: ₹5,900 invoice → ₹6,035.76 charged) must not
 * become account credit; credits created that way before the fix can be found and taken back.
 *   npx tsx --test test/gateway-surcharge.test.ts
 */
import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "../src/db";
import { applyCreditToInvoice, applyPayment, createInvoice } from "../src/modules/billing/invoices";
import { settleVerified } from "../src/modules/payments/service";
import { findSurchargeCredits, reverseSurchargeCredits } from "../src/modules/billing/surcharge-credits";
import { closeQueues } from "../src/jobs/queues";

const RUN = Date.now().toString(36);
let userId = "";
const newInvoice = (rupees: number) => prisma.$transaction((tx) => createInvoice(tx, { userId, items: [{ type: "CUSTOM", description: `Colocation ${RUN}`, unitPrice: rupees * 100, taxable: false }] }));
const balance = async () => (await prisma.clientProfile.findUniqueOrThrow({ where: { userId } })).creditBalance;

before(async () => {
  userId = (await prisma.user.create({ data: { email: `sur-${RUN}@t.test`, passwordHash: "x", firstName: "Vikas", lastName: "V", type: "CLIENT", status: "ACTIVE", profile: { create: { country: "IN", state: "Uttar Pradesh", stateCode: "09" } } } })).id;
});

after(async () => {
  await prisma.transaction.deleteMany({ where: { userId } });
  await prisma.paymentIntent.deleteMany({ where: { userId } });
  await prisma.creditLedger.deleteMany({ where: { userId } });
  await prisma.invoiceItem.deleteMany({ where: { invoice: { userId } } });
  await prisma.invoice.deleteMany({ where: { userId } });
  await prisma.activityLog.deleteMany({ where: { userId } }).catch(() => undefined);
  await prisma.clientProfile.deleteMany({ where: { userId } });
  await prisma.user.deleteMany({ where: { id: userId } });
  await closeQueues().catch(() => undefined);
  await prisma.$disconnect();
});

test("a payment with the gateway's convenience fee pays the invoice — the fee doesn't become credit", async () => {
  const inv = await newInvoice(5900);
  const intent = await prisma.paymentIntent.create({ data: { userId, invoiceId: inv.id, gateway: "cashfree", amount: 590000, currency: "INR", gatewayOrderId: `ord-${RUN}-1` } });
  const r = await settleVerified("cashfree", { gatewayOrderId: intent.gatewayOrderId!, gatewayTxnId: `cf-${RUN}-1`, amount: 603576, paid: true, raw: { payment_amount: 6035.76 } });
  assert.equal(r.invoicePaid, true);
  assert.equal((await prisma.invoice.findUniqueOrThrow({ where: { id: inv.id } })).status, "PAID");
  assert.equal(await balance(), 0, "no credit from the fee");
  const t = await prisma.transaction.findFirstOrThrow({ where: { gatewayTxnId: `cf-${RUN}-1` } });
  assert.equal(t.amount, 590000);
  assert.match(t.description ?? "", /135\.76 INR gateway convenience fee/);
  assert.equal((t.raw as any).chargedAmount, 603576);
});

test("a real partial payment still part-pays, and a duplicate notification changes nothing", async () => {
  const inv = await newInvoice(1000);
  await prisma.paymentIntent.create({ data: { userId, invoiceId: inv.id, gateway: "cashfree", amount: 100000, currency: "INR", gatewayOrderId: `ord-${RUN}-2` } });
  await settleVerified("cashfree", { gatewayOrderId: `ord-${RUN}-2`, gatewayTxnId: `cf-${RUN}-2`, amount: 40000, paid: true });
  const i = await prisma.invoice.findUniqueOrThrow({ where: { id: inv.id } });
  assert.equal(i.status, "UNPAID");
  assert.equal(i.amountPaid, 40000);
  await settleVerified("cashfree", { gatewayOrderId: `ord-${RUN}-2`, gatewayTxnId: `cf-${RUN}-2`, amount: 40000, paid: true });
  assert.equal((await prisma.invoice.findUniqueOrThrow({ where: { id: inv.id } })).amountPaid, 40000);
});

test("credit created from fees before the fix is found; the unused part is taken back, the used part reported", async () => {
  // the old behaviour: the whole charged amount applied → excess credited as "Overpayment on invoice"
  for (const [n, rupees, charged] of [[3, 5900, 603576], [4, 7080, 724291]] as const) {
    const inv = await newInvoice(rupees);
    await prisma.paymentIntent.create({ data: { userId, invoiceId: inv.id, gateway: "cashfree", amount: rupees * 100, currency: "INR", status: "PAID", gatewayOrderId: `ord-${RUN}-${n}` } });
    await applyPayment({ invoiceId: inv.id, amount: charged, gateway: "cashfree", gatewayTxnId: `cf-${RUN}-${n}` });
  }
  assert.equal(await balance(), 29867, "₹135.76 + ₹162.91 credited");
  // the customer used ₹200 of it
  const next = await newInvoice(200);
  await applyCreditToInvoice(userId, next.id);
  assert.equal(await balance(), 9867);

  const found = (await findSurchargeCredits()).find((c) => c.userId === userId)!;
  assert.ok(found);
  assert.equal(found.entries.length, 2);
  assert.equal(found.total, 29867);
  assert.equal(found.removable, 9867);
  assert.equal(found.alreadySpent, 20000);

  // a genuine overpayment (no intent explains it) is left alone
  const inv5 = await newInvoice(100);
  await applyPayment({ invoiceId: inv5.id, amount: 15000, gateway: "manual", gatewayTxnId: `bank-${RUN}` });
  assert.equal(await balance(), 14867);

  const done = await reverseSurchargeCredits([userId]);
  assert.deepEqual(done.map((d) => [d.removed, d.alreadySpent]), [[9867, 20000]]);
  assert.equal(await balance(), 5000, "only the genuine ₹50 overpayment is left");
  assert.equal((await findSurchargeCredits()).find((c) => c.userId === userId), undefined, "not reported again");
  await reverseSurchargeCredits([userId]);
  assert.equal(await balance(), 5000, "running it twice changes nothing");
});
