/**
 * Staff "Send verification email" on the client page, and the client's own resend.
 *   npx tsx --test test/verify-email.test.ts
 */
import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { prisma } from "../src/db";
import { emailQueue, closeQueues } from "../src/jobs/queues";

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
const queued = async (to: string) => (await emailQueue().getJobs(["waiting", "delayed", "prioritized", "paused"], 0, 1000, false)).filter((j) => j.data.to === to && j.data.template === "auth.verify_email");

before(async () => {
  const { createApp } = await import("../src/app");
  app = createApp().listen(0);
  base = `http://127.0.0.1:${(app.address() as AddressInfo).port}/api`;
  const bcrypt = (await import("bcryptjs")).default;
  ids.role = (await prisma.role.create({ data: { name: `QA ve ${RUN}`, permissions: ["*"] } })).id;
  ids.staff = (await prisma.user.create({ data: { email: `ve-staff-${RUN}@t.test`, passwordHash: await bcrypt.hash(PW, 10), firstName: "S", type: "STAFF", status: "ACTIVE", roleId: ids.role } })).id;
  ids.user = (await prisma.user.create({ data: { email: `ve-${RUN}@t.test`, passwordHash: "x", firstName: "Ajju", type: "CLIENT", status: "ACTIVE" } })).id;
  ids.verified = (await prisma.user.create({ data: { email: `ve-ok-${RUN}@t.test`, passwordHash: "x", firstName: "V", type: "CLIENT", status: "ACTIVE", emailVerifiedAt: new Date() } })).id;
  ids.rsUser = (await prisma.user.create({ data: { email: `ve-rs-${RUN}@t.test`, passwordHash: "x", firstName: "R", type: "CLIENT", status: "ACTIVE" } })).id;
  ids.reseller = (await prisma.reseller.create({ data: { userId: ids.rsUser, brandName: `RS ${RUN}`, status: "APPROVED" } })).id;
  ids.endUser = (await prisma.user.create({ data: { email: `ve-end-${RUN}@t.test`, passwordHash: "x", firstName: "E", type: "CLIENT", status: "ACTIVE", ownerResellerId: ids.reseller } })).id;
  assert.equal((await staff.req("POST", "/auth/login", { email: `ve-staff-${RUN}@t.test`, password: PW })).status, 200);
});

after(async () => {
  app.close();
  for (const j of await emailQueue().getJobs(["waiting", "delayed", "prioritized", "paused"], 0, 1000, false)) if (String(j.data.to).includes(RUN)) await j.remove().catch(() => undefined);
  const users = [ids.user, ids.verified, ids.endUser, ids.rsUser, ids.staff].filter(Boolean);
  await prisma.verificationToken.deleteMany({ where: { userId: { in: users } } });
  await prisma.activityLog.deleteMany({ where: { actorId: ids.staff } }).catch(() => undefined);
  await prisma.loginHistory.deleteMany({ where: { userId: ids.staff } }).catch(() => undefined);
  await prisma.session.deleteMany({ where: { userId: ids.staff } });
  await prisma.user.deleteMany({ where: { id: ids.endUser } });
  await prisma.reseller.deleteMany({ where: { id: ids.reseller } });
  await prisma.user.deleteMany({ where: { id: { in: users } } });
  await prisma.role.deleteMany({ where: { id: ids.role } });
  await closeQueues().catch(() => undefined);
  await prisma.$disconnect();
});

test("staff sends a verification link; the link verifies the customer", async () => {
  const r = await staff.req("POST", `/admin/clients/${ids.user}/send-verification`, {});
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const jobs = await queued(`ve-${RUN}@t.test`);
  assert.equal(jobs.length, 1);
  assert.equal(await prisma.verificationToken.count({ where: { userId: ids.user, type: "EMAIL_VERIFY" } }), 1);
  assert.equal((await prisma.activityLog.count({ where: { actorId: ids.staff, action: "client.verification_sent" } })), 1);

  // a second click straight away is held back
  assert.equal((await staff.req("POST", `/admin/clients/${ids.user}/send-verification`, {})).status, 429);
  assert.equal((await queued(`ve-${RUN}@t.test`)).length, 1);

  // the link from the email works
  const { openVars } = await import("../src/modules/email/mailer");
  const link = String(openVars(jobs[0].data.vars).link);
  const token = new URL(link).searchParams.get("token")!;
  assert.equal((await new Agent().req("POST", "/auth/verify-email", { token })).status, 200);
  assert.ok((await prisma.user.findUniqueOrThrow({ where: { id: ids.user } })).emailVerifiedAt);
  const detail = await staff.req("GET", `/admin/clients/${ids.user}`);
  assert.equal(detail.json.client.emailVerified, true);
});

test("already verified, reseller customers and non-clients are refused", async () => {
  assert.equal((await staff.req("POST", `/admin/clients/${ids.verified}/send-verification`, {})).status, 409);
  const end = await staff.req("POST", `/admin/clients/${ids.endUser}/send-verification`, {});
  assert.equal(end.status, 400);
  assert.equal((await queued(`ve-end-${RUN}@t.test`)).length, 0, "white-label: never emailed by us");
  assert.equal((await staff.req("GET", `/admin/clients/${ids.endUser}`)).json.client.resellerCustomer, true);
  assert.equal((await staff.req("POST", `/admin/clients/${ids.endUser}/password-reset`, {})).status, 400);
  assert.equal((await staff.req("POST", `/admin/clients/${ids.staff}/send-verification`, {})).status, 404);
});
