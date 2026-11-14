/**
 * End-to-end tests against a real PostgreSQL + Redis.
 *   DATABASE_URL=… REDIS_URL=… npm test -w apps/api
 * Uses its own unique emails so it can run against a seeded dev database.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import crypto from "node:crypto";
import { createApp } from "../src/app";
import { prisma } from "../src/db";
import { config } from "../src/config";
import { encryptJson, encrypt } from "../src/lib/crypto";
import { computeGst } from "../src/modules/billing/gst";
import { expandIpv4Cidr } from "../src/lib/ip";
import { expireReservations, importCidr, reserveIp, allocateIpsForService } from "../src/modules/ipam/service";
import { runProvisionAction } from "../src/modules/provisioning/provisioner";
import { generateRenewalInvoices, processSuspensions } from "../src/jobs/billing";
import { closeQueues } from "../src/jobs/queues";


/** Test IP ranges come from 200 fixed slots — remove a leftover from an earlier run so this run owns it. */
async function clearStaleRange(cidr: string) {
  const stale = await prisma.ipSubnet.findUnique({ where: { cidr } });
  if (!stale) return;
  await prisma.ipAddress.deleteMany({ where: { subnetId: stale.id } });
  await prisma.ipSubnet.delete({ where: { id: stale.id } });
}
const RUN = Date.now().toString(36);
let base = "";
let server: http.Server;

class Session {
  cookies: Record<string, string> = {};
  async req(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
    const res = await fetch(base + path, {
      method,
      headers: {
        "Content-Type": "application/json",
        "X-Requested-With": "crapplet",
        Cookie: Object.entries(this.cookies).map(([k, v]) => `${k}=${v}`).join("; "),
        ...headers,
      },
      body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
      redirect: "manual",
    });
    for (const c of res.headers.getSetCookie()) {
      const [kv] = c.split(";");
      const [k, v] = kv.split("=");
      if (v) this.cookies[k] = v;
      else delete this.cookies[k];
    }
    const text = await res.text();
    let json: any = null;
    try {
      json = JSON.parse(text);
    } catch {
      json = text;
    }
    return { status: res.status, body: json };
  }
}

async function registerClient(s: Session, email: string, state = "Madhya Pradesh") {
  return s.req("POST", "/api/auth/register", {
    email, password: "Test@12345", firstName: "Test", lastName: "User", phone: "+919000000000",
    address1: "1 Test Street", city: "Gwalior", state, country: "IN", postcode: "474001",
  });
}

let testServerId = "";

/** Run a provisioning action inline, or wait for a concurrently running worker to finish it. */
async function runOrWait(serviceId: string, action: Parameters<typeof runProvisionAction>[1], status: string, params: Record<string, unknown> = {}) {
  await runProvisionAction(serviceId, action, params).catch((e) => {
    if (!/already running/.test(String(e.message))) throw e;
  });
  for (let i = 0; i < 60; i++) {
    if ((await prisma.service.findUniqueOrThrow({ where: { id: serviceId } })).status === status) return;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`service did not reach ${status}`);
}
let productId = "";

before(async () => {
  config.provisionDryRun = true;
  server = createApp().listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  // isolated server + subnet for this run
  const loc = await prisma.location.upsert({ where: { code: "TST" }, update: {}, create: { name: "Test DC", code: "TST" } });
  const srv = await prisma.server.create({ data: { name: `test-${RUN}`, type: "PROXMOX", hostname: "pve.invalid", apiUser: "x@pve!t", apiSecretEnc: encrypt("s"), locationId: loc.id } });
  testServerId = srv.id;
  const third = (parseInt(RUN.slice(-2), 36) % 200) + 10;
  // the range is picked from 200 slots — clear a leftover from an earlier run so this run owns it
  const cidr = `198.18.${third}.0/28`;
  await clearStaleRange(cidr);
  await importCidr({ cidr, serverId: srv.id, gateway: `198.18.${third}.1` });
  const p = await prisma.product.findUniqueOrThrow({ where: { slug: "linux-vps-g2" } });
  productId = p.id;
  await prisma.productServer.create({ data: { productId, serverId: srv.id } });
});

after(async () => {
  await prisma.productServer.deleteMany({ where: { serverId: testServerId } });
  server.close();
  await closeQueues().catch(() => undefined);
  await prisma.$disconnect();
});

test("GST: intra-state CGST+SGST, inter-state IGST, export zero-rated, inclusive pricing", () => {
  const ctx = { enabled: true, rate: 18, inclusive: false, companyStateCode: "23", applyToForeign: false };
  const intra = computeGst([{ amount: 54900, taxable: true }], { ...ctx, customer: { country: "IN", stateCode: "23" } });
  assert.equal(intra.cgst, 4941);
  assert.equal(intra.sgst, 4941);
  assert.equal(intra.igst, 0);
  assert.equal(intra.total, 64782);
  const inter = computeGst([{ amount: 54900, taxable: true }], { ...ctx, customer: { country: "IN", gstin: "27AAACR5055K1Z5" } });
  assert.equal(inter.igst, 9882);
  assert.equal(inter.placeOfSupplyCode, "27");
  const exp = computeGst([{ amount: 10000, taxable: true }], { ...ctx, customer: { country: "US" } });
  assert.equal(exp.taxTotal, 0);
  assert.equal(exp.regime, "EXPORT");
  const incl = computeGst([{ amount: 11800, taxable: true }], { ...ctx, inclusive: true, customer: { country: "IN", stateCode: "07" } });
  assert.equal(incl.taxableAmount, 10000);
  assert.equal(incl.igst, 1800);
  assert.equal(incl.total, 11800);
});

test("CIDR expansion skips network, broadcast and gateway", () => {
  const r = expandIpv4Cidr("10.1.2.0/29");
  assert.equal(r.gateway, "10.1.2.1");
  assert.deepEqual(r.hosts, ["10.1.2.2", "10.1.2.3", "10.1.2.4", "10.1.2.5", "10.1.2.6"]);
});

test("IP reservation: 25 customers racing for one IP → exactly one wins", async () => {
  const ip = await prisma.ipAddress.findFirstOrThrow({ where: { serverId: testServerId, status: "AVAILABLE" } });
  const users = await Promise.all(
    Array.from({ length: 25 }, (_, i) => prisma.user.create({ data: { email: `race-${RUN}-${i}@t.test`, passwordHash: "x", firstName: "R", profile: { create: {} } } })),
  );
  const results = await Promise.allSettled(users.map((u) => reserveIp({ ipId: ip.id, userId: u.id, serverIds: [testServerId] })));
  const wins = results.filter((r) => r.status === "fulfilled");
  assert.equal(wins.length, 1, "exactly one reservation must succeed");
  assert.ok(results.filter((r) => r.status === "rejected").every((r) => (r as PromiseRejectedResult).reason.status === 409));
  const after = await prisma.ipAddress.findUniqueOrThrow({ where: { id: ip.id } });
  assert.equal(after.status, "RESERVED");

  // expiry releases it
  await prisma.ipAddress.update({ where: { id: ip.id }, data: { reservedUntil: new Date(Date.now() - 1000) } });
  const released = await expireReservations();
  assert.ok(released >= 1);
  assert.equal((await prisma.ipAddress.findUniqueOrThrow({ where: { id: ip.id } })).status, "AVAILABLE");
});

test("IP allocation: concurrent provisioning never hands out the same address twice", async () => {
  const u = await prisma.user.create({ data: { email: `alloc-${RUN}@t.test`, passwordHash: "x", firstName: "A", profile: { create: {} } } });
  const svcs = await Promise.all(
    Array.from({ length: 6 }, () => prisma.service.create({ data: { userId: u.id, productId, billingCycle: "MONTHLY", firstAmount: 1, recurringAmount: 1, serverId: testServerId } })),
  );
  const out = await Promise.all(svcs.map((s) => prisma.$transaction((tx) => allocateIpsForService(tx, { serviceId: s.id, userId: u.id, serverId: testServerId, count: 1 }))));
  const addrs = out.map((o) => o[0].address);
  assert.equal(new Set(addrs).size, addrs.length, `duplicate IPs allocated: ${addrs.join(", ")}`);
  // return them to the pool for later tests
  await prisma.ipAddress.updateMany({ where: { serviceId: { in: svcs.map((s) => s.id) } }, data: { status: "AVAILABLE", serviceId: null, isPrimary: false } });
  await prisma.service.deleteMany({ where: { id: { in: svcs.map((s) => s.id) } } });
});

test("full order flow: register → pick IP → checkout with GST + promo → signed webhook → provision → renew → suspend", async () => {
  // configure Razorpay with test secrets
  const webhookSecret = "whsec_test_" + RUN;
  await prisma.paymentGateway.update({ where: { code: "razorpay" }, data: { enabled: true, configEnc: encryptJson({ keyId: "rzp_test", keySecret: "sk_test", webhookSecret }) } });

  const s = new Session();
  const reg = await registerClient(s, `buyer-${RUN}@t.test`);
  assert.equal(reg.status, 201, JSON.stringify(reg.body));

  // catalogue by legacy pid (website links use pid=2)
  const prod = await s.req("GET", "/api/catalog/products/2");
  assert.equal(prod.status, 200);
  assert.equal(prod.body.product.slug, "linux-vps-g2");
  assert.ok(prod.body.product.allowIpSelection);

  const ips = await s.req("GET", `/api/catalog/products/linux-vps-g2/ips?serverId=${testServerId}`);
  assert.equal(ips.status, 200);
  const chosen = ips.body.ips[2];
  const resv = await s.req("POST", `/api/catalog/ips/${chosen.id}/reserve`, { productId: "linux-vps-g2" });
  assert.equal(resv.status, 200, JSON.stringify(resv.body));

  const other = new Session();
  await registerClient(other, `other-${RUN}@t.test`);
  const steal = await other.req("POST", `/api/catalog/ips/${chosen.id}/reserve`, { productId: "linux-vps-g2" });
  assert.equal(steal.status, 409, "another customer must not be able to reserve a held IP");

  const os = prod.body.product.osTemplates[0].id;
  const cart = { items: [{ productId: "linux-vps-g2", cycle: "MONTHLY", osTemplateId: os, hostname: `web-${RUN}.example.com`, ipId: chosen.id }], domains: [], promoCode: "SPECIAL15", currency: "INR" };
  const quote = await s.req("POST", "/api/catalog/cart/quote", cart);
  assert.equal(quote.status, 200, JSON.stringify(quote.body));
  // ₹549 − 15% = ₹466.65 → CGST 9% + SGST 9% (customer in MP, same state as Crapplet)
  assert.equal(quote.body.totals.taxableAmount, 46665);
  assert.equal(quote.body.totals.cgst, 4200);
  assert.equal(quote.body.totals.sgst, 4200);
  assert.equal(quote.body.totals.total, 55065);

  const co = await s.req("POST", "/api/catalog/cart/checkout", { ...cart, acceptTos: true });
  assert.equal(co.status, 201, JSON.stringify(co.body));
  const inv = await prisma.invoice.findUniqueOrThrow({ where: { id: co.body.invoiceId }, include: { items: true } });
  assert.equal(inv.total, 55065);
  assert.equal(inv.status, "UNPAID");
  assert.equal(inv.number, null, "tax invoice number is only assigned on payment");
  const svc = await prisma.service.findFirstOrThrow({ where: { orderId: co.body.orderId } });
  assert.equal(svc.status, "PENDING");
  const held = await prisma.ipAddress.findUniqueOrThrow({ where: { id: chosen.id } });
  assert.equal(held.reservedOrderId, co.body.orderId);

  // the browser "success" alone must not activate anything — only a verified webhook
  const intent = await prisma.paymentIntent.create({ data: { userId: inv.userId, invoiceId: inv.id, gateway: "razorpay", gatewayOrderId: `order_${RUN}`, amount: inv.total } });
  const payload = JSON.stringify({ event: "payment.captured", payload: { payment: { entity: { id: `pay_${RUN}`, order_id: `order_${RUN}`, amount: inv.total, status: "captured", fee: 1300 } } } });

  const bad = await s.req("POST", "/api/webhooks/razorpay", payload, { "X-Razorpay-Signature": "deadbeef", "X-Razorpay-Event-Id": `evt_${RUN}` });
  assert.equal(bad.status, 400, "forged webhook must be rejected");
  assert.equal((await prisma.invoice.findUniqueOrThrow({ where: { id: inv.id } })).status, "UNPAID");

  const sig = crypto.createHmac("sha256", webhookSecret).update(payload).digest("hex");
  const [w1, w2] = await Promise.all([
    s.req("POST", "/api/webhooks/razorpay", payload, { "X-Razorpay-Signature": sig, "X-Razorpay-Event-Id": `evt_${RUN}` }),
    s.req("POST", "/api/webhooks/razorpay", payload, { "X-Razorpay-Signature": sig, "X-Razorpay-Event-Id": `evt_${RUN}` }),
  ]);
  assert.ok([w1.status, w2.status].every((x) => x === 200), JSON.stringify([w1.body, w2.body]));
  const txns = await prisma.transaction.findMany({ where: { invoiceId: inv.id } });
  assert.equal(txns.length, 1, "duplicate webhook must not double-apply the payment");
  const paid = await prisma.invoice.findUniqueOrThrow({ where: { id: inv.id } });
  assert.equal(paid.status, "PAID");
  assert.match(paid.number ?? "", /^CC\/\d{4}-\d{2}\/\d{5}$/);
  assert.equal((await prisma.paymentIntent.findUniqueOrThrow({ where: { id: intent.id } })).status, "PAID");

  const queued = await prisma.service.findUniqueOrThrow({ where: { id: svc.id } });
  assert.equal(queued.status, "PROVISIONING");

  // run the provisioning job inline (dry-run hypervisor); if a running worker already picked it up, wait for it
  await runOrWait(svc.id, "create", "ACTIVE");
  const live = await prisma.service.findUniqueOrThrow({ where: { id: svc.id }, include: { ips: true } });
  assert.equal(live.status, "ACTIVE");
  assert.equal(live.ips.length, 1);
  assert.equal(live.ips[0].address, chosen.address, "customer must get the IP they picked");
  assert.equal(live.ips[0].status, "ALLOCATED");
  assert.ok(live.passwordEnc && live.remoteId);

  // client can see it and reveal credentials
  const detail = await s.req("GET", `/api/client/services/${svc.id}`);
  assert.equal(detail.status, 200);
  const pw = await s.req("POST", `/api/client/services/${svc.id}/reveal-password`);
  assert.equal(pw.status, 200);
  assert.ok(pw.body.password.length >= 16);
  // …but another client cannot
  assert.equal((await other.req("GET", `/api/client/services/${svc.id}`)).status, 404);

  // invoice PDF renders
  const pdf = await fetch(`${base}/api/client/invoices/${inv.id}/pdf`, { headers: { Cookie: Object.entries(s.cookies).map(([k, v]) => `${k}=${v}`).join("; ") } });
  assert.equal(pdf.status, 200);
  assert.equal(pdf.headers.get("content-type"), "application/pdf");
  assert.ok((await pdf.arrayBuffer()).byteLength > 5000);

  // renewal: due in 5 days → one renewal invoice, idempotent across runs
  await prisma.service.update({ where: { id: svc.id }, data: { nextDueDate: new Date(Date.now() - 6 * 86400000) } });
  // time passes: the month paid on the order ended at that due date
  await prisma.invoiceItem.updateMany({ where: { relId: svc.id, type: "SERVICE", periodStart: null }, data: { periodEnd: new Date(Date.now() - 6 * 86400000) } });
  await generateRenewalInvoices();
  await generateRenewalInvoices();
  const renewals = await prisma.invoiceItem.findMany({ where: { relId: svc.id, type: "SERVICE", periodStart: { not: null }, invoice: { status: "UNPAID" } } });
  assert.equal(renewals.length, 1);
  assert.equal(renewals[0].unitPrice, 54900, "promo was not recurring, renewal is at list price");

  // overdue beyond grace → suspension queued with reason
  const r = await processSuspensions();
  assert.ok(r.suspended >= 1);
  assert.match((await prisma.service.findUniqueOrThrow({ where: { id: svc.id } })).suspendReason ?? "", /^Overdue/);
  await runOrWait(svc.id, "suspend", "SUSPENDED", { reason: "Overdue invoice" });
  assert.equal((await prisma.service.findUniqueOrThrow({ where: { id: svc.id } })).status, "SUSPENDED");

  // suspended service: client power actions refused
  const act = await s.req("POST", `/api/client/services/${svc.id}/action`, { action: "reboot" });
  assert.equal(act.status, 409);

  // terminate releases the IP into quarantine
  await runOrWait(svc.id, "terminate", "TERMINATED", { notify: false });
  assert.equal((await prisma.ipAddress.findUniqueOrThrow({ where: { id: chosen.id } })).status, "QUARANTINED");
  await prisma.ipAddress.update({ where: { id: chosen.id }, data: { status: "AVAILABLE" } });
});

test("admin endpoints require staff and enforce permissions", async () => {
  const anon = new Session();
  assert.equal((await anon.req("GET", "/api/admin/dashboard")).status, 401);
  const client = new Session();
  await registerClient(client, `nosy-${RUN}@t.test`);
  assert.equal((await client.req("GET", "/api/admin/clients")).status, 403);
  // client login on admin portal is refused
  assert.equal((await new Session().req("POST", "/api/auth/login", { email: `nosy-${RUN}@t.test`, password: "Test@12345", portal: "admin" })).status, 401);

  const role = await prisma.role.findUniqueOrThrow({ where: { name: "Support Agent" } });
  const bcrypt = (await import("bcryptjs")).default;
  await prisma.user.create({ data: { type: "STAFF", email: `agent-${RUN}@t.test`, firstName: "Agent", passwordHash: await bcrypt.hash("Agent@12345", 10), roleId: role.id } });
  const agent = new Session();
  assert.equal((await agent.req("POST", "/api/auth/login", { email: `agent-${RUN}@t.test`, password: "Agent@12345", portal: "admin" })).status, 200);
  assert.equal((await agent.req("GET", "/api/admin/clients")).status, 200, "clients.view granted");
  assert.equal((await agent.req("GET", "/api/admin/gateways")).status, 403, "payments.manage not granted");
  assert.equal((await agent.req("GET", "/api/admin/dashboard")).status, 200);

  // CSRF: cookie-auth POST without the custom header is rejected
  const res = await fetch(`${base}/api/auth/logout`, { method: "POST", headers: { Cookie: Object.entries(agent.cookies).map(([k, v]) => `${k}=${v}`).join("; ") } });
  assert.equal(res.status, 403);
});

test("reseller API: API-key access is scoped to the reseller's own VPS", async () => {
  const s = new Session();
  await registerClient(s, `reseller-${RUN}@t.test`);
  const apply = await s.req("POST", "/api/client/reseller/apply", { brandName: `Brand ${RUN}` });
  assert.equal(apply.status, 201);
  assert.equal((await s.req("GET", "/api/reseller/dashboard")).status, 403, "pending resellers have no access");
  await prisma.reseller.update({ where: { id: apply.body.reseller.id }, data: { status: "APPROVED", discountPct: 10 } });
  const key = await s.req("POST", "/api/auth/api-keys", { name: "automation", scopes: ["reseller"] });
  assert.equal(key.status, 201);
  const api = (path: string, init: RequestInit = {}) => fetch(base + path, { ...init, headers: { Authorization: `Bearer ${key.body.key}`, "Content-Type": "application/json" } });
  const plans = await (await api("/api/v1/reseller/plans")).json();
  const g2 = plans.plans.find((p: any) => p.name === "Linux VPS G2");
  assert.ok(g2, "reseller-enabled plans are listed");
  const monthly = g2.prices.find((p: any) => p.cycle === "MONTHLY");
  assert.equal(monthly.wholesale, Math.round(Math.round(549 * 0.8) * 100 * 0.9));

  // no wallet balance → 402 with an invoice to pay
  const create = await api("/api/v1/reseller/vps", { method: "POST", body: JSON.stringify({ planId: g2.id, osTemplateId: g2.os[0].id, hostname: `rs-${RUN}.example.com` }) });
  assert.equal(create.status, 402);
  // top up wallet, retry → paid from credit
  const u = await prisma.user.findUniqueOrThrow({ where: { email: `reseller-${RUN}@t.test` } });
  await prisma.clientProfile.update({ where: { userId: u.id }, data: { creditBalance: 1000000 } });
  const create2 = await api("/api/v1/reseller/vps", { method: "POST", body: JSON.stringify({ planId: g2.id, osTemplateId: g2.os[0].id, hostname: `rs2-${RUN}.example.com` }) });
  assert.equal(create2.status, 201, await create2.text());

  // a different reseller cannot see it
  const other = await prisma.reseller.findFirst({ where: { status: "APPROVED", NOT: { userId: u.id } } });
  if (other) {
    const svcs = await prisma.service.findMany({ where: { resellerId: other.id } });
    assert.ok(svcs.every((x) => x.userId !== u.id));
  }
  const bad = await fetch(`${base}/api/v1/reseller/plans`, { headers: { Authorization: "Bearer ck_nope_nope" } });
  assert.equal(bad.status, 401);
});

test("Proxmox client: real REST flow against a mock PVE API (clone → config → resize → start)", async () => {
  const calls: string[] = [];
  const guests = new Map<string, string>();
  const mock = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const url = new URL(req.url!, "http://x");
      const p = url.pathname.replace("/api2/json", "");
      calls.push(`${req.method} ${p}`);
      assert.match(String(req.headers.authorization), /^PVEAPIToken=billing@pve!crapplet=secret-uuid$/);
      const send = (data: unknown, code = 200) => {
        res.writeHead(code, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ data }));
      };
      let m;
      if (p === "/nodes") return send([{ node: "pve1", status: "online", cpu: 0.2, maxcpu: 32, mem: 10e9, maxmem: 128e9, disk: 1e11, maxdisk: 2e12 }, { node: "pve2", status: "online", cpu: 0.95, maxcpu: 32, mem: 10e9, maxmem: 128e9, disk: 1e11, maxdisk: 2e12 }]);
      if (p === "/cluster/nextid") return send("123");
      if (p === "/cluster/resources") return send([{ id: "qemu/9000", type: "qemu", node: "pve1", vmid: 9000, template: 1 }]);
      if ((m = p.match(/^\/nodes\/(\w+)\/tasks\/(.+)\/status$/))) return send({ status: "stopped", exitstatus: "OK" });
      if ((m = p.match(/^\/nodes\/(\w+)\/qemu\/9000\/clone$/))) {
        const f = new URLSearchParams(body);
        assert.equal(f.get("newid"), "123");
        assert.equal(f.get("full"), "1");
        guests.set("123", "stopped");
        return send("UPID:pve1:clone");
      }
      if ((m = p.match(/^\/nodes\/pve1\/qemu\/123\/status\/current$/))) return guests.has("123") ? send({ status: guests.get("123"), cpu: 0, cpus: 2, mem: 0, maxmem: 4e9, disk: 0, maxdisk: 8e10, netin: 0, netout: 0, uptime: 0 }) : send(null, 500);
      if (p === "/nodes/pve1/qemu/123/config" && req.method === "POST") {
        const f = new URLSearchParams(body);
        assert.equal(f.get("cores"), "2");
        assert.equal(f.get("memory"), "4096");
        assert.match(f.get("ipconfig0") ?? "", /^ip=198\.18\.\d+\.\d+\/28,gw=198\.18\.\d+\.17$/);
        assert.equal(f.get("net0"), "virtio,bridge=vmbr0");
        assert.ok((f.get("cipassword") ?? "").length >= 16);
        return send(null);
      }
      if (p === "/nodes/pve1/qemu/123/config") return send({ scsi0: "local-lvm:vm-123-disk-0,size=10G" });
      if (p === "/nodes/pve1/qemu/123/resize") {
        assert.equal(new URLSearchParams(body).get("size"), "80G");
        return send(null);
      }
      if (p === "/nodes/pve1/qemu/123/status/start") {
        guests.set("123", "running");
        return send("UPID:pve1:start");
      }
      send(null, 501);
    });
  });
  await new Promise<void>((r) => mock.listen(0, r));
  const port = (mock.address() as AddressInfo).port;
  const srv = await prisma.server.create({ data: { name: `mockpve-${RUN}`, type: "PROXMOX", hostname: `http://127.0.0.1:${port}`, port, apiUser: "billing@pve!crapplet", apiSecretEnc: encrypt("secret-uuid"), verifyTls: false, maxCpuPct: 85 } });
  const third = (parseInt(RUN.slice(-3, -1), 36) % 200) + 20;
  await clearStaleRange(`198.18.${third}.16/28`);
  await importCidr({ cidr: `198.18.${third}.16/28`, serverId: srv.id, gateway: `198.18.${third}.17` });
  const u = await prisma.user.create({ data: { email: `pve-${RUN}@t.test`, passwordHash: "x", firstName: "P", profile: { create: {} } } });
  const os = await prisma.osTemplate.findFirstOrThrow({ where: { proxmoxKvmVmid: 9000 } });
  const svc = await prisma.service.create({ data: { userId: u.id, productId, billingCycle: "MONTHLY", firstAmount: 1, recurringAmount: 1, serverId: srv.id, osTemplateId: os.id, hostname: "mock.example.com", status: "PROVISIONING" } });
  config.provisionDryRun = false;
  try {
    await runProvisionAction(svc.id, "create");
  } finally {
    config.provisionDryRun = true;
    mock.close();
  }
  const done = await prisma.service.findUniqueOrThrow({ where: { id: svc.id }, include: { ips: true } });
  assert.equal(done.status, "ACTIVE");
  assert.equal(done.node, "pve1", "overloaded pve2 (95% CPU) must be skipped");
  assert.equal(done.remoteId, "123");
  assert.equal(done.ips.length, 1);
  assert.ok(calls.includes("POST /nodes/pve1/qemu/9000/clone"));
  assert.ok(calls.includes("PUT /nodes/pve1/qemu/123/resize"));
  assert.ok(calls.includes("POST /nodes/pve1/qemu/123/status/start"));
});
