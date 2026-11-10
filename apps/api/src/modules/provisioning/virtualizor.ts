/**
 * Virtualizor Admin API client.
 * Docs: https://www.virtualizor.com/docs/admin-api/
 * Auth: adminapikey + adminapipass, JSON responses (api=json).
 */
import { createHash, randomBytes } from "node:crypto";
import { Agent, request } from "undici";
import { explainNetError } from "../../lib/net-errors";

export interface VirtualizorCreds {
  host: string;
  port: number; // 4085 (https admin panel)
  apiKey: string;
  apiPass: string;
  verifyTls: boolean;
}

export class VirtualizorError extends Error {
  constructor(message: string, public body?: unknown) {
    super(message);
  }
}

/** PHP-style form fields: arrays of scalars → k[]=v, objects/arrays of objects → k[0][size]=v. */
function appendForm(form: URLSearchParams, key: string, v: unknown) {
  if (v === undefined || v === null) return;
  if (Array.isArray(v) && v.every((x) => x === null || typeof x !== "object")) return v.forEach((x) => form.append(`${key}[]`, String(x)));
  if (typeof v === "object") return Object.entries(v as Record<string, unknown>).forEach(([k2, x]) => appendForm(form, `${key}[${k2}]`, x));
  form.set(key, String(v));
}

export class VirtualizorClient {
  private agent: Agent;
  constructor(private creds: VirtualizorCreds) {
    this.agent = new Agent({ connect: { rejectUnauthorized: creds.verifyTls, timeout: 20_000, autoSelectFamily: true }, headersTimeout: 120_000, bodyTimeout: 300_000 });
  }

  private url(act: string, query: Record<string, string | number | undefined> = {}) {
    const host = this.creds.host.replace(/^https?:\/\//, "").replace(/\/$/, "");
    // same auth as Virtualizor's own admin SDK: key + pass, plus apikey = rand8 + md5(pass + rand8)
    const pass = this.creds.apiPass.trim();
    const rand = randomBytes(6).toString("base64url").replace(/[^a-zA-Z0-9]/g, "x").slice(0, 8).toLowerCase();
    const apikey = rand + createHash("md5").update(pass + rand).digest("hex");
    const q = new URLSearchParams({ act, api: "json", adminapikey: this.creds.apiKey.trim(), adminapipass: pass, apikey });
    for (const [k, v] of Object.entries(query)) if (v !== undefined) q.set(k, String(v));
    return `https://${host}:${this.creds.port}/index.php?${q.toString()}`;
  }

  async call<T = Record<string, unknown>>(act: string, query: Record<string, string | number | undefined> = {}, post?: Record<string, unknown>): Promise<T> {
    let body: string | undefined;
    if (post) {
      const form = new URLSearchParams();
      for (const [k, v] of Object.entries(post)) {
        if (v === undefined || v === null) continue;
        appendForm(form, k, v);
      }
      body = form.toString();
    }
    const host = this.creds.host.replace(/^https?:\/\//, "").replace(/\/$/, "");
    const res = await request(this.url(act, query), {
      method: post ? "POST" : "GET",
      dispatcher: this.agent,
      headers: post ? { "Content-Type": "application/x-www-form-urlencoded" } : undefined,
      body,
    }).catch((e) => {
      throw explainNetError(e, host, this.creds.port, "Virtualizor");
    });
    const text = await res.body.text();
    let json: Record<string, unknown>;
    try {
      json = JSON.parse(text);
    } catch {
      if (res.statusCode >= 300 && res.statusCode < 400) {
        const loc = String(res.headers.location ?? "");
        throw new VirtualizorError(
          `Virtualizor rejected the API login (HTTP ${res.statusCode} redirect${loc ? ` to ${loc.split("?")[0]}` : ""}). Check: (1) the Admin API key and API password are exactly as shown in Virtualizor Admin → Configuration → API Credentials (not your admin login password); (2) that credential has no IP restriction, or allows this panel's public IP; (3) you're using the master's admin port 4085.`,
          loc,
        );
      }
      throw new VirtualizorError(
        `Virtualizor ${act}: the panel answered (HTTP ${res.statusCode}) but not with API data. Check the Admin API key and password, and that this panel's IP is allowed under Virtualizor Admin → Configuration → API Credentials. Use the master's admin port (4085, https).`,
        text.slice(0, 300),
      );
    }
    if (json.error && (Array.isArray(json.error) ? json.error.length : Object.keys(json.error as object).length)) {
      throw new VirtualizorError(`Virtualizor ${act}: ${JSON.stringify(json.error)}`, json);
    }
    return json as T;
  }

  listVps(page = 1, reslen = 50) {
    return this.call<{ vs: Record<string, Record<string, unknown>> }>("vs", { page, reslen });
  }
  getVps(vpsid: string | number) {
    return this.call<{ vs: Record<string, Record<string, unknown>> }>("vs", { vpsid });
  }
  plans() {
    return this.call<{ plans: Record<string, Record<string, unknown>> }>("plans");
  }
  /** All OS templates on the master (`ostemplates` keyed by osid; older versions also send `oslist`). */
  osTemplates() {
    return this.call<{ ostemplates?: unknown; oslist?: unknown }>("ostemplates", { page: 1, reslen: 1000 });
  }
  /** Every server (master + slave nodes) registered on this Virtualizor master. */
  servers() {
    return this.call<{ servs: Record<string, Record<string, unknown>> | Record<string, unknown>[] }>("servers", { page: 1, reslen: 1000 });
  }
  /** Live CPU / RAM / disk usage of one node (serid 0 = the master itself). */
  serverUsage(serid: number | string) {
    return this.call<{ usage?: Record<string, any>; info?: Record<string, any> }>("manageserver", { changeserid: serid });
  }
  /** IP pools (ippid → gateway, netmask, servers…). */
  ipPools() {
    return this.call<{ ippools?: Record<string, Record<string, unknown>> }>("ippool", { page: 1, reslen: 1000 });
  }
  /** One page of IP addresses (ipid → ip, ippid, vpsid, locked…). */
  ips(page = 1, reslen = 1000) {
    return this.call<{ ips?: Record<string, Record<string, unknown>> }>("ips", { page, reslen });
  }
  /** Details of one VPS, including the IPs Virtualizor gave it. */
  async vpsIps(vpsid: string): Promise<string[]> {
    const r = await this.call<{ vs?: Record<string, { ips?: Record<string, string> | string[] }> }>("vs", { vpsid });
    const v = r.vs?.[vpsid] ?? Object.values(r.vs ?? {})[0];
    const raw = v?.ips ? (Array.isArray(v.ips) ? v.ips : Object.values(v.ips)) : [];
    return raw.map(String).filter((ip) => /^\d+\.\d+\.\d+\.\d+$/.test(ip));
  }
  /** Server groups (used for automatic node selection). */
  serverGroups() {
    return this.call<{ servergroups?: Record<string, Record<string, unknown>> }>("servergroups");
  }
  /** Load averages for all nodes. */
  serverLoads() {
    return this.call<{ loads?: Record<string, any>; server_loads?: Record<string, any> }>("serverloads");
  }

  async createVps(p: {
    virt: string;
    planId?: number;
    /** Virtualizor serid of the node to build on (0 = master). Omit to let Virtualizor choose (node_select). */
    serverId?: number;
    /** with automatic placement: limit Virtualizor's choice to this server group */
    serverGroupId?: number;
    /** storage to put the disk on; omit = the node's primary storage */
    storage?: { stid: number; uuid?: string | null };
    /**
     * how the disk is described: "scalar" = space=<GB> (classic), "array" = space[0][size]+st_uuid
     * (newer masters), "plan" = send no ram/disk/cpu overrides and let the Virtualizor plan decide
     */
    diskMode?: "scalar" | "array" | "plan";
    /** extra addvs fields from the plan's advanced settings (vnc, nic_type, …) */
    extra?: Record<string, string>;
    userEmail: string;
    userPass: string;
    hostname: string;
    rootPass: string;
    osId: number;
    /** IPs the panel allocated; leave empty to let Virtualizor assign `numIps` from its own pools */
    ips: string[];
    numIps?: number;
    ramMb?: number;
    diskGb?: number;
    cores?: number;
    bandwidthGb?: number;
  }) {
    const r = await this.call<{ done?: boolean; vs_info?: { vpsid: string | number }; newvs?: { vpsid: string | number } }>("addvs", {}, {
      addvps: 1,
      virt: p.virt,
      plid: p.planId,
      ...(p.serverId !== undefined
        ? { slave_server: p.serverId, serid: p.serverId }
        : { node_select: 1, ...(p.serverGroupId !== undefined ? { server_group: p.serverGroupId } : {}) }),
      ...(p.storage ? { stid: p.storage.stid } : {}),
      user_email: p.userEmail,
      user_pass: p.userPass,
      hostname: p.hostname,
      rootpass: p.rootPass,
      osid: p.osId,
      ...(p.ips.length ? { ips: p.ips } : {}),
      num_ips: p.ips.length || p.numIps || 1,
      ...(p.diskMode === "plan" && p.planId
        ? {}
        : {
            ram: p.ramMb,
            cores: p.cores,
            space: p.diskMode === "array" && p.diskGb ? { 0: { size: p.diskGb, ...(p.storage?.uuid ? { st_uuid: p.storage.uuid } : {}) } } : p.diskGb,
          }),
      bandwidth: p.bandwidthGb ?? 0,
      ...(p.extra ?? {}),
    });
    const vpsid = r.vs_info?.vpsid ?? r.newvs?.vpsid;
    if (!vpsid) throw new VirtualizorError("Virtualizor did not return a VPS id", r);
    return String(vpsid);
  }

  /** All storages with the nodes they're attached to (act=storage). */
  async storages(): Promise<VirtStorage[]> {
    return parseStorages(await this.storagesRaw());
  }
  storagesRaw() {
    return this.call<Record<string, unknown>>("storage", { reslen: 1000 });
  }

  suspend(vpsid: string) {
    return this.call("vs", { suspend: vpsid });
  }
  unsuspend(vpsid: string) {
    return this.call("vs", { unsuspend: vpsid });
  }
  terminate(vpsid: string) {
    return this.call("vs", { delete: vpsid });
  }
  power(vpsid: string, action: "start" | "stop" | "restart" | "poweroff") {
    return this.call("vs", { action, vpsid });
  }
  rebuild(vpsid: string, osId: number, newPass: string) {
    return this.call("rebuild", {}, { vpsid, osid: osId, newpass: newPass, conf: newPass, reos: 1 });
  }
  changeRootPassword(vpsid: string, rootPass: string) {
    return this.call("managevps", { vpsid }, { editvps: 1, rootpass: rootPass });
  }
  setIps(vpsid: string, ips: string[]) {
    return this.call("managevps", { vpsid }, { editvps: 1, ips });
  }
  stats(vpsid: string) {
    return this.call<Record<string, unknown>>("vps_stats", { vpsid });
  }
}

export interface VirtStorage {
  stid: number;
  uuid: string | null;
  name: string;
  type: string;
  primary: boolean;
  /** Virtualizor serids the storage is attached to (empty = the master didn't say) */
  serids: string[];
  /** server groups the storage is attached to */
  sgids: string[];
  totalGb: number | null;
  freeGb: number | null;
}

const numOrNull = (v: unknown) => {
  const n = typeof v === "number" ? v : parseFloat(String(v ?? ""));
  return Number.isFinite(n) ? n : null;
};

/** Collects node ids from the many shapes Virtualizor uses: "3", 3, "1,3", [1,3], {"1":…,"3":…}, [{serid:1}]. */
function seridList(...vals: unknown[]): string[] {
  const out = new Set<string>();
  const add = (v: unknown) => {
    if (v === null || v === undefined || v === "") return;
    if (Array.isArray(v)) return v.forEach((x) => (x && typeof x === "object" ? add((x as Record<string, unknown>).serid ?? (x as Record<string, unknown>).id) : add(x)));
    if (typeof v === "object") {
      for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
        if (x && typeof x === "object" && "serid" in (x as object)) add((x as Record<string, unknown>).serid);
        else if (/^-?\d+$/.test(k)) out.add(k);
      }
      return;
    }
    for (const part of String(v).split(/[,\s]+/)) if (/^-?\d+$/.test(part) && part !== "-1") out.add(part);
  };
  vals.forEach(add);
  return [...out];
}

export function parseStorages(r: Record<string, unknown>): VirtStorage[] {
  const raw = (r.storage ?? r.storages ?? {}) as Record<string, Record<string, unknown>> | Record<string, unknown>[];
  const rows = Array.isArray(raw) ? raw : Object.entries(raw).map(([k, v]) => ({ stid: k, ...(v as object) }) as Record<string, unknown>);
  const map = (r.storage_servers ?? r.storages_servers ?? null) as Record<string, unknown> | null;
  return rows
    .filter((s) => s && typeof s === "object")
    .map((s) => {
      const stid = Number(s.stid ?? s.id);
      return {
        stid,
        uuid: s.st_uuid ? String(s.st_uuid) : s.uuid ? String(s.uuid) : null,
        name: String(s.name ?? s.path ?? `Storage ${stid}`),
        type: String(s.type ?? ""),
        primary: String(s.primary_storage ?? s.primary ?? "0") === "1",
        serids: seridList(s.serid, s.servers, s.server_ids, s.storage_servers, map?.[String(stid)]),
        sgids: seridList(s.sgid, s.sgids, s.server_groups),
        totalGb: numOrNull(s.size ?? s.total ?? s.total_size),
        freeGb: numOrNull(s.free ?? s.free_size ?? s.available),
      };
    })
    .filter((s) => Number.isFinite(s.stid));
}

/**
 * Best storage for a new disk on a node — only storages the master says are attached to that node
 * (directly or through its server group). Its primary storage when it has room, else the roomiest.
 * null = the panel can't be sure, so the caller sends no storage and Virtualizor uses the node's primary.
 */
export function pickStorage(storages: VirtStorage[], serid: string, diskGb = 0, sgid?: string | null): VirtStorage | null {
  const onNode = storages.filter((s) => s.serids.includes(serid) || (!!sgid && s.sgids.includes(sgid)));
  const fits = (s: VirtStorage) => s.freeGb === null || s.freeGb >= diskGb;
  const primary = onNode.filter((s) => s.primary && fits(s)).sort((a, b) => (b.freeGb ?? 0) - (a.freeGb ?? 0));
  if (primary.length) return primary[0];
  const any = onNode.filter(fits).sort((a, b) => (b.freeGb ?? 0) - (a.freeGb ?? 0));
  return any[0] ?? null;
}

/** Storages attached to a node, for display (same rules as pickStorage). */
export function storagesOfNode(storages: VirtStorage[], serid: string, sgid?: string | null) {
  return storages.filter((s) => s.serids.includes(serid) || (!!sgid && s.sgids.includes(sgid)));
}
