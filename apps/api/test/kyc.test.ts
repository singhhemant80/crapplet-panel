/**
 * Aadhaar KYC through Cashfree SecureID (DigiLocker), against a stand-in Cashfree.
 *   npx tsx --test test/kyc.test.ts
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
let fake: http.Server;
const cf = { status: "PENDING", name: "Rahul Kumar Sharma", uid: "xxxxxxxx5647", calls: [] as string[] };
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
const CPW = "Client@12345";

before(async () => {
  fake = http.createServer((req, res) => {
    cf.calls.push(`${req.method} ${req.url} ${req.headers["x-client-id"]}`);
    res.setHeader("Content-Type", "application/json");
    if (req.method === "POST") return res.end(JSON.stringify({ reference_id: 77, url: "https://digilocker.example/consent", status: "PENDING" }));
    if (req.url?.startsWith("/digilocker/document/AADHAAR")) return res.end(JSON.stringify({ status: "SUCCESS", name: cf.name, uid: cf.uid, dob: "02-02-1995", gender: "M", split_address: { state: "Madhya Pradesh", pincode: "474011" }, photo_link: "BASE64", xml_file: "https://x" }));
    return res.end(JSON.stringify({ status: cf.status }));
  }).listen(0);
  process.env.CASHFREE_KYC_BASE = `http://127.0.0.1:${(fake.address() as AddressInfo).port}`;
  const { createApp } = await import("../src/app");
  app = createApp().listen(0);
  base = `http://127.0.0.1:${(app.address() as AddressInfo).port}/api`;
  const bcrypt = (await import("bcryptjs")).default;
  ids.role = (await prisma.role.create({ data: { name: `QA kyc ${RUN}`, permissions: ["*"] } })).id;
  ids.staff = (await prisma.user.create({ data: { email: `kyc-staff-${RUN}@t.test`, passwordHash: await bcrypt.hash(PW, 10), firstName: "S", type: "STAFF", status: "ACTIVE", roleId: ids.role } })).id;
  ids.user = (await prisma.user.create({ data: { email: `kyc-${RUN}@t.test`, passwordHash: await bcrypt.hash(CPW, 10), firstName: "Rahul", lastName: "Sharma", type: "CLIENT", status: "ACTIVE", profile: { create: { currency: "INR", address1: "x" } } } })).id;
  assert.equal((await staff.req("POST", "/auth/login", { email: `kyc-staff-${RUN}@t.test`, password: PW })).status, 200);
  assert.equal((await staff.req("POST", "/auth/reauth", { password: PW })).status, 200);
  assert.equal((await client.req("POST", "/auth/login", { email: `kyc-${RUN}@t.test`, password: CPW })).status, 200);
  ids.oldKyc = JSON.stringify((await prisma.setting.findUnique({ where: { key: "kyc" } }))?.value ?? null);
});

after(async () => {
  app.close();
  fake.close();
  const old = JSON.parse(ids.oldKyc);
  if (old) await prisma.setting.update({ where: { key: "kyc" }, data: { value: old } });
  else await prisma.setting.deleteMany({ where: { key: "kyc" } });
  await prisma.kycVerification.deleteMany({ where: { userId: ids.user } });
  await prisma.emailLog.deleteMany({ where: { userId: ids.user } }).catch(() => undefined);
  await prisma.activityLog.deleteMany({ where: { OR: [{ actorId: { in: [ids.staff, ids.user] } }, { userId: ids.user }] } }).catch(() => undefined);
  await prisma.loginHistory.deleteMany({ where: { userId: { in: [ids.staff, ids.user] } } }).catch(() => undefined);
  await prisma.session.deleteMany({ where: { userId: { in: [ids.staff, ids.user] } } });
  await prisma.clientProfile.deleteMany({ where: { userId: ids.user } });
  await prisma.user.deleteMany({ where: { id: { in: [ids.user, ids.staff] } } });
  await prisma.role.deleteMany({ where: { id: ids.role } });
  await closeQueues().catch(() => undefined);
  await prisma.$disconnect();
});

const setKyc = (body: object) => staff.req("PUT", "/admin/kyc/settings", body);

test("switched off: nothing is asked; can't switch on without credentials; the secret never comes back", async () => {
  await prisma.setting.deleteMany({ where: { key: "kyc" } });
  const { clearKycCache, kycNeededFor } = await import("../src/modules/kyc/kyc");
  clearKycCache();
  assert.equal(await kycNeededFor(ids.user, ["VPS_LINUX"]), false);
  assert.equal((await client.req("POST", "/client/kyc/start")).status, 400);
  assert.equal((await setKyc({ enabled: true })).status, 400);
  const r = await setKyc({ enabled: true, sandbox: true, clientId: "CF_ID", clientSecret: "supersecret1234", require: "servers" });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.settings.clientSecret, "••••••••1234");
  const stored = JSON.stringify((await prisma.setting.findUniqueOrThrow({ where: { key: "kyc" } })).value);
  assert.ok(!stored.includes("supersecret"), "secret stored encrypted");
  assert.equal((await setKyc({ clientSecret: "••••••••1234", require: "servers" })).status, 200, "masked secret keeps the old one");
  clearKycCache();
  assert.equal((await (await import("../src/modules/kyc/kyc")).getKycSettings()).clientSecret, "supersecret1234");
  assert.equal(await kycNeededFor(ids.user, ["VPS_LINUX"]), true);
  assert.equal(await kycNeededFor(ids.user, ["SHARED"]), false, "servers only");
});

test("DigiLocker flow: matching name → verified; only the last 4 digits are kept", async () => {
  const s = await client.req("POST", "/client/kyc/start");
  assert.equal(s.status, 200, JSON.stringify(s.json));
  assert.equal(s.json.url, "https://digilocker.example/consent");
  assert.ok(cf.calls.some((c) => c.startsWith("POST /digilocker CF_ID")));
  cf.status = "PENDING";
  let c = await client.req("POST", "/client/kyc/check", {});
  assert.equal(c.json.status, "PENDING");
  cf.status = "AUTHENTICATED";
  c = await client.req("POST", "/client/kyc/check", {});
  assert.equal(c.status, 200, JSON.stringify(c.json));
  assert.equal(c.json.status, "VERIFIED");
  const v = await prisma.kycVerification.findFirstOrThrow({ where: { userId: ids.user } });
  assert.equal(v.aadhaarLast4, "5647");
  assert.ok(!JSON.stringify(v).includes("BASE64"), "no photo stored");
  const { kycNeededFor } = await import("../src/modules/kyc/kyc");
  assert.equal(await kycNeededFor(ids.user, ["VPS_LINUX"]), false);
  assert.equal((await client.req("POST", "/client/kyc/start")).status, 409, "already verified");
});

test("a different name goes to review; staff approve it; exempt / require / reset work", async () => {
  assert.equal((await staff.req("POST", `/admin/clients/${ids.user}/kyc`, { action: "reset" })).status, 200);
  cf.name = "Priya Verma";
  cf.status = "AUTHENTICATED";
  assert.equal((await client.req("POST", "/client/kyc/start")).status, 200);
  const c = await client.req("POST", "/client/kyc/check", {});
  assert.equal(c.json.status, "REVIEW");
  const { kycNeededFor } = await import("../src/modules/kyc/kyc");
  assert.equal(await kycNeededFor(ids.user, ["VPS_LINUX"]), true, "review blocks server orders");
  assert.equal((await staff.req("POST", `/admin/clients/${ids.user}/kyc`, { action: "approve", note: "Checked PAN" })).status, 200);
  assert.equal((await prisma.clientProfile.findUniqueOrThrow({ where: { userId: ids.user } })).kycStatus, "VERIFIED");

  await staff.req("POST", `/admin/clients/${ids.user}/kyc`, { action: "reset" });
  assert.equal(await kycNeededFor(ids.user, ["SHARED"]), false);
  await staff.req("POST", `/admin/clients/${ids.user}/kyc`, { action: "require" });
  assert.equal(await kycNeededFor(ids.user, ["SHARED"]), true, "required for this customer");
  await staff.req("POST", `/admin/clients/${ids.user}/kyc`, { action: "exempt" });
  assert.equal(await kycNeededFor(ids.user, ["VPS_LINUX"]), false, "exempt wins");
  assert.equal((await staff.req("POST", `/admin/clients/${ids.user}/kyc`, { action: "verify" })).status, 400, "manual verify needs a note");
});

test("checkout is refused with KYC_REQUIRED when a server order needs verification", async () => {
  await staff.req("POST", `/admin/clients/${ids.user}/kyc`, { action: "unexempt" });
  await staff.req("POST", `/admin/clients/${ids.user}/kyc`, { action: "unrequire" });
  const p = await prisma.product.findFirst({ where: { type: "VPS_LINUX", hidden: false } });
  if (!p) return;
  const r = await client.req("POST", "/catalog/cart/checkout", { items: [{ productId: p.id, cycle: "MONTHLY" }], acceptTos: true });
  assert.equal(r.status, 403, JSON.stringify(r.json));
  assert.equal(r.json.error?.code ?? r.json.code, "KYC_REQUIRED");
  // switched off → no longer asked
  assert.equal((await setKyc({ enabled: false })).status, 200);
  const { kycNeededFor } = await import("../src/modules/kyc/kyc");
  assert.equal(await kycNeededFor(ids.user, ["VPS_LINUX"]), false);
});

test("name matching", async () => {
  const { nameScore } = await import("../src/modules/kyc/kyc");
  assert.ok(nameScore("Rahul Sharma", "Rahul Kumar Sharma") >= 80);
  assert.ok(nameScore("Hemant Singh", "HEMANT SINGH") >= 80);
  assert.ok(nameScore("R Sharma", "Rahul Sharma") >= 80);
  assert.ok(nameScore("Rahul Sharma", "Priya Verma") < 80);
  assert.ok(nameScore("Rahul Sharma", "Rohit Sharma") < 80);
});
