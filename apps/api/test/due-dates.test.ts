/**
 * Next due date: services activated before their first invoice was paid still get one.
 *   npx tsx --test test/due-dates.test.ts
 */
import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "../src/db";
import { fillMissingDueDates, onInvoicePaid } from "../src/modules/billing/hooks";
import { addCycle } from "../src/lib/money";
import { closeQueues } from "../src/jobs/queues";

const RUN = Date.now().toString(36);
const ids: Record<string, string> = {};
const created = new Date("2026-11-22T08:00:00Z");

async function svc(extra: Record<string, unknown> = {}) {
  return (await prisma.service.create({ data: { userId: ids.user, productId: ids.product, status: "ACTIVE", billingCycle: "MONTHLY", firstAmount: 39900, recurringAmount: 39900, currency: "INR", createdAt: created, ...extra } })).id;
}
async function invoice(serviceId: string, status: "PAID" | "UNPAID", paidAt?: Date) {
  const { createInvoice } = await import("../src/modules/billing/invoices");
  const inv = await prisma.$transaction((tx) => createInvoice(tx, { userId: ids.user, dueDate: created, items: [{ type: "SERVICE", relId: serviceId, description: "V-Primo (2GB)", unitPrice: 39900 }] }));
  if (status === "PAID") await prisma.invoice.update({ where: { id: inv.id }, data: { status: "PAID", paidAt, amountPaid: inv.total } });
  return inv.id;
}

before(async () => {
  ids.user = (await prisma.user.create({ data: { email: `dd-${RUN}@t.test`, passwordHash: "x", firstName: "C", type: "CLIENT", status: "ACTIVE" } })).id;
  ids.group = (await prisma.productGroup.create({ data: { name: `QA DD ${RUN}`, slug: `qa-dd-${RUN}` } })).id;
  ids.product = (await prisma.product.create({ data: { groupId: ids.group, name: `DD VPS ${RUN}`, slug: `qa-dd-${RUN}`, type: "VPS_LINUX", provisioner: "MANUAL", autoSetup: "MANUAL" } })).id;
});
after(async () => {
  await prisma.invoiceItem.deleteMany({ where: { invoice: { userId: ids.user } } });
  await prisma.invoice.deleteMany({ where: { userId: ids.user } });
  await prisma.service.deleteMany({ where: { userId: ids.user } });
  await prisma.product.deleteMany({ where: { id: ids.product } });
  await prisma.productGroup.deleteMany({ where: { id: ids.group } });
  await prisma.user.deleteMany({ where: { id: ids.user } });
  await prisma.$disconnect();
  await closeQueues();
});

test("first invoice paid after staff activated the service: next due = one cycle from the order", async () => {
  const s = await svc();
  const inv = await invoice(s, "PAID", new Date());
  await onInvoicePaid(inv);
  const row = await prisma.service.findUniqueOrThrow({ where: { id: s } });
  assert.equal(row.nextDueDate?.toISOString(), addCycle(created, "MONTHLY").toISOString());
});

test("placeholder due date (the unpaid invoice's) moves on a cycle when paid; a later date is kept", async () => {
  const s = await svc({ nextDueDate: created });
  await onInvoicePaid(await invoice(s, "PAID", new Date()));
  assert.equal((await prisma.service.findUniqueOrThrow({ where: { id: s } })).nextDueDate?.toISOString(), addCycle(created, "MONTHLY").toISOString());
  const later = new Date("2027-06-01T00:00:00Z");
  const s2 = await svc({ nextDueDate: later });
  await onInvoicePaid(await invoice(s2, "PAID", new Date()));
  assert.equal((await prisma.service.findUniqueOrThrow({ where: { id: s2 } })).nextDueDate?.toISOString(), later.toISOString());
});

test("safety net fills services left without a due date: paid → cycle from payment, unpaid → invoice due date", async () => {
  const paidAt = new Date("2026-11-23T10:00:00Z");
  const a = await svc();
  await invoice(a, "PAID", paidAt);
  const b = await svc();
  await invoice(b, "UNPAID");
  const c = await svc({ billingCycle: "ONETIME" });
  await fillMissingDueDates();
  const [ra, rb, rc] = await Promise.all([a, b, c].map((id) => prisma.service.findUniqueOrThrow({ where: { id } })));
  assert.equal(ra.nextDueDate?.toISOString(), addCycle(paidAt, "MONTHLY").toISOString());
  assert.equal(rb.nextDueDate?.toISOString(), created.toISOString());
  assert.equal(rc.nextDueDate, null);
});
