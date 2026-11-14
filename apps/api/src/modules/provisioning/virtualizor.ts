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

  private url(act: string, query: Record<string, string | number | undefined> = {}, port = this.creds.port) {
    const host = this.creds.host.replace(/^https?:\/\//, "").replace(/\/$/, "");
    // same auth as Virtualizor's own admin SDK: key + pass, plus apikey = rand8 + md5(pass + rand8)
    const pass = this.creds.apiPass.trim();
    const rand = randomBytes(6).toString("base64url").replace(/[^a-zA-Z0-9]/g, "x").slice(0, 8).toLowerCase();
    const apikey = rand + createHash("md5").update(pass + rand).digest("hex");
    const q = new URLSearchParams({ act, api: "json", adminapikey: this.creds.apiKey.trim(), adminapipass: pass, apikey });
    for (const [k, v] of Object.entries(query)) if (v !== undefined) q.set(k, String(v));
    return `https://${host}:${port}/index.php?${q.toString()}`;
  }

  async call<T = Record<string, unknown>>(act: string, query: Record<string, string | number | undefined> = {}, post?: Record<string, unknown>, opts: { slow?: boolean; cookies?: Record<string, string>; port?: number } = {}): Promise<T> {
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
    const res = await request(this.url(act, query, opts.port), {
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
  async vncInfo(vpsid: string): Promise<{ password: string; virt?: string; host?: string; method?: string }> {
    const pick = (r: Record<string, unknown>) => {
      const info = (r.info ?? r.vnc ?? r) as Record<string, unknown>;
      return { password: String(info.password ?? info.vncpass ?? ""), virt: info.virt ? String(info.virt) : undefined, host: info.host ? String(info.host) : undefined };
    };
    const errors: string[] = [];
    // 1) exactly like the WHMCS module: end-user API on 4083 with the admin key, acting on VPS "svs"
    try {
      const r = pick(await this.call<Record<string, unknown>>("vnc", { novnc: 1, svs: vpsid }, undefined, { port: 4083 }));
      if (r.password) return { ...r, method: "end-user API (4083)" };
      errors.push("end-user API (4083) returned no console password");
    } catch (e) {
      errors.push(`end-user API (4083): ${(e as Error).message}`);
    }
    // 2) admin API
    try {
      const r = pick(await this.call<Record<string, unknown>>("vnc", { novnc: 1, vpsid, svs: vpsid }, { vpsid, novnc: 1 }));
      if (r.password) return { ...r, method: `admin API (end-user API failed: ${errors.join("; ")})` };
      errors.push("admin API returned no console password");
    } catch (e) {
      errors.push(`admin API: ${(e as Error).message}`);
    }
    // 3) the VNC password stored on the VPS
    const form = await this.call<{ vps?: Record<string, unknown> }>("editvs", { vpsid }).catch(() => null);
    const vncpass = form?.vps?.vncpass ? String(form.vps.vncpass) : "";
    if (vncpass && String(form?.vps?.vnc ?? "1") !== "0") return { password: vncpass, virt: form?.vps?.virt ? String(form.vps.virt) : undefined, method: `stored VNC password (${errors.join("; ")})` };
    throw new VirtualizorError(`Couldn't get console access for VPS ${vpsid} — ${errors.join("; ")}. Check that VNC is enabled for the VPS (Virtualizor → Manage VPS → VNC) and that this panel can reach the master on port 4083.`);
  }

  /**
   * Where the VPS's node can be reached (hostname and IP), for the console: with Virtualizor's
   * "Master Proxy Only" off, noVNC is served by the node, not the master. Empty for VPSes on the master.
   */
  async nodeAddress(vpsid: string): Promise<{ serid: string; name?: string; hosts: string[] }> {
    const r = await this.call<{ vs?: Record<string, Record<string, unknown>> }>("vs", { vpsid }).catch(() => null);
    const v = pickVps(r, vpsid);
    const serid = v?.serid !== undefined && v?.serid !== null ? String(v.serid) : "";
    if (!serid || serid === "0") return { serid, hosts: [] };
    const list = await this.servers().catch(() => null);
    const all = list?.servs ? (Array.isArray(list.servs) ? list.servs : Object.values(list.servs)) : [];
    const node = (all as Record<string, unknown>[]).find((x) => String(x.serid ?? x.id ?? "") === serid);
    if (!node) return { serid, hosts: [] };
    const hosts = [node.hostname, node.server_hostname, node.ip, node.internal_ip]
      .map((x) => String(x ?? "").trim().replace(/^https?:\/\//, "").replace(/[:/].*$/, ""))
      .filter((x) => x && x !== "0.0.0.0" && /^[a-z0-9.-]+$/i.test(x));
    return { serid, name: node.server_name ? String(node.server_name) : undefined, hosts: [...new Set(hosts)] };
  }

  getVps(vpsid: string | number) {
    return this.call<{ vs: Record<string, Record<string, unknown>> }>("vs", { vpsid });
  }
  /** The row for exactly this VPS (or null) — never "the first one", in case the master ignores the filter and lists others. */
  async findVps(vpsid: string | number): Promise<Record<string, unknown> | null> {
    return pickVps(await this.getVps(vpsid), vpsid);
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
  /** The IPs Virtualizor gave one VPS — from its details, or else from Virtualizor's IP list. */
  async vpsIps(vpsid: string): Promise<string[]> {
    const r = await this.call<{ vs?: Record<string, Record<string, unknown>> }>("vs", { vpsid });
    const fromRow = vpsIpsOf(pickVps(r as never, vpsid) as Record<string, unknown> | null);
    if (fromRow.length) return fromRow;
    return (await this.ipsByVps().catch(() => new Map<string, string[]>())).get(String(vpsid)) ?? [];
  }
  /** vpsid → its IPs, from Virtualizor's IP list (for VPS rows that don't carry their IPs). */
  async ipsByVps(): Promise<Map<string, string[]>> {
    const out = new Map<string, string[]>();
    for (let page = 1; page <= 50; page++) {
      const r = await this.ips(page, 1000);
      const list = Object.values(r.ips ?? {});
      for (const row of list) {
        const vpsid = String(row.vpsid ?? row.vps_id ?? "");
        const ip = String(row.ip ?? row.ipaddress ?? "").trim();
        if (!vpsid || vpsid === "0" || !isIp(ip)) continue;
        out.set(vpsid, [...(out.get(vpsid) ?? []), ip]);
      }
      if (list.length < 1000) break;
    }
    for (const [k, v] of out) out.set(k, sortIps(v));
    return out;
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
  /**
   * Live usage the way the WHMCS module's client area reads it, from the end-user API on 4083:
   *   act=vpsmanage&stats=1 → info.cpu.percent, info.disk{used_gb,limit_gb,percent}, info.netspeed{download,upload}
   *   act=monitor           → cpu{percent,limit}, ram{used,limit,percent}, disk{disk{…},inodes{…}}
   *   act=bandwidth         → bandwidth{used_gb,limit_gb,percent} for this month
   * Each part is optional — whatever answers is used.
   */
  async liveUsage(vpsid: string) {
    const n = (x: unknown) => (x === undefined || x === null || x === "" || Number.isNaN(Number(x)) ? undefined : Number(x));
    const [man, mon, bw] = await Promise.all([
      this.call<{ info?: Record<string, any> }>("vpsmanage", { stats: 1, svs: vpsid }, undefined, { port: 4083 }).catch(() => null),
      this.call<Record<string, any>>("monitor", { svs: vpsid }, undefined, { port: 4083 }).catch(() => null),
      this.call<Record<string, any>>("bandwidth", { svs: vpsid }, undefined, { port: 4083 }).catch(() => null),
    ]);
    const info = man?.info ?? {};
    const cpu = info.cpu ?? mon?.cpu?.cpu ?? mon?.cpu ?? {};
    const ram = mon?.ram ?? info.ram ?? {};
    const disk = info.disk ?? mon?.disk?.disk ?? mon?.disk ?? {};
    const band = bw?.bandwidth ?? info.bandwidth ?? {};
    const speed = info.netspeed ?? {};
    return {
      reachable: !!(man || mon),
      status: n(info.status),
      cpuPct: n(cpu.percent),
      cpuLimitMhz: n(cpu.limit),
      memUsedMb: n(ram.used),
      memTotalMb: n(ram.limit),
      memPct: n(ram.percent),
      diskUsedGb: n(disk.used_gb),
      diskTotalGb: n(disk.limit_gb),
      diskPct: n(disk.percent),
      netInBps: n(speed.download),
      netOutBps: n(speed.upload),
      bandwidthUsedGb: n(band.used_gb),
      bandwidthGb: n(band.limit_gb),
      bandwidthPct: n(band.percent),
      uptimeSec: n(info.uptime ?? info.vps?.uptime),
    };
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
  /**
   * Change a VPS's CPU / RAM / bandwidth and grow its disk (never shrinks — that would destroy data).
   * Fields that aren't sent keep their value (managevps edits are partial). Checks the result afterwards.
   */
  async resizeVps(vpsid: string, want: { cores?: number | null; ramMb?: number | null; diskGb?: number | null; bandwidthGb?: number | null }) {
    const cur = (await this.findVps(vpsid)) ?? {};
    const curDisk = Number(cur.space ?? 0);
    const growDisk = !!want.diskGb && want.diskGb > curDisk;
    const post: Record<string, unknown> = { editvps: 1 };
    if (want.ramMb) post.ram = want.ramMb;
    if (want.cores) post.cores = want.cores;
    if (want.bandwidthGb !== undefined && want.bandwidthGb !== null) post.bandwidth = want.bandwidthGb;
    if (growDisk) post.space = want.diskGb;
    try {
      await this.call("managevps", { vpsid }, post, { slow: true });
    } catch (e) {
      // newer masters describe disks as an array
      if (!growDisk || !/space|disk/i.test((e as Error).message)) throw e;
      const { space: _s, ...rest } = post;
      await this.call("managevps", { vpsid }, { ...rest, space: { 0: { size: want.diskGb } } }, { slow: true });
    }
    const after = (await this.findVps(vpsid)) ?? {};
    const notes: string[] = [];
    if (want.ramMb && Number(after.ram) && Number(after.ram) !== want.ramMb) notes.push(`RAM is ${after.ram} MB, expected ${want.ramMb} MB`);
    if (want.cores && Number(after.cores) && Number(after.cores) !== want.cores) notes.push(`cores are ${after.cores}, expected ${want.cores}`);
    if (growDisk && Number(after.space) && Number(after.space) < want.diskGb!) notes.push(`disk is ${after.space} GB, expected ${want.diskGb} GB`);
    return { diskKept: !!want.diskGb && want.diskGb < curDisk ? curDisk : null, mismatch: notes };
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

/** Pick one VPS out of an `act=vs` reply: keyed by id, or a row whose vpsid matches; a lone row without a vpsid field is accepted. */
const isV4 = (s: string) => /^\d{1,3}(\.\d{1,3}){3}$/.test(s);
const isV6 = (s: string) => /^[0-9a-f:]+$/i.test(s) && s.includes(":") && s.length >= 3;
export const isIp = (s: string) => isV4(s) || isV6(s);
/** IPv4 first (in Virtualizor's order), then IPv6. */
const sortIps = (a: string[]) => [...new Set(a)].sort((x, y) => Number(isV6(x)) - Number(isV6(y)));

/**
 * The IPs in a VPS row, whatever shape this Virtualizor version uses:
 * ips: {"12": "1.2.3.4"} | ["1.2.3.4"] | {"12": {ip: "1.2.3.4"}} | "1.2.3.4, …", plus ip / ipv4 / ips6 fields.
 */
export function vpsIpsOf(row: Record<string, unknown> | null | undefined): string[] {
  if (!row) return [];
  const out: string[] = [];
  const take = (v: unknown): void => {
    if (v === null || v === undefined || v === "") return;
    if (typeof v === "string" || typeof v === "number") {
      for (const part of String(v).split(/[\s,;]+/)) if (isIp(part.trim())) out.push(part.trim());
      return;
    }
    if (Array.isArray(v)) return v.forEach(take);
    if (typeof v === "object") {
      const o = v as Record<string, unknown>;
      if (o.ip !== undefined || o.ipaddress !== undefined || o.address !== undefined) return take(o.ip ?? o.ipaddress ?? o.address);
      for (const [k, x] of Object.entries(o)) {
        if (isIp(k) && (x === true || x === 1 || x === "1" || typeof x === "object")) out.push(k); // keyed by the IP itself
        else take(x);
      }
    }
  };
  for (const key of ["ips", "ip", "ipv4", "primary_ip", "ips6", "ipv6", "ips_int"]) take(row[key]);
  return sortIps(out);
}

export function pickVps(r: { vs?: Record<string, Record<string, unknown>> | null } | null | undefined, vpsid: string | number): Record<string, unknown> | null {
  const vs = r?.vs ?? {};
  const id = String(vpsid);
  if (vs[id]) return vs[id];
  const rows = Object.values(vs);
  const hit = rows.find((v) => v && String(v.vpsid ?? v.vps_id ?? "") === id);
  if (hit) return hit;
  if (rows.length === 1 && rows[0] && rows[0].vpsid === undefined && rows[0].vps_id === undefined) return rows[0];
  return null;
}
