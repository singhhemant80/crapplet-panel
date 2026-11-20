/**
 * Moving a not-yet-built VPS to another hypervisor from the order / service page.
 *   npx tsx --test test/hypervisor-move.test.ts
 */
import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { prisma } from "../src/db";
import { closeQueues } from "../src/jobs/queues";

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

before(async () => {
  const { createApp } = await import("../src/app");
  app = createApp().listen(0);
  base = `http://127.0.0.1:${(app.address() as AddressInfo).port}/api`;
  const bcrypt = (await import("bcryptjs")).default;
  ids.role = (await prisma.role.create({ data: { name: `QA hv ${RUN}`, permissions: ["*"] } })).id;
  ids.staff = (await prisma.user.create({ data: { email: `hv-staff-${RUN}@t.test`, passwordHash: await bcrypt.hash(PW, 10), firstName: "S", type: "STAFF", status: "ACTIVE", roleId: ids.role } })).id;
  ids.user = (await prisma.user.create({ data: { email: `hv-${RUN}@t.test`, passwordHash: "x", firstName: "C", type: "CLIENT", status: "ACTIVE" } })).id;
  const srv = (name: string, type: string) => prisma.server.create({ data: { name: `${name} ${RUN}`, type: type as never, hostname: `${name.toLowerCase()}-${RUN}.test`, enabled: true } }).then((s) => s.id);
  ids.a = await srv("VA", "VIRTUALIZOR");
  ids.b = await srv("VB", "VIRTUALIZOR");
  ids.px = await srv("PX", "PROXMOX");
  ids.group = (await prisma.productGroup.create({ data: { name: `QA HV ${RUN}`, slug: `qa-hv-${RUN}` } })).id;
  ids.product = (await prisma.product.create({ data: { groupId: ids.group, name: `HV VPS ${RUN}`, slug: `qa-hv-${RUN}`, type: "VPS_LINUX", provisioner: "VIRTUALIZOR", autoSetup: "MANUAL", servers: { create: [{ serverId: ids.a }] } } })).id;
  const mk = (status: string, remoteId: string | null) => prisma.service.create({ data: { userId: ids.user, productId: ids.product, serverId: ids.a, node: "0", remoteId, status: status as never, billingCycle: "MONTHLY", firstAmount: 100, recurringAmount: 100, currency: "INR", nextDueDate: new Date() } }).then((s) => s.id);
  ids.failed = await mk("FAILED", "283");
  ids.active = await mk("ACTIVE", "284");
  assert.equal((await staff.req("POST", "/auth/login", { email: `hv-staff-${RUN}@t.test`, password: PW })).status, 200);
  assert.equal((await staff.req("POST", "/auth/reauth", { password: PW })).status, 200);
});

after(async () => {
  app.close();
  await prisma.service.deleteMany({ where: { userId: ids.user } });
  await prisma.product.deleteMany({ where: { id: ids.product } });
  await prisma.productGroup.deleteMany({ where: { id: ids.group } });
  await prisma.server.deleteMany({ where: { id: { in: [ids.a, ids.b, ids.px] } } });
  await prisma.activityLog.deleteMany({ where: { actorId: ids.staff } }).catch(() => undefined);
  await prisma.loginHistory.deleteMany({ where: { userId: ids.staff } }).catch(() => undefined);
  await prisma.session.deleteMany({ where: { userId: ids.staff } });
  await prisma.user.deleteMany({ where: { id: { in: [ids.user, ids.staff] } } });
  await prisma.role.deleteMany({ where: { id: ids.role } });
  await closeQueues().catch(() => undefined);
  await prisma.$disconnect();
});

test("choices list servers of the plan's kind", async () => {
  const r = await staff.req("GET", "/admin/server-choices?type=VIRTUALIZOR");
  assert.equal(r.status, 200);
  const names = r.json.servers.map((s: any) => s.id);
  assert.ok(names.includes(ids.a) && names.includes(ids.b) && !names.includes(ids.px));
});

test("a failed VPS moves to another master; its old node and VPS id are cleared", async () => {
  const r = await staff.req("PUT", `/admin/services/${ids.failed}`, { serverId: ids.b });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const s = await prisma.service.findUniqueOrThrow({ where: { id: ids.failed } });
  assert.equal(s.serverId, ids.b);
  assert.equal(s.node, null);
  assert.equal(s.remoteId, null);
});

test("a built VPS can't be moved, nor onto a server of the wrong kind", async () => {
  assert.equal((await staff.req("PUT", `/admin/services/${ids.active}`, { serverId: ids.b })).status, 409);
  assert.equal((await prisma.service.findUniqueOrThrow({ where: { id: ids.active } })).serverId, ids.a);
  assert.equal((await staff.req("PUT", `/admin/services/${ids.failed}`, { serverId: ids.px })).status, 400);
});
