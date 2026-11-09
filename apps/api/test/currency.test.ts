/**
 * Multi-currency (USD) end-to-end: catalogue conversion, overseas checkout (zero-rated export),
 * gateway filtering by currency, currency-checked webhook settlement, USD wallet top-ups.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { createApp } from "../src/app";
import { prisma } from "../src/db";
import { config } from "../src/config";
import { encryptJson, hmacHex } from "../src/lib/crypto";
import { updateSettings, clearSettingsCache } from "../src/lib/settings";
import { clearCurrencyCache, convertFromInr, roundMinor } from "../src/lib/currency";
import { closeQueues } from "../src/jobs/queues";

const RUN = Date.now().toString(36);
let base = "";
let server: http.Server;
const createdPricing: string[] = [];

class Session {
  cookies: Record<string, string> = {};
  async req(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
    const res = await fetch(base + path, {
      method,
      headers: { "Content-Type": "application/json", "X-Requested-With": "crapplet", Cookie: Object.entries(this.cookies).map(([k, v]) => `${k}=${v}`).join("; "), ...headers },
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

before(async () => {
  config.provisionDryRun = true;
  server = createApp().listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  await prisma.currency.upsert({ where: { code: "USD" }, update: { rate: 0.012, enabled: true }, create: { code: "USD", prefix: "$", rate: 0.012, enabled: true } });
  await updateSettings("currency", { autoConvert: true, markupPct: 0, rounding: "nice99" });
  clearCurrencyCache();
  clearSettingsCache();
  // explicit USD price for one cycle, so we test "explicit wins over conversion"
  const p = await prisma.product.findUniqueOrThrow({ where: { slug: "shared-basic" } });
  await prisma.productPricing.deleteMany({ where: { productId: p.id, currency: "USD" } });
  const row = await prisma.productPricing.create({ data: { productId: p.id, currency: "USD", cycle: "ANNUAL", price: 999, setupFee: 0 } });
  createdPricing.push(row.id);
  // gateways: Stripe + PayPal take USD, UPI is INR-only
  await prisma.paymentGateway.upsert({ where: { code: "stripe" }, update: { enabled: true, configEnc: encryptJson({ secretKey: "sk_test", webhookSecret: "whsec_" + RUN }), publicConfig: {} }, create: { code: "stripe", name: "Stripe", enabled: true, configEnc: encryptJson({ secretKey: "sk_test", webhookSecret: "whsec_" + RUN }) } });
  await prisma.paymentGateway.upsert({ where: { code: "paypal" }, update: { enabled: true, configEnc: encryptJson({ clientId: "c", clientSecret: "s" }) }, create: { code: "paypal", name: "PayPal", enabled: true, configEnc: encryptJson({ clientId: "c", clientSecret: "s" }) } });
  await prisma.paymentGateway.upsert({ where: { code: "upi" }, update: { enabled: true, publicConfig: { vpa: "crapplet@upi" } }, create: { code: "upi", name: "UPI", enabled: true, publicConfig: { vpa: "crapplet@upi" } } });
});

after(async () => {
  await prisma.productPricing.deleteMany({ where: { id: { in: createdPricing } } });
  server.close();
  await closeQueues().catch(() => undefined);
  await prisma.$disconnect();
});

test("conversion: rate, markup and rounding modes", () => {
  const usd = { code: "USD", rate: 0.012 };
  assert.equal(convertFromInr(54900, usd, { markupPct: 0, rounding: "cent" }), 659); // ₹549 → $6.59
  assert.equal(convertFromInr(54900, usd, { markupPct: 0, rounding: "nice99" }), 699); // → $6.99
  assert.equal(convertFromInr(54900, usd, { markupPct: 0, rounding: "whole" }), 700); // → $7.00
  assert.equal(convertFromInr(54900, usd, { markupPct: 10, rounding: "cent" }), 725); // +10% fees
  assert.equal(roundMinor(4, "nice99"), 99, "never below $0.99");
  assert.equal(convertFromInr(54900, { code: "INR", rate: 1 }, { markupPct: 50, rounding: "whole" }), 54900, "INR is never converted");
});

test("catalogue: prices in INR and USD (explicit price wins, others auto-converted)", async () => {
  const s = new Session();
  const r = await s.req("GET", "/api/catalog/products/shared-basic");
  assert.equal(r.status, 200);
  const pr = r.body.product.pricing as { cycle: string; currency: string; price: number; converted?: boolean }[];
  const inrMonthly = pr.find((x) => x.currency === "INR" && x.cycle === "MONTHLY")!;
  const usdMonthly = pr.find((x) => x.currency === "USD" && x.cycle === "MONTHLY")!;
  const usdAnnual = pr.find((x) => x.currency === "USD" && x.cycle === "ANNUAL")!;
  assert.ok(inrMonthly && usdMonthly && usdAnnual);
  assert.equal(usdMonthly.price, convertFromInr(inrMonthly.price, { code: "USD", rate: 0.012 }, { markupPct: 0, rounding: "nice99" }));
  assert.equal(usdMonthly.converted, true);
  assert.equal(usdAnnual.price, 999);
  assert.equal(usdAnnual.converted, false);
  const cur = await s.req("GET", "/api/catalog/currencies");
  assert.deepEqual(cur.body.currencies.map((c: any) => c.code).sort(), ["INR", "USD"]);
});

test("overseas customer: USD account, zero-rated export invoice with FX rate, USD-only gateways, currency-checked webhook", async () => {
  const s = new Session();
  const reg = await s.req("POST", "/api/auth/register", {
    email: `us-${RUN}@t.test`, password: "Test@12345", firstName: "Ana", lastName: "Smith", phone: "+14155550100",
    address1: "1 Market St", city: "San Francisco", state: "California", country: "US", postcode: "94105",
  });
  assert.equal(reg.status, 201, JSON.stringify(reg.body));
  const me = await s.req("GET", "/api/auth/me");
  assert.equal(me.body.user.profile.currency, "USD", "non-Indian sign-ups bill in USD");

  // even if the browser asks for INR, a signed-in USD account is priced in USD
  const cart = { items: [{ productId: "shared-basic", cycle: "ANNUAL", hostname: `us-${RUN}.example.com` }], domains: [], currency: "INR" };
  const q = await s.req("POST", "/api/catalog/cart/quote", cart);
  assert.equal(q.status, 200, JSON.stringify(q.body));
  assert.equal(q.body.currency, "USD");
  assert.equal(q.body.totals.total, 999, "explicit $9.99 annual price, no GST");
  assert.equal(q.body.totals.taxTotal, 0);

  const co = await s.req("POST", "/api/catalog/cart/checkout", { ...cart, acceptTos: true });
  assert.equal(co.status, 201, JSON.stringify(co.body));
  const inv = await prisma.invoice.findUniqueOrThrow({ where: { id: co.body.invoiceId } });
  assert.equal(inv.currency, "USD");
  assert.equal(inv.total, 999);
  assert.equal(inv.taxTotal, 0);
  assert.equal(inv.placeOfSupplyCode, "96", "export of services");
  assert.ok(Math.abs(inv.exchangeRate - 1 / 0.012) < 1e-6, "INR per USD stored on the invoice");
  const svc = await prisma.service.findFirstOrThrow({ where: { orderId: co.body.orderId } });
  assert.equal(svc.currency, "USD");
  assert.equal(svc.recurringAmount, 999, "renewals stay in USD");

  // only gateways that can charge USD are offered
  const m = await s.req("GET", "/api/payments/methods?currency=USD");
  const codes = m.body.methods.map((x: any) => x.code);
  assert.ok(codes.includes("stripe") && codes.includes("paypal"), JSON.stringify(codes));
  assert.ok(!codes.includes("upi"), "UPI is INR-only");
  const upi = await s.req("POST", "/api/payments/start", { invoiceId: inv.id, gateway: "upi" });
  assert.equal(upi.status, 400);
  assert.match(upi.body.error, /USD/);

  // a Stripe webhook that charged INR must NOT settle a USD invoice
  const intent = await prisma.paymentIntent.create({ data: { userId: inv.userId, invoiceId: inv.id, gateway: "stripe", amount: 999, currency: "USD", gatewayOrderId: `cs_${RUN}` } });
  const sendStripe = async (currency: string, evtId: string) => {
    const payload = JSON.stringify({ id: evtId, type: "checkout.session.completed", data: { object: { id: `cs_${RUN}`, client_reference_id: intent.id, payment_intent: `pi_${evtId}`, amount_total: 999, currency, payment_status: "paid" } } });
    const t = Math.floor(Date.now() / 1000);
    const sig = hmacHex("sha256", "whsec_" + RUN, `${t}.${payload}`);
    return new Session().req("POST", "/api/webhooks/stripe", payload, { "Stripe-Signature": `t=${t},v1=${sig}` });
  };
  const wrong = await sendStripe("inr", `evt_inr_${RUN}`);
  assert.notEqual(wrong.status, 200, "currency mismatch rejected");
  assert.equal((await prisma.invoice.findUniqueOrThrow({ where: { id: inv.id } })).status, "UNPAID");

  const ok = await sendStripe("usd", `evt_usd_${RUN}`);
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  const paid = await prisma.invoice.findUniqueOrThrow({ where: { id: inv.id }, include: { transactions: true } });
  assert.equal(paid.status, "PAID");
  assert.ok(paid.number, "tax invoice number assigned");
  assert.equal(paid.transactions.find((t) => t.type === "PAYMENT")?.currency, "USD");

  // wallet top-ups in USD: $5 minimum, invoice in USD
  const small = await s.req("POST", "/api/client/credit/topup", { amount: 400 });
  assert.equal(small.status, 400);
  const top = await s.req("POST", "/api/client/credit/topup", { amount: 2000 });
  assert.equal(top.status, 201, JSON.stringify(top.body));
  assert.equal((await prisma.invoice.findUniqueOrThrow({ where: { id: top.body.invoiceId } })).currency, "USD");

  // PDF renders for an export invoice
  const pdf = await fetch(`${base}/api/client/invoices/${inv.id}/pdf`, { headers: { Cookie: Object.entries(s.cookies).map(([k, v]) => `${k}=${v}`).join("; ") } });
  assert.equal(pdf.status, 200);
  assert.equal(pdf.headers.get("content-type"), "application/pdf");
});

test("Indian customer keeps INR + GST even when the browser picked USD", async () => {
  const s = new Session();
  const reg = await s.req("POST", "/api/auth/register", {
    email: `in-${RUN}@t.test`, password: "Test@12345", firstName: "Ravi", lastName: "K", phone: "+919000000001",
    address1: "1 MG Road", city: "Pune", state: "Maharashtra", country: "IN", postcode: "411001",
  });
  assert.equal(reg.status, 201, JSON.stringify(reg.body));
  const q = await s.req("POST", "/api/catalog/cart/quote", { items: [{ productId: "shared-basic", cycle: "MONTHLY", hostname: `in-${RUN}.example.com` }], domains: [], currency: "USD" });
  assert.equal(q.status, 200, JSON.stringify(q.body));
  assert.equal(q.body.currency, "INR");
  assert.ok(q.body.totals.igst > 0, "inter-state IGST for Maharashtra");
  // and can't switch an invoiced account's currency themselves
  const prof = (await s.req("GET", "/api/auth/me")).body.user.profile;
  const sw = await s.req("PUT", "/api/client/profile", { ...prof, firstName: "Ravi", lastName: "K", phone: "+919000000001", currency: "USD" });
  assert.equal(sw.status, 200, "no invoices yet → allowed, but India stays INR");
  assert.equal((await s.req("GET", "/api/auth/me")).body.user.profile.currency, "INR");
});
