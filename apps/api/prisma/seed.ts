/**
 * Seeds Crapplet Cloud with the catalogue from crapplet.co.in (legacy WHMCS pids kept so existing
 * website "Order" buttons keep working), roles, departments, templates and an admin account.
 *
 *   SEED_ADMIN_EMAIL=admin@crapplet.co.in SEED_ADMIN_PASSWORD='…' npm run db:seed
 *   SEED_DEMO=true …   also adds a dry-run Proxmox server, a test subnet, domain pricing and a demo client
 */
import "dotenv/config";
import bcrypt from "bcryptjs";
import crypto from "crypto";
import { prisma, BillingCycle, ProductType, Provisioner } from "../src/db";
import { encrypt, encryptJson } from "../src/lib/crypto";
import { importCidr } from "../src/modules/ipam/service";

const R = (rupees: number) => Math.round(rupees * 100);
const CYCLES: [BillingCycle, number][] = [["MONTHLY", 1], ["QUARTERLY", 3], ["SEMIANNUAL", 6], ["ANNUAL", 12]];

interface Plan {
  pid?: number;
  name: string;
  slug: string;
  tagline: string;
  monthly: number;
  cpu?: number;
  ram?: number; // GB
  disk?: number; // GB
  bw?: number | null; // GB, null = unmetered
  features?: string[];
  featured?: boolean;
}

const VPS_FEATURES = ["Full root / admin access", "KVM virtualization", "NVMe / SSD storage", "DDoS protection", "Choose your IPv4 address", "99.9% uptime SLA"];

const GROUPS: { name: string; slug: string; headline: string; type: ProductType; provisioner: Provisioner; os: "linux" | "windows" | "none"; plans: Plan[]; resellerEnabled?: boolean; sac?: string }[] = [
  {
    name: "Shared Hosting", slug: "shared-hosting", headline: "Affordable hosting for websites & blogs", type: "SHARED", provisioner: "MANUAL", os: "none",
    plans: [
      { pid: 19, name: "Shared Basic", slug: "shared-basic", tagline: "Perfect for personal sites & blogs", monthly: 49, features: ["Host 1 website", "50 GB NVMe SSD", "Unlimited bandwidth", "5 MySQL databases", "5 email accounts", "LiteSpeed web server", "Weekly backup", "Free SSL"] },
      { pid: 20, name: "Shared Business", slug: "shared-business", tagline: "Optimised for growing traffic", monthly: 99, featured: true, features: ["Host 10 websites", "150 GB NVMe SSD", "Unlimited bandwidth", "50 MySQL databases", "50 email accounts", "LiteSpeed web server", "Weekly backup", "Free SSL"] },
      { pid: 21, name: "Shared Ultimate", slug: "shared-ultimate", tagline: "Ultimate power for pros", monthly: 199, features: ["Unlimited websites", "Unlimited NVMe SSD", "Unlimited bandwidth", "Unlimited databases", "Unlimited email accounts", "LiteSpeed web server", "Weekly backup", "Free SSL"] },
    ],
  },
  {
    name: "Reseller Hosting", slug: "reseller-hosting", headline: "Start your own hosting business", type: "RESELLER_HOSTING", provisioner: "MANUAL", os: "none",
    plans: [
      { pid: 22, name: "Reseller Basic", slug: "reseller-basic", tagline: "Perfect for starting your own hosting business", monthly: 299 },
      { pid: 23, name: "Reseller Business", slug: "reseller-business", tagline: "Best for growing hosting businesses and agencies", monthly: 599, featured: true },
      { pid: 24, name: "Reseller Ultimate", slug: "reseller-ultimate", tagline: "Unlimited power for large-scale hosting businesses", monthly: 999 },
    ],
  },
  { name: "WordPress Hosting", slug: "wordpress-hosting", headline: "Fast, secure hosting tuned for WordPress", type: "WORDPRESS", provisioner: "MANUAL", os: "none", plans: [] },
  {
    name: "Linux VPS", slug: "linux-vps-hosting", headline: "Full root access, SSD storage, instant setup", type: "VPS_LINUX", provisioner: "PROXMOX", os: "linux", resellerEnabled: true,
    plans: [
      { pid: 1, name: "Linux VPS G1", slug: "linux-vps-g1", tagline: "Ideal for dev environments & small apps", monthly: 399, cpu: 2, ram: 2, disk: 40 },
      { pid: 2, name: "Linux VPS G2", slug: "linux-vps-g2", tagline: "Perfect for production workloads", monthly: 549, cpu: 2, ram: 4, disk: 80, featured: true },
      { pid: 3, name: "Linux VPS G3", slug: "linux-vps-g3", tagline: "High-traffic apps", monthly: 749, cpu: 4, ram: 8, disk: 160 },
      { pid: 4, name: "Linux VPS G4", slug: "linux-vps-g4", tagline: "Ultimate performance", monthly: 1099, cpu: 6, ram: 16, disk: 320 },
    ],
  },
  {
    name: "Windows VPS", slug: "windows-vps-hosting", headline: "Full RDP access with SSD storage", type: "VPS_WINDOWS", provisioner: "PROXMOX", os: "windows", resellerEnabled: true,
    plans: [
      { pid: 7, name: "Windows VPS W1", slug: "windows-vps-w1", tagline: "Light apps, remote desktop access", monthly: 799, cpu: 2, ram: 4, disk: 80 },
      { pid: 8, name: "Windows VPS W2", slug: "windows-vps-w2", tagline: "Business apps & multi-user RDP", monthly: 999, cpu: 4, ram: 8, disk: 120, featured: true },
      { pid: 9, name: "Windows VPS W3", slug: "windows-vps-w3", tagline: "Heavy workloads & enterprise use", monthly: 1299, cpu: 8, ram: 16, disk: 160 },
    ],
  },
  {
    name: "Forex VPS", slug: "forex-vps-hosting", headline: "Low-latency VPS for trading platforms", type: "VPS_FOREX", provisioner: "PROXMOX", os: "windows",
    plans: [
      { pid: 26, name: "Forex VPS F1 (Trader Lite)", slug: "forex-vps-f1", tagline: "1–2 EAs, single broker account", monthly: 799, cpu: 2, ram: 4, disk: 80, features: ["MT4 / MT5 pre-installed", "< 5 ms broker latency", "DDoS protection"] },
      { pid: 27, name: "Forex VPS F2 (Trader Pro)", slug: "forex-vps-f2", tagline: "5–10 EAs, multi-account trading", monthly: 999, cpu: 4, ram: 8, disk: 120, featured: true, features: ["MT4 / MT5 / cTrader", "< 2 ms broker latency", "Dedicated IPv4 + DDoS"] },
      { pid: 28, name: "Forex VPS F3 (Trader Elite)", slug: "forex-vps-f3", tagline: "Unlimited EAs, fund managers", monthly: 1299, cpu: 8, ram: 16, disk: 160, features: ["All platforms included", "< 1 ms broker latency", "24/7 priority support"] },
    ],
  },
  {
    name: "Tally on Cloud", slug: "tally-on-cloud", headline: "Access Tally securely from anywhere", type: "TALLY", provisioner: "PROXMOX", os: "windows",
    plans: [
      { pid: 29, name: "Tally Starter", slug: "tally-starter", tagline: "Solo accountant · 1–2 users", monthly: 999, cpu: 2, ram: 4, disk: 80, features: ["Tally Prime pre-installed", "Daily backups", "RDP access"] },
      { pid: 30, name: "Tally Business", slug: "tally-business", tagline: "Small business · 3–5 users", monthly: 1499, cpu: 4, ram: 8, disk: 120, featured: true, features: ["Tally Prime pre-installed", "Daily backups", "RDP access"] },
      { pid: 31, name: "Tally Enterprise", slug: "tally-enterprise", tagline: "CA firms & large teams · 10+ users", monthly: 1999, cpu: 8, ram: 16, disk: 160, features: ["Tally Prime pre-installed", "Daily backups", "RDP access"] },
    ],
  },
  {
    name: "Gold VPS", slug: "gold-vps-hosting", headline: "Premium high-performance VPS plans", type: "VPS_GOLD", provisioner: "PROXMOX", os: "linux", resellerEnabled: true,
    plans: [
      // NOTE: the website's "Gold M" button links to pid=30, which is also Tally Business. Gold M is seeded as 34.
      { pid: 33, name: "Gold S", slug: "gold-vps-s", tagline: "Ideal for growing apps & APIs", monthly: 999, cpu: 2, ram: 4, disk: 80, bw: null },
      { pid: 34, name: "Gold M", slug: "gold-vps-m", tagline: "High-traffic sites & e-commerce", monthly: 1299, cpu: 4, ram: 8, disk: 120, bw: null, featured: true },
      { pid: 35, name: "Gold L", slug: "gold-vps-l", tagline: "Enterprise workloads & SaaS", monthly: 1599, cpu: 8, ram: 16, disk: 160, bw: null },
    ],
  },
  {
    name: "n8n VPS", slug: "n8n-vps-hosting", headline: "Self-host n8n with unlimited workflows", type: "VPS_N8N", provisioner: "PROXMOX", os: "linux",
    plans: [
      { name: "n8n Starter VPS N1", slug: "n8n-vps-n1", tagline: "Solo automators & hobby projects", monthly: 699, cpu: 2, ram: 2, disk: 40, bw: 1024 },
      { name: "n8n Pro VPS N2", slug: "n8n-vps-n2", tagline: "Small teams & business automations", monthly: 1399, cpu: 4, ram: 4, disk: 80, bw: 3072, featured: true },
      { name: "n8n Enterprise VPS N3", slug: "n8n-vps-n3", tagline: "High-volume & production workloads", monthly: 2799, cpu: 8, ram: 8, disk: 160, bw: 6144 },
    ],
  },
  {
    name: "Minecraft VPS", slug: "minecraft-vps-hosting", headline: "Game servers live in under 60 seconds", type: "VPS_MINECRAFT", provisioner: "PROXMOX", os: "linux",
    plans: [
      ["Sapling", "sapling-4gb", "Small Survival · up to 10 players", 989, 2, 4, 50],
      ["Sprout", "sprout-6gb", "Friend Group SMP · up to 20 players", 1319, 3, 6, 75],
      ["Miner", "miner-8gb", "SMP Servers · up to 30 players", 1704, 4, 8, 100],
      ["Explorer", "explorer-12gb", "Modded Servers · up to 45 players", 2364, 5, 12, 150],
      ["Builder", "builder-16gb", "Large Communities · up to 60 players", 3024, 6, 16, 200],
      ["Warden", "warden-24gb", "Heavy Modpacks · up to 80 players", 4344, 7, 24, 300],
      ["Overlord", "overlord-32gb", "Big Modpacks · up to 100 players", 5939, 8, 32, 400],
      ["Titan", "titan-48gb", "Networks & BungeeCord · up to 150 players", 8304, 9, 48, 600],
      ["Ascendant", "ascendant-64gb", "Enterprise Networks · unlimited players", 10559, 10, 64, 800],
    ].map(([name, slug, tagline, monthly, cpu, ram, disk]) => ({ name: `Minecraft ${name}`, slug: slug as string, tagline: tagline as string, monthly: monthly as number, cpu: cpu as number, ram: ram as number, disk: disk as number, bw: 20480 })),
  },
  { name: "Dedicated Servers", slug: "dedicated-servers", headline: "Bare-metal servers, fully yours", type: "DEDICATED", provisioner: "MANUAL", os: "none", plans: [] },
  { name: "GPU Cloud Servers", slug: "gpu-servers", headline: "NVIDIA H100, A100, L40S & RTX GPUs", type: "GPU", provisioner: "MANUAL", os: "none", plans: [] },
  {
    name: "Colocation", slug: "colocation", headline: "Tier III data centre in Noida", type: "COLOCATION", provisioner: "MANUAL", os: "none",
    plans: [
      { pid: 40, name: "Colocation Single U", slug: "colo-1u", tagline: "Perfect for single servers — 1U, 1 TB bandwidth, 5 IPs", monthly: 5500 },
      { pid: 42, name: "Colocation Half Rack", slug: "colo-half-rack", tagline: "20U rack space, 5 TB bandwidth, 16 IPs", monthly: 25000 },
      { pid: 43, name: "Colocation Full Rack", slug: "colo-full-rack", tagline: "42U fully yours, 10 TB bandwidth, 28 IPs", monthly: 40000, featured: true },
    ],
  },
];

const OS = [
  { name: "Ubuntu 24.04 LTS", family: "linux", vmid: 9000, lxc: "local:vztmpl/ubuntu-24.04-standard_24.04-2_amd64.tar.zst" },
  { name: "Ubuntu 22.04 LTS", family: "linux", vmid: 9001, lxc: "local:vztmpl/ubuntu-22.04-standard_22.04-1_amd64.tar.zst" },
  { name: "Debian 12", family: "linux", vmid: 9002, lxc: "local:vztmpl/debian-12-standard_12.7-1_amd64.tar.zst" },
  { name: "AlmaLinux 9", family: "linux", vmid: 9003, lxc: "local:vztmpl/almalinux-9-default_20240911_amd64.tar.xz" },
  { name: "Rocky Linux 9", family: "linux", vmid: 9004, lxc: "local:vztmpl/rockylinux-9-default_20240912_amd64.tar.xz" },
  { name: "Windows Server 2022", family: "windows", vmid: 9010, lxc: null },
  { name: "Windows Server 2019", family: "windows", vmid: 9011, lxc: null },
];

async function main() {
  const demo = process.env.SEED_DEMO === "true";

  // roles
  const roles = [
    { name: "Administrator", description: "Full access", permissions: ["*"] },
    { name: "Support Agent", description: "Tickets, read-only clients & services", permissions: ["tickets.manage", "clients.view", "services.view", "ips.view", "billing.view", "orders.view"] },
    { name: "Billing", description: "Invoices, payments and orders", permissions: ["billing.manage", "payments.manage", "clients.view", "orders.manage", "reports.view", "tickets.view"] },
    { name: "Sales", description: "Orders and pre-sales tickets", permissions: ["orders.view", "clients.view", "tickets.manage", "products.manage"] },
    { name: "Network Engineer", description: "Servers, IPs and VPS operations", permissions: ["servers.manage", "ips.manage", "services.manage", "clients.view", "tickets.manage"] },
  ];
  for (const r of roles) await prisma.role.upsert({ where: { name: r.name }, update: { permissions: r.permissions, description: r.description }, create: r });
  const adminRole = await prisma.role.findUniqueOrThrow({ where: { name: "Administrator" } });

  const adminEmail = (process.env.SEED_ADMIN_EMAIL ?? "admin@crapplet.co.in").toLowerCase();
  if (!(await prisma.user.findUnique({ where: { email: adminEmail } }))) {
    const pw = process.env.SEED_ADMIN_PASSWORD ?? crypto.randomBytes(12).toString("base64url");
    await prisma.user.create({ data: { type: "STAFF", email: adminEmail, firstName: "Crapplet", lastName: "Admin", passwordHash: await bcrypt.hash(pw, 12), roleId: adminRole.id, emailVerifiedAt: new Date() } });
    console.log(`\n  Admin login: ${adminEmail}\n  Password:    ${process.env.SEED_ADMIN_PASSWORD ? "(from SEED_ADMIN_PASSWORD)" : pw}\n`);
  }

  // currencies
  await prisma.currency.upsert({ where: { code: "INR" }, update: {}, create: { code: "INR", prefix: "₹", rate: 1, isDefault: true } });
  await prisma.currency.upsert({ where: { code: "USD" }, update: {}, create: { code: "USD", prefix: "$", rate: 0.012 } });

  // departments
  const depts = ["Technical Support", "Billing Support", "Network Support", "Abuse Department", "Sales Department"];
  for (const [i, name] of depts.entries())
    await prisma.ticketDepartment.upsert({ where: { name }, update: {}, create: { name, sortOrder: i, slaHours: name === "Abuse Department" ? 2 : name === "Sales Department" ? 8 : 4 } });

  // OS templates (Proxmox VMIDs are the conventional 9000+ template IDs — edit them in Admin → OS Templates)
  const osRows = [];
  for (const [i, o] of OS.entries()) {
    const existing = await prisma.osTemplate.findFirst({ where: { name: o.name } });
    osRows.push(
      existing ??
        (await prisma.osTemplate.create({ data: { name: o.name, family: o.family, proxmoxKvmVmid: o.vmid, proxmoxLxcVolid: o.lxc, defaultUser: o.family === "windows" ? "Administrator" : "root", sortOrder: i } })),
    );
  }

  // location
  const gwl = await prisma.location.upsert({ where: { code: "NOI" }, update: {}, create: { name: "Noida, India", code: "NOI", country: "IN" } });

  // catalogue
  for (const [gi, g] of GROUPS.entries()) {
    const group = await prisma.productGroup.upsert({ where: { slug: g.slug }, update: { name: g.name, headline: g.headline }, create: { name: g.name, slug: g.slug, headline: g.headline, sortOrder: gi } });
    for (const [pi, p] of g.plans.entries()) {
      if (await prisma.product.findUnique({ where: { slug: p.slug } })) continue;
      const isVps = g.provisioner === "PROXMOX";
      const prod = await prisma.product.create({
        data: {
          groupId: group.id,
          legacyPid: p.pid ?? null,
          name: p.name,
          slug: p.slug,
          type: g.type,
          tagline: p.tagline,
          features: p.features ?? (isVps ? VPS_FEATURES : []),
          provisioner: g.provisioner,
          virtType: "KVM",
          cpuCores: p.cpu ?? null,
          ramMb: p.ram ? p.ram * 1024 : null,
          diskGb: p.disk ?? null,
          bandwidthGb: p.bw === undefined ? null : p.bw,
          ipv4Count: isVps ? 1 : 0,
          allowIpSelection: isVps,
          requireHostname: isVps,
          featured: !!p.featured,
          sortOrder: pi,
          resellerEnabled: !!g.resellerEnabled,
          hsnSac: "998315",
          pricing: { create: CYCLES.map(([cycle, m]) => ({ cycle, currency: "INR", price: R(p.monthly * m), enabled: true })) },
          wholesalePricing: g.resellerEnabled ? { create: CYCLES.map(([cycle, m]) => ({ cycle, price: R(Math.round(p.monthly * 0.8) * m) })) } : undefined,
        },
      });
      if (isVps) {
        const fam = g.os;
        await prisma.productOs.createMany({ data: osRows.filter((o) => o.family === fam).map((o) => ({ productId: prod.id, osTemplateId: o.id })) });
      }
    }
  }

  // website promo: 15% off Linux & Windows VPS
  if (!(await prisma.promoCode.findUnique({ where: { code: "SPECIAL15" } }))) {
    const vps = await prisma.product.findMany({ where: { type: { in: ["VPS_LINUX", "VPS_WINDOWS"] } }, select: { id: true } });
    await prisma.promoCode.create({ data: { code: "SPECIAL15", type: "PERCENT", value: 15, productIds: vps.map((v) => v.id) } });
  }

  // payment gateways (disabled until configured in Admin → Payment Gateways)
  const gw = [
    ["razorpay", "Razorpay — UPI, Cards, Netbanking, Wallets"],
    ["cashfree", "Cashfree — UPI, Cards, Netbanking"],
    ["payu", "PayU"],
    ["stripe", "Stripe — International cards"],
    ["upi", "UPI (Scan & Pay)"],
    ["bank", "Bank Transfer (NEFT / RTGS / IMPS)"],
    ["manual", "Manual / Cash / Cheque"],
    ["custom", "Custom gateway"],
  ];
  for (const [i, [code, name]] of gw.entries()) await prisma.paymentGateway.upsert({ where: { code }, update: {}, create: { code, name, sortOrder: i, enabled: false, configEnc: encryptJson({}) } });

  if (demo) {
    console.log("  Adding demo data (dry-run Proxmox server, test subnet, demo client)…");
    let server = await prisma.server.findFirst({ where: { name: { in: ["PVE Noida 1 (demo)", "PVE Gwalior 1 (demo)"] } } });
    if (!server)
      server = await prisma.server.create({
        data: { name: "PVE Noida 1 (demo)", type: "PROXMOX", locationId: gwl.id, hostname: "pve1.example.invalid", port: 8006, apiUser: "billing@pve!crapplet", apiSecretEnc: encrypt("00000000-0000-0000-0000-000000000000"), verifyTls: false, storage: "local-lvm", bridge: "vmbr0" },
      });
    const vpsProducts = await prisma.product.findMany({ where: { provisioner: "PROXMOX" } });
    await prisma.productServer.createMany({ data: vpsProducts.map((p) => ({ productId: p.id, serverId: server!.id })), skipDuplicates: true });
    await importCidr({ cidr: "203.0.113.0/26", serverId: server.id, locationId: gwl.id, gateway: "203.0.113.1", notes: "Demo range (RFC 5737 TEST-NET-3)" });
    const tlds: [string, number, number][] = [[".in", 599, 799], [".co.in", 499, 699], [".com", 899, 1099], [".net", 1099, 1299], [".org", 999, 1199]];
    for (const [tld, reg, renew] of tlds) await prisma.domainPricing.upsert({ where: { tld }, update: {}, create: { tld, register: R(reg), transfer: R(renew), renew: R(renew) } });
    await prisma.paymentGateway.update({ where: { code: "upi" }, data: { enabled: true, publicConfig: { vpa: "crapplet@upi", payeeName: "Crapplet Infotech Pvt Ltd" } } });
    await prisma.paymentGateway.update({ where: { code: "bank" }, data: { enabled: true, publicConfig: { instructions: "Bank: <your bank>\nA/C name: Crapplet Infotech Private Limited\nA/C no: <account>\nIFSC: <ifsc>\nUse your invoice number as the payment reference." } } });
    if (!(await prisma.user.findUnique({ where: { email: "demo@crapplet.test" } }))) {
      await prisma.user.create({
        data: {
          email: "demo@crapplet.test",
          firstName: "Asha",
          lastName: "Verma",
          phone: "+91 98260 00000",
          passwordHash: await bcrypt.hash("Demo@12345", 12),
          emailVerifiedAt: new Date(),
          profile: { create: { companyName: "Verma Traders", address1: "12 MG Road", city: "Indore", state: "Madhya Pradesh", stateCode: "23", country: "IN", postcode: "452001" } },
        },
      });
      console.log("  Demo client: demo@crapplet.test / Demo@12345");
    }
    if (!(await prisma.announcement.count())) await prisma.announcement.create({ data: { title: "Welcome to the new Crapplet Cloud client area", body: "Choose your own IPv4 address when ordering a VPS, manage your servers and pay invoices with UPI — all in one place." } });
    if (!(await prisma.kbCategory.count())) {
      const cat = await prisma.kbCategory.create({ data: { name: "VPS", slug: "vps" } });
      await prisma.kbArticle.create({ data: { categoryId: cat.id, title: "Connecting to your Linux VPS with SSH", slug: "connect-linux-vps-ssh", body: "Open a terminal and run:\n\n    ssh root@YOUR_SERVER_IP\n\nYour root password is in the VPS activation email and under My Services → your VPS → Show password." } });
    }
  }
  console.log("  Seed complete.");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
