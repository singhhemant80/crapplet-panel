/** In-memory WHMCS data shaped like the real tables — shared by the importer and SQL-dump tests. */
import bcrypt from "bcryptjs";
import crypto from "node:crypto";
import { whmcsEncrypt } from "../src/modules/migration/whmcs-crypto";
import type { Row } from "../src/modules/migration/whmcs";

export const CC = "a1b2c3d4e5f6CrappletWhmcsHash";
export const B = (Date.now() % 1_000_000) * 100; // unique WHMCS ids per test run (LegacyMap persists between runs)
export const RUN = B.toString(36);
export const oct = (B / 100) % 200 + 20;
export const id = (n: number) => B + n;

export function fakeWhmcs(): Record<string, Row[]> {
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


/** mysqldump-style escaping */
export function lit(v: unknown) {
  if (v === null || v === undefined) return "NULL";
  if (typeof v === "number") return String(v);
  return "'" + String(v).replace(/\\/g, "\\\\").replace(/'/g, "\\'").replace(/\n/g, "\\n").replace(/\r/g, "\\r").replace(/\0/g, "\\0").replace(/\x1a/g, "\\Z") + "'";
}

/** Write tables as a dump. style "mysqldump" = extended INSERT per table; "phpmyadmin" = column list, one tuple per line, '' quotes. */
export function writeDump(data: Record<string, Row[]>, style: "mysqldump" | "phpmyadmin") {
  const out: string[] = [
    "-- MySQL dump 10.13  Distrib 8.0.36, for Linux (x86_64)",
    "--",
    "-- Host: localhost    Database: whmcs",
    "/*!40101 SET @OLD_CHARACTER_SET_CLIENT=@@CHARACTER_SET_CLIENT */;",
    "/*!40101 SET NAMES utf8mb4 */;",
    "SET SQL_MODE = \"NO_AUTO_VALUE_ON_ZERO\";",
    "# a hash comment",
    "",
  ];
  // a table the importer doesn't need, full of things that look like statement ends
  data = { tblactivitylog: [{ id: 1, description: "Login; DROP TABLE x; -- not a comment # nor this /* nor this */ it's \"quoted\"" }, { id: 2, description: "line1\nline2;\n-- still text" }], ...data };
  for (const [t, rows] of Object.entries(data)) {
    const cols = [...new Set(rows.flatMap((r) => Object.keys(r)))];
    out.push(`--\n-- Table structure for table \`${t}\`\n--\n`, `DROP TABLE IF EXISTS \`${t}\`;`, "/*!40101 SET @saved_cs_client     = @@character_set_client */;");
    out.push(`CREATE TABLE \`${t}\` (\n${cols.map((c) => `  \`${c}\` text DEFAULT NULL,`).join("\n")}\n  PRIMARY KEY (\`${cols[0]}\`),\n  KEY \`idx\` (\`${cols[0]}\`)\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;`);
    if (!rows.length) continue;
    const tuples = rows.map((r) => "(" + cols.map((c) => (style === "phpmyadmin" && typeof r[c] === "string" ? lit(r[c]).replace(/\\'/g, "''") : lit(r[c]))).join(",") + ")");
    if (style === "mysqldump") {
      out.push(`LOCK TABLES \`${t}\` WRITE;`, `/*!40000 ALTER TABLE \`${t}\` DISABLE KEYS */;`, `INSERT INTO \`${t}\` VALUES ${tuples.join(",")};`, `/*!40000 ALTER TABLE \`${t}\` ENABLE KEYS */;`, "UNLOCK TABLES;");
    } else {
      out.push(`INSERT INTO \`${t}\` (${cols.map((c) => `\`${c}\``).join(", ")}) VALUES\n${tuples.join(",\n")};`);
    }
  }
  out.push("/*!40101 SET CHARACTER_SET_CLIENT=@OLD_CHARACTER_SET_CLIENT */;", "-- Dump completed on 2026-11-11 10:00:00", "");
  return out.join("\n");
}

