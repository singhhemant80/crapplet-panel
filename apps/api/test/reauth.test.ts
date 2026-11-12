/**
 * Staff password re-confirmation: Products, Servers, Setup and critical actions need the password again.
 *   npx tsx --test test/reauth.test.ts
 */
import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import bcrypt from "bcryptjs";
import { prisma } from "../src/db";
import { closeQueues } from "../src/jobs/queues";
import { createApp } from "../src/app";

const RUN = Date.now().toString(36);
let base = "";
let server: import("node:http").Server;
let roleId = "";
let staffId = "";
let clientId = "";
const EMAIL = `sudo-${RUN}@t.test`;
const PW = "Sudo@12345";

class Agent {
  cookies: Record<string, string> = {};
  async req(method: string, path: string, body?: unknown) {
    const res = await fetch(base + path, {
      method,
      headers: { "Content-Type": "application/json", "X-Requested-With": "crapplet", Cookie: Object.entries(this.cookies).map(([k, v]) => `${k}=${v}`).join("; ") },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    for (const c of res.headers.getSetCookie()) {
      const [k, v] = c.split(";")[0].split("=");
      if (v) this.cookies[k] = v;
      else delete this.cookies[k];
    }
    const t = await res.text();
    let json: any = null;
    try { json = JSON.parse(t); } catch { json = t; }
    return { status: res.status, json };
  }
}
const login = async () => {
  const a = new Agent();
  assert.equal((await a.req("POST", "/auth/login", { email: EMAIL, password: PW, portal: "admin" })).status, 200);
  return a;
};

before(async () => {
  server = createApp().listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
  roleId = (await prisma.role.create({ data: { name: `QA sudo ${RUN}`, permissions: ["*"] } })).id;
  staffId = (await prisma.user.create({ data: { email: EMAIL, passwordHash: await bcrypt.hash(PW, 10), firstName: "S", lastName: "U", type: "STAFF", status: "ACTIVE", roleId } })).id;
  clientId = (await prisma.user.create({ data: { email: `sudo-client-${RUN}@t.test`, passwordHash: "x", firstName: "C", lastName: "T", type: "CLIENT", status: "ACTIVE", profile: { create: { country: "IN" } } } })).id;
});

after(async () => {
  await prisma.activityLog.deleteMany({ where: { OR: [{ actorId: staffId }, { userId: { in: [staffId, clientId] } }] } }).catch(() => undefined);
  await prisma.loginHistory.deleteMany({ where: { userId: staffId } }).catch(() => undefined);
  await prisma.session.deleteMany({ where: { userId: { in: [staffId, clientId] } } });
  await prisma.user.deleteMany({ where: { id: { in: [staffId, clientId] } } });
  await prisma.role.deleteMany({ where: { id: roleId } });
  server.close();
  await closeQueues().catch(() => undefined);
  await prisma.$disconnect();
});

test("protected areas and critical actions ask for the password; ordinary work doesn't", async () => {
  const a = await login();
  // not unlocked by logging in
  assert.deepEqual((await a.req("GET", "/auth/reauth")).json.active, false);

  for (const [m, p, body] of [
    ["PUT", "/admin/settings/company", { brand: "X" }],
    ["GET", "/admin/settings"],
    ["GET", "/admin/gateways"],
    ["POST", "/admin/products/bulk", { ids: [], action: "hide" }],
    ["DELETE", "/admin/servers/nope"],
    ["POST", `/admin/clients/${clientId}/close`, {}],
    ["DELETE", `/admin/clients/${clientId}`],
    ["POST", "/admin/invoices/x/refund", {}],
    ["POST", "/admin/services/x/action", { action: "terminate" }],
    ["PUT", `/admin/clients/${clientId}`, { status: "CLOSED" }],
    ["POST", "/auth/impersonate", { userId: clientId }],
  ] as [string, string, unknown?][]) {
    const r = await a.req(m, p, body);
    assert.equal(r.status, 403, `${m} ${p}`);
    assert.equal(r.json.code, "REAUTH_REQUIRED", `${m} ${p}`);
    assert.ok(r.json.details.label);
  }
  // ordinary work goes straight through (whatever the route itself then says)
  for (const [m, p, body] of [
    ["GET", "/admin/clients"],
    ["GET", "/admin/products"],
    ["GET", "/admin/servers"],
    ["POST", "/admin/services/x/action", { action: "reboot" }],
    ["PUT", `/admin/clients/${clientId}`, { firstName: "Changed" }],
  ] as [string, string, unknown?][]) {
    const r = await a.req(m, p, body);
    assert.notEqual(r.json?.code, "REAUTH_REQUIRED", `${m} ${p}`);
  }
});

test("the right password unlocks for a while on this session only; Lock ends it", async () => {
  const a = await login();
  const b = await login();
  const bad = await a.req("POST", "/auth/reauth", { password: "wrong" });
  assert.equal(bad.status, 400);
  assert.match(bad.json.error, /4 tries left/);
  const ok = await a.req("POST", "/auth/reauth", { password: PW });
  assert.equal(ok.status, 200);
  assert.ok(new Date(ok.json.until).getTime() > Date.now() + 10 * 60_000);
  assert.equal((await a.req("GET", "/admin/settings")).status, 200);
  assert.equal((await b.req("GET", "/admin/settings")).json.code, "REAUTH_REQUIRED", "another sign-in isn't unlocked");
  await a.req("DELETE", "/auth/reauth");
  assert.equal((await a.req("GET", "/admin/settings")).json.code, "REAUTH_REQUIRED");
  // an expired window asks again
  await a.req("POST", "/auth/reauth", { password: PW });
  await prisma.session.updateMany({ where: { userId: staffId, sudoUntil: { not: null } }, data: { sudoUntil: new Date(Date.now() - 1000) } });
  assert.equal((await a.req("GET", "/admin/settings")).json.code, "REAUTH_REQUIRED");
  const log = await prisma.activityLog.findMany({ where: { actorId: staffId, action: { startsWith: "auth.reauth" } } });
  assert.ok(log.some((l) => l.action === "auth.reauth") && log.some((l) => l.action === "auth.reauth_failed"));
  assert.ok(!JSON.stringify(log).includes(PW), "password never written to the activity log");
});

test("five wrong passwords sign the session out", async () => {
  const a = await login();
  for (let i = 1; i <= 4; i++) assert.equal((await a.req("POST", "/auth/reauth", { password: `bad${i}` })).status, 400);
  const last = await a.req("POST", "/auth/reauth", { password: "bad5" });
  assert.equal(last.status, 401);
  assert.equal((await a.req("GET", "/admin/clients")).status, 401);
});
