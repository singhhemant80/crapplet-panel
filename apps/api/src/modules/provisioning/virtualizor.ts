/**
 * Virtualizor Admin API client.
 * Docs: https://www.virtualizor.com/docs/admin-api/
 * Auth: adminapikey + adminapipass, JSON responses (api=json).
 */
import { Agent, request } from "undici";

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
    this.agent = new Agent({ connect: { rejectUnauthorized: creds.verifyTls }, headersTimeout: 120_000, bodyTimeout: 300_000 });
  }

  private url(act: string, query: Record<string, string | number | undefined> = {}) {
    const host = this.creds.host.replace(/^https?:\/\//, "").replace(/\/$/, "");
    const q = new URLSearchParams({ act, api: "json", adminapikey: this.creds.apiKey, adminapipass: this.creds.apiPass });
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
    const res = await request(this.url(act, query), {
      method: post ? "POST" : "GET",
      dispatcher: this.agent,
      headers: post ? { "Content-Type": "application/x-www-form-urlencoded" } : undefined,
      body,
    });
    const text = await res.body.text();
    let json: Record<string, unknown>;
    try {
      json = JSON.parse(text);
    } catch {
      throw new VirtualizorError(`Virtualizor ${act}: invalid response (HTTP ${res.statusCode})`, text.slice(0, 300));
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
  osTemplates() {
    return this.call<{ oslist: Record<string, unknown> }>("ostemplates");
  }
  servers() {
    return this.call<{ servs: Record<string, Record<string, unknown>> }>("servers");
  }

  async createVps(p: {
    virt: string;
    planId?: number;
    serverId?: number;
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
      slave_server: p.serverId ?? 0,
      node_select: p.serverId === undefined ? 1 : undefined,
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
