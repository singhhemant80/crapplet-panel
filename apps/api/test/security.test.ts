/**
 * Security regressions found in the audit:
 *  - client tools can't be turned on staff accounts (privilege escalation)
 *  - per-account sign-in lockout (on top of the per-IP limiter)
 *  - CSRF header required whenever an auth cookie is sent
 *  - staff HTML (campaigns / email templates) is stripped of anything that can run
 *   npx tsx --test test/security.test.ts
 */
import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import bcrypt from "bcryptjs";
import { prisma } from "../src/db";
import { closeQueues } from "../src/jobs/queues";
import { createApp } from "../src/app";
import { stripActiveHtml } from "../src/lib/html";

const RUN = Date.now().toString(36);
let base = "";
let server: import("node:http").Server;
const ids: Record<string, string> = {};
const PW = "Sec@123456";

class Agent {
  cookies: Record<string, string> = {};
  async req(method: string, path: string, body?: unknown, headers: Record<string, string> = { "X-Requested-With": "crapplet" }) {
    const res = await fetch(base + path, {
      method,
      headers: { "Content-Type": "application/json", ...headers, Cookie: Object.entries(this.cookies).map(([k, v]) => `${k}=${v}`).join("; ") },
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

before(async () => {
  server = createApp().listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
  const hash = await bcrypt.hash(PW, 10);
  ids.supportRole = (await prisma.role.create({ data: { name: `QA support ${RUN}`, permissions: ["clients.manage", "clients.view", "billing.manage"] } })).id;
  ids.ownerRole = (await prisma.role.create({ data: { name: `QA owner ${RUN}`, permissions: ["*"] } })).id;
  ids.support = (await prisma.user.create({ data: { email: `support-${RUN}@t.test`, passwordHash: hash, firstName: "Sup", lastName: "Port", type: "STAFF", status: "ACTIVE", roleId: ids.supportRole } })).id;
  ids.owner = (await prisma.user.create({ data: { email: `owner-${RUN}@t.test`, passwordHash: hash, firstName: "Own", lastName: "Er", type: "STAFF", status: "ACTIVE", roleId: ids.ownerRole, totpEnabled: false } })).id;
  ids.client = (await prisma.user.create({ data: { email: `cust-${RUN}@t.test`, passwordHash: hash, firstName: "Cu", lastName: "St", type: "CLIENT", status: "ACTIVE", profile: { create: { country: "IN" } } } })).id;
});

after(async () => {
  const users = [ids.support, ids.owner, ids.client];
  await prisma.activityLog.deleteMany({ where: { OR: [{ actorId: { in: users } }, { userId: { in: users } }] } }).catch(() => undefined);
  await prisma.loginHistory.deleteMany({ where: { OR: [{ userId: { in: users } }, { email: { endsWith: `${RUN}@t.test` } }] } });
  await prisma.creditLedger.deleteMany({ where: { userId: { in: users } } });
  await prisma.verificationToken.deleteMany({ where: { userId: { in: users } } });
  await prisma.session.deleteMany({ where: { userId: { in: users } } });
  await prisma.clientProfile.deleteMany({ where: { userId: { in: users } } });
  await prisma.user.deleteMany({ where: { id: { in: users } } });
  await prisma.role.deleteMany({ where: { id: { in: [ids.supportRole, ids.ownerRole] } } });
  server.close();
  await closeQueues().catch(() => undefined);
  await prisma.$disconnect();
});

async function staffLogin(email: string) {
  const a = new Agent();
  assert.equal((await a.req("POST", "/auth/login", { email, password: PW, portal: "admin" })).status, 200);
  assert.equal((await a.req("POST", "/auth/reauth", { password: PW })).status, 200);
  return a;
}

test("staff with client permissions can't use client tools on an administrator", async () => {
  const a = await staffLogin(`support-${RUN}@t.test`);
  const attempts: [string, string, unknown][] = [
    ["PUT", `/admin/clients/${ids.owner}`, { email: `taken-${RUN}@t.test` }],
    ["PUT", `/admin/clients/${ids.owner}`, { status: "CLOSED" }],
    ["POST", `/admin/clients/${ids.owner}/reset-2fa`, {}],
    ["POST", `/admin/clients/${ids.owner}/set-password`, { password: "Hijack@12345" }],
    ["POST", `/admin/clients/${ids.owner}/password-reset`, {}],
    ["POST", `/admin/clients/${ids.owner}/credit`, { amount: 100, description: "test" }],
    ["POST", `/admin/clients/${ids.owner}/close`, {}],
    ["POST", `/admin/clients/${ids.client}/merge`, { intoUserId: ids.owner }],
    ["GET", `/admin/clients/${ids.owner}`, undefined],
  ];
  for (const [m, p, b] of attempts) assert.equal((await a.req(m, p, b)).status, 404, `${m} ${p}`);
  const owner = await prisma.user.findUniqueOrThrow({ where: { id: ids.owner } });
  assert.equal(owner.email, `owner-${RUN}@t.test`);
  assert.equal(owner.status, "ACTIVE");
  assert.ok(await bcrypt.compare(PW, owner.passwordHash), "admin password unchanged");
  // …while the same tools still work on a real customer
  assert.equal((await a.req("PUT", `/admin/clients/${ids.client}`, { firstName: "Customer" })).status, 200);
});

test("ten wrong passwords lock that account's sign-in for a while, from any IP", async () => {
  const a = new Agent();
  const email = `cust-${RUN}@t.test`;
  // earlier failures (e.g. from other IPs) count for the account
  await prisma.loginHistory.createMany({ data: Array.from({ length: 10 }, () => ({ userId: ids.client, email, success: false, reason: "bad_credentials", ip: "203.0.113.9" })) });
  const r = await a.req("POST", "/auth/login", { email, password: PW });
  assert.equal(r.status, 429, "even the right password waits");
  assert.equal(r.json.code, "TOO_MANY_ATTEMPTS");
  await prisma.loginHistory.deleteMany({ where: { email } });
  assert.equal((await a.req("POST", "/auth/login", { email, password: PW })).status, 200);
});

test("a cookie-authenticated change without the app's header is refused (CSRF), refresh cookie included", async () => {
  const a = new Agent();
  await a.req("POST", "/auth/login", { email: `cust-${RUN}@t.test`, password: PW });
  assert.equal((await a.req("PUT", "/client/email-preferences", { marketing: false }, {})).status, 403);
  const onlyRefresh = new Agent();
  onlyRefresh.cookies = { cc_rt: a.cookies.cc_rt };
  assert.equal((await onlyRefresh.req("POST", "/auth/logout", {}, {})).status, 403, "logout forged from another site is refused");
  assert.equal((await a.req("PUT", "/client/email-preferences", { marketing: false })).status, 200);
});

test("staff HTML can't carry scripts", () => {
  const cases: [string, RegExp][] = [
    [`<p onclick="alert(1)">Hi</p>`, /onclick/i],
    [`<img src=x onerror=alert(1)>`, /onerror/i],
    [`<a href="javascript:alert(1)">x</a>`, /javascript:/i],
    [`<a href=" JaVaScRiPt:alert(1)">x</a>`, /javascript:/i],
    [`<scr<script>ipt>alert(1)</script>`, /<script/i],
    [`<svg/onload=alert(1)>`, /onload/i],
    [`<iframe src="https://evil.example"></iframe>`, /<iframe/i],
    [`<form action="https://evil.example"><input name=p></form>`, /<form|<input/i],
  ];
  for (const [html, bad] of cases) assert.doesNotMatch(stripActiveHtml(html), bad, html);
  const email = `<table width="600" style="margin:0"><tr><td>Hi {{firstName}} — <a href="https://crapplet.co.in/offer?x=1">See offer</a></td></tr></table>`;
  assert.equal(stripActiveHtml(email), email, "ordinary email HTML is untouched");
});
