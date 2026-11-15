/**
 * Staff alerts: emails to the business for payments, tickets, etc. — recipients, per-alert switches,
 * no duplicate on a replayed payment, escaped details.
 *   npx tsx --test test/staff-alerts.test.ts
 */
import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "../src/db";
import { emailQueue, closeQueues } from "../src/jobs/queues";
import { createInvoice, applyPayment } from "../src/modules/billing/invoices";
import { openTicket, replyTicket } from "../src/modules/tickets/service";
import { getStaffAlertConfig, saveStaffAlertConfig, parseRecipients, detailsTable } from "../src/modules/email/staff-alerts";
import { getSettings, updateSettings, clearSettingsCache } from "../src/lib/settings";

const RUN = Date.now().toString(36);
const TO = [`alerts-${RUN}@t.test`, `ops-${RUN}@t.test`];
const ids: Record<string, string> = {};
const tickets: string[] = [];
let saved: unknown;

/** alert jobs queued to our test recipients */
async function jobs(template?: string) {
  const all = await emailQueue().getJobs(["waiting", "delayed", "active", "completed", "failed", "paused", "prioritized"], 0, 400, false);
  return all.filter((j) => TO.includes(j.data.to) && (!template || j.data.template === template));
}
async function waitFor(template: string, n: number) {
  for (let i = 0; i < 60; i++) {
    const js = await jobs(template);
    if (js.length >= n) return js;
    await new Promise((r) => setTimeout(r, 100));
  }
  return jobs(template);
}

before(async () => {
  saved = (await getSettings()).staffAlerts;
  await saveStaffAlertConfig({ enabled: true, recipients: TO.join(", "), events: { "payment.received": true, "ticket.opened": true, "ticket.client_reply": true, "ticket.cancellation": true } });
  ids.user = (await prisma.user.create({ data: { email: `sa-${RUN}@t.test`, passwordHash: "x", firstName: "Asha <b>", lastName: "Verma", type: "CLIENT", status: "ACTIVE", profile: { create: { country: "IN", state: "Madhya Pradesh", stateCode: "23", currency: "INR", companyName: "Verma Hosting" } } } })).id;
  ids.staff = (await prisma.user.create({ data: { email: `sa-staff-${RUN}@t.test`, passwordHash: "x", firstName: "Staff", type: "STAFF", status: "ACTIVE" } })).id;
  ids.dept = (await prisma.ticketDepartment.create({ data: { name: `QA Alerts ${RUN}`, email: `d-${RUN}@t.test` } })).id;
});

after(async () => {
  await updateSettings("staffAlerts", saved as never);
  clearSettingsCache();
  for (const j of await jobs()) await j.remove().catch(() => undefined);
  await prisma.ticketMessage.deleteMany({ where: { ticketId: { in: tickets } } });
  await prisma.ticket.deleteMany({ where: { id: { in: tickets } } });
  await prisma.ticketDepartment.deleteMany({ where: { id: ids.dept } });
  await prisma.transaction.deleteMany({ where: { userId: ids.user } });
  await prisma.creditLedger.deleteMany({ where: { userId: ids.user } });
  await prisma.invoiceItem.deleteMany({ where: { invoice: { userId: ids.user } } });
  await prisma.invoice.deleteMany({ where: { userId: ids.user } });
  await prisma.activityLog.deleteMany({ where: { OR: [{ userId: ids.user }, { actorId: ids.staff }] } }).catch(() => undefined);
  await prisma.clientProfile.deleteMany({ where: { userId: ids.user } });
  await prisma.user.deleteMany({ where: { id: { in: [ids.user, ids.staff] } } });
  await closeQueues().catch(() => undefined);
  await prisma.$disconnect();
});

test("recipients: parsed, de-duplicated, invalid ones dropped; falls back to the billing email", async () => {
  assert.deepEqual(parseRecipients(" A@x.in, b@y.com;a@x.in\nnot-an-email "), ["a@x.in", "b@y.com"]);
  const cfg = await getStaffAlertConfig();
  assert.deepEqual(cfg.to, TO);
  await saveStaffAlertConfig({ recipients: "" });
  assert.deepEqual((await getStaffAlertConfig()).to, parseRecipients((await getSettings()).company.billingEmail));
  await saveStaffAlertConfig({ recipients: TO.join(",") });
});

test("every payment emails each recipient with the amount, method, client and invoice — once", async () => {
  const inv = await prisma.$transaction((tx) => createInvoice(tx, { userId: ids.user, items: [{ type: "CUSTOM", description: "Rack colocation 1U", unitPrice: 100000 }] }));
  const r = await applyPayment({ invoiceId: inv.id, amount: inv.total, gateway: "manual", gatewayTxnId: `SA-${RUN}-1` });
  assert.equal(r.paid, true);
  const js = await waitFor("alert.payment_received", 2);
  assert.equal(js.length, 2, "one per recipient");
  assert.deepEqual(js.map((j) => j.data.to).sort(), [...TO].sort());
  const v = js[0].data.vars as Record<string, string>;
  assert.match(v.amount, /₹1,180\.00/);
  assert.match(v.details, /Paid in full/);
  assert.match(v.details, /Rack colocation 1U/);
  assert.match(v.details, new RegExp(`sa-${RUN}@t\\.test`));
  assert.match(v.details, /Asha &lt;b&gt;/, "client-supplied text is escaped");
  assert.doesNotMatch(v.details, /Asha <b>/);
  assert.match(v.adminUrl, new RegExp(`/admin/invoices/${inv.id}$`));
  assert.equal(js[0].data.userId, undefined, "staff alerts aren't tied to the customer (no WhatsApp to them)");

  // the gateway re-sends the same payment → no second alert
  const dup = await applyPayment({ invoiceId: inv.id, amount: inv.total, gateway: "manual", gatewayTxnId: `SA-${RUN}-1` });
  assert.equal(dup.duplicate, true);
  await new Promise((r) => setTimeout(r, 400));
  assert.equal((await jobs("alert.payment_received")).length, 2);
});

test("a switched-off alert isn't sent; the master switch stops everything", async () => {
  await saveStaffAlertConfig({ events: { "payment.received": false } });
  const inv = await prisma.$transaction((tx) => createInvoice(tx, { userId: ids.user, items: [{ type: "CUSTOM", description: "Extra IP", unitPrice: 20000 }] }));
  await applyPayment({ invoiceId: inv.id, amount: 5000, gateway: "manual", gatewayTxnId: `SA-${RUN}-2` });
  await new Promise((r) => setTimeout(r, 400));
  assert.equal((await jobs("alert.payment_received")).length, 2, "still only the first payment's alerts");
  await saveStaffAlertConfig({ enabled: false, events: { "payment.received": true } });
  await applyPayment({ invoiceId: inv.id, amount: 5000, gateway: "manual", gatewayTxnId: `SA-${RUN}-3` });
  await new Promise((r) => setTimeout(r, 400));
  assert.equal((await jobs("alert.payment_received")).length, 2);
  await saveStaffAlertConfig({ enabled: true });
  // part payment reads as such
  await applyPayment({ invoiceId: inv.id, amount: 5000, gateway: "manual", gatewayTxnId: `SA-${RUN}-4` });
  const js = await waitFor("alert.payment_received", 4);
  assert.equal(js.length, 4);
  assert.ok(js.some((j) => /Part paid/.test((j.data.vars as Record<string, string>).details)));
});

test("tickets: new ticket, cancellation request and customer reply alert staff; staff replies don't", async () => {
  const t = await openTicket({ userId: ids.user, authorId: ids.user, isStaff: false, departmentId: ids.dept, priority: "HIGH", subject: "Server not reachable", message: "Ping fails since 10am" });
  tickets.push(t.id);
  const opened = await waitFor("alert.ticket_opened", 2);
  assert.equal(opened.length, 2);
  assert.match((opened[0].data.vars as Record<string, string>).details, /Ping fails since 10am/);
  assert.match(String((opened[0].data.vars as Record<string, string>).ticketNumber), /^CC-/);

  await replyTicket({ ticketId: t.id, authorId: ids.staff, isStaff: true, message: "Looking into it" });
  await replyTicket({ ticketId: t.id, authorId: ids.staff, isStaff: true, isNote: true, message: "internal" });
  await new Promise((r) => setTimeout(r, 400));
  assert.equal((await jobs("alert.ticket_reply")).length, 0);
  await replyTicket({ ticketId: t.id, authorId: ids.user, isStaff: false, message: "Still down" });
  assert.equal((await waitFor("alert.ticket_reply", 2)).length, 2);

  const c = await openTicket({ userId: ids.user, authorId: ids.user, isStaff: false, departmentId: ids.dept, priority: "MEDIUM", subject: "Cancellation request: Starter Hosting x.in", message: "Cancellation type: end_of_period\nReason: moving" });
  tickets.push(c.id);
  assert.equal((await waitFor("alert.cancellation", 2)).length, 2);
  assert.equal((await jobs("alert.ticket_opened")).length, 2, "a cancellation isn't also sent as a plain new ticket");
});

test("details table skips empty rows and escapes links", () => {
  const h = detailsTable([["A", "1"], ["B", ""], ["C", null], ["D", "x\"y", "https://e.in/?a=1&b=2"]]);
  assert.match(h, />A</);
  assert.doesNotMatch(h, />B</);
  assert.doesNotMatch(h, />C</);
  assert.match(h, /href="https:\/\/e\.in\/\?a=1&amp;b=2"/);
  assert.match(h, /x&quot;y/);
});
