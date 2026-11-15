/**
 * Bulk ticket actions (close / status / priority / assign / department) and the assignee list
 * support agents can use without staff-management rights.
 *   npx tsx --test test/ticket-bulk.test.ts
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
const tickets: string[] = [];

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
const agent = new Agent();
const viewer = new Agent();
const get = (id: string) => prisma.ticket.findUniqueOrThrow({ where: { id } });

before(async () => {
  const { createApp } = await import("../src/app");
  app = createApp().listen(0);
  base = `http://127.0.0.1:${(app.address() as AddressInfo).port}/api`;
  const bcrypt = (await import("bcryptjs")).default;
  ids.role = (await prisma.role.create({ data: { name: `QA support ${RUN}`, permissions: ["tickets.view", "tickets.manage"] } })).id;
  ids.viewRole = (await prisma.role.create({ data: { name: `QA support ro ${RUN}`, permissions: ["tickets.view"] } })).id;
  ids.agent = (await prisma.user.create({ data: { email: `tb-agent-${RUN}@t.test`, passwordHash: await bcrypt.hash(PW, 10), firstName: "Agent", lastName: RUN, type: "STAFF", status: "ACTIVE", roleId: ids.role } })).id;
  ids.viewer = (await prisma.user.create({ data: { email: `tb-view-${RUN}@t.test`, passwordHash: await bcrypt.hash(PW, 10), firstName: "View", type: "STAFF", status: "ACTIVE", roleId: ids.viewRole } })).id;
  ids.user = (await prisma.user.create({ data: { email: `tb-c-${RUN}@t.test`, passwordHash: "x", firstName: "C", type: "CLIENT", status: "ACTIVE" } })).id;
  ids.d1 = (await prisma.ticketDepartment.create({ data: { name: `QA Billing ${RUN}`, email: `b-${RUN}@t.test` } })).id;
  ids.d2 = (await prisma.ticketDepartment.create({ data: { name: `QA Tech ${RUN}`, email: `t-${RUN}@t.test` } })).id;
  for (let i = 0; i < 4; i++) tickets.push((await prisma.ticket.create({ data: { number: `QA-${RUN}-${i}`, userId: ids.user, departmentId: ids.d1, subject: `Cancellation request ${i}`, status: i === 3 ? "CLOSED" : "OPEN", closedAt: i === 3 ? new Date("2026-01-01") : null } })).id);
  assert.equal((await agent.req("POST", "/auth/login", { email: `tb-agent-${RUN}@t.test`, password: PW })).status, 200);
  assert.equal((await viewer.req("POST", "/auth/login", { email: `tb-view-${RUN}@t.test`, password: PW })).status, 200);
});

after(async () => {
  await prisma.ticket.deleteMany({ where: { id: { in: tickets } } });
  await prisma.ticketDepartment.deleteMany({ where: { id: { in: [ids.d1, ids.d2] } } });
  for (const id of [ids.agent, ids.viewer, ids.user]) {
    await prisma.activityLog.deleteMany({ where: { OR: [{ userId: id }, { actorId: id }] } }).catch(() => undefined);
    await prisma.loginHistory.deleteMany({ where: { userId: id } });
    await prisma.session.deleteMany({ where: { userId: id } });
  }
  await prisma.user.deleteMany({ where: { id: { in: [ids.agent, ids.viewer, ids.user] } } });
  await prisma.role.deleteMany({ where: { id: { in: [ids.role, ids.viewRole] } } });
  app.close();
  const { closeQueues } = await import("../src/jobs/queues");
  await closeQueues().catch(() => undefined);
  await prisma.$disconnect();
});

test("close many tickets at once; already-closed ones keep their close date", async () => {
  const r = await agent.req("POST", "/admin/tickets/bulk", { ids: tickets, status: "CLOSED" });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.deepEqual(r.json, { updated: 3, skipped: 1 });
  for (const id of tickets) assert.equal((await get(id)).status, "CLOSED");
  assert.equal((await get(tickets[3])).closedAt?.toISOString(), "2026-01-01T00:00:00.000Z");
  assert.ok(await prisma.activityLog.findFirst({ where: { action: "ticket.bulk_updated", actorId: ids.agent } }));
});

test("reopen, prioritise, move and assign in bulk", async () => {
  const two = tickets.slice(0, 2);
  assert.equal((await agent.req("POST", "/admin/tickets/bulk", { ids: two, status: "OPEN" })).json.updated, 2);
  assert.equal((await get(two[0])).closedAt, null, "reopening clears the close date");
  await agent.req("POST", "/admin/tickets/bulk", { ids: two, priority: "HIGH" });
  await agent.req("POST", "/admin/tickets/bulk", { ids: two, departmentId: ids.d2 });
  await agent.req("POST", "/admin/tickets/bulk", { ids: two, assignedToId: ids.agent });
  const t = await get(two[1]);
  assert.deepEqual([t.priority, t.departmentId, t.assignedToId], ["HIGH", ids.d2, ids.agent]);
  await agent.req("POST", "/admin/tickets/bulk", { ids: two, assignedToId: null });
  assert.equal((await get(two[1])).assignedToId, null);
});

test("bad requests are refused with a reason", async () => {
  assert.match((await agent.req("POST", "/admin/tickets/bulk", { ids: [] })).json.error, /Select at least one ticket/);
  assert.match((await agent.req("POST", "/admin/tickets/bulk", { ids: tickets })).json.error, /Choose what to change/);
  assert.match((await agent.req("POST", "/admin/tickets/bulk", { ids: tickets, departmentId: "nope" })).json.error, /Department not found/);
  assert.match((await agent.req("POST", "/admin/tickets/bulk", { ids: tickets, assignedToId: ids.user })).json.error, /Staff member not found/, "customers can't be assignees");
  assert.equal((await viewer.req("POST", "/admin/tickets/bulk", { ids: tickets, status: "CLOSED" })).status, 403, "view-only staff can't change tickets");
});

test("support agents can list who to assign to without staff-management rights", async () => {
  assert.equal((await agent.req("GET", "/admin/staff")).status, 403);
  const r = await viewer.req("GET", "/admin/ticket-assignees");
  assert.equal(r.status, 200);
  const me = r.json.staff.find((s: any) => s.id === ids.agent);
  assert.deepEqual(Object.keys(me).sort(), ["email", "firstName", "id", "lastName"], "names only — no roles, 2FA or status");
  assert.ok(!r.json.staff.some((s: any) => s.id === ids.user));
});

test("dashboard chart: 7 days by default, by day up to a month, by month beyond", async () => {
  const todayIst = new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);
  const d = await agent.req("GET", "/admin/dashboard/chart");
  assert.equal(d.status, 200);
  assert.equal(d.json.range, "7d");
  assert.equal(d.json.unit, "day");
  assert.equal(d.json.rows.length, 7);
  assert.equal(d.json.rows.at(-1).key, todayIst, "ends today (IST)");
  // the client created in before() counts as a new client today
  assert.ok(d.json.rows.at(-1).clients >= 1);
  assert.equal(d.json.totals.clients, d.json.rows.reduce((a: number, r: any) => a + r.clients, 0));
  for (const [range, n, unit] of [["15d", 15, "day"], ["1m", 30, "day"], ["6m", 6, "month"], ["1y", 12, "month"]] as const) {
    const r = await agent.req("GET", `/admin/dashboard/chart?range=${range}`);
    assert.equal(r.json.rows.length, n, range);
    assert.equal(r.json.unit, unit, range);
  }
  assert.equal((await agent.req("GET", "/admin/dashboard/chart?range=nonsense")).json.range, "7d");
});
