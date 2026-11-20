/**
 * Service period (start – end) on invoice lines, worked out for new and existing invoices alike.
 *   npx tsx --test test/invoice-periods.test.ts
 */
import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "../src/db";
import { linePeriods } from "../src/modules/billing/periods";
import { renderInvoicePdf } from "../src/modules/billing/pdf";

const RUN = Date.now().toString(36);
const ids: Record<string, string> = {};
const d = (s: string) => new Date(`${s}T00:00:00+05:30`);
const ymd = (x: Date) => x.toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });

before(async () => {
  ids.user = (await prisma.user.create({ data: { email: `ip-${RUN}@t.test`, passwordHash: "x", firstName: "C", type: "CLIENT", status: "ACTIVE" } })).id;
  ids.group = (await prisma.productGroup.create({ data: { name: `QA IP ${RUN}`, slug: `qa-ip-${RUN}` } })).id;
  ids.product = (await prisma.product.create({ data: { groupId: ids.group, name: `IP VPS ${RUN}`, slug: `qa-ip-${RUN}`, type: "VPS_LINUX", provisioner: "MANUAL", autoSetup: "MANUAL" } })).id;
  ids.svc = (await prisma.service.create({ data: { userId: ids.user, productId: ids.product, status: "ACTIVE", billingCycle: "QUARTERLY", firstAmount: 100, recurringAmount: 100, currency: "INR", nextDueDate: d("2026-12-01") } })).id;
});
after(async () => {
  await prisma.invoiceItem.deleteMany({ where: { invoice: { userId: ids.user } } });
  await prisma.invoice.deleteMany({ where: { userId: ids.user } });
  await prisma.service.deleteMany({ where: { userId: ids.user } });
  await prisma.product.deleteMany({ where: { id: ids.product } });
  await prisma.productGroup.deleteMany({ where: { id: ids.group } });
  await prisma.user.deleteMany({ where: { id: ids.user } });
  await prisma.$disconnect();
});

test("renewal, first order, old line without dates, and non-service lines", async () => {
  const inv = { issueDate: d("2026-11-16"), createdAt: d("2026-11-16") };
  const out = await linePeriods(
    [
      { type: "SERVICE", relId: ids.svc, periodStart: d("2026-12-16"), periodEnd: d("2027-01-16") }, // renewal
      { type: "SERVICE", relId: ids.svc, periodStart: null, periodEnd: d("2026-12-16") }, // first order
      { type: "SERVICE", relId: ids.svc, periodStart: null, periodEnd: null }, // old line → service cycle (quarterly)
      { type: "CUSTOM", relId: null, periodStart: null, periodEnd: null },
      { type: "SETUP", relId: ids.svc, periodStart: null, periodEnd: null },
    ],
    inv,
  );
  assert.deepEqual([ymd(out[0].period!.from), ymd(out[0].period!.to)], ["2026-12-16", "2027-01-15"]);
  assert.deepEqual([ymd(out[1].period!.from), ymd(out[1].period!.to)], ["2026-11-16", "2026-12-15"]);
  assert.deepEqual([ymd(out[2].period!.from), ymd(out[2].period!.to)], ["2026-11-16", "2027-02-15"]);
  assert.equal(out[3].period, null);
  assert.equal(out[4].period, null);
});

test("the PDF still renders with periods", async () => {
  const { createInvoice } = await import("../src/modules/billing/invoices");
  const inv = await prisma.$transaction((tx) => createInvoice(tx, { userId: ids.user, items: [{ type: "SERVICE", relId: ids.svc, description: "VPS (Quarterly renewal)", unitPrice: 30000, periodStart: d("2026-12-01"), periodEnd: d("2027-03-01") }] }));
  const pdf = await renderInvoicePdf(inv.id);
  assert.ok(pdf.length > 1000 && pdf.subarray(0, 4).toString() === "%PDF");
});
