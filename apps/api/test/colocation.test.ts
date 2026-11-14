/**
 * Colocation & manually delivered services: equipment asked at order time, rack details kept by staff and
 * shown to the customer, and terminated services made active again by hand (with their invoices back).
 *   npx tsx --test test/colocation.test.ts
 */
import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { prisma } from "../src/db";

const RUN = Date.now().toString(36);
const PW = "Staff@12345";
let base = "";
let app: http.Server;
const ids: Record<string, string> = {};

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

before(async () => {
  const { createApp } = await import("../src/app");
  app = createApp().listen(0);
  base = `http://127.0.0.1:${(app.address() as AddressInfo).port}/api`;
  const bcrypt = (await import("bcryptjs")).default;
  ids.role = (await prisma.role.create({ data: { name: `QA colo ${RUN}`, permissions: ["*"] } })).id;
  ids.staff = (await prisma.user.create({ data: { email: `co-staff-${RUN}@t.test`, passwordHash: await bcrypt.hash(PW, 10), firstName: "C", lastName: "S", type: "STAFF", status: "ACTIVE", roleId: ids.role } })).id;
  ids.user = (await prisma.user.create({ data: { email: `co-client-${RUN}@t.test`, passwordHash: await bcrypt.hash("Client@12345", 10), firstName: "Vikas", lastName: "V", type: "CLIENT", status: "ACTIVE", emailVerifiedAt: new Date(), phone: "+919000000000", profile: { create: { address1: "1 Test Rd", city: "Prayagraj", postcode: "211001", country: "IN", state: "Uttar Pradesh", stateCode: "09" } } } })).id;
  ids.group = (await prisma.productGroup.create({ data: { name: `QA colo ${RUN}`, slug: `qa-colo-${RUN}` } })).id;
  ids.product = (await prisma.product.create({
    data: {
      groupId: ids.group, name: `Colocation 1U ${RUN}`, slug: `qa-colo-${RUN}`, type: "COLOCATION", provisioner: "MANUAL", autoSetup: "MANUAL", taxable: false, requireHostname: true, ipv4Count: 1,
      moduleConfig: { colo: { rackUnits: 1, powerW: 300, portSpeed: "1 Gbps", datacenter: "Noida DC-1", remoteHands: "30 min/month" } },
      pricing: { create: [{ cycle: "MONTHLY", currency: "INR", price: 500000 }] },
    },
  })).id;
  assert.equal((await staff.req("POST", "/auth/login", { email: `co-staff-${RUN}@t.test`, password: PW })).status, 200);
  assert.equal((await staff.req("POST", "/auth/reauth", { password: PW })).status, 200);
  assert.equal((await client.req("POST", "/auth/login", { email: `co-client-${RUN}@t.test`, password: "Client@12345" })).status, 200);
});

after(async () => {
  const u = ids.user;
  await prisma.transaction.deleteMany({ where: { userId: u } });
  await prisma.invoiceItem.deleteMany({ where: { invoice: { userId: u } } });
  await prisma.invoice.deleteMany({ where: { userId: u } });
  const sv = await prisma.service.findMany({ where: { userId: u }, select: { id: true } });
  await prisma.provisioningLog.deleteMany({ where: { serviceId: { in: sv.map((s) => s.id) } } });
  await prisma.service.deleteMany({ where: { userId: u } });
  await prisma.order.deleteMany({ where: { userId: u } });
  await prisma.productPricing.deleteMany({ where: { productId: ids.product } }).catch(() => undefined);
  await prisma.product.deleteMany({ where: { id: ids.product } });
  await prisma.productGroup.deleteMany({ where: { id: ids.group } });
  for (const id of [ids.user, ids.staff]) {
    await prisma.activityLog.deleteMany({ where: { OR: [{ userId: id }, { actorId: id }] } }).catch(() => undefined);
    await prisma.loginHistory.deleteMany({ where: { userId: id } });
    await prisma.session.deleteMany({ where: { userId: id } });
  }
  await prisma.user.deleteMany({ where: { id: { in: [ids.user, ids.staff] } } });
  await prisma.role.deleteMany({ where: { id: ids.role } });
  app.close();
  const { closeQueues } = await import("../src/jobs/queues");
  await closeQueues().catch(() => undefined);
  await prisma.$disconnect();
});

test("the catalog describes a colocation plan by rack space, power and port — not vCPU/RAM", async () => {
  const r = await client.req("GET", `/catalog/products/qa-colo-${RUN}`);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const p = r.json.product ?? r.json;
  assert.equal(p.isColo, true);
  assert.equal(p.isVps, false);
  assert.deepEqual({ u: p.colo.rackUnits, w: p.colo.powerW, port: p.colo.portSpeed, dc: p.colo.datacenter }, { u: 1, w: 300, port: "1 Gbps", dc: "Noida DC-1" });
});

test("ordering colocation records the customer's equipment; too-tall equipment is refused", async () => {
  const tooBig = await client.req("POST", "/catalog/cart/checkout", { items: [{ productId: ids.product, cycle: "MONTHLY", equipment: { device: "Dell R740", units: 2 } }], acceptTos: true });
  assert.equal(tooBig.status, 400);
  assert.match(tooBig.json.error, /1U of rack space/);
  const co = await client.req("POST", "/catalog/cart/checkout", { items: [{ productId: ids.product, cycle: "MONTHLY", hostname: "db1.example.com", equipment: { device: "Dell PowerEdge R640", units: 1, powerW: 250, psus: 2, serial: "ABC123" } }], acceptTos: true });
  assert.equal(co.status, 201, JSON.stringify(co.json));
  const s = await prisma.service.findFirstOrThrow({ where: { userId: ids.user, productId: ids.product } });
  ids.svc = s.id;
  const cfg = s.config as any;
  assert.equal(cfg.equipment.device, "Dell PowerEdge R640");
  assert.equal(cfg.equipment.psus, 2);
  assert.equal(s.osTemplateId, null);
});

test("staff record where it's racked; the customer sees it (and their equipment), not VM fields", async () => {
  const put = await staff.req("PUT", `/admin/services/${ids.svc}`, { colo: { rack: "R12", position: "U21", pdu: "PDU-A 7", switchPort: "sw2 Gi1/0/14" }, equipment: { serial: "XYZ999" } });
  assert.equal(put.status, 200, JSON.stringify(put.json));
  const cfg = (await prisma.service.findUniqueOrThrow({ where: { id: ids.svc } })).config as any;
  assert.equal(cfg.colo.rack, "R12");
  assert.equal(cfg.equipment.serial, "XYZ999");
  assert.equal(cfg.equipment.device, "Dell PowerEdge R640", "partial edit keeps the rest");
  const r = await client.req("GET", `/client/services/${ids.svc}`);
  assert.equal(r.status, 200);
  assert.equal(r.json.service.colo.location.rack, "R12");
  assert.equal(r.json.service.colo.specs.rackUnits, 1);
  assert.equal(r.json.service.colo.equipment.serial, "XYZ999");
  assert.equal(r.json.service.product.moduleConfig, undefined, "plan internals aren't sent to customers");
});

test("a terminated manual service is made active again by staff, with the invoice cancelled at termination restored", async () => {
  // deliver it, then terminate by hand (which cancels its unpaid renewal)
  await prisma.service.update({ where: { id: ids.svc }, data: { status: "ACTIVE" } });
  const inv = await prisma.invoice.findFirstOrThrow({ where: { userId: ids.user, items: { some: { relId: ids.svc } } } });
  assert.equal(inv.status, "UNPAID");
  const t = await staff.req("PUT", `/admin/services/${ids.svc}`, { status: "TERMINATED", terminationReason: "Non-payment" });
  assert.equal(t.status, 200, JSON.stringify(t.json));
  assert.equal((await prisma.invoice.findUniqueOrThrow({ where: { id: inv.id } })).status, "CANCELLED");

  const r = await staff.req("POST", `/admin/services/${ids.svc}/reactivate`, { nextDueDate: "2026-12-24", restoreInvoices: true });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.deepEqual(r.json.restoredInvoices, [inv.id]);
  const s = await prisma.service.findUniqueOrThrow({ where: { id: ids.svc } });
  assert.equal(s.status, "ACTIVE");
  assert.equal(s.terminationDate, null);
  assert.equal(s.terminationReason, null);
  assert.equal(s.nextDueDate?.toISOString().slice(0, 10), "2026-12-24");
  assert.equal((await prisma.invoice.findUniqueOrThrow({ where: { id: inv.id } })).status, "UNPAID");
  assert.ok(await prisma.provisioningLog.findFirst({ where: { serviceId: ids.svc, action: "reactivate" } }));
  assert.ok(await prisma.activityLog.findFirst({ where: { action: "service.reactivated", entityId: ids.svc } }));
});

test("reactivation is refused for services that are already running", async () => {
  const r = await staff.req("POST", `/admin/services/${ids.svc}/reactivate`, {});
  assert.equal(r.status, 409);
  assert.equal((await client.req("POST", `/admin/services/${ids.svc}/reactivate`, {})).status, 403);
});

test("invoice lists say which service each invoice is for — staff and customer", async () => {
  const inv = await prisma.invoice.findFirstOrThrow({ where: { userId: ids.user, items: { some: { relId: ids.svc } } } });
  const a = await staff.req("GET", `/admin/invoices?userId=${ids.user}`);
  assert.equal(a.status, 200);
  const row = a.json.invoices.find((i: any) => i.id === inv.id);
  assert.deepEqual(row.for.map((f: any) => [f.kind, f.id, f.label, f.product]), [["service", ids.svc, "db1.example.com", `Colocation 1U ${RUN}`]]);
  assert.equal(row.for[0].status, "ACTIVE");
  const p = await staff.req("GET", `/admin/clients/${ids.user}`);
  assert.equal(p.json.invoices.find((i: any) => i.id === inv.id).for[0].id, ids.svc);
  const c = await client.req("GET", "/client/invoices");
  const mine = c.json.invoices.find((i: any) => i.id === inv.id);
  assert.equal(mine.for[0].label, "db1.example.com");
  assert.equal(mine.for[0].status, undefined, "customers get the link, not internal states");
  // a custom charge with nothing linked is described by its line
  const custom = await staff.req("POST", "/admin/invoices", { userId: ids.user, sendEmail: false, items: [{ description: "Remote hands — 1 hour", unitPrice: 100000, taxable: false }] });
  assert.equal(custom.status, 201);
  const list = (await staff.req("GET", `/admin/invoices?userId=${ids.user}`)).json.invoices;
  const r2 = list.find((i: any) => i.id === custom.json.id);
  assert.deepEqual(r2.for, []);
  assert.equal(r2.forSummary, "Remote hands — 1 hour");
});

test("colocation details are written on the invoice — at order time and on each renewal", async () => {
  const order = await prisma.invoiceItem.findFirstOrThrow({ where: { relId: ids.svc, type: "SERVICE" }, orderBy: { id: "asc" } });
  assert.match(order.description, /1U rack space · 300 W power · 1 Gbps port/);
  assert.match(order.description, /Noida DC-1/);
  assert.match(order.description, /Equipment: Dell PowerEdge R640 \(1U\) S\/N ABC123/);

  // time passes: the month paid on the order has ended
  await prisma.invoiceItem.updateMany({ where: { relId: ids.svc }, data: { periodStart: new Date("2020-01-01"), periodEnd: new Date(Date.now() + 2 * 86400_000) } });
  await prisma.service.update({ where: { id: ids.svc }, data: { status: "ACTIVE", nextDueDate: new Date(Date.now() + 2 * 86400_000) } });
  const g = await staff.req("POST", `/admin/clients/${ids.user}/generate-due`, {});
  assert.equal(g.status, 200, JSON.stringify(g.json));
  const renewal = await prisma.invoiceItem.findFirstOrThrow({ where: { relId: ids.svc, type: "SERVICE", description: { contains: "renewal" } } });
  assert.match(renewal.description, /Colocation 1U .* \(Monthly renewal\) — db1\.example\.com · 1U rack space · 300 W power/);
  assert.match(renewal.description, /Rack R12, U21/, "staff's rack details");
  assert.match(renewal.description, /S\/N XYZ999/, "the updated serial");
});
