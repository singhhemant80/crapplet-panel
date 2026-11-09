/**
 * Proxmox VE REST client (API token auth).
 * Docs: https://pve.proxmox.com/pve-docs/api-viewer/
 */
import { Agent, request } from "undici";
import { explainNetError } from "../../lib/net-errors";

export interface ProxmoxCreds {
  host: string;
  port: number;
  tokenId: string; // user@realm!tokenname
  secret: string; // token UUID
  verifyTls: boolean;
}

export interface PveNode {
  node: string;
  status: string;
  cpu: number;
  maxcpu: number;
  mem: number;
  maxmem: number;
  disk: number;
  maxdisk: number;
  uptime?: number;
}

export class ProxmoxError extends Error {
  constructor(message: string, public status?: number, public body?: unknown) {
    super(message);
  }
}

export class ProxmoxClient {
  private agent: Agent;
  private base: string;

  constructor(private creds: ProxmoxCreds) {
    this.agent = new Agent({ connect: { rejectUnauthorized: creds.verifyTls, timeout: 20_000, autoSelectFamily: true }, headersTimeout: 60_000, bodyTimeout: 120_000 });
    const scheme = creds.host.startsWith("http://") ? "" : "https://";
    this.base = `${scheme}${creds.host.replace(/\/$/, "")}:${creds.port}/api2/json`;
    if (creds.host.startsWith("http")) this.base = `${creds.host.replace(/\/$/, "")}/api2/json`;
  }

  async call<T = unknown>(method: "GET" | "POST" | "PUT" | "DELETE", path: string, params?: Record<string, unknown>): Promise<T> {
    const clean = Object.fromEntries(Object.entries(params ?? {}).filter(([, v]) => v !== undefined && v !== null)) as Record<string, string>;
    for (const k of Object.keys(clean)) clean[k] = typeof clean[k] === "boolean" ? (clean[k] ? "1" : "0") : String(clean[k]);
    let url = this.base + path;
    let body: string | undefined;
    if (method === "GET" || method === "DELETE") {
      const qs = new URLSearchParams(clean).toString();
      if (qs) url += "?" + qs;
    } else body = new URLSearchParams(clean).toString();
    const res = await request(url, {
      method,
      dispatcher: this.agent,
      headers: {
        Authorization: `PVEAPIToken=${this.creds.tokenId}=${this.creds.secret}`,
        ...(body !== undefined ? { "Content-Type": "application/x-www-form-urlencoded" } : {}),
      },
      body,
    }).catch((e) => {
      throw explainNetError(e, this.creds.host.replace(/^https?:\/\//, "").replace(/[:/].*$/, ""), this.creds.port, "Proxmox");
    });
    const text = await res.body.text();
    let json: { data?: T; errors?: unknown; message?: string } = {};
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      /* non-json error page */
    }
    if (res.statusCode >= 400) {
      const detail = json.errors ? JSON.stringify(json.errors) : json.message ?? text.slice(0, 200);
      throw new ProxmoxError(`Proxmox ${method} ${path} failed (${res.statusCode}): ${detail}`, res.statusCode, json);
    }
    return json.data as T;
  }

  version() {
    return this.call<{ version: string; release: string }>("GET", "/version");
  }
  nodes() {
    return this.call<PveNode[]>("GET", "/nodes");
  }
  clusterStatus() {
    return this.call<{ type: string; name: string; online?: number; quorate?: number }[]>("GET", "/cluster/status");
  }
  resources(type?: "vm" | "storage" | "node") {
    return this.call<{ id: string; type: string; node: string; vmid?: number; status?: string; template?: number; storage?: string; disk?: number; maxdisk?: number; name?: string }[]>(
      "GET",
      "/cluster/resources",
      type ? { type } : undefined,
    );
  }
  async nextId(): Promise<number> {
    return Number(await this.call<string>("GET", "/cluster/nextid"));
  }
  storageStatus(node: string, storage: string) {
    return this.call<{ total: number; used: number; avail: number; active: number }>("GET", `/nodes/${node}/storage/${storage}/status`);
  }

  /** Waits for a task (UPID) to finish; throws if it ended with an error. */
  async waitTask(node: string, upid: string, timeoutMs = 10 * 60_000) {
    const start = Date.now();
    for (;;) {
      const st = await this.call<{ status: string; exitstatus?: string }>("GET", `/nodes/${node}/tasks/${encodeURIComponent(upid)}/status`);
      if (st.status === "stopped") {
        if (st.exitstatus && st.exitstatus !== "OK" && !st.exitstatus.startsWith("WARNINGS")) throw new ProxmoxError(`Task failed: ${st.exitstatus}`);
        return st;
      }
      if (Date.now() - start > timeoutMs) throw new ProxmoxError(`Task timed out: ${upid}`);
      await new Promise((r) => setTimeout(r, 2000));
    }
  }

  // ── guests (kind = "qemu" | "lxc") ──
  guestStatus(node: string, kind: "qemu" | "lxc", vmid: number | string) {
    return this.call<{ status: string; cpu: number; cpus: number; mem: number; maxmem: number; disk: number; maxdisk: number; netin: number; netout: number; uptime: number; name?: string }>(
      "GET",
      `/nodes/${node}/${kind}/${vmid}/status/current`,
    );
  }
  async power(node: string, kind: "qemu" | "lxc", vmid: number | string, action: "start" | "stop" | "shutdown" | "reboot" | "reset" | "suspend" | "resume", wait = true) {
    const path = kind === "lxc" && action === "reset" ? "reboot" : action;
    const upid = await this.call<string>("POST", `/nodes/${node}/${kind}/${vmid}/status/${path}`, action === "shutdown" ? { timeout: 60, forceStop: 1 } : undefined);
    if (wait && upid) await this.waitTask(node, upid, 5 * 60_000);
    return upid;
  }
  config(node: string, kind: "qemu" | "lxc", vmid: number | string) {
    return this.call<Record<string, string | number>>("GET", `/nodes/${node}/${kind}/${vmid}/config`);
  }
  setConfig(node: string, kind: "qemu" | "lxc", vmid: number | string, params: Record<string, unknown>) {
    return this.call<string | null>(kind === "qemu" ? "POST" : "PUT", `/nodes/${node}/${kind}/${vmid}/config`, params);
  }
  async destroy(node: string, kind: "qemu" | "lxc", vmid: number | string) {
    const upid = await this.call<string>("DELETE", `/nodes/${node}/${kind}/${vmid}`, { purge: 1, "destroy-unreferenced-disks": 1, force: kind === "lxc" ? 1 : undefined });
    if (upid) await this.waitTask(node, upid);
  }
  async cloneQemu(templateNode: string, templateVmid: number, params: { newid: number; name: string; target?: string; storage?: string; full?: boolean; pool?: string }) {
    const upid = await this.call<string>("POST", `/nodes/${templateNode}/qemu/${templateVmid}/clone`, {
      newid: params.newid,
      name: params.name,
      target: params.target,
      storage: params.storage,
      full: params.full === false ? 0 : 1,
      pool: params.pool,
    });
    await this.waitTask(templateNode, upid, 20 * 60_000);
  }
  async resizeDisk(node: string, kind: "qemu" | "lxc", vmid: number | string, disk: string, sizeGb: number) {
    const upid = await this.call<string | null>("PUT", `/nodes/${node}/${kind}/${vmid}/resize`, { disk, size: `${sizeGb}G` });
    if (upid) await this.waitTask(node, upid);
  }
  regenerateCloudInit(node: string, vmid: number | string) {
    return this.call("PUT", `/nodes/${node}/qemu/${vmid}/cloudinit`);
  }
  async createLxc(node: string, params: Record<string, unknown>) {
    const upid = await this.call<string>("POST", `/nodes/${node}/lxc`, params);
    await this.waitTask(node, upid, 15 * 60_000);
  }
  async migrate(node: string, kind: "qemu" | "lxc", vmid: number | string, target: string, online = true) {
    const upid = await this.call<string>("POST", `/nodes/${node}/${kind}/${vmid}/migrate`, kind === "qemu" ? { target, online: online ? 1 : 0 } : { target, restart: online ? 1 : 0 });
    await this.waitTask(node, upid, 60 * 60_000);
  }
  async cloneGuest(node: string, kind: "qemu" | "lxc", vmid: number, newid: number, name: string, target?: string) {
    const upid = await this.call<string>("POST", `/nodes/${node}/${kind}/${vmid}/clone`, kind === "qemu" ? { newid, name, target, full: 1 } : { newid, hostname: name, target, full: 1 });
    await this.waitTask(node, upid, 30 * 60_000);
  }
  snapshots(node: string, kind: "qemu" | "lxc", vmid: number | string) {
    return this.call<{ name: string; description?: string; snaptime?: number; parent?: string }[]>("GET", `/nodes/${node}/${kind}/${vmid}/snapshot`);
  }
  async snapshot(node: string, kind: "qemu" | "lxc", vmid: number | string, snapname: string, description?: string) {
    const upid = await this.call<string>("POST", `/nodes/${node}/${kind}/${vmid}/snapshot`, { snapname, description });
    await this.waitTask(node, upid);
  }
  async rollback(node: string, kind: "qemu" | "lxc", vmid: number | string, snapname: string) {
    const upid = await this.call<string>("POST", `/nodes/${node}/${kind}/${vmid}/snapshot/${snapname}/rollback`);
    await this.waitTask(node, upid);
  }
  async deleteSnapshot(node: string, kind: "qemu" | "lxc", vmid: number | string, snapname: string) {
    const upid = await this.call<string>("DELETE", `/nodes/${node}/${kind}/${vmid}/snapshot/${snapname}`);
    await this.waitTask(node, upid);
  }
  async backup(node: string, vmid: number | string, storage: string, mode: "snapshot" | "suspend" | "stop" = "snapshot") {
    return this.call<string>("POST", `/nodes/${node}/vzdump`, { vmid, storage, mode, compress: "zstd" });
  }
  backups(node: string, storage: string, vmid: number | string) {
    return this.call<{ volid: string; size: number; ctime: number; format: string }[]>("GET", `/nodes/${node}/storage/${storage}/content`, { content: "backup", vmid });
  }
  rrd(node: string, kind: "qemu" | "lxc", vmid: number | string, timeframe: "hour" | "day" | "week" | "month" = "day") {
    return this.call<{ time: number; cpu?: number; mem?: number; maxmem?: number; netin?: number; netout?: number; diskread?: number; diskwrite?: number }[]>(
      "GET",
      `/nodes/${node}/${kind}/${vmid}/rrddata`,
      { timeframe, cf: "AVERAGE" },
    );
  }
  vncProxy(node: string, kind: "qemu" | "lxc", vmid: number | string) {
    return this.call<{ port: string; ticket: string; user: string; upid: string; cert?: string }>("POST", `/nodes/${node}/${kind}/${vmid}/vncproxy`, { websocket: 1 });
  }
}
