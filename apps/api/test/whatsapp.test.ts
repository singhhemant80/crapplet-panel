/**
 * WhatsApp notifications: phone numbers, the HTTP gateway and Meta Cloud API payloads, opt-out,
 * and that passwords never go out on WhatsApp.
 *   npx tsx --test test/whatsapp.test.ts
 */
import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { prisma } from "../src/db";
import { closeQueues } from "../src/jobs/queues";
import { deliverWhatsapp, getWhatsappConfig, normalizePhone, notifyWhatsapp, saveWhatsappConfig } from "../src/modules/whatsapp/service";

const RUN = Date.now().toString(36);
let saved: unknown;
let server: http.Server;
let port = 0;
const received: { url: string; headers: http.IncomingHttpHeaders; body: string }[] = [];
let userId = "";

before(async () => {
  saved = (await prisma.setting.findUnique({ where: { key: "whatsapp" } }))?.value ?? null;
  server = http.createServer((req, res) => {
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", () => {
      received.push({ url: req.url ?? "", headers: req.headers, body: b });
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ success: true, id: `gw-${received.length}` }));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  port = (server.address() as { port: number }).port;
  const u = await prisma.user.create({ data: { email: `wa-${RUN}@t.test`, passwordHash: "x", firstName: "Asha", lastName: "K", phone: "098765 43210", type: "CLIENT", status: "ACTIVE", profile: { create: { country: "IN", state: "Madhya Pradesh", stateCode: "23" } } } });
  userId = u.id;
});

after(async () => {
  if (saved) await prisma.setting.update({ where: { key: "whatsapp" }, data: { value: saved as never } });
  else await prisma.setting.deleteMany({ where: { key: "whatsapp" } });
  server.close();
  await closeQueues().catch(() => undefined);
  await prisma.$disconnect();
});

const latest = () => prisma.whatsappMessage.findFirst({ where: { userId }, orderBy: { createdAt: "desc" } });

test("phone numbers are normalised to international format", () => {
  assert.equal(normalizePhone("9876543210"), "919876543210");
  assert.equal(normalizePhone("098765 43210"), "919876543210");
  assert.equal(normalizePhone("+91 98765-43210"), "919876543210");
  assert.equal(normalizePhone("+1 (415) 555-0100"), "14155550100");
  assert.equal(normalizePhone("0044 20 7946 0958"), "442079460958");
  assert.equal(normalizePhone("12345"), null);
  assert.equal(normalizePhone(""), null);
});

test("HTTP gateway: notification rendered, JSON-escaped, token in header, marked SENT", async () => {
  await saveWhatsappConfig({
    enabled: true,
    provider: "http",
    http: { url: `http://127.0.0.1:${port}/send?key={{token}}`, method: "POST", headers: '{"Content-Type": "application/json", "Authorization": "Bearer {{token}}"}', body: '{"to": "{{phone}}", "message": "{{message}}"}', successMatch: '"success":true' },
    events: { "invoice.created": { enabled: true, text: 'Hi {{name}}, invoice {{invoiceNumber}} for {{total}} is due {{dueDate}}.\nPay: {{payLink}} "quoted"' } },
    token: "tok-123",
  } as never);
  await notifyWhatsapp("invoice.created", userId, { name: "Asha", invoiceNumber: "PF-000123", invoiceId: "inv1", total: "₹1,180.00", dueDate: "15 Nov 2026" });
  const m = await latest();
  assert.ok(m, "message logged");
  assert.equal(m.to, "919876543210");
  assert.match(m.body, /^Hi Asha, invoice PF-000123 for ₹1,180.00 is due 15 Nov 2026\.\nPay: .*\/client\/invoices\/inv1 "quoted"$/);
  await deliverWhatsapp(m.id, {});
  const req = received.at(-1)!;
  assert.equal(req.url, "/send?key=tok-123");
  assert.equal(req.headers.authorization, "Bearer tok-123");
  const sent = JSON.parse(req.body);
  assert.equal(sent.to, "919876543210");
  assert.equal(sent.message, m.body, "newlines and quotes survive JSON escaping");
  const after = await prisma.whatsappMessage.findUniqueOrThrow({ where: { id: m.id } });
  assert.equal(after.status, "SENT");
  assert.equal(after.providerId, `gw-${received.length}`);
});

test("passwords never go out on WhatsApp, even if a template asks for them", async () => {
  await saveWhatsappConfig({ events: { "service.vps_ready": { enabled: true, text: "VPS {{hostname}} ready, IP {{ip}}, password {{password}} root {{rootPassword}}" } } } as never);
  await notifyWhatsapp("service.vps_ready", userId, { name: "Asha", hostname: "vps1.test", ip: "103.1.2.3", password: "S3cret!pass", rootPassword: "S3cret!pass", username: "root" });
  const m = await latest();
  assert.ok(m && m.event === "service.vps_ready");
  assert.ok(!m.body.includes("S3cret"), m.body);
  assert.match(m.body, /vps1\.test.*103\.1\.2\.3/);
});

test("nothing is sent when the client switched WhatsApp off, the event is off, or WhatsApp is off", async () => {
  const before = await prisma.whatsappMessage.count({ where: { userId } });
  await saveWhatsappConfig({ events: { "invoice.paid": { enabled: false, text: "x" } } } as never);
  await notifyWhatsapp("invoice.paid", userId, { name: "Asha" });
  await prisma.clientProfile.update({ where: { userId }, data: { whatsappNotifications: false } });
  await notifyWhatsapp("invoice.created", userId, { name: "Asha" });
  await prisma.clientProfile.update({ where: { userId }, data: { whatsappNotifications: true } });
  await saveWhatsappConfig({ enabled: false } as never);
  await notifyWhatsapp("invoice.created", userId, { name: "Asha" });
  await notifyWhatsapp("auth.password_reset", userId, { name: "Asha", link: "https://x" });
  assert.equal(await prisma.whatsappMessage.count({ where: { userId } }), before);
});

test("Meta Cloud API: approved template with parameters in order, bearer token", async () => {
  await saveWhatsappConfig({
    enabled: true,
    provider: "meta",
    meta: { phoneNumberId: "1234567890", apiVersion: "v21.0" },
    events: { "invoice.overdue": { enabled: true, text: "fallback", metaTemplate: "invoice_overdue", metaLanguage: "en_US", metaParams: "name, invoiceNumber, total" } },
    token: "EAAG-test",
  } as never);
  await notifyWhatsapp("invoice.overdue", userId, { name: "Asha", invoiceNumber: "PF-9", total: "₹500.00", dueDate: "1 Nov" });
  const m = await latest();
  const real = globalThis.fetch;
  let captured: { url: string; init: RequestInit } | null = null;
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    captured = { url: String(url), init };
    return new Response(JSON.stringify({ messages: [{ id: "wamid.ABC" }] }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  try {
    const cfg = await getWhatsappConfig();
    assert.equal(cfg.provider, "meta");
    await deliverWhatsapp(m!.id, { name: "Asha", invoiceNumber: "PF-9", total: "₹500.00" });
  } finally {
    globalThis.fetch = real;
  }
  assert.ok(captured);
  const c = captured as unknown as { url: string; init: RequestInit };
  assert.equal(c.url, "https://graph.facebook.com/v21.0/1234567890/messages");
  assert.equal((c.init.headers as Record<string, string>).Authorization, "Bearer EAAG-test");
  const body = JSON.parse(String(c.init.body));
  assert.equal(body.type, "template");
  assert.equal(body.template.name, "invoice_overdue");
  assert.equal(body.template.language.code, "en_US");
  assert.deepEqual(body.template.components[0].parameters.map((p: { text: string }) => p.text), ["Asha", "PF-9", "₹500.00"]);
  const after = await prisma.whatsappMessage.findUniqueOrThrow({ where: { id: m!.id } });
  assert.equal(after.status, "SENT");
  assert.equal(after.providerId, "wamid.ABC");
});

test("a provider error marks the message FAILED with the reason", async () => {
  await saveWhatsappConfig({ provider: "http", http: { url: `http://127.0.0.1:${port}/send`, successMatch: "NEVER-MATCHES" } } as never);
  const msg = await prisma.whatsappMessage.create({ data: { userId, to: "919876543210", event: "manual", body: "hello" } });
  await assert.rejects(deliverWhatsapp(msg.id));
  const m = await prisma.whatsappMessage.findUniqueOrThrow({ where: { id: msg.id } });
  assert.equal(m.status, "FAILED");
  assert.match(m.error ?? "", /didn't contain "NEVER-MATCHES"/);
});
