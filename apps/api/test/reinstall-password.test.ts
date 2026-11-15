/**
 * Reinstall with a password chosen in the reinstall window (client or staff); otherwise a generated one.
 * The chosen password reaches the hypervisor and the service, and is never in the audit log or the job in plain text.
 *   npx tsx --test test/reinstall-password.test.ts
 */
import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { prisma } from "../src/db";
import { decrypt, encrypt } from "../src/lib/crypto";
import { VirtualizorClient } from "../src/modules/provisioning/virtualizor";
import { runProvisionAction } from "../src/modules/provisioning/provisioner";
import { closeQueues, provisioningQueue } from "../src/jobs/queues";

const RUN = Date.now().toString(36);
const PW = "Client@12345";
let base = "";
let app: http.Server;
const ids: Record<string, string> = {};
const rebuilt: { vpsid: string; osId: number; pass: string }[] = [];

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
const client = new Agent();
const staff = new Agent();

/** the provisioning job queued for this service (the worker isn't running in tests) */
async function lastJob(serviceId: string) {
  const jobs = await provisioningQueue().getJobs(["waiting", "delayed", "prioritized", "paused"], 0, 200, false);
  return jobs.filter((j) => j.data.serviceId === serviceId && j.data.action === "reinstall").sort((a, b) => b.timestamp - a.timestamp)[0];
}

before(async () => {
  const { createApp } = await import("../src/app");
  app = createApp().listen(0);
  base = `http://127.0.0.1:${(app.address() as AddressInfo).port}/api`;
  const bcrypt = (await import("bcryptjs")).default;
  const hash = await bcrypt.hash(PW, 10);
  ids.server = (await prisma.server.create({ data: { name: `rp-${RUN}`, type: "VIRTUALIZOR", hostname: "rp.invalid", apiUser: "k", apiSecretEnc: encrypt("p") } })).id;
  ids.os = (await prisma.osTemplate.create({ data: { name: "Ubuntu 24.04", remoteName: `ubuntu-24.04-${RUN}`, source: "virtualizor", virtualizorServerId: ids.server, virtualizorOsId: 1001, family: "linux" } })).id;
  ids.win = (await prisma.osTemplate.create({ data: { name: "Windows Server 2022", remoteName: `win2022-${RUN}`, source: "virtualizor", virtualizorServerId: ids.server, virtualizorOsId: 1002, family: "windows" } })).id;
  const g = await prisma.productGroup.create({ data: { name: `QA rp ${RUN}`, slug: `qa-rp-${RUN}` } });
  ids.group = g.id;
  ids.product = (await prisma.product.create({ data: { groupId: g.id, name: `QA VPS ${RUN}`, slug: `qa-rp-${RUN}`, type: "VPS_LINUX", provisioner: "VIRTUALIZOR", autoSetup: "MANUAL" } })).id;
  await prisma.productOs.createMany({ data: [{ productId: ids.product, osTemplateId: ids.os }, { productId: ids.product, osTemplateId: ids.win }] });
  ids.user = (await prisma.user.create({ data: { email: `rp-${RUN}@t.test`, passwordHash: hash, firstName: "R", type: "CLIENT", status: "ACTIVE", emailVerifiedAt: new Date() } })).id;
  ids.role = (await prisma.role.create({ data: { name: `QA rp ${RUN}`, permissions: ["*"] } })).id;
  ids.staff = (await prisma.user.create({ data: { email: `rp-staff-${RUN}@t.test`, passwordHash: hash, firstName: "S", type: "STAFF", status: "ACTIVE", roleId: ids.role } })).id;
  ids.svc = (await prisma.service.create({ data: { userId: ids.user, productId: ids.product, status: "ACTIVE", billingCycle: "MONTHLY", firstAmount: 39900, recurringAmount: 39900, currency: "INR", serverId: ids.server, remoteId: "4242", hostname: `rp-${RUN}.test`, osTemplateId: ids.os, passwordEnc: encrypt("Old-Pass-123") } })).id;
  VirtualizorClient.prototype.rebuild = async function (this: { creds: { host: string } }, vpsid: string, osId: number, pass: string) {
    if (this.creds.host !== "rp.invalid") throw new Error("unreachable in tests");
    rebuilt.push({ vpsid, osId, pass });
    return { done: 1 } as never;
  } as never;
  assert.equal((await client.req("POST", "/auth/login", { email: `rp-${RUN}@t.test`, password: PW })).status, 200);
  assert.equal((await staff.req("POST", "/auth/login", { email: `rp-staff-${RUN}@t.test`, password: PW })).status, 200);
  assert.equal((await staff.req("POST", "/auth/reauth", { password: PW })).status, 200);
});

after(async () => {
  app.close();
  for (const j of await provisioningQueue().getJobs(["waiting", "delayed", "prioritized", "paused"], 0, 500, false)) if (j.data.serviceId === ids.svc) await j.remove().catch(() => undefined);
  await prisma.provisioningLog.deleteMany({ where: { serviceId: ids.svc } });
  await prisma.activityLog.deleteMany({ where: { OR: [{ actorId: { in: [ids.user, ids.staff] } }, { userId: ids.user }] } }).catch(() => undefined);
  await prisma.loginHistory.deleteMany({ where: { userId: { in: [ids.user, ids.staff] } } }).catch(() => undefined);
  await prisma.session.deleteMany({ where: { userId: { in: [ids.user, ids.staff] } } });
  await prisma.service.deleteMany({ where: { id: ids.svc } });
  await prisma.user.deleteMany({ where: { id: { in: [ids.user, ids.staff] } } });
  await prisma.role.deleteMany({ where: { id: ids.role } });
  await prisma.productOs.deleteMany({ where: { productId: ids.product } });
  await prisma.product.deleteMany({ where: { id: ids.product } });
  await prisma.productGroup.deleteMany({ where: { id: ids.group } });
  await prisma.osTemplate.deleteMany({ where: { virtualizorServerId: ids.server } });
  await prisma.server.deleteMany({ where: { id: ids.server } });
  await closeQueues().catch(() => undefined);
  await prisma.$disconnect();
});

test("customer reinstalls with their own password: queued encrypted, used on the VPS and saved", async () => {
  const mine = "My-Own-Pass-2026";
  const r = await client.req("POST", `/client/services/${ids.svc}/action`, { action: "reinstall", osTemplateId: ids.os, confirm: "REINSTALL", password: mine });
  assert.equal(r.status, 202, JSON.stringify(r.json));
  const job = await lastJob(ids.svc);
  assert.ok(job, "job queued");
  assert.ok(!JSON.stringify(job.data).includes(mine), "never in plain text in the queue");
  assert.equal(decrypt(String(job.data.params.passwordEnc)), mine);
  await runProvisionAction(ids.svc, "reinstall", job.data.params);
  assert.equal(rebuilt.at(-1)?.pass, mine);
  const s = await prisma.service.findUniqueOrThrow({ where: { id: ids.svc } });
  assert.equal(decrypt(s.passwordEnc!), mine);
  assert.equal(s.username, "root");
});

test("a weak password is refused with a clear message", async () => {
  const r = await client.req("POST", `/client/services/${ids.svc}/action`, { action: "reinstall", osTemplateId: ids.os, confirm: "REINSTALL", password: "short" });
  assert.equal(r.status, 400);
  assert.match(r.json.error, /Root password must be at least 10 characters/);
});

test("staff reinstall (Windows) with a chosen password; the audit log doesn't contain it", async () => {
  await new Promise((r) => setTimeout(r, 10)); // different job timestamp
  const chosen = "Staff-Set-Pass-77";
  const r = await staff.req("POST", `/admin/services/${ids.svc}/action`, { action: "reinstall", osTemplateId: ids.win, password: chosen });
  assert.equal(r.status, 202, JSON.stringify(r.json));
  const job = await lastJob(ids.svc);
  assert.equal(decrypt(String(job!.data.params.passwordEnc)), chosen);
  await runProvisionAction(ids.svc, "reinstall", job!.data.params);
  assert.equal(rebuilt.at(-1)?.pass, chosen);
  assert.equal(rebuilt.at(-1)?.osId, 1002);
  assert.equal((await prisma.service.findUniqueOrThrow({ where: { id: ids.svc } })).username, "Administrator");
  const logs = await prisma.activityLog.findMany({ where: { actorId: ids.staff, action: "service.reinstall" } });
  assert.ok(logs.length);
  assert.ok(!JSON.stringify(logs).includes(chosen));
  assert.equal((logs[0].details as any).passwordChosen, true);
});

test("without a password a strong one is generated", async () => {
  await runProvisionAction(ids.svc, "reinstall", { osTemplateId: ids.os });
  const pass = rebuilt.at(-1)!.pass;
  assert.ok(pass.length >= 16);
  assert.notEqual(pass, "Staff-Set-Pass-77");
  assert.equal(decrypt((await prisma.service.findUniqueOrThrow({ where: { id: ids.svc } })).passwordEnc!), pass);
});
