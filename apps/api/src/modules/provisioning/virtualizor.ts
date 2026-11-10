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

/** Virtualizor can take many minutes to answer addvs (it clones the disk before replying). */
export const CREATE_TIMEOUT_MS = Number(process.env.VIRTUALIZOR_CREATE_TIMEOUT_MS) || 15 * 60_000;
/** how often to look for the VPS after an unanswered create, and how many times */
export const ADOPT_POLL_MS = Number(process.env.VIRTUALIZOR_ADOPT_POLL_MS) || 20_000;
export const ADOPT_POLLS = 30;

/** True when the request went out but no answer came back in time — the VPS may still be being built. */
export function isNoAnswer(e: unknown) {
  const err = e as { code?: string; cause?: { code?: string }; message?: string };
  const code = err?.code ?? err?.cause?.code ?? "";
  return /UND_ERR_HEADERS_TIMEOUT|UND_ERR_BODY_TIMEOUT|UND_ERR_SOCKET|ECONNRESET|EPIPE/.test(code) || /headers timeout|body timeout|socket hang up|other side closed|closed the connection/i.test(err?.message ?? "");
}

export class VirtualizorClient {
  private agent: Agent;
  private slowAgent: Agent;
  constructor(private creds: VirtualizorCreds) {
    this.agent = new Agent({ connect: { rejectUnauthorized: creds.verifyTls, timeout: 20_000, autoSelectFamily: true }, headersTimeout: 120_000, bodyTimeout: 300_000 });
    this.slowAgent = new Agent({ connect: { rejectUnauthorized: creds.verifyTls, timeout: 20_000, autoSelectFamily: true }, headersTimeout: CREATE_TIMEOUT_MS, bodyTimeout: CREATE_TIMEOUT_MS, keepAliveTimeout: 1000 });
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

  async call<T = Record<string, unknown>>(act: string, query: Record<string, string | number | undefined> = {}, post?: Record<string, unknown>, opts: { slow?: boolean; cookies?: Record<string, string> } = {}): Promise<T> {
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
      dispatcher: opts.slow ? this.slowAgent : this.agent,
      headers: {
        ...(post ? { "Content-Type": "application/x-www-form-urlencoded" } : {}),
        ...(opts.cookies && Object.keys(opts.cookies).length ? { Cookie: Object.entries(opts.cookies).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join("; ") } : {}),
      },
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
  /**
   * VPSes on the master with this hostname (Virtualizor's list search). Used to find a VPS an earlier,
   * unanswered create request already built, so a retry never builds a second one.
   */
  async findVpsByHostname(hostname: string): Promise<{ vpsid: string; hostname: string; serid: string | null; createdAt: number | null; email: string | null }[]> {
    const want = hostname.trim().toLowerCase();
    const r = await this.call<{ vs?: Record<string, Record<string, unknown>> | Record<string, unknown>[] }>("vs", { search: 1, vpshostname: want, page: 1, reslen: 200 });
    const rows = Array.isArray(r.vs) ? r.vs : Object.entries(r.vs ?? {}).map(([k, v]) => ({ vpsid: k, ...(v as object) }) as Record<string, unknown>);
    return rows
      .filter((v) => String(v.hostname ?? "").trim().toLowerCase() === want)
      .map((v) => ({
        vpsid: String(v.vpsid),
        hostname: String(v.hostname),
        serid: v.serid !== undefined && v.serid !== null ? String(v.serid) : null,
        createdAt: Number(v.time ?? v.created ?? 0) ? Number(v.time ?? v.created) * 1000 : null,
        email: v.email ? String(v.email) : null,
      }))
      .sort((a, b) => Number(a.vpsid) - Number(b.vpsid));
  }

  /**
   * What a VPS that already works on this node uses: storage references (st_uuid / stid) found in its
   * details and edit form, its VPS type (virt) and plan. VPSes made in Virtualizor's own panel are the
   * ground truth for what this master accepts on that node.
   */
  async learnNode(serid: number | string, max = 3): Promise<NodeHints> {
    const hints: NodeHints = { serid: String(serid), uuids: [], stids: [], virts: [], plids: [], sampleVpsids: [], diskShapes: [] };
    const r = await this.call<{ vs?: Record<string, Record<string, unknown>> | Record<string, unknown>[] }>("vs", { search: 1, serid, page: 1, reslen: 50 });
    const rows = (Array.isArray(r.vs) ? r.vs : Object.entries(r.vs ?? {}).map(([k, v]) => ({ vpsid: k, ...(v as object) }) as Record<string, unknown>))
      .filter((v) => String(v.serid ?? "") === String(serid))
      .sort((a, b) => Number(b.vpsid) - Number(a.vpsid))
      .slice(0, max);
    for (const v of rows) {
      hints.sampleVpsids.push(String(v.vpsid));
      if (v.virt) hints.virts.push(String(v.virt));
      if (v.plid) hints.plids.push(String(v.plid));
      collectStorageRefs(v, hints);
      for (const act of ["vs", "editvs"] as const) {
        const d = await this.call<Record<string, unknown>>(act, { vpsid: String(v.vpsid) }).catch(() => null);
        if (d) collectStorageRefs(act === "vs" ? (d.vs as Record<string, unknown>)?.[String(v.vpsid)] ?? d.vs : d, hints);
      }
    }
    hints.uuids = [...new Set(hints.uuids)];
    hints.stids = [...new Set(hints.stids)];
    hints.virts = [...new Set(hints.virts)];
    hints.plids = [...new Set(hints.plids)];
    return hints;
  }

  private cookieNameCache: string | null = null;
  /** Name of the admin session cookie; "<name>_server" selects the node in the Create VPS form. */
  async cookieName(virt = "kvm") {
    if (this.cookieNameCache) return this.cookieNameCache;
    const r = await this.call<{ globals?: { cookie_name?: string } }>("addvs", { virt });
    this.cookieNameCache = r.globals?.cookie_name ? String(r.globals.cookie_name) : "SIMCookies";
    return this.cookieNameCache;
  }

  /** Virtualizor's Create VPS form for a node and VPS type, unparsed (for diagnosis). */
  async addvsForm(serid: number | string, virt = "kvm") {
    const name = await this.cookieName(virt).catch(() => null);
    return this.call<Record<string, unknown>>("addvs", { virt, serid, slave_server: serid }, undefined, { cookies: name ? { [`${name}_server`]: String(serid) } : {} });
  }

  /**
   * Free IPv4 addresses Virtualizor offers for a node in its Create VPS form (its own pools). null when
   * the master doesn't include the list — then the panel can't check and lets Virtualizor assign.
   */
  async formFreeIps(serid: number | string, virt: string): Promise<Set<string> | null> {
    const r = await this.addvsForm(serid, virt);
    const list = r.ips as Record<string, { ip?: string }> | { ip?: string }[] | undefined;
    if (!list || typeof list !== "object") return null;
    const ips = (Array.isArray(list) ? list : Object.values(list)).map((x) => String(x?.ip ?? "")).filter((ip) => /^\d+\.\d+\.\d+\.\d+$/.test(ip));
    return new Set(ips);
  }

  /**
   * Power state codes for many VPSes in one call (act=vs&vs_status=1,2,3 — the official SDK's status()):
   * 1 = online, 0 = offline, 2 = suspended.
   */
  async vpsStatus(vpsids: (string | number)[]): Promise<Record<string, number>> {
    if (!vpsids.length) return {};
    const r = await this.call<{ status?: Record<string, unknown> }>("vs", { vs_status: vpsids.join(",") });
    const out: Record<string, number> = {};
    for (const [k, v] of Object.entries(r.status ?? {})) {
      const code = typeof v === "object" && v !== null ? Number((v as Record<string, unknown>).status ?? (v as Record<string, unknown>).stat) : Number(v);
      if (Number.isFinite(code)) out[k] = code;
    }
    return out;
  }

  /**
   * Replace a VPS's IPv4 addresses the way the official WHMCS module changes a package: read the VPS
   * from the edit form, swap the ips list, post it back with editvps=1. With no list given, the same
   * number of free IPs from Virtualizor's own pools for that node are used.
   */
  async replaceIps(vpsid: string, newIps?: string[]): Promise<string[]> {
    const form = await this.call<{ vps?: Record<string, unknown>; ips?: Record<string, { ip?: string }> | { ip?: string }[] }>("editvs", { vpsid });
    const vps = form.vps;
    if (!vps) throw new VirtualizorError(`Virtualizor didn't return VPS ${vpsid} for editing`, form);
    const current = Object.values((vps.ips ?? {}) as Record<string, string>).map(String).filter((ip) => /^\d+\.\d+\.\d+\.\d+$/.test(ip));
    const free = (Array.isArray(form.ips) ? form.ips : Object.values(form.ips ?? {})).map((x) => String(x?.ip ?? "")).filter((ip) => /^\d+\.\d+\.\d+\.\d+$/.test(ip));
    const want = newIps?.length ? newIps : free.filter((ip) => !current.includes(ip)).slice(0, Math.max(1, current.length));
    if (!want.length) throw new VirtualizorError("Virtualizor has no free IPs for this VPS's node", form);
    const post: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(vps)) if (v === null || typeof v !== "object") post[k] = v;
    await this.call("editvs", { vpsid }, { ...post, hostname: vps.hostname, ips: want, editvps: 1 });
    return want;
  }

  /**
   * Console (noVNC) details for a VPS — like the official module's act=vnc&novnc=1. The password is a
   * VNC password Virtualizor generates; the websocket is served by the master on port 4083
   * (https) at /novnc/?virttoken=<vpsid>.
   */
  async vncInfo(vpsid: string): Promise<{ password: string; virt?: string; host?: string }> {
    const r = await this.call<Record<string, unknown>>("vnc", { novnc: 1, vpsid }, { vpsid, novnc: 1 });
    const info = (r.info ?? r.vnc ?? r) as Record<string, unknown>;
    let password = String(info.password ?? info.vncpass ?? "");
    if (!password) {
      const form = await this.call<{ vps?: Record<string, unknown> }>("editvs", { vpsid }).catch(() => null);
      password = String(form?.vps?.vncpass ?? "");
    }
    if (!password) throw new VirtualizorError("Virtualizor didn't return a console password — make sure VNC is enabled for this VPS (Virtualizor → Manage VPS → VNC)", r);
    return { password, virt: info.virt ? String(info.virt) : undefined, host: info.host ? String(info.host) : undefined };
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
    storage?: { stid?: number | null; uuid?: string | null };
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
    // Same request shape as Virtualizor's own WHMCS module: the VPS type goes in the URL (it decides
    // which storages/templates are valid), the node is sent as slave_server with node_select=1 and as
    // the "<cookie>_server" cookie the admin panel uses; storage is only sent when asked for.
    const cookies: Record<string, string> = {};
    if (p.serverId !== undefined) {
      const name = await this.cookieName(p.virt).catch(() => null);
      if (name) cookies[`${name}_server`] = String(p.serverId);
    }
    const r = await this.call<{ done?: boolean; vs_info?: { vpsid: string | number }; newvs?: { vpsid: string | number } }>("addvs", { virt: p.virt }, {
      addvps: 1,
      virt: p.virt,
      plid: p.planId,
      node_select: 1,
      ...(p.serverId !== undefined
        ? { slave_server: p.serverId, serid: p.serverId, server_group: "" }
        : { slave_server: "auto", ...(p.serverGroupId !== undefined ? { server_group: p.serverGroupId } : {}) }),
      ...(p.storage?.stid !== undefined && p.storage?.stid !== null ? { stid: p.storage.stid } : {}),
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
      ...(p.diskMode === "plan" && p.planId ? {} : { bandwidth: p.bandwidthGb ?? 0 }),
      ...(p.extra ?? {}),
    }, { slow: true, cookies });
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
  /**
   * Storages Virtualizor offers for one node — read from its own Create VPS form (act=addvs without
   * submitting), the same list the admin panel's storage dropdown shows for that server.
   */
  async storagesForServer(serid: number, virt = "kvm"): Promise<VirtStorage[]> {
    const r = await this.addvsForm(serid, virt);
    return parseStorages(r).map((x) => (x.serids.length ? x : { ...x, serids: [String(serid)] }));
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

const isStorageRow = (v: unknown) => !!v && typeof v === "object" && !Array.isArray(v) && ("stid" in (v as object) || "st_uuid" in (v as object));

/**
 * Finds storage rows wherever a master puts them: {storage:{1:{…}}}, {storages:[…]}, or grouped per
 * node {storage:{<serid>:{<stid>:{…}}}} (the node id is then remembered on each row).
 */
function findStorageRows(r: Record<string, unknown>): Record<string, unknown>[] {
  const keys = ["storage", "storages", "storage_list", "server_storage", "storage_details", ...Object.keys(r)];
  for (const k of [...new Set(keys)]) {
    const v = r[k];
    if (!v || typeof v !== "object") continue;
    const entries = Array.isArray(v) ? v.map((x, i) => [String(i), x] as const) : Object.entries(v as Record<string, unknown>);
    if (entries.some(([, x]) => isStorageRow(x))) return entries.filter(([, x]) => isStorageRow(x)).map(([key, x]) => ({ stid: key, ...(x as object) }));
    // grouped by node
    const grouped = entries.filter(([, x]) => x && typeof x === "object" && Object.values(x as object).some(isStorageRow));
    if (grouped.length)
      return grouped.flatMap(([serid, x]) =>
        Object.entries(x as Record<string, unknown>).filter(([, y]) => isStorageRow(y)).map(([key, y]) => ({ stid: key, _serid: serid, ...(y as object) })),
      );
  }
  return [];
}

export function parseStorages(r: Record<string, unknown>): VirtStorage[] {
  const rows = findStorageRows(r);
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
        serids: seridList(s._serid, s.serid, s.servers, s.server_ids, s.storage_servers, map?.[String(stid)]),
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

export interface NodeHints {
  serid: string;
  uuids: string[];
  stids: number[];
  virts: string[];
  plids: string[];
  sampleVpsids: string[];
  /** a few disk objects as Virtualizor reports them (keys and values), for diagnosis */
  diskShapes: Record<string, unknown>[];
}

/** Walks any Virtualizor reply and collects storage references from disk/storage objects. */
export function collectStorageRefs(obj: unknown, acc: Pick<NodeHints, "uuids" | "stids" | "diskShapes">, depth = 0) {
  if (!obj || typeof obj !== "object" || depth > 6) return;
  if (Array.isArray(obj)) return obj.forEach((x) => collectStorageRefs(x, acc, depth + 1));
  const o = obj as Record<string, unknown>;
  const uuid = o.st_uuid ?? o.storage_uuid;
  const stid = o.stid ?? o.storage_id;
  if (typeof uuid === "string" && uuid) acc.uuids.push(uuid);
  if (stid !== undefined && stid !== null && /^\d+$/.test(String(stid)) && Number(stid) > 0) acc.stids.push(Number(stid));
  if ((uuid || stid) && acc.diskShapes.length < 4) acc.diskShapes.push(Object.fromEntries(Object.entries(o).filter(([, v]) => v === null || typeof v !== "object").slice(0, 20)));
  for (const v of Object.values(o)) if (v && typeof v === "object") collectStorageRefs(v, acc, depth + 1);
}
