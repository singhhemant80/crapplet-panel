/**
 * WHMCS importer tests using an in-memory WHMCS "database" shaped like the real tables.
 *   npx tsx --test test/whmcs-import.test.ts
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import bcrypt from "bcryptjs";
import crypto from "node:crypto";
import { prisma } from "../src/db";
import { decrypt } from "../src/lib/crypto";
import { verifyPassword } from "../src/lib/passwords";
import { whmcsDecrypt, whmcsEncrypt } from "../src/modules/migration/whmcs-crypto";
import { runWhmcsImport, DEFAULT_ENTITIES, ENTITIES, type SourceDb, type Row } from "../src/modules/migration/whmcs";
import { generateRenewalInvoices } from "../src/jobs/billing";
import { closeQueues } from "../src/jobs/queues";

import { CC, B, RUN, oct, id, fakeWhmcs } from "./whmcs-fixture";

function source(data: Record<string, Row[]>): SourceDb {
  return { table: async (n) => structuredClone(data[n] ?? []) as never, close: async () => {} };
}

after(async () => {
  await closeQueues().catch(() => undefined);
  await prisma.$disconnect();
});

test("WHMCS legacy crypto round-trips and rejects a wrong key", () => {
  const enc = whmcsEncrypt("Hunter2-long-password-over-twenty-bytes!", CC, Buffer.alloc(20, 7));
  assert.equal(whmcsDecrypt(enc, CC), "Hunter2-long-password-over-twenty-bytes!");
  assert.equal(whmcsDecrypt(enc, "wrong-hash"), null);
  assert.equal(whmcsDecrypt("", CC), null);
});

test("WHMCS import: dry run writes nothing, real run imports everything, re-run is idempotent", async () => {
  // the 198.19.<oct>.x range comes from 200 slots — free addresses left by an earlier run
  await prisma.ipAddress.deleteMany({ where: { address: { startsWith: `198.19.${oct}.` } } });
  const data = fakeWhmcs();
  const opts = { entities: [...ENTITIES], ccEncryptionHash: CC, overwritePricing: false };

  // ── dry run ──
  const dry = await runWhmcsImport(source(data), { ...opts, dryRun: true });
  assert.equal(dry.counts.clients.created, 2);
  assert.equal(dry.counts.services.created, 3);
  assert.equal(await prisma.user.count({ where: { email: `ravi-${RUN}@example.in` } }), 0, "dry run must roll back");
  assert.ok(dry.warnings.some((w) => /no valid email/.test(w.message)));

  // ── real run ──
  const res = await runWhmcsImport(source(data), { ...opts, dryRun: false });
  assert.equal(res.counts.clients.created, 2);
  assert.equal(res.counts.services.created, 3);
  assert.equal(res.counts.services.skipped, 1, "orphan service skipped");
  assert.equal(res.counts.invoices.created, 3);
  assert.equal(res.counts.transactions.created, 3);
  assert.equal(res.counts.tickets.created, 2, "guest ticket matched to a client by email");

  // clients + passwords
  const ravi = await prisma.user.findUniqueOrThrow({ where: { email: `ravi-${RUN}@example.in` }, include: { profile: true } });
  assert.equal(ravi.profile!.gstin, "23ABCDE1234F1Z5");
  assert.equal(ravi.profile!.stateCode, "23");
  assert.equal(ravi.profile!.creditBalance, 25050);
  assert.ok(ravi.passwordHash.startsWith("$2y$"));
  assert.equal(await verifyPassword(ravi, "Customer#2024"), true, "WHMCS bcrypt password works");
  assert.equal(await verifyPassword(ravi, "nope"), false);
  assert.ok(!(await prisma.user.findUniqueOrThrow({ where: { id: ravi.id } })).passwordHash.startsWith("$2y$"), "hash upgraded after login");
  const old = await prisma.user.findUniqueOrThrow({ where: { email: `old-${RUN}@example.in` } });
  assert.equal(await verifyPassword(old, "OldPass1"), true, "WHMCS md5:salt password works");

  // products: pid 2 matched to the seeded plan, unknown plan created with prices
  const g2 = await prisma.product.findUniqueOrThrow({ where: { legacyPid: 2 }, include: { servers: true } });
  assert.equal(g2.slug, "linux-vps-g2");
  const custom = await prisma.product.findUniqueOrThrow({ where: { legacyPid: id(21) }, include: { pricing: true } });
  assert.equal(custom.provisioner, "PROXMOX");
  assert.equal(custom.pricing.find((p) => p.cycle === "MONTHLY")!.price, 149900);
  assert.equal(custom.pricing.find((p) => p.cycle === "TRIENNIAL")!.price, 4000000);
  assert.ok(!custom.pricing.some((p) => p.cycle === "SEMIANNUAL"), "-1 prices are disabled");

  // server imported disabled with decrypted secret; cPanel server skipped
  const srv = await prisma.server.findFirstOrThrow({ where: { name: "PVE-OLD (WHMCS)" }, orderBy: { createdAt: "desc" } });
  assert.equal(srv.enabled, false);
  assert.equal(decrypt(srv.apiSecretEnc), "S3rverPass!");
  assert.ok(g2.servers.some((s) => s.serverId === srv.id), "server group linked to product");

  // services
  const svcMap = await prisma.legacyMap.findUniqueOrThrow({ where: { source_entity_legacyId: { source: "whmcs", entity: "service", legacyId: String(id(40)) } } });
  const svc = await prisma.service.findUniqueOrThrow({ where: { id: svcMap.localId }, include: { ips: true, addons: true } });
  assert.equal(svc.status, "ACTIVE");
  assert.equal(svc.remoteId, "4101");
  assert.equal(svc.node, "pve2");
  assert.equal(decrypt(svc.passwordEnc), "RootPw-xyz123");
  assert.equal(svc.recurringAmount, 54900);
  assert.deepEqual(svc.ips.map((i) => i.address).sort(), [`198.19.${oct}.10`, `198.19.${oct}.11`, `198.19.${oct}.12`]);
  assert.ok(svc.ips.every((i) => i.status === "ALLOCATED"));
  assert.equal(svc.ips.find((i) => i.isPrimary)!.address, `198.19.${oct}.10`);
  assert.equal(svc.addons.length, 1);
  const suspended = await prisma.service.findFirstOrThrow({ where: { hostname: "legacy.sharma.in", userId: ravi.id } });
  assert.equal(suspended.status, "SUSPENDED");
  assert.equal(suspended.overrideAutoSuspend, true);
  assert.equal((await prisma.server.findUniqueOrThrow({ where: { id: suspended.serverId! } })).type, "CPANEL", "cPanel server imported and linked");
  assert.equal(suspended.passwordEnc, null, "undecryptable password left empty");
  assert.ok(res.warnings.some((w) => /could not be decrypted/.test(w.message)));
  const dead = await prisma.ipAddress.findUnique({ where: { address: `198.19.${oct}.30` } });
  assert.equal(dead, null, "terminated services don't hold IPs");
  const dsvc = await prisma.service.findFirstOrThrow({ where: { hostname: "dead.example" } });
  assert.equal(dsvc.billingCycle, "TRIENNIAL");

  // invoices & GST
  const paid = await prisma.invoice.findFirstOrThrow({ where: { number: `CI/24-25/${RUN}` }, include: { items: true, transactions: true } });
  assert.equal(paid.status, "PAID");
  assert.equal(paid.cgst, 4941);
  assert.equal(paid.sgst, 4941);
  assert.equal(paid.total, 64782);
  assert.equal(paid.items[0].relId, svc.id);
  assert.equal(paid.transactions.length, 2, "payment + refund linked");
  const unpaid = await prisma.invoice.findFirstOrThrow({ where: { proformaNumber: `WH-${id(51)}` }, include: { items: true } });
  assert.equal(unpaid.status, "UNPAID");
  assert.equal(unpaid.number, null);
  assert.equal(unpaid.igst, 13464);
  assert.equal(unpaid.total, 88264, "credit applied is added back so total = subtotal + tax");
  assert.equal(unpaid.amountPaid, 10000);
  const hostItem = unpaid.items.find((i) => i.type === "SERVICE")!;
  assert.equal(hostItem.periodStart!.toISOString(), svc.nextDueDate!.toISOString(), "renewal item lines up with next due date");
  const wallet = await prisma.invoice.findFirstOrThrow({ where: { proformaNumber: `WH-${id(52)}` } });
  assert.equal(wallet.isWalletTopup, true);
  const order = await prisma.order.findFirstOrThrow({ where: { number: `WH-9${B}`, userId: ravi.id } });
  assert.equal(order.invoiceId, paid.id);

  // our renewal engine must not bill the same period again
  await generateRenewalInvoices();
  const dup = await prisma.invoiceItem.count({ where: { relId: svc.id, type: "SERVICE", periodStart: svc.nextDueDate!, invoice: { status: { not: "CANCELLED" } } } });
  assert.equal(dup, 1, "no duplicate renewal invoice after import");

  // transactions
  const bank = await prisma.transaction.findFirstOrThrow({ where: { userId: ravi.id, gateway: "bank" } });
  assert.equal(bank.amount, 100000);
  const refund = await prisma.transaction.findFirstOrThrow({ where: { gatewayTxnId: `rfnd_${RUN}` } });
  assert.equal(refund.type, "REFUND");

  // tickets
  const t = await prisma.ticket.findUniqueOrThrow({ where: { number: `TKT-${RUN}` }, include: { messages: { orderBy: { createdAt: "asc" } } } });
  assert.equal(t.status, "ANSWERED");
  assert.equal(t.priority, "HIGH");
  assert.equal(t.serviceId, svc.id);
  assert.equal(t.messages.length, 4);
  assert.ok(t.messages.some((m) => m.isNote));
  assert.ok(t.messages.some((m) => m.isStaff && m.fromEmail === "Anil K"));
  assert.ok(res.warnings.some((w) => /attachments were not copied/.test(w.message)));

  // domains, promos, content, affiliates
  assert.equal((await prisma.domain.findUniqueOrThrow({ where: { name: `sharma-${RUN}.in` } })).status, "ACTIVE");
  const promo = await prisma.promoCode.findUniqueOrThrow({ where: { code: `DIWALI${RUN}`.toUpperCase().slice(0, 30) } });
  assert.deepEqual(promo.productIds, [custom.id]);
  assert.ok(res.warnings.some((w) => /Free Setup/.test(w.message)));
  assert.equal(await prisma.kbArticle.count({ where: { title: `How to pay with UPI ${RUN}` } }), 1);
  assert.equal((await prisma.affiliate.findUniqueOrThrow({ where: { userId: ravi.id } })).commissionPct, 15);

  // ── WHMCS changes before cutover → delta re-sync ──
  data.tblinvoices[1] = { ...data.tblinvoices[1], status: "Paid", datepaid: "2026-11-10 12:00:00" };
  data.tblhosting[0] = { ...data.tblhosting[0], nextduedate: "2026-12-15" };
  data.tblclients[0] = { ...data.tblclients[0], credit: "300.00", phonenumber: "+91.9000000001" };
  data.tblticketreplies.push({ id: id(99), tid: id(85), userid: 0, date: "2025-03-02", message: "Closing this.", admin: "Anil K" });
  const again = await runWhmcsImport(source(data), { ...opts, dryRun: false });
  assert.equal(again.counts.clients.created, 0);
  assert.equal(again.counts.services.created, 0);
  assert.equal(again.counts.invoices.created, 0);
  assert.equal(again.counts.transactions.created, 0);
  assert.equal(await prisma.user.count({ where: { email: `ravi-${RUN}@example.in` } }), 1);
  assert.equal((await prisma.invoice.findUniqueOrThrow({ where: { id: unpaid.id } })).status, "PAID");
  assert.equal((await prisma.service.findUniqueOrThrow({ where: { id: svc.id } })).nextDueDate!.toISOString().slice(0, 10), "2026-12-14", "IST midnight stored as UTC");
  const ravi2 = await prisma.user.findUniqueOrThrow({ where: { id: ravi.id }, include: { profile: true } });
  assert.equal(ravi2.profile!.creditBalance, 30000);
  assert.equal(ravi2.phone, "+91.9000000001");
  assert.equal(await prisma.ticketMessage.count({ where: { ticketId: t.id } }), 5);
  assert.equal(await prisma.ipAddress.count({ where: { serviceId: svc.id } }), 3);
});

test("services import even when plans weren't ticked; deleted plans go to a placeholder; cPanel servers import; placeholder GSTINs are dropped quietly", async () => {
  const data = fakeWhmcs();
  data.tblhosting.push({ id: id(44), userid: id(10), packageid: 777777, regdate: "2024-01-01", domain: "old-plan.sharma.in", amount: "99.00", billingcycle: "Monthly", nextduedate: "2026-12-01", domainstatus: "Active" });
  data.tblclients[1].tax_id = "NA";
  // only "Services" ticked — exactly what left 3,485 services skipped before
  const r = await runWhmcsImport(source(data), { entities: ["services"], ccEncryptionHash: CC, overwritePricing: false, dryRun: true });
  assert.equal(r.counts.services.created + r.counts.services.updated, 4, "3 normal services + 1 on the placeholder plan (the orphan without a client is skipped)");
  assert.equal(r.counts.services.skipped, 1);
  assert.ok(r.counts.products, "plans step ran automatically");
  assert.ok(r.counts.clients, "clients step ran automatically");
  assert.ok(r.warnings.some((w) => w.entity === "products" && /included automatically/.test(w.message)));
  assert.ok(r.warnings.some((w) => /plan #777777 no longer exists in WHMCS/.test(w.message)));
  assert.ok(!r.warnings.some((w) => /cPanel1: module/.test(w.message)), "cPanel server is no longer rejected");
  assert.ok(!r.warnings.some((w) => /module "cpanel" has no equivalent/.test(w.message)));
  assert.ok(!r.warnings.some((w) => /"NA"/.test(w.message)), "placeholder GSTIN dropped without a warning");
  for (const e of ["services", "products", "productGroups", "clients", "servers", "orders", "addons", "currencies"]) assert.ok(r.counts[e], `${e} appears in the report`);
});

test("default entity list excludes staff", () => {
  assert.ok(!DEFAULT_ENTITIES.includes("staff"));
});

test("WHMCS 8 logins: password comes from tblusers; Inactive customers can sign in; a re-import fixes accounts imported without it", async () => {
  const http = await import("node:http");
  const { createApp } = await import("../src/app");
  const app = createApp().listen(0);
  const base = `http://127.0.0.1:${(app.address() as import("node:net").AddressInfo).port}/api`;
  const login = (email: string, password: string) => fetch(`${base}/auth/login`, { method: "POST", headers: { "Content-Type": "application/json", "X-Requested-With": "crapplet" }, body: JSON.stringify({ email, password }) }).then((r) => r.status);
  void http;
  try {
    const email = `w8-${RUN}@example.in`;
    const pw = "Whmcs8-Login!";
    const base8 = fakeWhmcs();
    const client = { id: id(90), firstname: "Eight", lastname: "User", email, address1: "1", city: "Noida", state: "Uttar Pradesh", postcode: "201301", country: "IN", phonenumber: "", password: "", status: "Inactive", credit: "0", datecreated: "2023-01-01", currency: 1 };
    const opts = { entities: ["clients" as const], ccEncryptionHash: CC, overwritePricing: false, dryRun: false };

    // 1) imported the old way (no tblusers read) → nobody knows the password
    await runWhmcsImport(source({ ...base8, tblclients: [client] }), opts);
    assert.equal(await login(email, pw), 401);

    // 2) re-import with WHMCS 8's user tables → their WHMCS password works, even though WHMCS marked them Inactive
    const users8 = {
      tblusers: [{ id: id(91), first_name: "Eight", last_name: "User", email, password: bcrypt.hashSync(pw, 10).replace(/^\$2a\$/, "$2y$") }],
      tblusers_clients: [{ auth_user_id: id(91), client_id: id(90), owner: 1 }],
    };
    const r = await runWhmcsImport(source({ ...base8, tblclients: [client], ...users8 }), opts);
    assert.equal(r.counts.clients.updated, 1);
    const u = await prisma.user.findUniqueOrThrow({ where: { email } });
    assert.equal(u.status, "INACTIVE");
    assert.equal(await login(email, pw), 200, "WHMCS 8 password + Inactive account signs in");

    // 3) once they've signed in here, a later re-import doesn't overwrite their password
    const other = { tblusers: [{ ...users8.tblusers[0], password: bcrypt.hashSync("different-old", 10).replace(/^\$2a\$/, "$2y$") }], tblusers_clients: users8.tblusers_clients };
    await runWhmcsImport(source({ ...base8, tblclients: [client], ...other }), opts);
    assert.equal(await login(email, pw), 200);

    // closed accounts stay out
    await prisma.user.update({ where: { id: u.id }, data: { status: "CLOSED" } });
    assert.equal(await login(email, pw), 401);

    // a new WHMCS 8 client created by the import gets the tblusers password straight away
    const email2 = `w8b-${RUN}@example.in`;
    await runWhmcsImport(source({ ...base8, tblclients: [{ ...client, id: id(92), email: email2 }], tblusers: [{ ...users8.tblusers[0], id: id(93), email: email2 }], tblusers_clients: [{ auth_user_id: id(93), client_id: id(92), owner: 1 }] }), opts);
    assert.equal(await login(email2, pw), 200);
  } finally {
    app.close();
  }
});
