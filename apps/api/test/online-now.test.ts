/**
 * "Clients online now" on the admin dashboard: request activity + heartbeat set Session.lastSeenAt / lastPath,
 * the list shows one row per client with a friendly page name, staff impersonation isn't counted, and
 * clients idle for more than 5 minutes drop off.
 *   npx tsx --test test/online-now.test.ts
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
  ua = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";
  async req(method: string, path: string, body?: unknown) {
    const res = await fetch(base + path, { method, headers: { "Content-Type": "application/json", "X-Requested-With": "crapplet", "User-Agent": this.ua, Cookie: Object.entries(this.cookies).map(([k, v]) => `${k}=${v}`).join("; ") }, body: body === undefined ? undefined : JSON.stringify(body) });
    for (const c of res.headers.getSetCookie()) { const [k, v] = c.split(";")[0].split("="); if (v) this.cookies[k] = v; }
    const t = await res.text();
    let json: any = null;
    try { json = JSON.parse(t); } catch { json = t; }
    return { status: res.status, json };
  }
}
const staff = new Agent();
const client = new Agent();
const viewer = new Agent();
const online = async () => {
  const r = await staff.req("GET", "/admin/dashboard/online");
  assert.equal(r.status, 200, JSON.stringify(r.json));
  return r.json;
};

before(async () => {
  const { createApp } = await import("../src/app");
  app = createApp().listen(0);
  base = `http://127.0.0.1:${(app.address() as AddressInfo).port}/api`;
  const bcrypt = (await import("bcryptjs")).default;
  ids.role = (await prisma.role.create({ data: { name: `QA online ${RUN}`, permissions: ["*"] } })).id;
  ids.viewRole = (await prisma.role.create({ data: { name: `QA online billing ${RUN}`, permissions: ["invoices.view"] } })).id;
  ids.staff = (await prisma.user.create({ data: { email: `on-staff-${RUN}@t.test`, passwordHash: await bcrypt.hash(PW, 10), firstName: "On", lastName: "Staff", type: "STAFF", status: "ACTIVE", roleId: ids.role } })).id;
  ids.viewer = (await prisma.user.create({ data: { email: `on-view-${RUN}@t.test`, passwordHash: await bcrypt.hash(PW, 10), firstName: "On", lastName: "Viewer", type: "STAFF", status: "ACTIVE", roleId: ids.viewRole } })).id;
  ids.user = (await prisma.user.create({ data: { email: `on-client-${RUN}@t.test`, passwordHash: await bcrypt.hash("Client@12345", 10), firstName: "Neha", lastName: "Online", type: "CLIENT", status: "ACTIVE", profile: { create: { country: "IN", state: "Uttar Pradesh", stateCode: "09", companyName: "Neha Labs", city: "Lucknow" } } } })).id;
  assert.equal((await staff.req("POST", "/auth/login", { email: `on-staff-${RUN}@t.test`, password: PW })).status, 200);
  assert.equal((await viewer.req("POST", "/auth/login", { email: `on-view-${RUN}@t.test`, password: PW })).status, 200);
});

after(async () => {
  for (const id of [ids.user, ids.staff, ids.viewer]) {
    await prisma.activityLog.deleteMany({ where: { OR: [{ userId: id }, { actorId: id }] } }).catch(() => undefined);
    await prisma.loginHistory.deleteMany({ where: { userId: id } });
    await prisma.session.deleteMany({ where: { userId: id } });
  }
  await prisma.user.deleteMany({ where: { id: { in: [ids.user, ids.staff, ids.viewer] } } });
  await prisma.role.deleteMany({ where: { id: { in: [ids.role, ids.viewRole] } } });
  app.close();
  const { closeQueues } = await import("../src/jobs/queues");
  await closeQueues().catch(() => undefined);
  await prisma.$disconnect();
});

test("a signed-in client shows as online, with the page they're on, their device and company", async () => {
  assert.ok(!(await online()).clients.some((c: any) => c.id === ids.user), "not online before signing in");
  assert.equal((await client.req("POST", "/auth/login", { email: `on-client-${RUN}@t.test`, password: "Client@12345" })).status, 200);
  assert.equal((await client.req("GET", "/auth/me")).status, 200);
  await new Promise((r) => setTimeout(r, 150)); // the activity write is fire-and-forget
  let row = (await online()).clients.find((c: any) => c.id === ids.user);
  assert.ok(row, "any signed-in request marks the client online");

  const p = await client.req("POST", "/auth/ping", { path: "/client/invoices/abc123" });
  assert.equal(p.status, 200);
  await new Promise((r) => setTimeout(r, 150));
  const list = await online();
  row = list.clients.find((c: any) => c.id === ids.user);
  assert.equal(row.page, "An invoice");
  assert.equal(row.path, "/client/invoices/abc123");
  assert.equal(row.company, "Neha Labs");
  assert.equal(row.location, "Lucknow, IN");
  assert.equal(row.device.label, "Chrome on Windows");
  assert.equal(list.windowMinutes, 5);
  assert.equal(list.clients.filter((c: any) => c.id === ids.user).length, 1, "one row per client");
  // staff never appear in the client list
  assert.ok(!list.clients.some((c: any) => c.id === ids.staff));
});

test("the heartbeat rejects junk paths and needs a signed-in user", async () => {
  assert.equal((await client.req("POST", "/auth/ping", { path: "javascript:alert(1)" })).status, 400);
  assert.equal((await new Agent().req("POST", "/auth/ping", { path: "/client" })).status, 401);
});

test("the dashboard counts use the same 5-minute window; idle clients drop off", async () => {
  const ov = await staff.req("GET", "/admin/dashboard/overview");
  assert.equal(ov.status, 200);
  assert.ok(ov.json.clients.online >= 1);
  assert.ok(ov.json.staffOnline.some((u: any) => u.id === ids.staff), "staff signed in now are listed");

  await prisma.session.updateMany({ where: { userId: ids.user }, data: { lastSeenAt: new Date(Date.now() - 6 * 60_000) } });
  assert.ok(!(await online()).clients.some((c: any) => c.id === ids.user), "idle for 6 minutes → not online");
});

test("staff 'login as client' sessions aren't counted as the client being online", async () => {
  await prisma.session.updateMany({ where: { userId: ids.user }, data: { impersonatedById: ids.staff, lastSeenAt: new Date() } });
  const list = await online();
  assert.ok(!list.clients.some((c: any) => c.id === ids.user));
  assert.ok(list.viewedByStaff >= 1);
});

test("only staff who can view clients see the list", async () => {
  assert.equal((await viewer.req("GET", "/admin/dashboard/online")).status, 403);
  assert.equal((await client.req("GET", "/admin/dashboard/online")).status, 403);
});
