/**
 * WHMCS → Crapplet Cloud importer.
 *
 * Reads directly from the WHMCS MySQL database (read-only user recommended) and writes everything inside ONE
 * PostgreSQL transaction:
 *   - dry run  → the whole import executes and is then rolled back, so the report is exactly what a real run does
 *   - real run → commits atomically; any error rolls back everything
 * Every imported row is recorded in LegacyMap, so the import can be re-run (e.g. a final delta sync right before
 * cutover): existing records are updated instead of duplicated.
 */
import mysql from "mysql2/promise";
import bcrypt from "bcryptjs";
import { prisma, type Tx, BillingCycle, ServiceStatus, InvoiceStatus, InvoiceItemType, DomainStatus, TicketStatus, TicketPriority, Prisma } from "../../db";
import { encrypt, randomToken } from "../../lib/crypto";
import { addCycle } from "../../lib/money";
import { isIpv4, isIpv6, compressIpv6, expandIpv6 } from "../../lib/ip";
import { INDIAN_STATES, resolveStateCode } from "../auth/states";
import { whmcsDecrypt } from "./whmcs-crypto";

// ───────────────────────── source abstraction ─────────────────────────

export interface SourceDb {
  /** Returns all rows of a table, or [] if the table doesn't exist in this WHMCS version. */
  table<T = Row>(name: string): Promise<T[]>;
  close(): Promise<void>;
}
export type Row = Record<string, any>;

export interface MysqlConn {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
  ssl?: boolean;
}

/**
 * Turn MySQL connection failures into steps the admin can act on. The usual cause is that the
 * WHMCS database only accepts connections from its own server (cPanel's default).
 */
export function explainMysqlError(e: any, c: Pick<MysqlConn, "host" | "port" | "user" | "database">): string {
  const msg = String(e?.message ?? e);
  const code = e?.code as string | undefined;
  const seenAs = /Host '([^']+)' is not allowed/.exec(msg)?.[1];
  if (code === "ER_HOST_NOT_PRIVILEGED" || seenAs)
    return `The WHMCS MySQL server refused this panel${seenAs ? ` (it sees it as '${seenAs}')` : ""} — its database user is only allowed to connect from the WHMCS server itself. ` +
      `Fix on the WHMCS server: in cPanel open "Remote MySQL" (Databases section) and add this panel's public IP${seenAs ? ` and ${seenAs}` : ""} as an access host; ` +
      `then allow TCP port ${c.port} from that IP in its firewall (CSF: add the IP to csf.allow). ` +
      `Without cPanel: GRANT SELECT ON \`${c.database}\`.* TO '${c.user}'@'<panel IP>' IDENTIFIED BY '…'; ` +
      `Or use an SSH tunnel from this server and set the host to 127.0.0.1.`;
  if (code === "ER_ACCESS_DENIED_ERROR")
    return `MySQL rejected the user '${c.user}' or its password. Check the password, and that the user is allowed from this panel's IP (cPanel → Remote MySQL). (${msg})`;
  if (code === "ER_DBACCESS_DENIED_ERROR" || code === "ER_BAD_DB_ERROR")
    return `The user '${c.user}' can't open the database '${c.database}'. Check the database name, and in cPanel → MySQL Databases add the user to that database. (${msg})`;
  if (code === "ETIMEDOUT" || code === "ECONNREFUSED" || /timed? ?out|ECONNREFUSED/i.test(msg))
    return `Couldn't reach ${c.host}:${c.port} — the port is closed or blocked. On the WHMCS server allow port ${c.port} from this panel's IP in the firewall (CSF: csf.allow), and make sure MySQL listens on the public address (bind-address). (${msg})`;
  if (code === "ENOTFOUND" || code === "EAI_AGAIN")
    return `The host '${c.host}' doesn't resolve — use the WHMCS server's IP address instead. (${msg})`;
  return msg;
}

export async function mysqlSource(c: MysqlConn): Promise<SourceDb> {
  const conn = await mysql.createConnection({
    host: c.host,
    port: c.port,
    database: c.database,
    user: c.user,
    password: c.password,
    ssl: c.ssl ? { rejectUnauthorized: false } : undefined,
    dateStrings: true, // keep WHMCS's '0000-00-00' as strings
    supportBigNumbers: true,
    bigNumberStrings: true,
    connectTimeout: 15000,
    charset: "utf8mb4",
  }).catch((e) => {
    throw new Error(explainMysqlError(e, c));
  });
  const existing = new Set(((await conn.query("SHOW TABLES"))[0] as Row[]).map((r) => String(Object.values(r)[0]).toLowerCase()));
  return {
    async table<T>(name: string) {
      if (!existing.has(name.toLowerCase())) return [] as T[];
      if (!/^[a-z0-9_]+$/i.test(name)) throw new Error("bad table name");
      const [rows] = await conn.query(`SELECT * FROM \`${name}\``);
      return rows as T[];
    },
    close: () => conn.end(),
  };
}

// ───────────────────────── options / report ─────────────────────────

export const ENTITIES = [
  "currencies", "staff", "clients", "productGroups", "servers", "products", "addons", "promotions",
  "orders", "services", "domains", "invoices", "transactions", "tickets", "announcements", "knowledgebase", "affiliates",
] as const;
export type Entity = (typeof ENTITIES)[number];
export const DEFAULT_ENTITIES: Entity[] = ENTITIES.filter((e) => e !== "staff");

export interface ImportOptions {
  entities: Entity[];
  dryRun: boolean;
  ccEncryptionHash?: string;
  /** overwrite prices of products that already exist here (matched by WHMCS pid) */
  overwritePricing?: boolean;
  /** skip invoices/transactions/tickets older than this date (keeps history smaller) */
  historySince?: string | null;
}

export interface Counts { created: number; updated: number; skipped: number }
export interface ImportResult { counts: Record<string, Counts>; warnings: { entity: string; id: string; message: string }[]; dryRun: boolean; ms: number }
type Progress = (p: { entity: string; done: number; total: number }) => Promise<void> | void;

class DryRunRollback extends Error {
  constructor(public result: ImportResult) {
    super("dry run");
  }
}

// ───────────────────────── value helpers ─────────────────────────

const paise = (v: unknown) => {
  const n = parseFloat(String(v ?? "0"));
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
};
const dt = (v: unknown): Date | null => {
  if (!v) return null;
  const s = String(v);
  if (s.startsWith("0000")) return null;
  const d = new Date(s.length === 10 ? `${s}T00:00:00+05:30` : s.replace(" ", "T") + "+05:30");
  return Number.isNaN(d.getTime()) ? null : d;
};
const str = (v: unknown) => (v === null || v === undefined ? "" : String(v)).trim();
const nul = (v: unknown) => str(v) || null;
const slugify = (s: string) => s.toLowerCase().replace(/&/g, " and ").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "item";
const GSTIN_RE = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;
const PAN_RE = /^[A-Z]{5}[0-9]{4}[A-Z]$/;

export const CYCLE_MAP: Record<string, BillingCycle> = {
  monthly: "MONTHLY", quarterly: "QUARTERLY", "semi-annually": "SEMIANNUAL", semiannually: "SEMIANNUAL", annually: "ANNUAL",
  biennially: "BIENNIAL", triennially: "TRIENNIAL", "one time": "ONETIME", onetime: "ONETIME", "free account": "ONETIME", free: "ONETIME",
};
const SERVICE_STATUS: Record<string, ServiceStatus> = { active: "ACTIVE", pending: "PENDING", suspended: "SUSPENDED", terminated: "TERMINATED", cancelled: "CANCELLED", fraud: "CANCELLED", completed: "TERMINATED" };
const INVOICE_STATUS: Record<string, InvoiceStatus> = { paid: "PAID", unpaid: "UNPAID", cancelled: "CANCELLED", refunded: "REFUNDED", collections: "COLLECTIONS", draft: "DRAFT", "payment pending": "UNPAID" };
const DOMAIN_STATUS: Record<string, DomainStatus> = { active: "ACTIVE", pending: "PENDING", "pending registration": "PENDING", "pending transfer": "PENDING_TRANSFER", expired: "EXPIRED", grace: "EXPIRED", redemption: "EXPIRED", cancelled: "CANCELLED", fraud: "CANCELLED", "transferred away": "TRANSFERRED_AWAY" };
const TICKET_STATUS: Record<string, TicketStatus> = { open: "OPEN", answered: "ANSWERED", "customer-reply": "CUSTOMER_REPLY", closed: "CLOSED", "on hold": "ON_HOLD", "in progress": "IN_PROGRESS" };
const GATEWAY_MAP: Record<string, string> = { banktransfer: "bank", mailin: "manual", "": "manual", payumoney: "payu", payubiz: "payu", stripe_checkout: "stripe", razorpayx: "razorpay" };
const ITEM_TYPE: Record<string, InvoiceItemType> = {
  hosting: "SERVICE", setup: "SETUP", promohosting: "PROMO", promodomain: "PROMO", addon: "ADDON", domainregister: "DOMAIN", domaintransfer: "DOMAIN", domain: "DOMAIN",
  domainaddondns: "DOMAIN", domainaddonemf: "DOMAIN", domainaddonidp: "DOMAIN", latefee: "LATE_FEE", addfunds: "WALLET", invoice: "CUSTOM", item: "CUSTOM", upgrade: "SERVICE",
};

function guessType(name: string, group: string, whmcsType: string) {
  const s = `${group} ${name}`.toLowerCase();
  if (/windows/.test(s)) return "VPS_WINDOWS";
  if (/forex|mt4|mt5/.test(s)) return "VPS_FOREX";
  if (/tally/.test(s)) return "TALLY";
  if (/minecraft/.test(s)) return "VPS_MINECRAFT";
  if (/n8n/.test(s)) return "VPS_N8N";
  if (/gold/.test(s)) return "VPS_GOLD";
  if (/gpu/.test(s)) return "GPU";
  if (/colo|rack/.test(s)) return "COLOCATION";
  if (/dedicated|bare.?metal/.test(s)) return "DEDICATED";
  if (/vps|kvm|cloud server|virtual/.test(s)) return "VPS_LINUX";
  if (/wordpress|\bwp\b/.test(s)) return "WORDPRESS";
  if (/reseller/.test(s) || whmcsType === "reselleraccount") return "RESELLER_HOSTING";
  if (whmcsType === "hostingaccount") return "SHARED";
  if (whmcsType === "server") return "DEDICATED";
  return "CUSTOM";
}

// ───────────────────────── connection test ─────────────────────────

export async function inspectSource(src: SourceDb) {
  const cfg = await src.table("tblconfiguration");
  const version = cfg.find((r) => r.setting === "Version")?.value ?? "unknown";
  const company = cfg.find((r) => r.setting === "CompanyName")?.value ?? "";
  const tables = ["tblclients", "tblproducts", "tblhosting", "tbldomains", "tblinvoices", "tblaccounts", "tbltickets", "tblservers", "tbladmins", "tblpromotions"];
  const counts: Record<string, number> = {};
  for (const t of tables) counts[t] = (await src.table(t)).length;
  return { version, company, counts };
}

// ───────────────────────── importer ─────────────────────────

export async function runWhmcsImport(src: SourceDb, opts: ImportOptions, onProgress: Progress = () => {}): Promise<ImportResult> {
  const started = Date.now();
  const want = (e: Entity) => opts.entities.includes(e);
  const since = opts.historySince ? new Date(opts.historySince) : null;
  const counts: Record<string, Counts> = {};
  const warnings: ImportResult["warnings"] = [];
  const c = (e: string) => (counts[e] ??= { created: 0, updated: 0, skipped: 0 });
  const warn = (entity: string, id: unknown, message: string) => {
    if (warnings.length < 5000) warnings.push({ entity, id: String(id), message });
  };

  // read everything up front (outside the write transaction)
  const T = async (name: string) => src.table(name);
  const [customFields, customValues, pricing, currencies] = await Promise.all([T("tblcustomfields"), T("tblcustomfieldsvalues"), T("tblpricing"), T("tblcurrencies")]);
  const currencyCode = new Map(currencies.map((r) => [String(r.id), str(r.code).toUpperCase()]));
  const defaultCurrency = str(currencies.find((r) => Number(r.default) === 1)?.code ?? "INR").toUpperCase();
  const cfValue = (fieldIds: Set<string>, relid: unknown) => customValues.find((v) => fieldIds.has(String(v.fieldid)) && String(v.relid) === String(relid) && str(v.value))?.value;
  const clientFields = (re: RegExp) => new Set(customFields.filter((f) => f.type === "client" && re.test(str(f.fieldname))).map((f) => String(f.id)));
  const gstFields = clientFields(/gst/i);
  const panFields = clientFields(/\bpan\b|pan number|pan no/i);

  const run = async (tx: Tx): Promise<ImportResult> => {
    // legacy map cache
    const map = new Map<string, string>();
    for (const m of await tx.legacyMap.findMany({ where: { source: "whmcs" } })) map.set(`${m.entity}:${m.legacyId}`, m.localId);
    const get = (entity: string, id: unknown) => (id === null || id === undefined || id === "" || id === 0 || id === "0" ? undefined : map.get(`${entity}:${id}`));
    const setMap = async (entity: string, id: unknown, localId: string) => {
      map.set(`${entity}:${id}`, localId);
      await tx.legacyMap.upsert({ where: { source_entity_legacyId: { source: "whmcs", entity, legacyId: String(id) } }, update: { localId }, create: { source: "whmcs", entity, legacyId: String(id), localId } });
    };
    const tick = async (entity: string, done: number, total: number) => {
      if (done === total || done % 250 === 0) await onProgress({ entity, done, total });
    };

    // ── currencies ──
    if (want("currencies")) {
      for (const r of currencies) {
        const code = str(r.code).toUpperCase();
        if (!/^[A-Z]{3}$/.test(code)) continue;
        const exists = await tx.currency.findUnique({ where: { code } });
        await tx.currency.upsert({ where: { code }, update: { rate: Number(r.rate) || 1 }, create: { code, prefix: str(r.prefix) || code, suffix: str(r.suffix), rate: Number(r.rate) || 1, isDefault: false } });
        c("currencies")[exists ? "updated" : "created"]++;
      }
      if (defaultCurrency !== "INR") warn("currencies", defaultCurrency, `WHMCS default currency is ${defaultCurrency}; this panel bills in INR`);
    }

    // ── staff ──
    if (want("staff")) {
      const roles = await tx.role.findMany();
      const admin = roles.find((r) => r.name === "Administrator");
      const agent = roles.find((r) => r.name === "Support Agent") ?? admin;
      const rows = await T("tbladmins");
      for (const r of rows) {
        const email = str(r.email).toLowerCase();
        if (get("staff", r.id)) { c("staff").skipped++; continue; }
        const existing = email ? await tx.user.findUnique({ where: { email } }) : null;
        if (!email || existing) {
          if (existing?.type === "STAFF") await setMap("staff", r.id, existing.id);
          else warn("staff", r.id, `${email || r.username}: email missing or used by a customer — not imported`);
          c("staff").skipped++;
          continue;
        }
        const u = await tx.user.create({
          data: { type: "STAFF", email, firstName: str(r.firstname) || str(r.username), lastName: str(r.lastname), passwordHash: str(r.password) || (await bcrypt.hash(randomToken(), 10)), roleId: (Number(r.roleid) === 1 ? admin : agent)?.id, status: Number(r.disabled) ? "INACTIVE" : "ACTIVE", emailVerifiedAt: new Date() },
        });
        await setMap("staff", r.id, u.id);
        c("staff").created++;
      }
    }

    // ── clients ──
    const clientRows = await T("tblclients");
    if (want("clients")) {
      let i = 0;
      for (const r of clientRows) {
        i++;
        const email = str(r.email).toLowerCase();
        if (!email || !email.includes("@")) { warn("clients", r.id, "no valid email — skipped"); c("clients").skipped++; continue; }
        const country = (str(r.country) || "IN").toUpperCase().slice(0, 2);
        let gstin: string | null = (str(r.tax_id) || str(cfValue(gstFields, r.id))).toUpperCase().replace(/\s/g, "") || null;
        if (gstin && !GSTIN_RE.test(gstin)) { warn("clients", r.id, `${email}: invalid GSTIN "${gstin}" not imported`); gstin = null; }
        let pan: string | null = str(cfValue(panFields, r.id)).toUpperCase() || null;
        if (pan && !PAN_RE.test(pan)) pan = null;
        const state = str(r.state);
        const stateCode = resolveStateCode(country, state, gstin, null);
        const profile = {
          companyName: nul(r.companyname), gstin, pan, address1: str(r.address1), address2: nul(r.address2), city: str(r.city), state, stateCode, country, postcode: str(r.postcode),
          currency: currencyCode.get(String(r.currency)) ?? defaultCurrency, notes: nul(r.notes),
        };
        const status = ({ active: "ACTIVE", inactive: "INACTIVE", closed: "CLOSED" } as const)[str(r.status).toLowerCase() as "active"] ?? "ACTIVE";
        const credit = paise(r.credit);
        let localId = get("client", r.id);
        if (!localId) {
          const existing = await tx.user.findUnique({ where: { email } });
          if (existing) {
            if (existing.type !== "CLIENT") { warn("clients", r.id, `${email} belongs to a staff account — skipped`); c("clients").skipped++; continue; }
            localId = existing.id;
            await setMap("client", r.id, localId);
            warn("clients", r.id, `${email} already existed here — linked to the existing account`);
          }
        }
        if (localId) {
          await tx.user.update({ where: { id: localId }, data: { firstName: str(r.firstname) || "Customer", lastName: str(r.lastname), phone: nul(r.phonenumber), status, profile: { upsert: { create: { ...profile, creditBalance: credit }, update: profile } } } });
          const prof = await tx.clientProfile.findUniqueOrThrow({ where: { userId: localId } });
          if (prof.creditBalance !== credit) {
            const local = await tx.creditLedger.count({ where: { userId: localId, NOT: { refType: "whmcs" } } });
            if (!local) {
              await tx.clientProfile.update({ where: { userId: localId }, data: { creditBalance: credit } });
              await tx.creditLedger.create({ data: { userId: localId, amount: credit - prof.creditBalance, balanceAfter: credit, description: "Credit re-synced from WHMCS", refType: "whmcs", refId: String(r.id) } });
            } else warn("clients", r.id, `${email}: credit differs (WHMCS ${credit / 100}, here ${prof.creditBalance / 100}) but has new activity here — left unchanged`);
          }
          c("clients").updated++;
        } else {
          const created = dt(r.datecreated) ?? new Date();
          const u = await tx.user.create({
            data: {
              email, firstName: str(r.firstname) || "Customer", lastName: str(r.lastname), phone: nul(r.phonenumber), status,
              // WHMCS bcrypt/md5 hashes are accepted at login and upgraded automatically
              passwordHash: str(r.password) || (await bcrypt.hash(randomToken(), 10)),
              emailVerifiedAt: created, createdAt: created,
              profile: { create: { ...profile, creditBalance: credit } },
            },
          });
          if (credit) await tx.creditLedger.create({ data: { userId: u.id, amount: credit, balanceAfter: credit, description: "Opening credit balance imported from WHMCS", refType: "whmcs", refId: String(r.id) } });
          await setMap("client", r.id, u.id);
          c("clients").created++;
        }
        await tick("clients", i, clientRows.length);
      }
    }
    const clientEmail = new Map(clientRows.map((r) => [String(r.id), str(r.email).toLowerCase()]));

    // ── product groups ──
    const groups = await T("tblproductgroups");
    if (want("productGroups")) {
      for (const g of groups) {
        if (get("productGroup", g.id)) { c("productGroups").skipped++; continue; }
        const slug = slugify(str(g.name));
        const existing = await tx.productGroup.findUnique({ where: { slug } });
        const local = existing ?? (await tx.productGroup.create({ data: { name: str(g.name), slug, headline: nul(g.headline) ?? nul(g.tagline), hidden: !!Number(g.hidden), sortOrder: Number(g.order) || 0 } }));
        await setMap("productGroup", g.id, local.id);
        c("productGroups")[existing ? "skipped" : "created"]++;
      }
    }

    // ── servers ──
    const servers = await T("tblservers");
    if (want("servers")) {
      for (const s of servers) {
        const type = str(s.type).toLowerCase();
        const kind = type.includes("proxmox") ? "PROXMOX" : type.includes("virtualizor") ? "VIRTUALIZOR" : null;
        if (!kind) { warn("servers", s.id, `${s.name}: module "${type}" has no equivalent here — services on it are imported as manual`); c("servers").skipped++; continue; }
        if (get("server", s.id)) { c("servers").skipped++; continue; }
        const secret = whmcsDecrypt(s.password, opts.ccEncryptionHash ?? "") ?? "";
        if (s.password && !secret) warn("servers", s.id, `${s.name}: could not decrypt the stored password (check cc_encryption_hash)`);
        const local = await tx.server.create({
          data: {
            name: `${str(s.name)} (WHMCS)`, type: kind, hostname: str(s.hostname) || str(s.ipaddress), port: Number(s.port) || (kind === "PROXMOX" ? 8006 : 4085),
            apiUser: nul(s.username), apiSecretEnc: secret ? encrypt(secret) : null, verifyTls: false, enabled: false,
          },
        });
        await setMap("server", s.id, local.id);
        warn("servers", s.id, `${s.name}: imported DISABLED — ${kind === "PROXMOX" ? "replace with an API token (user@realm!token) and " : ""}run Test connection before enabling`);
        c("servers").created++;
      }
    }
    const groupServers = await T("tblservergroupsrel");

    // ── products ──
    const products = await T("tblproducts");
    const groupName = new Map(groups.map((g) => [String(g.id), str(g.name)]));
    const priceRows = (type: string, relid: unknown) => pricing.filter((p) => p.type === type && String(p.relid) === String(relid));
    const buildPricing = (type: string, relid: unknown, paytype: string) => {
      const out: { cycle: BillingCycle; currency: string; price: number; setupFee: number; enabled: boolean }[] = [];
      for (const p of priceRows(type, relid)) {
        const currency = currencyCode.get(String(p.currency));
        if (!currency) continue;
        const pairs: [BillingCycle, string, string][] = paytype === "onetime" || paytype === "free"
          ? [["ONETIME", "monthly", "msetupfee"]]
          : [["MONTHLY", "monthly", "msetupfee"], ["QUARTERLY", "quarterly", "qsetupfee"], ["SEMIANNUAL", "semiannually", "ssetupfee"], ["ANNUAL", "annually", "asetupfee"], ["BIENNIAL", "biennially", "bsetupfee"], ["TRIENNIAL", "triennially", "tsetupfee"]];
        for (const [cycle, col, setup] of pairs) {
          const v = parseFloat(String(p[col] ?? "-1"));
          if (paytype === "free") { out.push({ cycle, currency, price: 0, setupFee: 0, enabled: true }); continue; }
          if (!(v >= 0)) continue;
          out.push({ cycle, currency, price: paise(v), setupFee: Math.max(0, paise(p[setup])), enabled: true });
        }
      }
      return out;
    };
    if (want("products")) {
      let i = 0;
      for (const p of products) {
        i++;
        const prices = buildPricing("product", p.id, str(p.paytype).toLowerCase());
        const serverIds = groupServers.filter((g) => String(g.groupid) === String(p.servergroup)).map((g) => get("server", g.serverid)).filter(Boolean) as string[];
        let localId = get("product", p.id) ?? (await tx.product.findUnique({ where: { legacyPid: Number(p.id) } }))?.id;
        if (localId) {
          if (!get("product", p.id)) await setMap("product", p.id, localId);
          if (opts.overwritePricing && prices.length) {
            await tx.productPricing.deleteMany({ where: { productId: localId } });
            await tx.productPricing.createMany({ data: prices.map((x) => ({ ...x, productId: localId! })) });
            c("products").updated++;
          } else c("products").skipped++;
          if (serverIds.length) await tx.productServer.createMany({ data: serverIds.map((serverId) => ({ productId: localId!, serverId })), skipDuplicates: true });
        } else {
          const gid = get("productGroup", p.gid) ?? (await tx.productGroup.upsert({ where: { slug: "imported" }, update: {}, create: { name: "Imported from WHMCS", slug: "imported", hidden: true, sortOrder: 99 } })).id;
          let slug = slugify(str(p.name));
          if (await tx.product.findUnique({ where: { slug } })) slug = `${slug}-${p.id}`;
          const st = str(p.servertype).toLowerCase();
          const provisioner = st.includes("proxmox") ? "PROXMOX" : st.includes("virtualizor") ? "VIRTUALIZOR" : "MANUAL";
          const created = await tx.product.create({
            data: {
              groupId: gid, legacyPid: Number(p.id), name: str(p.name), slug, type: guessType(str(p.name), groupName.get(String(p.gid)) ?? "", str(p.type)) as never,
              description: nul(p.description), provisioner, allowIpSelection: provisioner !== "MANUAL", ipv4Count: provisioner !== "MANUAL" ? 1 : 0,
              enabled: !Number(p.retired), hidden: !!Number(p.hidden), sortOrder: Number(p.order) || 0, autoSetup: provisioner === "MANUAL" ? "MANUAL" : "ON_PAYMENT",
              pricing: { create: prices },
            },
          });
          if (serverIds.length) await tx.productServer.createMany({ data: serverIds.map((serverId) => ({ productId: created.id, serverId })), skipDuplicates: true });
          await setMap("product", p.id, created.id);
          if (provisioner !== "MANUAL") warn("products", p.id, `${p.name}: set CPU/RAM/disk and OS templates before selling it again`);
          c("products").created++;
        }
        await tick("products", i, products.length);
      }
    }

    // ── add-ons ──
    if (want("addons")) {
      for (const a of await T("tbladdons")) {
        if (get("addon", a.id)) { c("addons").skipped++; continue; }
        const pr = priceRows("addon", a.id).find((x) => currencyCode.get(String(x.currency)) === "INR") ?? priceRows("addon", a.id)[0];
        const monthly = pr ? Math.max(0, paise(pr.monthly)) : 0;
        const created = await tx.addon.create({ data: { name: str(a.name), description: nul(a.description), monthly, setupFee: pr ? Math.max(0, paise(pr.msetupfee)) : 0, taxable: !!Number(a.tax), enabled: !Number(a.retired) } });
        const pids = str(a.packages).split(",").map((x) => get("product", x.trim())).filter(Boolean) as string[];
        if (pids.length) await tx.addonProduct.createMany({ data: pids.map((productId) => ({ productId, addonId: created.id })), skipDuplicates: true });
        await setMap("addon", a.id, created.id);
        c("addons").created++;
      }
    }

    // ── promotions ──
    if (want("promotions")) {
      for (const p of await T("tblpromotions")) {
        const code = str(p.code).toUpperCase();
        if (!code || get("promotion", p.id) || (await tx.promoCode.findUnique({ where: { code } }))) { c("promotions").skipped++; continue; }
        const t = str(p.type).toLowerCase();
        if (t !== "percentage" && t !== "fixed amount") { warn("promotions", p.id, `${code}: type "${p.type}" not supported — skipped`); c("promotions").skipped++; continue; }
        const created = await tx.promoCode.create({
          data: {
            code, type: t === "percentage" ? "PERCENT" : "FIXED", value: t === "percentage" ? Math.round(parseFloat(p.value)) : paise(p.value), recurring: !!Number(p.recurring),
            productIds: str(p.appliesto).split(",").map((x) => get("product", x.trim())).filter(Boolean) as string[],
            cycles: str(p.cycles).split(",").map((x) => CYCLE_MAP[x.trim().toLowerCase()]).filter((x) => x && x !== "ONETIME") as BillingCycle[],
            maxUses: Number(p.maxuses) || 0, uses: Number(p.uses) || 0, newOnly: !!Number(p.newsignups), startsAt: dt(p.startdate), expiresAt: dt(p.expirationdate),
            enabled: !dt(p.expirationdate) || dt(p.expirationdate)! > new Date(),
          },
        });
        await setMap("promotion", p.id, created.id);
        c("promotions").created++;
      }
    }

    // ── orders ──
    const orders = await T("tblorders");
    if (want("orders")) {
      let i = 0;
      for (const o of orders) {
        i++;
        const userId = get("client", o.userid);
        if (!userId) { c("orders").skipped++; continue; }
        const status = ({ active: "ACTIVE", pending: "PENDING", cancelled: "CANCELLED", fraud: "FRAUD" } as const)[str(o.status).toLowerCase() as "active"] ?? "ACTIVE";
        const existing = get("order", o.id);
        if (existing) { await tx.order.update({ where: { id: existing }, data: { status } }); c("orders").updated++; continue; }
        let number = `WH-${str(o.ordernum) || o.id}`;
        if (await tx.order.findUnique({ where: { number } })) number = `${number}-${o.id}`;
        const created = await tx.order.create({ data: { number, userId, status, total: paise(o.amount), promoCode: nul(o.promocode), ip: nul(o.ipaddress), notes: nul(o.notes), createdAt: dt(o.date) ?? new Date() } });
        await setMap("order", o.id, created.id);
        c("orders").created++;
        await tick("orders", i, orders.length);
      }
    }

    // ── services (tblhosting) ──
    const hosting = await T("tblhosting");
    if (want("services")) {
      const vmFields = new Map<string, Set<string>>();
      const nodeFields = new Map<string, Set<string>>();
      for (const f of customFields.filter((f) => f.type === "product")) {
        const name = str(f.fieldname).split("|")[0].trim();
        const bucket = /^(vpsid|vps ?id|vmid|vm ?id|vserverid|proxmox ?(vm)? ?id)$/i.test(name) ? vmFields : /^node$/i.test(name) ? nodeFields : null;
        if (bucket) (bucket.get(String(f.relid)) ?? bucket.set(String(f.relid), new Set()).get(String(f.relid))!).add(String(f.id));
      }
      let i = 0;
      let undecrypted = 0;
      for (const h of hosting) {
        i++;
        await tick("services", i, hosting.length);
        const userId = get("client", h.userid);
        const productId = get("product", h.packageid);
        if (!userId || !productId) { warn("services", h.id, `${h.domain || "service"}: ${!userId ? "client" : "product"} not imported — skipped`); c("services").skipped++; continue; }
        const cycle = CYCLE_MAP[str(h.billingcycle).toLowerCase()] ?? "MONTHLY";
        const status = SERVICE_STATUS[str(h.domainstatus).toLowerCase()] ?? "ACTIVE";
        let passwordEnc: string | null = null;
        if (str(h.password)) {
          const pw = whmcsDecrypt(h.password, opts.ccEncryptionHash ?? "");
          if (pw) passwordEnc = encrypt(pw);
          else undecrypted++;
        }
        const remoteId = str(cfValue(vmFields.get(String(h.packageid)) ?? new Set(), h.id)) || null;
        const node = str(cfValue(nodeFields.get(String(h.packageid)) ?? new Set(), h.id)) || null;
        const product = await tx.product.findUniqueOrThrow({ where: { id: productId } });
        const data = {
          status,
          billingCycle: cycle,
          recurringAmount: str(h.billingcycle).toLowerCase() === "free account" ? 0 : paise(h.amount),
          nextDueDate: cycle === "ONETIME" ? null : dt(h.nextduedate),
          nextInvoiceDate: cycle === "ONETIME" ? null : dt(h.nextinvoicedate) ?? dt(h.nextduedate),
          hostname: nul(h.domain),
          username: nul(h.username),
          ...(passwordEnc ? { passwordEnc } : {}),
          serverId: get("server", h.server) ?? null,
          suspendReason: status === "SUSPENDED" ? nul(h.suspendreason) ?? "Suspended in WHMCS" : null,
          overrideAutoSuspend: !!Number(h.overideautosuspend),
          terminationDate: dt(h.termination_date),
          notes: nul(h.notes),
          ...(remoteId ? { remoteId } : {}),
          ...(node ? { node } : {}),
        };
        let localId = get("service", h.id);
        if (localId) {
          await tx.service.update({ where: { id: localId }, data });
          c("services").updated++;
        } else {
          const created = await tx.service.create({
            data: { ...data, userId, productId, orderId: get("order", h.orderid) ?? null, currency: "INR", firstAmount: paise(h.firstpaymentamount), registrationDate: dt(h.regdate) ?? new Date(), virtType: product.provisioner === "MANUAL" ? null : product.virtType, config: { importedFrom: "whmcs", whmcsId: String(h.id) } },
          });
          localId = created.id;
          await setMap("service", h.id, localId);
          c("services").created++;
        }
        // IP addresses
        const ips = [str(h.dedicatedip), ...str(h.assignedips).split(/[\s,;]+/)].map((x) => x.trim()).filter(Boolean);
        const seen = new Set<string>();
        for (const [idx, raw] of ips.entries()) {
          const v6 = isIpv6(raw);
          if (!isIpv4(raw) && !v6) { warn("services", h.id, `invalid IP "${raw}" ignored`); continue; }
          const address = v6 ? compressIpv6(expandIpv6(raw)!) : raw;
          if (seen.has(address)) continue;
          seen.add(address);
          const live = !["TERMINATED", "CANCELLED"].includes(status);
          const ip = await tx.ipAddress.findUnique({ where: { address } });
          if (ip?.serviceId && ip.serviceId !== localId) {
            if (live) warn("services", h.id, `${address} is already allocated to another service here — not assigned`);
            continue;
          }
          if (!live) continue; // history only: don't hold IPs of dead services
          const row = ip
            ? await tx.ipAddress.update({ where: { id: ip.id }, data: { status: "ALLOCATED", serviceId: localId, isPrimary: idx === 0, serverId: ip.serverId ?? data.serverId, reservedById: null, reservedOrderId: null, reservedUntil: null } })
            : await tx.ipAddress.create({ data: { address, version: v6 ? 6 : 4, status: "ALLOCATED", serviceId: localId, isPrimary: idx === 0, serverId: data.serverId } });
          if (!ip || ip.serviceId !== localId) await tx.ipHistory.create({ data: { ipId: row.id, action: "allocated", fromStatus: ip?.status ?? null, toStatus: "ALLOCATED", userId, serviceId: localId, note: `imported from WHMCS service #${h.id}` } });
        }
        if (product.provisioner !== "MANUAL" && status === "ACTIVE" && !remoteId) warn("services", h.id, `${h.domain || h.id}: no VM/VPS id custom field found — set it on the service to enable power controls`);
      }
      if (undecrypted) warn("services", "*", `${undecrypted} service passwords could not be decrypted (wrong or missing cc_encryption_hash) — customers can use "Reset password"`);
      // hosting add-ons
      for (const a of await T("tblhostingaddons")) {
        const serviceId = get("service", a.hostingid);
        const addonId = get("addon", a.addonid);
        if (!serviceId || !addonId || get("serviceAddon", a.id)) continue;
        const sa = await tx.serviceAddon.create({ data: { serviceId, addonId, recurringAmount: paise(a.recurring), status: str(a.status).toUpperCase() || "ACTIVE" } });
        await setMap("serviceAddon", a.id, sa.id);
        c("serviceAddons").created++;
      }
    }

    // ── domains ──
    if (want("domains")) {
      for (const d of await T("tbldomains")) {
        const userId = get("client", d.userid);
        const name = str(d.domain).toLowerCase();
        if (!userId || !name) { c("domains").skipped++; continue; }
        const data = {
          status: DOMAIN_STATUS[str(d.status).toLowerCase()] ?? "ACTIVE", registrar: str(d.registrar) || "manual", years: Number(d.registrationperiod) || 1,
          registrationDate: dt(d.registrationdate), expiryDate: dt(d.expirydate), nextDueDate: dt(d.nextduedate), recurringAmount: paise(d.recurringamount),
          autoRenew: !Number(d.donotrenew), idProtection: !!Number(d.idprotection),
        };
        let localId = get("domain", d.id);
        if (!localId) {
          const existing = await tx.domain.findUnique({ where: { name } });
          if (existing && existing.userId !== userId) { warn("domains", d.id, `${name} exists here for another customer — skipped`); c("domains").skipped++; continue; }
          localId = existing?.id;
        }
        if (localId) {
          await tx.domain.update({ where: { id: localId }, data });
          await setMap("domain", d.id, localId);
          c("domains").updated++;
        } else {
          const created = await tx.domain.create({ data: { ...data, userId, name, action: str(d.type).toLowerCase() === "transfer" ? "transfer" : "register", orderId: get("order", d.orderid) ?? null, nameservers: [] } });
          await setMap("domain", d.id, created.id);
          c("domains").created++;
        }
      }
    }

    // ── invoices ──
    if (want("invoices")) {
      const [invoices, items, accounts] = await Promise.all([T("tblinvoices"), T("tblinvoiceitems"), T("tblaccounts")]);
      const itemsBy = new Map<string, Row[]>();
      for (const it of items) (itemsBy.get(String(it.invoiceid)) ?? itemsBy.set(String(it.invoiceid), []).get(String(it.invoiceid))!).push(it);
      const paidBy = new Map<string, number>();
      for (const a of accounts) if (Number(a.invoiceid)) paidBy.set(String(a.invoiceid), (paidBy.get(String(a.invoiceid)) ?? 0) + paise(a.amountin) - paise(a.amountout));
      const profiles = new Map((await tx.clientProfile.findMany()).map((p) => [p.userId, p]));
      const users = new Map((await tx.user.findMany({ where: { type: "CLIENT" }, select: { id: true, firstName: true, lastName: true, email: true, phone: true } })).map((u) => [u.id, u]));
      const svcCycle = new Map((await tx.service.findMany({ select: { id: true, billingCycle: true } })).map((s) => [s.id, s.billingCycle]));
      let i = 0;
      for (const inv of invoices) {
        i++;
        await tick("invoices", i, invoices.length);
        const userId = get("client", inv.userid);
        if (!userId) { c("invoices").skipped++; continue; }
        const issue = dt(inv.date) ?? new Date();
        if (since && issue < since && str(inv.status).toLowerCase() !== "unpaid") { c("invoices").skipped++; continue; }
        const status = INVOICE_STATUS[str(inv.status).toLowerCase()] ?? "UNPAID";
        const credit = paise(inv.credit);
        const tax1 = paise(inv.tax), tax2 = paise(inv.tax2);
        const total = paise(inv.total) + credit;
        const paidAt = dt(inv.datepaid);
        const amountPaid = status === "PAID" ? total : Math.min(total, Math.max(0, (paidBy.get(String(inv.id)) ?? 0) + credit));
        const existing = get("invoice", inv.id);
        if (existing) {
          await tx.invoice.update({ where: { id: existing }, data: { status, amountPaid, paidAt: status === "PAID" ? paidAt ?? issue : null, dueDate: dt(inv.duedate) ?? issue } });
          c("invoices").updated++;
          continue;
        }
        const its = itemsBy.get(String(inv.id)) ?? [];
        const prof = profiles.get(userId);
        const u = users.get(userId);
        const twoTaxes = tax1 > 0 && tax2 > 0;
        const isWallet = its.length > 0 && its.every((x) => str(x.type).toLowerCase() === "addfunds");
        let number: string | null = status === "PAID" || status === "REFUNDED" ? str(inv.invoicenum) || String(inv.id) : null;
        if (number && (await tx.invoice.findUnique({ where: { number } }))) number = `${number}-WH${inv.id}`;
        const due = dt(inv.duedate) ?? issue;
        const created = await tx.invoice.create({
          data: {
            number, proformaNumber: `WH-${inv.id}`, userId, status, currency: prof?.currency ?? "INR", issueDate: issue, dueDate: due, paidAt: status === "PAID" ? paidAt ?? issue : null,
            subtotal: paise(inv.subtotal) + its.filter((x) => paise(x.amount) < 0).reduce((s, x) => s - paise(x.amount), 0),
            discount: its.filter((x) => paise(x.amount) < 0).reduce((s, x) => s - paise(x.amount), 0),
            taxableAmount: its.filter((x) => Number(x.taxed)).reduce((s, x) => s + paise(x.amount), 0),
            cgst: twoTaxes ? tax1 : 0, sgst: twoTaxes ? tax2 : 0, igst: twoTaxes ? 0 : tax1 + tax2, taxTotal: tax1 + tax2,
            gstRate: (parseFloat(inv.taxrate) || 0) + (twoTaxes ? parseFloat(inv.taxrate2) || 0 : 0),
            total, amountPaid, creditApplied: credit, isWalletTopup: isWallet,
            placeOfSupply: prof?.stateCode ? `${INDIAN_STATES[prof.stateCode] ?? ""} (${prof.stateCode})` : prof?.country && prof.country !== "IN" ? "Outside India (96)" : null,
            placeOfSupplyCode: prof?.stateCode ?? (prof?.country && prof.country !== "IN" ? "96" : null), customerGstin: prof?.gstin ?? null,
            billingSnapshot: { name: `${u?.firstName ?? ""} ${u?.lastName ?? ""}`.trim(), email: u?.email, phone: u?.phone, companyName: prof?.companyName, address1: prof?.address1, address2: prof?.address2, city: prof?.city, state: prof?.state, stateCode: prof?.stateCode, country: prof?.country, postcode: prof?.postcode, gstin: prof?.gstin },
            notes: [nul(inv.notes), `Imported from WHMCS invoice #${inv.id}`].filter(Boolean).join("\n"),
            items: {
              create: its.map((it) => {
                const type = ITEM_TYPE[str(it.type).toLowerCase()] ?? "CUSTOM";
                const rel = type === "SERVICE" || type === "SETUP" || (type === "PROMO" && str(it.type).toLowerCase() === "promohosting") ? get("service", it.relid) : type === "ADDON" ? get("serviceAddon", it.relid) : type === "DOMAIN" ? get("domain", it.relid) : undefined;
                const periodStart = type === "SERVICE" && rel ? dt(it.duedate) ?? due : null;
                const cyc = rel ? svcCycle.get(rel) : undefined;
                return {
                  type: isWallet ? "WALLET" : type, relId: rel ?? null, description: str(it.description).slice(0, 1000) || "Item", quantity: 1, unitPrice: paise(it.amount), amount: paise(it.amount), taxable: !!Number(it.taxed),
                  periodStart, periodEnd: periodStart && cyc && cyc !== "ONETIME" ? addCycle(periodStart, cyc) : null,
                };
              }),
            },
          },
        });
        await setMap("invoice", inv.id, created.id);
        c("invoices").created++;
      }
      // link orders → invoices
      for (const o of orders) {
        const oid = get("order", o.id);
        const iid = get("invoice", o.invoiceid);
        if (oid && iid && !(await tx.order.findFirst({ where: { invoiceId: iid } }))) await tx.order.update({ where: { id: oid }, data: { invoiceId: iid } });
      }
    }

    // ── transactions ──
    if (want("transactions")) {
      const rows = await T("tblaccounts");
      let i = 0;
      for (const a of rows) {
        i++;
        await tick("transactions", i, rows.length);
        if (get("transaction", a.id)) { c("transactions").skipped++; continue; }
        const userId = get("client", a.userid);
        const amountIn = paise(a.amountin), amountOut = paise(a.amountout);
        if (!userId || (!amountIn && !amountOut)) { c("transactions").skipped++; continue; }
        const when = dt(a.date) ?? new Date();
        if (since && when < since) { c("transactions").skipped++; continue; }
        const g = str(a.gateway).toLowerCase();
        const gateway = GATEWAY_MAP[g] ?? g;
        const type = amountOut > 0 ? "REFUND" : "PAYMENT";
        let txnId = str(a.transid) || `whmcs-${a.id}`;
        if (await tx.transaction.findUnique({ where: { gateway_gatewayTxnId_type: { gateway, gatewayTxnId: txnId, type } } })) txnId = `${txnId}#wh${a.id}`;
        const t = await tx.transaction.create({
          data: { userId, invoiceId: get("invoice", a.invoiceid) ?? null, gateway, gatewayTxnId: txnId, type, amount: amountOut > 0 ? amountOut : amountIn, fee: paise(a.fees), currency: currencyCode.get(String(a.currency)) ?? "INR", description: nul(a.description) ?? "Imported from WHMCS", createdAt: when },
        });
        await setMap("transaction", a.id, t.id);
        c("transactions").created++;
      }
    }

    // ── tickets ──
    if (want("tickets")) {
      const [depts, tickets, replies, notes] = await Promise.all([T("tblticketdepartments"), T("tbltickets"), T("tblticketreplies"), T("tblticketnotes")]);
      const localDepts = await tx.ticketDepartment.findMany();
      for (const d of depts) {
        if (get("department", d.id)) continue;
        const match = localDepts.find((x) => x.name.toLowerCase() === str(d.name).toLowerCase());
        const local = match ?? (await tx.ticketDepartment.create({ data: { name: str(d.name), email: nul(d.email), hidden: !!Number(d.hidden), sortOrder: Number(d.order) || 0 } }));
        await setMap("department", d.id, local.id);
      }
      const fallbackDept = (await tx.ticketDepartment.findFirst({ orderBy: { sortOrder: "asc" } }))?.id;
      const byEmail = new Map<string, string>();
      for (const [wid, email] of clientEmail) { const l = get("client", wid); if (l) byEmail.set(email, l); }
      const repliesBy = new Map<string, Row[]>();
      for (const r of replies) (repliesBy.get(String(r.tid)) ?? repliesBy.set(String(r.tid), []).get(String(r.tid))!).push(r);
      const notesBy = new Map<string, Row[]>();
      for (const n of notes) (notesBy.get(String(n.ticketid)) ?? notesBy.set(String(n.ticketid), []).get(String(n.ticketid))!).push(n);
      let i = 0;
      let attachments = 0;
      for (const t of tickets) {
        i++;
        await tick("tickets", i, tickets.length);
        const userId = get("client", t.userid) ?? byEmail.get(str(t.email).toLowerCase());
        const opened = dt(t.date) ?? new Date();
        if (!userId) { c("tickets").skipped++; continue; }
        if (since && opened < since && str(t.status).toLowerCase() === "closed") { c("tickets").skipped++; continue; }
        const status = TICKET_STATUS[str(t.status).toLowerCase()] ?? "OPEN";
        const priority = ({ low: "LOW", medium: "MEDIUM", high: "HIGH" } as Record<string, TicketPriority>)[str(t.urgency).toLowerCase()] ?? "MEDIUM";
        let ticketId = get("ticket", t.id);
        const svcRef = str(t.service).match(/^S(\d+)$/);
        const base = { status, priority, departmentId: get("department", t.did) ?? fallbackDept!, assignedToId: get("staff", t.flag) ?? null, serviceId: svcRef ? get("service", svcRef[1]) ?? null : null, lastReplyAt: dt(t.lastreply) ?? opened, closedAt: status === "CLOSED" ? dt(t.lastreply) ?? opened : null };
        if (ticketId) {
          await tx.ticket.update({ where: { id: ticketId }, data: base });
          c("tickets").updated++;
        } else {
          let number = str(t.tid) || `WH-${t.id}`;
          if (await tx.ticket.findUnique({ where: { number } })) number = `WH-${t.id}`;
          const created = await tx.ticket.create({
            data: { ...base, number, userId, subject: str(t.title).slice(0, 250) || "(no subject)", createdAt: opened, firstResponseAt: opened,
              messages: { create: { authorId: str(t.admin) ? null : userId, isStaff: !!str(t.admin), fromEmail: str(t.admin) || null, body: str(t.message) || "(empty)", createdAt: opened } } },
          });
          ticketId = created.id;
          await setMap("ticket", t.id, ticketId);
          c("tickets").created++;
        }
        if (str(t.attachment)) attachments++;
        for (const r of repliesBy.get(String(t.id)) ?? []) {
          if (get("ticketReply", r.id)) continue;
          if (str(r.attachment)) attachments++;
          const staff = !!str(r.admin);
          const m = await tx.ticketMessage.create({ data: { ticketId, authorId: staff ? null : get("client", r.userid) ?? userId, isStaff: staff, fromEmail: staff ? str(r.admin) : null, body: str(r.message) || "(empty)", createdAt: dt(r.date) ?? opened } });
          await setMap("ticketReply", r.id, m.id);
        }
        for (const n of notesBy.get(String(t.id)) ?? []) {
          if (get("ticketNote", n.id)) continue;
          const m = await tx.ticketMessage.create({ data: { ticketId, isStaff: true, isNote: true, fromEmail: str(n.admin) || "staff", body: str(n.message) || "(empty)", createdAt: dt(n.date) ?? opened } });
          await setMap("ticketNote", n.id, m.id);
        }
      }
      if (attachments) warn("tickets", "*", `${attachments} ticket attachments were not copied (files live on the WHMCS server under /attachments)`);
    }

    // ── announcements & knowledgebase ──
    if (want("announcements")) {
      for (const a of await T("tblannouncements")) {
        if (get("announcement", a.id) || Number(a.parentid)) { c("announcements").skipped++; continue; }
        const created = await tx.announcement.create({ data: { title: str(a.title) || "Announcement", body: str(a.announcement), published: !!Number(a.published), publishedAt: dt(a.date) ?? new Date() } });
        await setMap("announcement", a.id, created.id);
        c("announcements").created++;
      }
    }
    if (want("knowledgebase")) {
      const [cats, arts, links] = await Promise.all([T("tblknowledgebasecats"), T("tblknowledgebase"), T("tblknowledgebaselinks")]);
      for (const k of cats) {
        if (get("kbCategory", k.id) || Number(k.catid)) continue; // skip translations
        let slug = slugify(str(k.name));
        if (await tx.kbCategory.findUnique({ where: { slug } })) slug = `${slug}-${k.id}`;
        const created = await tx.kbCategory.create({ data: { name: str(k.name), slug } });
        await setMap("kbCategory", k.id, created.id);
      }
      for (const a of arts) {
        if (get("kbArticle", a.id) || Number(a.parentid)) { c("knowledgebase").skipped++; continue; }
        const catId = get("kbCategory", links.find((l) => String(l.articleid) === String(a.id))?.categoryid);
        if (!catId) { c("knowledgebase").skipped++; continue; }
        let slug = slugify(str(a.title));
        if (await tx.kbArticle.findUnique({ where: { slug } })) slug = `${slug}-${a.id}`;
        const created = await tx.kbArticle.create({ data: { categoryId: catId, title: str(a.title), slug, body: str(a.article), views: Number(a.views) || 0, published: !Number(a.private) } });
        await setMap("kbArticle", a.id, created.id);
        c("knowledgebase").created++;
      }
    }

    // ── affiliates ──
    if (want("affiliates")) {
      for (const a of await T("tblaffiliates")) {
        const userId = get("client", a.clientid);
        if (!userId || get("affiliate", a.id) || (await tx.affiliate.findUnique({ where: { userId } }))) { c("affiliates").skipped++; continue; }
        const pct = str(a.paytype).toLowerCase() === "percentage" ? Math.round(parseFloat(a.payamount) || 10) : 10;
        const created = await tx.affiliate.create({ data: { userId, code: randomToken(5).replace(/[-_]/g, "x").toUpperCase(), commissionPct: pct, balance: paise(a.balance), withdrawn: paise(a.withdrawn), visitors: Number(a.visitors) || 0 } });
        await setMap("affiliate", a.id, created.id);
        c("affiliates").created++;
      }
    }

    return { counts, warnings, dryRun: opts.dryRun, ms: Date.now() - started };
  };

  try {
    return await prisma.$transaction(
      async (tx) => {
        const result = await run(tx);
        if (opts.dryRun) throw new DryRunRollback(result);
        return result;
      },
      { timeout: 2 * 60 * 60 * 1000, maxWait: 60_000, isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted },
    );
  } catch (e) {
    if (e instanceof DryRunRollback) return { ...e.result, ms: Date.now() - started };
    throw e;
  }
}
