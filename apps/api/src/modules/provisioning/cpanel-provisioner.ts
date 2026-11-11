/**
 * Shared & reseller hosting on cPanel/WHM: create the account, suspend / unsuspend / terminate,
 * password and package changes, usage and one-click logins.
 */
import { prisma, type Server } from "../../db";
import { config } from "../../config";
import { decrypt, encrypt, generatePassword } from "../../lib/crypto";
import { WhmClient, WhmError, usernameFromDomain, toMb } from "./cpanel";

export type CpanelModuleConfig = {
  /** WHM package (plan) name */
  package?: string;
  /** make the account a reseller */
  reseller?: boolean;
  /** WHM ACL list the reseller gets (WHM → Edit Reseller Nameservers and Privileges) */
  acllist?: string;
  /** reseller limits; empty = unlimited */
  accountLimit?: number | null;
  diskMb?: number | null;
  bandwidthMb?: number | null;
  overselling?: boolean;
  /** on termination also remove the accounts the reseller created (default yes) */
  terminateSubAccounts?: boolean;
};

export class HostingError extends Error {
  constructor(message: string, public retryable = true) {
    super(message);
  }
}

export function whmFor(server: Server): WhmClient {
  return new WhmClient({ host: server.hostname, port: server.port || 2087, user: server.apiUser || "root", token: decrypt(server.apiSecretEnc), verifyTls: server.verifyTls });
}

const moduleConfig = (p: { moduleConfig: unknown }) => (((p.moduleConfig ?? {}) as { cpanel?: CpanelModuleConfig }).cpanel ?? {}) as CpanelModuleConfig;
export const isResellerProduct = (p: { type: string; moduleConfig: unknown }) => !!moduleConfig(p).reseller || p.type === "RESELLER_HOSTING";

type Svc = {
  id: string;
  userId: string;
  hostname: string | null;
  username: string | null;
  passwordEnc: string | null;
  remoteId: string | null;
  config: unknown;
  status: string;
  server: Server | null;
  user: { email: string; firstName: string };
  product: { id: string; name: string; type: string; moduleConfig: unknown; servers: { server: Server }[] };
};

async function log(serviceId: string, action: string, success: boolean, message?: string) {
  await prisma.provisioningLog.create({ data: { serviceId, action, success, message: message?.slice(0, 2000) } });
}

/** The server with the fewest live accounts among the plan's cPanel servers (respecting "max services"). */
async function pickServer(svc: Svc): Promise<Server> {
  if (svc.server) return svc.server;
  let servers = svc.product.servers.map((s) => s.server).filter((s) => s.type === "CPANEL" && s.enabled);
  if (!servers.length) servers = await prisma.server.findMany({ where: { type: "CPANEL", enabled: true } });
  if (!servers.length) throw new HostingError("No enabled cPanel/WHM server — add one under Infrastructure → Servers", false);
  const load = await Promise.all(servers.map(async (s) => ({ s, n: await prisma.service.count({ where: { serverId: s.id, status: { in: ["ACTIVE", "SUSPENDED", "PROVISIONING"] } } }) })));
  const fits = load.filter((x) => !x.s.maxServices || x.n < x.s.maxServices).sort((a, b) => a.n - b.n);
  if (!fits.length) throw new HostingError(`Every cPanel server for "${svc.product.name}" is full (Max services reached) — raise the limit or add a server`, false);
  return fits[0].s;
}

/** Free username for the domain: try the domain's name, then add digits. */
async function chooseUsername(whm: WhmClient, domain: string) {
  const base = usernameFromDomain(domain);
  if (await whm.usernameFree(base)) return base;
  for (let i = 0; i < 12; i++) {
    const u = `${base.slice(0, 5)}${Math.floor(100 + Math.random() * 900)}`;
    if (await whm.usernameFree(u)) return u;
  }
  throw new HostingError(`Couldn't find a free cPanel username for ${domain}`, true);
}

function nameserversOf(server: Server, created?: Record<string, unknown>) {
  if (server.nameservers?.length) return server.nameservers;
  return [created?.nameserver, created?.nameserver2, created?.nameserver3, created?.nameserver4].filter(Boolean).map(String);
}

/** Create (or adopt) the hosting account. Returns the details for the welcome email. */
export async function cpanelCreate(svc: Svc) {
  const mc = moduleConfig(svc.product);
  const domain = (svc.hostname ?? "").trim().toLowerCase();
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(domain)) throw new HostingError(`"${svc.hostname ?? ""}" isn't a valid domain — set the domain on the service, then retry`, false);
  if (!mc.package) throw new HostingError(`Plan "${svc.product.name}" has no WHM package — choose one under Products → ${svc.product.name} → Provisioning`, false);
  const server = await pickServer(svc);
  const reseller = isResellerProduct(svc.product);
  const whm = whmFor(server);
  await log(svc.id, "create", true, `cPanel server chosen: ${server.name}`);

  if (config.provisionDryRun) {
    const username = svc.username || usernameFromDomain(domain);
    const password = svc.passwordEnc ? decrypt(svc.passwordEnc) : generatePassword(16);
    await prisma.service.update({ where: { id: svc.id }, data: { serverId: server.id, username, passwordEnc: encrypt(password), remoteId: username, status: "ACTIVE" } });
    await log(svc.id, "create", true, `[dry run] cPanel account ${username} for ${domain} on ${server.name}`);
    return { username, password, domain, ip: "", server, nameservers: nameserversOf(server), reseller };
  }

  // an earlier attempt may have created it already (timeout, worker restart) — adopt it instead of failing
  const existing = (await whm.accounts({ by: "domain", value: domain }))[0];
  let username: string;
  let password: string;
  let ip = "";
  let created: Record<string, unknown> = {};
  if (existing) {
    if (svc.username && existing.user !== svc.username) throw new HostingError(`${domain} already exists on ${server.name} as cPanel user "${existing.user}" — it belongs to another account`, false);
    if (!svc.username) {
      const owner = await prisma.service.findFirst({ where: { serverId: server.id, remoteId: existing.user, id: { not: svc.id }, status: { notIn: ["TERMINATED", "CANCELLED"] } } });
      if (owner) throw new HostingError(`${domain} is already hosted on ${server.name} (service ${owner.id}) — use another domain`, false);
    }
    username = existing.user;
    password = svc.passwordEnc ? decrypt(svc.passwordEnc) : generatePassword(16);
    ip = existing.ip ?? "";
    await whm.changePassword(username, password).catch(() => undefined);
    await log(svc.id, "create", true, `Found the existing cPanel account ${username} for ${domain} on ${server.name} — adopted it`);
  } else {
    username = svc.username || (await chooseUsername(whm, domain));
    password = svc.passwordEnc ? decrypt(svc.passwordEnc) : generatePassword(16);
    // remember the chosen name first, so a retry after a timeout looks for the same account
    await prisma.service.update({ where: { id: svc.id }, data: { serverId: server.id, username, passwordEnc: encrypt(password) } });
    try {
      const r = await whm.createAccount({ username, domain, password, plan: mc.package, email: svc.user.email, reseller });
      created = r.data as Record<string, unknown>;
      ip = String(created.ip ?? "");
    } catch (e) {
      const m = (e as Error).message;
      // retry-safe: a duplicate means our previous attempt got through
      const again = (await whm.accounts({ by: "user", value: username }).catch(() => []))[0];
      if (!again || again.domain !== domain) {
        const permanent = e instanceof WhmError && /exists|already|taken|invalid|reserved|not allowed|package|plan/i.test(m);
        throw new HostingError(m, !permanent);
      }
      ip = again.ip ?? "";
    }
    await log(svc.id, "create", true, `cPanel account ${username} created for ${domain} on ${server.name} (package ${mc.package}${reseller ? ", reseller" : ""})`);
  }

  if (reseller) {
    await whm.setupReseller(username).catch((e) => {
      if (!/already/i.test((e as Error).message)) throw e;
    });
    if (mc.acllist) await whm.setAcls(username, mc.acllist);
    await whm.setResellerLimits(username, { accounts: mc.accountLimit ?? null, diskMb: mc.diskMb ?? null, bandwidthMb: mc.bandwidthMb ?? null, overselling: mc.overselling });
    await log(svc.id, "create", true, `Reseller privileges set${mc.acllist ? ` (ACL list ${mc.acllist})` : ""}${mc.accountLimit ? `, up to ${mc.accountLimit} accounts` : ""}`);
  }

  await prisma.service.update({ where: { id: svc.id }, data: { serverId: server.id, username, passwordEnc: encrypt(password), remoteId: username, status: "ACTIVE", hostname: domain } });
  return { username, password, domain, ip, server, nameservers: nameserversOf(server, created), reseller };
}

function requireAccount(svc: Svc) {
  if (!svc.server || !svc.remoteId) throw new HostingError("This hosting account hasn't been created on a cPanel server yet", false);
  return { whm: whmFor(svc.server), user: svc.remoteId, reseller: isResellerProduct(svc.product) };
}

export async function cpanelSuspend(svc: Svc, reason: string) {
  const { whm, user, reseller } = requireAccount(svc);
  if (config.provisionDryRun) return;
  // a reseller is suspended together with the accounts it owns
  if (reseller) await whm.suspendReseller(user, reason).catch(() => whm.suspend(user, reason));
  else await whm.suspend(user, reason);
}
export async function cpanelUnsuspend(svc: Svc) {
  const { whm, user, reseller } = requireAccount(svc);
  if (config.provisionDryRun) return;
  if (reseller) await whm.unsuspendReseller(user).catch(() => whm.unsuspend(user));
  else await whm.unsuspend(user);
}
export async function cpanelTerminate(svc: Svc) {
  if (!svc.server || !svc.remoteId || config.provisionDryRun) return;
  const { whm, user, reseller } = requireAccount(svc);
  const exists = await whm.summary(user);
  if (!exists) return; // already gone
  if (reseller && moduleConfig(svc.product).terminateSubAccounts !== false) await whm.terminateReseller(user);
  else await whm.remove(user);
}
export async function cpanelPassword(svc: Svc, password: string) {
  const { whm, user } = requireAccount(svc);
  if (!config.provisionDryRun) await whm.changePassword(user, password);
}
export async function cpanelChangePackage(svc: Svc, pkg: string) {
  const { whm, user } = requireAccount(svc);
  if (!config.provisionDryRun) await whm.changePackage(user, pkg);
}

/** Live state + usage for the admin/client pages. */
export async function cpanelStatus(svc: Svc) {
  const { whm, user, reseller } = requireAccount(svc);
  const a = await whm.summary(user);
  if (!a) return { state: "unknown" as const, reason: `cPanel user ${user} doesn't exist on ${svc.server!.name}` };
  const bw = await whm.bandwidth(user);
  return {
    state: a.suspended && String(a.suspended) !== "0" ? ("suspended" as const) : ("running" as const),
    reason: a.suspendreason && a.suspendreason !== "not suspended" ? a.suspendreason : undefined,
    domain: a.domain,
    ip: a.ip,
    plan: a.plan,
    reseller,
    disk: { usedMb: toMb(a.diskused) ?? 0, limitMb: toMb(a.disklimit) },
    bandwidth: bw,
    server: { name: svc.server!.name, hostname: whm.host },
    nameservers: svc.server!.nameservers ?? [],
  };
}

export async function cpanelLoginUrl(svc: Svc, service: "cpaneld" | "whostmgrd" | "webmaild" = "cpaneld") {
  const { whm, user, reseller } = requireAccount(svc);
  if (service === "whostmgrd" && !reseller) throw new HostingError("WHM login is only for reseller accounts", false);
  return whm.loginUrl(user, service);
}
