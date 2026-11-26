/**
 * Signing in with a 6-digit code sent by email (customers only).
 *   npx tsx --test test/login-email-code.test.ts
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
const client = new Agent();
const EMAIL = `elc-${RUN}@t.test`;
const STAFF = `elc-staff-${RUN}@t.test`;

before(async () => {
  const { createApp } = await import("../src/app");
  app = createApp().listen(0);
  base = `http://127.0.0.1:${(app.address() as AddressInfo).port}/api`;
  ids.user = (await prisma.user.create({ data: { email: EMAIL, passwordHash: "x", firstName: "C", type: "CLIENT", status: "ACTIVE", profile: { create: { currency: "INR" } } } })).id;
  ids.staff = (await prisma.user.create({ data: { email: STAFF, passwordHash: "x", firstName: "S", type: "STAFF", status: "ACTIVE" } })).id;
});
after(async () => {
  app.close();
  await prisma.loginHistory.deleteMany({ where: { email: { in: [EMAIL, STAFF] } } });
  await prisma.session.deleteMany({ where: { userId: { in: [ids.user, ids.staff] } } });
  await prisma.emailLog.deleteMany({ where: { to: { in: [EMAIL, STAFF] } } }).catch(() => undefined);
  await prisma.activityLog.deleteMany({ where: { userId: { in: [ids.user, ids.staff] } } }).catch(() => undefined);
  await prisma.clientProfile.deleteMany({ where: { userId: ids.user } });
  await prisma.user.deleteMany({ where: { id: { in: [ids.user, ids.staff] } } });
  await closeQueues().catch(() => undefined);
  await prisma.$disconnect();
});

/** the code is only in the email — give the issued token a known one */
async function knownCode(code = "123456") {
  const { config } = await import("../src/config");
  const { sha256 } = await import("../src/lib/crypto");
  const t = await prisma.verificationToken.findFirstOrThrow({ where: { userId: ids.user, type: "LOGIN_CODE", usedAt: null }, orderBy: { createdAt: "desc" } });
  await prisma.verificationToken.update({ where: { id: t.id }, data: { tokenHash: sha256(`${t.id}:${code}:${config.jwtSecret}`) } });
  return code;
}

test("a customer gets a code and signs in with it; it works once and verifies the email", async () => {
  const r = await client.req("POST", "/auth/login/email-code", { email: EMAIL.toUpperCase() });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.ok(r.json.challenge);
  assert.equal((await client.req("POST", "/auth/login/email-code", { email: EMAIL })).status, 429, "one a minute");
  const code = await knownCode();
  assert.equal((await client.req("POST", "/auth/login/email-code/verify", { challenge: r.json.challenge, code: "000000" })).status, 401);
  const ok = await client.req("POST", "/auth/login/email-code/verify", { challenge: r.json.challenge, code });
  assert.equal(ok.status, 200, JSON.stringify(ok.json));
  assert.equal(ok.json.user.email, EMAIL);
  assert.equal((await client.req("GET", "/auth/me")).status, 200);
  assert.ok((await prisma.user.findUniqueOrThrow({ where: { id: ids.user } })).emailVerifiedAt);
  assert.equal((await new Agent().req("POST", "/auth/login/email-code/verify", { challenge: r.json.challenge, code })).status, 401, "single use");
});

test("five wrong codes and the code stops working", async () => {
  await prisma.verificationToken.updateMany({ where: { userId: ids.user, type: "LOGIN_CODE" }, data: { createdAt: new Date(Date.now() - 120_000) } });
  const r = await client.req("POST", "/auth/login/email-code", { email: EMAIL });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const code = await knownCode("654321");
  for (let i = 0; i < 5; i++) await client.req("POST", "/auth/login/email-code/verify", { challenge: r.json.challenge, code: "111111" });
  const late = await client.req("POST", "/auth/login/email-code/verify", { challenge: r.json.challenge, code });
  assert.equal(late.status, 401);
  assert.equal(late.json.error?.code ?? late.json.code, "CODE_EXPIRED");
});

test("unknown emails and staff get the same answer but no code", async () => {
  for (const email of [`nobody-${RUN}@t.test`, STAFF]) {
    const r = await new Agent().req("POST", "/auth/login/email-code", { email });
    assert.equal(r.status, 200);
    assert.ok(r.json.challenge);
    assert.equal((await new Agent().req("POST", "/auth/login/email-code/verify", { challenge: r.json.challenge, code: "123456" })).status, 401);
  }
  assert.equal(await prisma.verificationToken.count({ where: { userId: ids.staff } }), 0);
});
