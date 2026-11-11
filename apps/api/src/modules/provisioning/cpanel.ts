/**
 * cPanel & WHM — WHM API 1 client (shared and reseller hosting).
 * Docs: https://api.docs.cpanel.net/whm/introduction
 * Auth: API token — header "Authorization: whm <user>:<token>" (WHM → Development → Manage API Tokens).
 */
import { Agent, request } from "undici";
import { explainNetError } from "../../lib/net-errors";

export interface WhmCreds {
  host: string;
  port: number; // 2087
  user: string; // usually "root" (or a reseller with the needed ACLs)
  token: string;
  verifyTls: boolean;
}

export class WhmError extends Error {
  constructor(message: string, public body?: unknown) {
    super(message);
  }
}

type WhmResponse<T> = { metadata?: { result?: number; reason?: string; command?: string; output?: { raw?: string } }; data?: T; cpanelresult?: unknown };

export type WhmAccount = {
  user: string;
  domain: string;
  ip?: string;
  plan?: string;
  email?: string;
  suspended?: number | boolean;
  suspendreason?: string;
  diskused?: string;
  disklimit?: string;
  startdate?: string;
  owner?: string;
  partition?: string;
};

/** Reasonable cPanel username for a domain: lowercase letters/digits, starts with a letter, ≤ 8 chars, not "test…". */
export function usernameFromDomain(domain: string) {
  let u = domain.toLowerCase().split(".")[0].replace(/[^a-z0-9]/g, "");
  u = u.replace(/^[0-9]+/, "");
  if (!u || u.startsWith("test")) u = `u${u}`;
  return u.slice(0, 8);
}

/** "1024" MB / "unlimited" / "1.5G" → MB (null = unlimited) */
export function toMb(v: unknown): number | null {
  const s = String(v ?? "").trim().toLowerCase();
  if (!s || s === "unlimited" || s === "0" || s === "none") return null;
  const m = s.match(/^([\d.]+)\s*([kmgt]?)/);
  if (!m) return null;
  const n = Number(m[1]);
  const mult = { "": 1, k: 1 / 1024, m: 1, g: 1024, t: 1024 * 1024 }[m[2] as "" | "k" | "m" | "g" | "t"];
  return Math.round(n * mult);
}

export class WhmClient {
  private agent: Agent;
  constructor(private creds: WhmCreds) {
    // createacct can take a minute or two on a busy server
    this.agent = new Agent({ connect: { rejectUnauthorized: creds.verifyTls, timeout: 20_000, autoSelectFamily: true }, headersTimeout: 240_000, bodyTimeout: 240_000 });
  }

  get host() {
    return this.creds.host.replace(/^https?:\/\//, "").replace(/[:/].*$/, "");
  }

  async call<T = Record<string, unknown>>(fn: string, params: Record<string, string | number | boolean | undefined> = {}): Promise<{ data: T; metadata: NonNullable<WhmResponse<T>["metadata"]> }> {
    const q = new URLSearchParams({ "api.version": "1" });
    for (const [k, v] of Object.entries(params)) if (v !== undefined) q.set(k, typeof v === "boolean" ? (v ? "1" : "0") : String(v));
    const res = await request(`https://${this.host}:${this.creds.port || 2087}/json-api/${fn}`, {
      method: "POST",
      dispatcher: this.agent,
      headers: { Authorization: `whm ${this.creds.user.trim() || "root"}:${this.creds.token.trim()}`, "Content-Type": "application/x-www-form-urlencoded" },
      body: q.toString(),
    }).catch((e) => {
      throw explainNetError(e, this.host, this.creds.port || 2087, "WHM");
    });
    const text = await res.body.text();
    if (res.statusCode === 401 || res.statusCode === 403) throw new WhmError(`WHM refused the API token (HTTP ${res.statusCode}). Check the username and API token (WHM → Development → Manage API Tokens), and that the token isn't IP-restricted against this panel.`);
    let json: WhmResponse<T>;
    try {
      json = JSON.parse(text);
    } catch {
      throw new WhmError(`WHM ${fn}: the server answered (HTTP ${res.statusCode}) but not with API data — is ${this.host}:${this.creds.port || 2087} the WHM port (2087, https)?`, text.slice(0, 300));
    }
    const md = json.metadata ?? {};
    if (md.result !== 1) throw new WhmError(`WHM ${fn}: ${md.reason || "failed"}`, json);
    return { data: (json.data ?? {}) as T, metadata: md };
  }

  version() {
    return this.call<{ version: string }>("version").then((r) => r.data.version);
  }
  loadAvg() {
    return this.call<{ one: string; five: string; fifteen: string }>("systemloadavg").then((r) => r.data).catch(() => null);
  }
  hostname() {
    return this.call<{ hostname: string }>("gethostname").then((r) => r.data.hostname).catch(() => null);
  }
  async packages(): Promise<{ name: string; diskMb: number | null; bandwidthMb: number | null; maxAddon?: string; maxSql?: string; maxPop?: string }[]> {
    const r = await this.call<{ pkg?: Record<string, unknown>[] }>("listpkgs");
    return (r.data.pkg ?? []).map((p) => ({ name: String(p.name), diskMb: toMb(p.QUOTA), bandwidthMb: toMb(p.BWLIMIT), maxAddon: p.MAXADDON as string, maxSql: p.MAXSQL as string, maxPop: p.MAXPOP as string }));
  }
  async aclLists(): Promise<string[]> {
    const r = await this.call<{ acl?: { name: string }[] }>("listacls").catch(() => null);
    return (r?.data.acl ?? []).map((a) => a.name).filter(Boolean);
  }
  async accounts(search?: { by: "user" | "domain"; value: string }): Promise<WhmAccount[]> {
    const r = await this.call<{ acct?: WhmAccount[] }>("listaccts", search ? { searchtype: search.by, search: `^${search.value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, searchmethod: "regex" } : {});
    return r.data.acct ?? [];
  }
  async accountCount() {
    const r = await this.call<{ acct?: unknown[] }>("listaccts", { want: "user" });
    return (r.data.acct ?? []).length;
  }
  async summary(user: string): Promise<WhmAccount | null> {
    const r = await this.call<{ acct?: WhmAccount[] }>("accountsummary", { user }).catch((e) => {
      if (/does not exist|not found|no account/i.test((e as Error).message)) return null;
      throw e;
    });
    return r?.data.acct?.[0] ?? null;
  }
  async bandwidth(user: string): Promise<{ usedMb: number; limitMb: number | null } | null> {
    const month = new Date();
    const r = await this.call<{ acct?: { user: string; totalbytes?: string | number; limit?: string | number }[] }>("showbw", { searchtype: "user", search: user, month: month.getMonth() + 1, year: month.getFullYear() }).catch(() => null);
    const a = r?.data.acct?.find((x) => x.user === user) ?? r?.data.acct?.[0];
    if (!a) return null;
    const used = Number(a.totalbytes ?? 0);
    const lim = Number(a.limit ?? 0);
    return { usedMb: Math.round(used / 1048576), limitMb: lim > 0 ? Math.round(lim / 1048576) : null };
  }
  /** Is this username free (and valid) on the server? */
  async usernameFree(user: string) {
    const v = await this.call<{ valid?: number }>("verify_new_username", { user }).then(() => true).catch((e) => (/already|exists|taken|reserved|invalid/i.test((e as Error).message) ? false : null));
    if (v !== null) return v;
    return (await this.accounts({ by: "user", value: user })).length === 0; // older WHM without verify_new_username
  }

  createAccount(p: { username: string; domain: string; password: string; plan: string; email: string; reseller?: boolean; ip?: string }) {
    return this.call<{ ip?: string; nameserver?: string; nameserver2?: string; nameserver3?: string; nameserver4?: string; package?: string }>("createacct", {
      username: p.username,
      domain: p.domain,
      password: p.password,
      plan: p.plan,
      contactemail: p.email,
      reseller: p.reseller ? 1 : 0,
      ip: p.ip || "n",
    });
  }
  setupReseller(user: string) {
    return this.call("setupreseller", { user, makeowner: 1 });
  }
  setAcls(reseller: string, acllist: string) {
    return this.call("setacls", { reseller, acllist });
  }
  setResellerLimits(user: string, l: { accounts?: number | null; diskMb?: number | null; bandwidthMb?: number | null; overselling?: boolean }) {
    return this.call("setresellerlimits", {
      user,
      enable_account_limit: l.accounts ? 1 : 0,
      account_limit: l.accounts ?? undefined,
      enable_resource_limits: l.diskMb || l.bandwidthMb ? 1 : 0,
      diskspace_limit: l.diskMb ?? undefined,
      bandwidth_limit: l.bandwidthMb ?? undefined,
      enable_overselling: l.overselling ? 1 : 0,
      enable_overselling_diskspace: l.overselling ? 1 : 0,
      enable_overselling_bandwidth: l.overselling ? 1 : 0,
    });
  }
  suspend(user: string, reason: string) {
    return this.call("suspendacct", { user, reason: reason.slice(0, 200) });
  }
  unsuspend(user: string) {
    return this.call("unsuspendacct", { user });
  }
  suspendReseller(user: string, reason: string) {
    return this.call("suspendreseller", { user, reason: reason.slice(0, 200) });
  }
  unsuspendReseller(user: string) {
    return this.call("unsuspendreseller", { user });
  }
  remove(user: string) {
    return this.call("removeacct", { username: user, keepdns: 0 });
  }
  /** Removes the reseller AND every account it owns. */
  terminateReseller(user: string) {
    return this.call("terminatereseller", { user, verify: "I understand this will irrevocably remove all the accounts owned by the reseller" });
  }
  changePassword(user: string, password: string) {
    return this.call("passwd", { user, password });
  }
  changePackage(user: string, pkg: string) {
    return this.call("changepackage", { user, pkg });
  }
  /** One-time login URL (valid a few minutes). service: cpaneld (cPanel), whostmgrd (WHM), webmaild. */
  async loginUrl(user: string, service: "cpaneld" | "whostmgrd" | "webmaild" = "cpaneld") {
    const r = await this.call<{ url: string }>("create_user_session", { user, service });
    return r.data.url;
  }
}
