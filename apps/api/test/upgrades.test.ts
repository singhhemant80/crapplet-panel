/**
 * Plan changes: prorated upgrade invoice → paid → service moves; downgrade → account credit;
 * billing-cycle change; staff free change with price override; guards; Virtualizor resize.
 *   npx tsx --test test/upgrades.test.ts
 */
import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { prisma } from "../src/db";
import { encrypt } from "../src/lib/crypto";
import { VirtualizorClient } from "../src/modules/provisioning/virtualizor";

const RUN = Date.now().toString(36);
const PW = "Staff@12345";
let base = "";
let app: http.Server;
const ids: Record<string, string> = {};
const P: Record<string, string> = {};

class Agent {
  cookies: Record<string, string> = {};
  async req(method: string, path: string, body?: unknown) {
    const res = await fetch(base + path, { method, headers: { "Content-Type": "application/json", "X-Requested-With": "crapplet", Cookie: Object.entries(this.cookies).map(([k, v]) => `${k}=${v}`).join("; ") }, body: body === undefined ? undefined : JSON.stringify(body) });
    for (const c of res.headers.getSetCookie()) { const [k, v] = c.split(";")[0].split("="); if (v) this.cookies[k] = v; }
    const t = await res.text();
    let json: any = null;
    try { json = JSON.parse(t); } catch { json = t; }
    return { status: res.status, json };
  }
}
const staff = new Agent();
const client = new Agent();

const DAY = 86400_000;
async function mkService(productId: string, extra: Record<string, unknown> = {}) {
  return prisma.service.create({ data: { userId: ids.user, productId, status: "ACTIVE", billingCycle: "MONTHLY", firstAmount: 100000, recurringAmount: 100000, currency: "INR", nextDueDate: new Date(Date.now() + 15 * DAY), nextInvoiceDate: new Date(Date.now() + 15 * DAY), ...extra } });
}
const pay = (invoiceId: string, amount: number) => staff.req("POST", `/admin/invoices/${invoiceId}/payment`, { amount, gateway: "bank", reference: `UP-${RUN}-${invoiceId.slice(-5)}` });

// Virtualizor master in memory
const VPSID = String(800000 + (parseInt(RUN.slice(-4), 36) % 90000));
const vps: Record<string, unknown> = { vpsid: VPSID, hostname: `up-${RUN}`, ram: 2048, cores: 1, space: 40, bandwidth: 1000 };
const edits: Record<string, unknown>[] = [];

before(async () => {
  const { createApp } = await import("../src/app");
  app = createApp().listen(0);
  base = `http://127.0.0.1:${(app.address() as AddressInfo).port}/api`;
  const bcrypt = (await import("bcryptjs")).default;
  ids.role = (await prisma.role.create({ data: { name: `QA up ${RUN}`, permissions: ["*"] } })).id;
  ids.staff = (await prisma.user.create({ data: { email: `up-staff-${RUN}@t.test`, passwordHash: await bcrypt.hash(PW, 10), firstName: "U", lastName: "S", type: "STAFF", status: "ACTIVE", roleId: ids.role } })).id;
  ids.user = (await prisma.user.create({ data: { email: `up-client-${RUN}@t.test`, passwordHash: await bcrypt.hash("Client@12345", 10), firstName: "Up", lastName: "Grade", type: "CLIENT", status: "ACTIVE", profile: { create: { country: "IN", state: "Uttar Pradesh", stateCode: "09" } } } })).id;
  ids.group = (await prisma.productGroup.create({ data: { name: `QA UP ${RUN}`, slug: `qa-up-${RUN}` } })).id;
  ids.other = (await prisma.productGroup.create({ data: { name: `QA UP other ${RUN}`, slug: `qa-up-o-${RUN}` } })).id;
  const mk = async (k: string, name: string, monthly: number, extra: Record<string, unknown> = {}, groupId = ids.group) => {
    P[k] = (await prisma.product.create({ data: { groupId, name: `${name} ${RUN}`, slug: `qa-up-${k}-${RUN}`, type: "VPS_LINUX", provisioner: "MANUAL", autoSetup: "MANUAL", taxable: false, cpuCores: 1, ramMb: 2048, diskGb: 40, ...extra, pricing: { create: [{ currency: "INR", cycle: "MONTHLY", price: monthly }, { currency: "INR", cycle: "ANNUAL", price: monthly * 10 }] } } })).id;
  };
  await mk("small", "VPS S", 50000);
  await mk("mid", "VPS M", 100000);
  await mk("big", "VPS L", 200000, { cpuCores: 4, ramMb: 8192, diskGb: 160 });
  await mk("foreign", "Other group plan", 300000, {}, ids.other);
  ids.server = (await prisma.server.create({ data: { name: `virt-up-${RUN}`, type: "VIRTUALIZOR", hostname: "virt-up.invalid", apiUser: "k", apiSecretEnc: encrypt("p") } })).id;
  await mk("vzMid", "VZ M", 100000, { provisioner: "VIRTUALIZOR" });
  await mk("vzBig", "VZ L", 200000, { provisioner: "VIRTUALIZOR", cpuCores: 4, ramMb: 8192, diskGb: 160 });
  await mk("vzSmall", "VZ S", 50000, { provisioner: "VIRTUALIZOR", cpuCores: 1, ramMb: 1024, diskGb: 20 });

  VirtualizorClient.prototype.call = async function (this: { creds: { host: string } }, act: string, q: Record<string, unknown> = {}, post?: Record<string, unknown>) {
    if (this.creds.host !== "virt-up.invalid") throw new Error("unreachable in tests");
    if (act === "vs" && q.vpsid === VPSID) return { vs: { [VPSID]: { ...vps } } };
    if (act === "managevps" && q.vpsid === VPSID && post?.editvps) {
      edits.push(post);
      for (const k of ["ram", "cores", "space", "bandwidth"]) if (post[k] !== undefined) vps[k] = Number(post[k]);
      return { done: true };
    }
    throw new Error(`unexpected ${act}`);
  } as never;

  assert.equal((await staff.req("POST", "/auth/login", { email: `up-staff-${RUN}@t.test`, password: PW })).status, 200);
  assert.equal((await staff.req("POST", "/auth/reauth", { password: PW })).status, 200);
  assert.equal((await client.req("POST", "/auth/login", { email: `up-client-${RUN}@t.test`, password: "Client@12345" })).status, 200);
});

after(async () => {
  const u = ids.user;
  await prisma.serviceUpgrade.deleteMany({ where: { userId: u } });
  await prisma.transaction.deleteMany({ where: { userId: u } });
  await prisma.paymentIntent.deleteMany({ where: { userId: u } });
  await prisma.invoiceItem.deleteMany({ where: { invoice: { userId: u } } });
  await prisma.invoice.deleteMany({ where: { userId: u } });
  await prisma.provisioningLog.deleteMany({ where: { service: { userId: u } } });
  await prisma.service.deleteMany({ where: { userId: u } });
  await prisma.product.deleteMany({ where: { id: { in: Object.values(P) } } });
  await prisma.productGroup.deleteMany({ where: { id: { in: [ids.group, ids.other] } } });
  await prisma.server.deleteMany({ where: { id: ids.server } });
  for (const id of [ids.user, ids.staff]) {
    await prisma.activityLog.deleteMany({ where: { OR: [{ userId: id }, { actorId: id }] } }).catch(() => undefined);
    await prisma.loginHistory.deleteMany({ where: { userId: id } });
    await prisma.session.deleteMany({ where: { userId: id } });
    await prisma.creditLedger.deleteMany({ where: { userId: id } });
  }
  await prisma.user.deleteMany({ where: { id: { in: [ids.user, ids.staff] } } });
  await prisma.role.deleteMany({ where: { id: ids.role } });
  app.close();
  const { closeQueues } = await import("../src/jobs/queues");
  await closeQueues().catch(() => undefined);
  await prisma.$disconnect();
});

test("proration maths", async () => {
  const { quote } = await import("../src/modules/billing/upgrades");
  const now = new Date("2026-06-16T00:00:00Z");
  const svc = { billingCycle: "MONTHLY" as const, recurringAmount: 100000, nextDueDate: new Date("2026-07-01T00:00:00Z"), currency: "INR" };
  const q = quote(svc, 200000, "MONTHLY", now); // 15 of 30 days left
  assert.deepEqual([q.daysLeft, q.periodDays, q.credit, q.charge, q.amountDue], [15, 30, 50000, 100000, 50000]);
  assert.equal(q.newNextDueDate?.toISOString(), svc.nextDueDate.toISOString());
  const y = quote(svc, 2000000, "ANNUAL", now);
  assert.deepEqual([y.credit, y.charge, y.amountDue], [50000, 2000000, 1950000]);
  assert.equal(y.newNextDueDate?.toISOString(), "2027-06-16T00:00:00.000Z");
  const overdue = quote({ ...svc, nextDueDate: new Date("2026-06-01T00:00:00Z") }, 200000, "MONTHLY", now);
  assert.deepEqual([overdue.credit, overdue.amountDue], [0, 200000], "nothing left of the period: full new-cycle price");
});

test("customer upgrades: sees allowed plans, gets a prorated invoice, paying it moves the service", async () => {
  const s = await mkService(P.mid);
  const o = await client.req("GET", `/client/services/${s.id}/upgrade-options`);
  assert.equal(o.status, 200, JSON.stringify(o.json));
  const names = o.json.plans.map((p: any) => p.id);
  assert.ok(names.includes(P.big) && names.includes(P.small));
  assert.ok(!names.includes(P.foreign), "other groups aren't offered to customers");
  assert.equal(o.json.plans.find((p: any) => p.id === P.big).direction, "upgrade");
  assert.equal(o.json.plans.find((p: any) => p.id === P.small).direction, "downgrade");
  assert.equal(o.json.plans[0].provisioner, undefined, "module details stay internal");

  assert.equal((await client.req("POST", `/client/services/${s.id}/upgrade`, { productId: P.foreign, cycle: "MONTHLY" })).status, 400);
  const r = await client.req("POST", `/client/services/${s.id}/upgrade`, { productId: P.big, cycle: "MONTHLY" });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  assert.ok(r.json.invoiceId);
  assert.ok(r.json.amountDue > 0 && r.json.amountDue <= 100000, `prorated ${r.json.amountDue}`);
  const inv = await prisma.invoice.findUniqueOrThrow({ where: { id: r.json.invoiceId }, include: { items: true } });
  assert.equal(inv.items[0].type, "UPGRADE");
  assert.equal(inv.total, r.json.amountDue);

  // a second change waits for this one
  assert.equal((await client.req("POST", `/client/services/${s.id}/upgrade`, { productId: P.small, cycle: "MONTHLY" })).status, 409);
  assert.equal((await prisma.service.findUniqueOrThrow({ where: { id: s.id } })).productId, P.mid, "nothing changes before payment");

  assert.ok((await pay(inv.id, inv.total)).status < 300);
  const after = await prisma.service.findUniqueOrThrow({ where: { id: s.id } });
  assert.deepEqual([after.productId, after.recurringAmount, after.billingCycle], [P.big, 200000, "MONTHLY"]);
  assert.equal(after.nextDueDate?.toISOString(), s.nextDueDate?.toISOString(), "same cycle keeps the due date");
  const up = await prisma.serviceUpgrade.findFirstOrThrow({ where: { serviceId: s.id } });
  assert.equal(up.status, "DONE", "manual plan: billing done, nothing to change on a server");
});

test("downgrade applies at once and credits the unused part; cycle change starts a new period", async () => {
  const s = await mkService(P.mid);
  const before = (await prisma.clientProfile.findUniqueOrThrow({ where: { userId: ids.user } })).creditBalance;
  const r = await client.req("POST", `/client/services/${s.id}/upgrade`, { productId: P.small, cycle: "MONTHLY" });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  assert.equal(r.json.invoiceId, null);
  assert.ok(r.json.amountDue < 0);
  assert.equal((await prisma.service.findUniqueOrThrow({ where: { id: s.id } })).productId, P.small);
  const afterBal = (await prisma.clientProfile.findUniqueOrThrow({ where: { userId: ids.user } })).creditBalance;
  assert.equal(afterBal - before, -r.json.amountDue);

  // monthly → annual on the same plan
  const y = await client.req("POST", `/client/services/${s.id}/upgrade`, { productId: P.small, cycle: "ANNUAL" });
  assert.equal(y.status, 201, JSON.stringify(y.json));
  const inv = await prisma.invoice.findUniqueOrThrow({ where: { id: y.json.invoiceId } });
  if (inv.status !== "PAID") assert.ok((await pay(inv.id, inv.total - inv.amountPaid)).status < 300);
  const a = await prisma.service.findUniqueOrThrow({ where: { id: s.id } });
  assert.equal(a.billingCycle, "ANNUAL");
  assert.equal(a.recurringAmount, 500000);
  assert.ok(a.nextDueDate! > new Date(Date.now() + 360 * DAY), "a new year starts today");
});

test("guards: unpaid renewal blocks customers; cancelling a pending change cancels its invoice; switch off", async () => {
  const s = await mkService(P.mid);
  const { createInvoice } = await import("../src/modules/billing/invoices");
  const ren = await prisma.$transaction((tx) => createInvoice(tx, { userId: ids.user, items: [{ type: "SERVICE", relId: s.id, description: "renewal", unitPrice: 100000, taxable: false, periodStart: new Date(), periodEnd: new Date(Date.now() + 30 * DAY) }] }));
  const blocked = await client.req("GET", `/client/services/${s.id}/upgrade-options`);
  assert.match(blocked.json.blocked, /renewal invoice/);
  assert.equal((await client.req("POST", `/client/services/${s.id}/upgrade`, { productId: P.big, cycle: "MONTHLY" })).status, 409);
  await prisma.invoice.update({ where: { id: ren.id }, data: { status: "CANCELLED" } });

  const r = await client.req("POST", `/client/services/${s.id}/upgrade`, { productId: P.big, cycle: "MONTHLY" });
  const up = await prisma.serviceUpgrade.findFirstOrThrow({ where: { serviceId: s.id, status: "PENDING" } });
  assert.equal((await client.req("POST", `/client/upgrades/${up.id}/cancel`)).status, 200);
  assert.equal((await prisma.invoice.findUniqueOrThrow({ where: { id: r.json.invoiceId } })).status, "CANCELLED");

  // a staff-cancelled upgrade invoice doesn't block a new change
  const r2 = await client.req("POST", `/client/services/${s.id}/upgrade`, { productId: P.big, cycle: "MONTHLY" });
  assert.equal(r2.status, 201);
  await staff.req("POST", `/admin/invoices/${r2.json.invoiceId}/cancel`, { reason: "x" });
  assert.equal((await client.req("POST", `/client/services/${s.id}/upgrade`, { productId: P.big, cycle: "MONTHLY" })).status, 201);

  const { updateSettings } = await import("../src/lib/settings");
  await updateSettings("automation", { clientUpgrades: false } as never);
  try {
    const s2 = await mkService(P.mid);
    assert.match((await client.req("GET", `/client/services/${s2.id}/upgrade-options`)).json.blocked, /support ticket/);
  } finally {
    await updateSettings("automation", { clientUpgrades: true } as never);
  }
});

test("staff: any plan, free change with a custom price; needs password re-confirmation", async () => {
  const s = await mkService(P.mid);
  const opts = await staff.req("GET", `/admin/services/${s.id}/upgrade-options`);
  assert.ok(opts.json.plans.some((p: any) => p.id === P.foreign), "staff can move to any plan");
  const fresh = new Agent();
  await fresh.req("POST", "/auth/login", { email: `up-staff-${RUN}@t.test`, password: PW });
  assert.equal((await fresh.req("POST", `/admin/services/${s.id}/change-plan`, { productId: P.big, cycle: "MONTHLY" })).status, 403);

  const r = await staff.req("POST", `/admin/services/${s.id}/change-plan`, { productId: P.foreign, cycle: "MONTHLY", billing: "free", recurringOverride: 150000 });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  assert.equal(r.json.invoiceId, null);
  const a = await prisma.service.findUniqueOrThrow({ where: { id: s.id } });
  assert.deepEqual([a.productId, a.recurringAmount], [P.foreign, 150000]);
});

test("Virtualizor VPS is resized after payment (disk only grows)", async () => {
  const { runProvisionAction } = await import("../src/modules/provisioning/provisioner");
  const s = await mkService(P.vzMid, { serverId: ids.server, remoteId: VPSID, hostname: `up-${RUN}` });
  const r = await staff.req("POST", `/admin/services/${s.id}/change-plan`, { productId: P.vzBig, cycle: "MONTHLY", billing: "invoice", sendEmail: false });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  const inv = await prisma.invoice.findUniqueOrThrow({ where: { id: r.json.invoiceId } });
  await pay(inv.id, inv.total);
  let up = await prisma.serviceUpgrade.findFirstOrThrow({ where: { serviceId: s.id } });
  assert.equal(up.status, "PROVISIONING", "server change queued for the worker");
  await runProvisionAction(s.id, "change_plan", { upgradeId: up.id });
  up = await prisma.serviceUpgrade.findUniqueOrThrow({ where: { id: up.id } });
  assert.equal(up.status, "DONE", up.message ?? "");
  assert.deepEqual([vps.ram, vps.cores, vps.space], [8192, 4, 160]);

  // downgrade: CPU/RAM go down, the disk stays
  const d = await staff.req("POST", `/admin/services/${s.id}/change-plan`, { productId: P.vzSmall, cycle: "MONTHLY", billing: "free" });
  assert.equal(d.status, 201, JSON.stringify(d.json));
  const down = await prisma.serviceUpgrade.findFirstOrThrow({ where: { serviceId: s.id, toProductId: P.vzSmall } });
  await runProvisionAction(s.id, "change_plan", { upgradeId: down.id });
  const dd = await prisma.serviceUpgrade.findUniqueOrThrow({ where: { id: down.id } });
  assert.equal(dd.status, "DONE", dd.message ?? "");
  assert.match(dd.message ?? "", /never shrunk/);
  assert.deepEqual([vps.ram, vps.cores, vps.space], [1024, 1, 160]);
  assert.equal(edits.at(-1)!.space, undefined, "no disk change was sent");
});
