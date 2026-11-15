/**
 * Staff editing a client's details: name / email / phone / address, duplicate email,
 * email-verification handling, accounts without a profile row, readable validation errors.
 *   npx tsx --test test/client-edit.test.ts
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
const u = (id: string) => prisma.user.findUniqueOrThrow({ where: { id }, include: { profile: true } });

before(async () => {
  const { createApp } = await import("../src/app");
  app = createApp().listen(0);
  base = `http://127.0.0.1:${(app.address() as AddressInfo).port}/api`;
  const bcrypt = (await import("bcryptjs")).default;
  ids.role = (await prisma.role.create({ data: { name: `QA edit ${RUN}`, permissions: ["*"] } })).id;
  ids.staff = (await prisma.user.create({ data: { email: `ce-staff-${RUN}@t.test`, passwordHash: await bcrypt.hash(PW, 10), firstName: "Edit", type: "STAFF", status: "ACTIVE", roleId: ids.role } })).id;
  ids.a = (await prisma.user.create({ data: { email: `ce-a-${RUN}@t.test`, emailVerifiedAt: new Date(), passwordHash: "x", firstName: "Hemant", lastName: "singh", phone: "7999122185", type: "CLIENT", status: "CLOSED", profile: { create: { country: "IN", state: "Madhya Pradesh", stateCode: "23", city: "Gwalior" } } } })).id;
  ids.b = (await prisma.user.create({ data: { email: `ce-b-${RUN}@t.test`, passwordHash: "x", firstName: "Other", type: "CLIENT", status: "ACTIVE" } })).id; // no profile row (old import)
  assert.equal((await staff.req("POST", "/auth/login", { email: `ce-staff-${RUN}@t.test`, password: PW })).status, 200);
  assert.equal((await staff.req("POST", "/auth/reauth", { password: PW })).status, 200);
});

after(async () => {
  app.close();
  await prisma.activityLog.deleteMany({ where: { OR: [{ actorId: ids.staff }, { userId: { in: [ids.a, ids.b] } }] } }).catch(() => undefined);
  await prisma.loginHistory.deleteMany({ where: { userId: ids.staff } }).catch(() => undefined);
  await prisma.session.deleteMany({ where: { userId: { in: [ids.staff, ids.a, ids.b] } } });
  await prisma.clientProfile.deleteMany({ where: { userId: { in: [ids.a, ids.b] } } });
  await prisma.user.deleteMany({ where: { id: { in: [ids.staff, ids.a, ids.b] } } });
  await prisma.role.deleteMany({ where: { id: ids.role } });
  await prisma.$disconnect();
});

test("staff change name, email, phone and address — even on a closed account; empty required fields keep their value", async () => {
  const r = await staff.req("PUT", `/admin/clients/${ids.a}`, { firstName: "Hemant", lastName: "Singh", email: `CE-New-${RUN}@T.test `, phone: "+91 79991 22186", companyName: "Crapplet", gstin: "", pan: "", address1: "City Center", address2: "", city: "Gwalior", state: "", postcode: "474011", country: "IN" });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const x = await u(ids.a);
  assert.equal(x.lastName, "Singh");
  assert.equal(x.email, `ce-new-${RUN}@t.test`, "trimmed and lower-cased");
  assert.equal(x.phone, "+91 79991 22186");
  assert.equal(x.profile?.address1, "City Center");
  assert.equal(x.profile?.state, "Madhya Pradesh", "blank required field didn't wipe the old value");
  assert.equal(x.profile?.gstin, null);
  assert.equal(x.emailVerifiedAt, null, "a new email has to be confirmed again");
  const log = await prisma.activityLog.findFirst({ where: { userId: ids.a, action: "client.updated" }, orderBy: { createdAt: "desc" } });
  assert.equal((log?.details as any)?.emailTo, `ce-new-${RUN}@t.test`);
});

test("staff can mark the email verified (or not) without changing it", async () => {
  assert.equal((await staff.req("PUT", `/admin/clients/${ids.a}`, { emailVerified: true })).status, 200);
  assert.ok((await u(ids.a)).emailVerifiedAt);
  // changing the address with "verified" ticked keeps it verified
  assert.equal((await staff.req("PUT", `/admin/clients/${ids.a}`, { email: `ce-a2-${RUN}@t.test`, emailVerified: true })).status, 200);
  assert.ok((await u(ids.a)).emailVerifiedAt);
  assert.equal((await staff.req("PUT", `/admin/clients/${ids.a}`, { emailVerified: false })).status, 200);
  assert.equal((await u(ids.a)).emailVerifiedAt, null);
});

test("an email already used by another account is refused with a clear message", async () => {
  const r = await staff.req("PUT", `/admin/clients/${ids.a}`, { email: `CE-B-${RUN}@t.test` });
  assert.equal(r.status, 409);
  assert.match(r.json.error, new RegExp(`Another client account already uses ce-b-${RUN}@t\\.test`));
  const r2 = await staff.req("PUT", `/admin/clients/${ids.a}`, { email: `ce-staff-${RUN}@t.test` });
  assert.match(r2.json.error, /Another staff account/);
});

test("validation errors name the field", async () => {
  const r = await staff.req("PUT", `/admin/clients/${ids.a}`, { email: "not-an-email", phone: "12" });
  assert.equal(r.status, 400);
  assert.match(r.json.error, /^Please check: /);
  assert.match(r.json.error, /Email isn't a valid email address/);
  assert.match(r.json.error, /Phone must be at least 6 characters/);
  const g = await staff.req("PUT", `/admin/clients/${ids.a}`, { gstin: "123" });
  assert.match(g.json.error, /GSTIN — Invalid GSTIN/);
});

test("accounts without a profile row (old imports) can be edited", async () => {
  const r = await staff.req("PUT", `/admin/clients/${ids.b}`, { lastName: "Person", address1: "12 MG Road", city: "Indore", state: "Madhya Pradesh", postcode: "452001", country: "IN" });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const x = await u(ids.b);
  assert.equal(x.lastName, "Person");
  assert.equal(x.profile?.city, "Indore");
  assert.equal(x.profile?.stateCode, "23");
});

test("staff can't edit a staff account through the client endpoint", async () => {
  assert.equal((await staff.req("PUT", `/admin/clients/${ids.staff}`, { firstName: "Hacked" })).status, 404);
});
