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
        if (Array.isArray(v)) v.forEach((x) => form.append(`${k}[]`, String(x)));
        else form.set(k, String(v));
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
    /** extra addvs fields from the plan's advanced settings (vnc, nic_type, …) */
    extra?: Record<string, string>;
    userEmail: string;
    userPass: string;
    hostname: string;
    rootPass: string;
    osId: number;
    ips: string[];
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
      user_email: p.userEmail,
      user_pass: p.userPass,
      hostname: p.hostname,
      rootpass: p.rootPass,
      osid: p.osId,
      ips: p.ips,
      num_ips: p.ips.length || 1,
      ram: p.ramMb,
      space: p.diskGb,
      cores: p.cores,
      bandwidth: p.bandwidthGb ?? 0,
      ...(p.extra ?? {}),
    });
    const vpsid = r.vs_info?.vpsid ?? r.newvs?.vpsid;
    if (!vpsid) throw new VirtualizorError("Virtualizor did not return a VPS id", r);
    return String(vpsid);
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
