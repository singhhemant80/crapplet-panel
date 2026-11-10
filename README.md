# Crapplet Cloud — hosting automation & billing

A WHMCS alternative for **Crapplet Infotech Private Limited**: your existing website, a client area,
a WHMCS-style admin, GST billing, Indian payment gateways, and native **Proxmox VE** / **Virtualizor**
provisioning with **customer-selected IPv4 addresses**.

```
crapplet-panel/
├─ public-site/        your existing crapplet.co.in website (from crapplet-website-only.zip), served as-is by Nginx
├─ apps/api/           Express + TypeScript + Prisma 7 (PostgreSQL) + BullMQ (Redis)  → :4000
│   ├─ prisma/         schema.prisma, migrations, seed.ts (your catalogue with the website's WHMCS pids)
│   ├─ src/server.ts   REST API            src/worker.ts   provisioning / email / billing worker
│   └─ test/           end-to-end tests (real Postgres + Redis)
├─ apps/web/           Next.js 14 + Tailwind — /client, /order, /admin                → :3000
└─ deploy/             install.sh (Ubuntu 24.04), nginx config, PM2 ecosystem, backup.sh
```

## How the three interfaces connect

| URL | Served by | Notes |
|---|---|---|
| `/`, `/linux-vps-hosting.html`, … | Nginx (static `public-site/`) | Your website, unchanged |
| `/client/*` | Next.js | Uses your site's exact header (header.css/header.js) and footer |
| `/order/*` | Next.js | Catalogue → configure (IP picker) → cart → pay |
| `/admin/*` | Next.js | Separate SaaS-style admin with Crapplet branding |
| `/api/*` | Express | REST API, webhooks, reseller API (`/api/v1/reseller`) |

**The website needs no edits.** Nginx 301-redirects the old WHMCS links:
`/clientarea/index.php?rp=/login` → `/client/login`, `/clientarea/cart.php?a=add&pid=2` → `/order/configure?pid=2`
(products keep their WHMCS `pid`), `?rp=/store/minecraft-vps-hosting/sapling-4gb` → that plan, `cart.php?a=add&domain=register` → domain search.

> One fix was made to `public-site/gold-vps-hosting.html`: the **Gold M** button linked to `pid=30`, which is
> also **Tally Business**. It now links to `pid=34` (Gold M is seeded as pid 34).

## Install (Ubuntu 24.04, no Docker) — one command

Point your domain's DNS (A record) at the server, then run as root:

```bash
curl -fsSL https://raw.githubusercontent.com/singhhemant80/crapplet-panel/main/install.sh | sudo bash -s -- --domain crapplet.co.in --email admin@crapplet.co.in
```

Options: `--no-ssl` (skip Let's Encrypt), `--demo` (seed a test server, IP range and demo customer),
`--dir /opt/crapplet-panel`, `--branch main`. **Run the same command again to update** — it pulls the latest code,
rebuilds and applies migrations; your `.env`, database and uploads are kept.

Email: open **Admin → Email Delivery**, pick your provider (Zoho, ZeptoMail, Google Workspace, Microsoft 365,
Amazon SES, Brevo, Mailgun, SendGrid, Postmark or any SMTP server), enter the login, press **Test connection**,
send a test email and **Save**. The **Deliverability check** tab then looks up SPF, DKIM, DMARC and MX for your
From domain (plus reverse DNS and blocklists when sending from this server) and shows the exact DNS records to add.
Every email, with the receiving server's reply, appears in the **Delivery log**; hard bounces aren't retried and
that address is paused for 30 days. The `SMTP_*` values in `.env` are only used until the page is saved once.

The script installs Node 22, PostgreSQL, Redis, Nginx, Certbot and PM2; generates secrets into `apps/api/.env`;
builds; runs `prisma migrate deploy`; seeds; starts `crapplet-api` (×2), `crapplet-worker` and `crapplet-web`
under PM2; configures Nginx + SSL, UFW and nightly `pg_dump` backups. Admin credentials are written to
`/root/crapplet-admin-credentials.txt`. Re-running the script upgrades in place.

Forgot the admin password? `sudo bash /opt/crapplet-panel/deploy/reset-admin.sh admin@crapplet.co.in` prints a new one
(`--list` shows every staff email).

**Back up `apps/api/.env`.** `APP_ENCRYPTION_KEY` encrypts hypervisor tokens, gateway secrets, VPS passwords
and 2FA seeds — losing it makes them unrecoverable.

Development: `npm install`, set `apps/api/.env` (see `.env.example`, `PROVISION_DRY_RUN=true`),
`npx prisma migrate deploy && SEED_DEMO=true npm run db:seed -w apps/api`, then run
`npm run dev -w apps/api`, `npx tsx src/worker.ts` (in apps/api) and `npm run dev -w apps/web`.

## After installing — go-live checklist

1. **Admin → Servers → Add server** (Proxmox): host, port 8006, API token `billing@pve!crapplet` + secret.
   Create the token in Proxmox with privileges on `/` (VM.Allocate, VM.Clone, VM.Config.*, VM.PowerMgmt,
   VM.Snapshot, VM.Backup, VM.Migrate, VM.Audit, Datastore.AllocateSpace, Datastore.Audit, Sys.Audit, SDN.Use).
   Click **Test connection**; nodes appear with live CPU/RAM. Set capacity thresholds per server.
2. **Admin → OS Templates**: set each OS's KVM template VMID (cloud-init templates, e.g. 9000 = Ubuntu 24.04)
   and/or LXC template volume. Windows templates should use cloudbase-init.
3. **Admin → IP Management → Import CIDR range** (e.g. `103.x.x.0/26`, gateway, server). Or import CSV.
4. **Admin → Products**: assign servers to each VPS plan (the IP picker shows that server's pool).
   All 30+ plans from your website are pre-seeded with their prices; quarterly/semi-annual/annual prices are
   seeded as simple multiples — adjust any discounts you offer. WordPress, Dedicated and GPU groups exist but
   have no plans yet (no prices on the site).
5. **Admin → Payment Gateways**: Razorpay (key id/secret + webhook secret), Cashfree, PayU, Stripe, UPI VPA,
   bank details. Point each gateway's webhook at the URL shown on its card.
6. **Admin → Settings**: company/GST details (pre-filled: GSTIN 23AAHCC8426G1ZR, Gwalior MP), invoice
   numbering, suspension/termination grace days, reminder schedule.
7. Domain TLD prices: **Admin → Domains → TLD pricing** (none are seeded for production).

## Migrating from WHMCS

**Admin → WHMCS Migration** copies your existing WHMCS data straight from its MySQL database.

1. On the WHMCS server create a read-only user: `GRANT SELECT ON whmcs.* TO 'migrate'@'<new server IP>' IDENTIFIED BY '…';`
   and allow port 3306 from the new server only (or use an SSH tunnel: `ssh -L 3307:127.0.0.1:3306 whmcs-host` and connect to 127.0.0.1:3307).
2. Enter the connection details and `cc_encryption_hash` (from WHMCS `configuration.php`), click **Test connection**.
3. Run a **Dry run** — the full import executes inside a transaction and is rolled back, so the report (created / updated /
   skipped per entity, plus warnings) is exactly what a real import would do.
4. Click **Import now**. It's all-or-nothing; re-running later only updates what changed (a delta sync for cutover day).

| WHMCS | Imported as |
|---|---|
| tblclients (+ GSTIN/PAN custom fields or `tax_id`, credit) | customers with billing profile, place-of-supply state code, opening credit. **Existing passwords keep working** (WHMCS `$2y$` bcrypt and old `md5:salt` hashes are accepted and upgraded to bcrypt on first login) |
| tblproductgroups / tblproducts / tblpricing | matched to the plans already here **by pid**; unknown plans are created (hidden settings kept), prices optional overwrite. Triennial billing is supported |
| tblservers (Proxmox / Virtualizor modules) | servers, imported **disabled** with the decrypted password; replace with a Proxmox API token, test, enable |
| tblhosting | services with status, cycle, amounts, next due date, hostname, decrypted root password, suspension reason, auto-suspend override, **dedicated + assigned IPs marked ALLOCATED**, VM/VPS id from the `vmid`/`vpsid` product custom field (the Proxmox node is detected automatically on first use) |
| tblhostingaddons, tbladdons, tblpromotions, tblorders | add-ons, promo codes (percentage / fixed), orders linked to invoices |
| tbldomains | domains with expiry, renewal price, auto-renew |
| tblinvoices / tblinvoiceitems / tblaccounts | invoices with WHMCS numbers, CGST+SGST (tax1+tax2) or IGST, partial payments, credit applied, wallet top-ups; payments and refunds. Unpaid renewal invoices line up with each service's next due date so customers are **not billed twice** |
| tbltickets / tblticketreplies / tblticketnotes | tickets with replies and internal notes (guest tickets matched by email) |
| announcements, knowledgebase, affiliates, admins (optional) | as-is; staff keep their WHMCS passwords |

Imported services never trigger provisioning or emails. Not carried over: ticket attachment files, domain nameservers
(stored at the registrar), cPanel/Plesk server modules (those services are imported as manual), "Free Setup"/"Price
Override" promo types, configurable-option selections. The WHMCS password decryption is a port of WHMCS's legacy
`decrypt()`; if your `cc_encryption_hash` doesn't match, passwords are left empty and listed as a warning (customers can
use **Reset password**). The importer was tested against a simulated WHMCS database with real table/column names —
always do a dry run against your real one first.

## What's built

- **Auth & accounts** — registration with GSTIN/PAN/address, email verification, password reset, TOTP 2FA,
  session list & revoke, login history, refresh-token rotation, httpOnly cookies + CSRF header, rate limits,
  staff roles & granular permissions, audit log.
- **IP selection (core requirement)** — customers pick an exact IPv4; held 15 min (configurable) via an atomic
  conditional `UPDATE`; expired holds released every minute; holds tied to the order at checkout; allocation
  inside the provisioning transaction with `FOR UPDATE` / `SKIP LOCKED`; per-service locking so one IP can never
  go to two services; quarantine on termination; full allocation history; CIDR/CSV import, rDNS, notes, bulk
  status, filtering by server/subnet/status/customer/location. If a hold expired and the IP was taken before
  payment, the next free IP on the same server is assigned and logged.
- **Proxmox VE** — multi-cluster, API tokens, node selection by capacity thresholds, KVM (clone template →
  cloud-init IP/gateway/password → resize disk → start) and LXC, extra IPs as extra NICs, suspend/unsuspend,
  terminate, start/stop/shutdown/reboot, reinstall (same VMID & IP), password reset, live stats & 24h graphs,
  admin snapshots/rollback/backup/migrate/clone, cluster overview with billing links. Retries are idempotent
  (VMID persisted before creation, Redis lock per service).
- **Virtualizor** — create (plan or resources), suspend/unsuspend, terminate, power, rebuild, root password,
  IPs, stats, VPS/plan listing, import existing VPS into billing.
- **Billing** — proforma → sequential GST tax invoice (`CC/2026-27/00001`) on payment, CGST+SGST vs IGST by
  place of supply, export zero-rating, inclusive/exclusive tax, SAC codes, PDF invoices (Inter font, ₹, amount in
  words), partial payments, wallet/credit, credit notes, refunds, promo codes (SPECIAL15 seeded), setup fees,
  add-ons, configurable options, renewal invoices, reminders, auto-suspend/unsuspend/terminate, GST monthly report
  with CSV export.
- **Payments** — Razorpay (checkout + signature + API re-check + webhook), Cashfree (v2023-08-01 + webhook),
  PayU (hash verified both ways), Stripe Checkout (signed webhook), UPI QR / bank transfer / manual with UTR
  submission and staff approval, generic HMAC custom gateway. Idempotent via unique `(gateway, txnId)` and
  stored webhook event ids; a browser "success" never activates anything on its own.
- **Reseller** — application/approval, wallet, wholesale prices + reseller discount, retail prices, customers,
  deploy/suspend/reboot/reinstall/terminate, API keys with IP allow-lists, REST API at `/api/v1/reseller`.
- **Support** — departments (the five you listed), priorities, SLA due times, attachments, internal notes,
  canned responses, assignment, auto-close, inbound email endpoint for piping.
- **Domains** — search (RDAP availability), register/transfer orders, renewals, nameservers, lock, auto-renew,
  DNS records, expiry alerts.
- **Also** — knowledgebase, announcements, downloads, affiliates/referral commissions, email templates editor
  with preview/test send, reports, settings.

## Not finished yet — be aware before launch

- **VM console (noVNC)**: the API can create VNC tickets (`vncProxy`), but there's no browser console or
  websocket proxy yet.
- **Registrar APIs**: domains use a "manual" registrar (RDAP checks; staff register at your registrar and mark
  the domain active). DNS records are stored but not pushed to a DNS server (PowerDNS/Cloudflare not wired).
- **Multi-currency checkout**: the data model stores prices per currency, but checkout and invoices currently
  run in INR. International customers get zero-rated GST and can pay with Stripe in INR.
- **GPU hourly billing** isn't supported (billing cycles start at monthly).
- **Email piping** is an HTTP endpoint (`POST /api/webhooks/email/inbound` with `X-Inbound-Secret`) — connect it
  from your mail provider's inbound webhook; there is no IMAP poller.
- **Live hypervisors**: Proxmox code is tested against a mock PVE API and dry-run mode, not a real cluster;
  Virtualizor parameter names follow the admin API docs but haven't been run against a live panel. Test both in
  staging first. Cashfree refunds must be done from its dashboard.
- **Initial migration**: `prisma/migrations/20261109000000_init` was generated from `schema.prisma` by a script
  (Prisma's engine downloads were blocked where this was built). It was applied and fully exercised by the
  tests; `install.sh` additionally runs `prisma migrate diff` as a check. Use `prisma migrate dev` for future
  schema changes.

## Tests

```bash
cd apps/api && npx tsx --test test/e2e.test.ts
```
Plus `npx tsx --test test/whmcs-import.test.ts` (dry run, full import, password compatibility, GST mapping, IP allocation, no double renewal billing, delta re-sync).

8 tests against real Postgres + Redis: GST maths; CIDR expansion; 25 customers racing for one IP (exactly one
wins) and expiry; concurrent allocation never duplicates; the full order flow (register → pick IP → SPECIAL15 →
checkout → forged webhook rejected → duplicate concurrent webhooks applied once → tax invoice number → VPS gets
the chosen IP → PDF → renewal invoice idempotent → overdue suspension → termination quarantines IP); staff
permissions and CSRF; reseller API scoping and wallet; Proxmox REST flow against a mock API (overloaded node
skipped, clone/config/resize/start).
