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

const CC = "a1b2c3d4e5f6CrappletWhmcsHash";
const B = (Date.now() % 1_000_000) * 100; // unique WHMCS ids per test run (LegacyMap persists between runs)
const RUN = B.toString(36);
const oct = (B / 100) % 200 + 20;
const id = (n: number) => B + n;

function fakeWhmcs(): Record<string, Row[]> {
  const clientPw = "Customer#2024";
  return {
    tblconfiguration: [{ setting: "Version", value: "8.10.1-release.1" }],
    tblcurrencies: [{ id: 1, code: "INR", prefix: "₹", suffix: "", rate: "1.00000", default: 1 }],
    tblcustomfields: [
      { id: id(1), type: "client", relid: 0, fieldname: "GSTIN|GST Number" },
      { id: id(2), type: "product", relid: 2, fieldname: "vmid|VM ID" },
      { id: id(3), type: "product", relid: 2, fieldname: "Node" },
    ],
    tblcustomfieldsvalues: [
      { fieldid: id(1), relid: id(10), value: "23ABCDE1234F1Z5" },
      { fieldid: id(2), relid: id(40), value: "4101" },
      { fieldid: id(3), relid: id(40), value: "pve2" },
    ],
    tblclients: [
      { id: id(10), firstname: "Ravi", lastname: "Sharma", companyname: "Sharma Infotech", email: `ravi-${RUN}@example.in`, address1: "5 Lashkar", address2: "", city: "Gwalior", state: "Madhya Pradesh", postcode: "474001", country: "IN", phonenumber: "+91.9876543210", tax_id: "", password: bcrypt.hashSync(clientPw, 10).replace(/^\$2a\$/, "$2y$"), status: "Active", credit: "250.50", datecreated: "2021-04-01", currency: 1, notes: "VIP" },
      { id: id(11), firstname: "Old", lastname: "Timer", companyname: "", email: `old-${RUN}@example.in`, address1: "1 Rd", city: "Pune", state: "Maharashtra", postcode: "411001", country: "IN", phonenumber: "", password: crypto.createHash("md5").update("saltyOldPass1").digest("hex") + ":salty", status: "Active", credit: "0.00", datecreated: "0000-00-00", currency: 1 },
      { id: id(12), firstname: "No", lastname: "Mail", email: "", status: "Active", credit: "0" },
    ],
    tblproductgroups: [{ id: id(20), name: `Imported KVM ${RUN}`, hidden: 0, order: 3 }],
    tblservers: [
      { id: id(30), name: "PVE-OLD", ipaddress: "10.0.0.5", hostname: "pve-old.crapplet.in", type: "proxmoxVPS", username: "root@pam", password: whmcsEncrypt("S3rverPass!", CC), port: 8006, disabled: 0 },
      { id: id(31), name: "cPanel1", ipaddress: "10.0.0.6", hostname: "cp1", type: "cpanel", username: "root", password: "", disabled: 0 },
    ],
    tblservergroupsrel: [{ groupid: 5, serverid: id(30) }],
    tblproducts: [
      { id: 2, type: "server", gid: id(20), name: "Linux VPS G2", paytype: "recurring", servertype: "proxmoxVPS", servergroup: 5, hidden: 0, retired: 0, order: 1 },
      { id: id(21), type: "server", gid: id(20), name: `Custom KVM 8GB ${RUN}`, description: "Legacy plan", paytype: "recurring", servertype: "proxmoxVPS", servergroup: 5, hidden: 1, retired: 0, order: 9 },
    ],
    tblpricing: [
      { type: "product", currency: 1, relid: id(21), msetupfee: "0.00", qsetupfee: "0.00", ssetupfee: "0.00", asetupfee: "0.00", bsetupfee: "0.00", tsetupfee: "0.00", monthly: "1499.00", quarterly: "4200.00", semiannually: "-1.00", annually: "15000.00", biennially: "-1.00", triennially: "40000.00" },
      { type: "addon", currency: 1, relid: id(25), msetupfee: "0.00", monthly: "199.00" },
    ],
    tbladdons: [{ id: id(25), name: "Daily Backups", description: "Off-site", packages: `2,${id(21)}`, tax: 1 }],
    tblpromotions: [
      { id: id(26), code: `DIWALI${RUN}`.toUpperCase().slice(0, 30), type: "Percentage", recurring: 0, value: "20.00", cycles: "Monthly,Annually", appliesto: `${id(21)}`, startdate: "0000-00-00", expirationdate: "2099-12-31", maxuses: 100, uses: 3, newsignups: 0 },
      { id: id(27), code: `FREESETUP${RUN}`.toUpperCase().slice(0, 30), type: "Free Setup", value: "0" },
    ],
    tblorders: [{ id: id(35), ordernum: `9${B}`, userid: id(10), date: "2025-01-10 10:00:00", amount: "1768.82", invoiceid: id(50), status: "Active", promocode: "", ipaddress: "49.36.1.2" }],
    tblhosting: [
      { id: id(40), userid: id(10), orderid: id(35), packageid: 2, server: id(30), regdate: "2025-01-10", domain: `web-${RUN}.sharma.in`, firstpaymentamount: "549.00", amount: "549.00", billingcycle: "Monthly", nextduedate: "2026-11-15", nextinvoicedate: "2026-11-05", domainstatus: "Active", username: "root", password: whmcsEncrypt("RootPw-xyz123", CC), dedicatedip: `198.19.${oct}.10`, assignedips: `198.19.${oct}.11\r\n198.19.${oct}.12\nnot-an-ip`, overideautosuspend: 0, notes: "" },
      { id: id(41), userid: id(10), orderid: 0, packageid: id(21), server: id(31), regdate: "2024-06-01", domain: "legacy.sharma.in", firstpaymentamount: "15000", amount: "15000.00", billingcycle: "Annually", nextduedate: "2027-06-01", domainstatus: "Suspended", suspendreason: "Overdue on Invoice Payment", dedicatedip: `198.19.${oct}.20`, assignedips: "", password: "garbage==", overideautosuspend: 1 },
      { id: id(42), userid: id(11), packageid: 2, server: id(30), regdate: "2023-01-01", domain: "dead.example", amount: "549.00", billingcycle: "Triennially", nextduedate: "2024-01-01", domainstatus: "Terminated", dedicatedip: `198.19.${oct}.30` },
      { id: id(43), userid: 999999999, packageid: 2, domain: "orphan", domainstatus: "Active" },
    ],
    tblhostingaddons: [{ id: id(45), hostingid: id(40), addonid: id(25), name: "", recurring: "199.00", status: "Active" }],
    tbldomains: [{ id: id(46), userid: id(10), orderid: id(35), type: "Register", registrationdate: "2025-01-10", domain: `sharma-${RUN}.in`, recurringamount: "799.00", registrar: "resellerclub", registrationperiod: 1, expirydate: "2027-01-10", nextduedate: "2027-01-10", status: "Active", donotrenew: 0, idprotection: 0 }],
    tblinvoices: [
      { id: id(50), userid: id(10), invoicenum: `CI/24-25/${RUN}`, date: "2025-01-10", duedate: "2025-01-10", datepaid: "2025-01-10 10:05:00", subtotal: "549.00", credit: "0.00", tax: "49.41", tax2: "49.41", total: "647.82", taxrate: "9.00", taxrate2: "9.00", status: "Paid", paymentmethod: "razorpay", notes: "" },
      { id: id(51), userid: id(10), invoicenum: "", date: "2026-11-05", duedate: "2026-11-15", datepaid: "0000-00-00 00:00:00", subtotal: "748.00", credit: "100.00", tax: "134.64", tax2: "0.00", total: "782.64", taxrate: "18.00", taxrate2: "0.00", status: "Unpaid", paymentmethod: "razorpay" },
      { id: id(52), userid: id(10), invoicenum: "", date: "2025-02-01", duedate: "2025-02-01", datepaid: "2025-02-01", subtotal: "1000.00", credit: "0", tax: "0", tax2: "0", total: "1000.00", status: "Paid" },
    ],
    tblinvoiceitems: [
      { id: id(60), invoiceid: id(50), userid: id(10), type: "Hosting", relid: id(40), description: "Linux VPS G2 (10/01/2025 - 09/02/2025)", amount: "549.00", taxed: 1, duedate: "2025-01-10" },
      { id: id(61), invoiceid: id(51), userid: id(10), type: "Hosting", relid: id(40), description: "Linux VPS G2 (15/11/2026 - 14/12/2026)", amount: "549.00", taxed: 1, duedate: "2026-11-15" },
      { id: id(62), invoiceid: id(51), userid: id(10), type: "Addon", relid: id(45), description: "Daily Backups", amount: "199.00", taxed: 1, duedate: "2026-11-15" },
      { id: id(63), invoiceid: id(52), userid: id(10), type: "AddFunds", relid: 0, description: "Add Funds", amount: "1000.00", taxed: 0 },
    ],
    tblaccounts: [
      { id: id(70), userid: id(10), currency: 0, gateway: "razorpay", date: "2025-01-10 10:05:00", description: "Invoice Payment", amountin: "647.82", fees: "15.29", amountout: "0", transid: `pay_${RUN}`, invoiceid: id(50) },
      { id: id(71), userid: id(10), currency: 0, gateway: "banktransfer", date: "2025-02-01", description: "Invoice Payment", amountin: "1000.00", fees: "0", amountout: "0", transid: "", invoiceid: id(52) },
      { id: id(72), userid: id(10), currency: 0, gateway: "razorpay", date: "2025-03-01", description: "Refund", amountin: "0", fees: "0", amountout: "100.00", transid: `rfnd_${RUN}`, invoiceid: id(50) },
    ],
    tblticketdepartments: [{ id: id(80), name: "Technical Support", email: "support@crapplet.in", hidden: 0, order: 1 }, { id: id(81), name: `Legacy Dept ${RUN}`, email: "", hidden: 1, order: 9 }],
    tbltickets: [
      { id: id(85), tid: `TKT-${RUN}`, did: id(80), userid: id(10), email: "", date: "2025-03-01 09:00:00", title: "Cannot SSH", message: "Port 22 refused", status: "Answered", urgency: "High", admin: "", lastreply: "2025-03-01 10:00:00", service: `S${id(40)}`, attachment: "abc_screenshot.png", flag: 0 },
      { id: id(86), tid: `GUEST-${RUN}`, did: id(81), userid: 0, email: `old-${RUN}@example.in`, date: "2025-04-01", title: "Pre-sales", message: "Do you have Mumbai?", status: "Closed", urgency: "Low", admin: "" },
    ],
    tblticketreplies: [
      { id: id(87), tid: id(85), userid: 0, date: "2025-03-01 10:00:00", message: "Please check your firewall.", admin: "Anil K", attachment: "" },
      { id: id(88), tid: id(85), userid: id(10), date: "2025-03-01 10:30:00", message: "Works now, thanks!", admin: "" },
    ],
    tblticketnotes: [{ id: id(89), ticketid: id(85), admin: "Anil K", date: "2025-03-01", message: "Customer had ufw enabled" }],
    tblannouncements: [{ id: id(90), date: "2025-05-01", title: `Maintenance ${RUN}`, announcement: "Network upgrade", published: 1, parentid: 0 }],
    tblknowledgebasecats: [{ id: id(91), parentid: 0, name: `Billing ${RUN}`, catid: 0 }],
    tblknowledgebase: [{ id: id(92), title: `How to pay with UPI ${RUN}`, article: "Scan the QR…", views: 42, parentid: 0, private: 0 }],
    tblknowledgebaselinks: [{ categoryid: id(91), articleid: id(92) }],
    tblaffiliates: [{ id: id(95), clientid: id(10), visitors: 12, paytype: "percentage", payamount: "15.00", balance: "300.00", withdrawn: "0" }],
  };
}

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
  assert.equal(suspended.serverId, null, "cPanel server not mapped");
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

test("default entity list excludes staff", () => {
  assert.ok(!DEFAULT_ENTITIES.includes("staff"));
});
