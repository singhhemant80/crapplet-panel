import crypto from "crypto";
import type { IncomingMessage, Server as HttpServer } from "http";
import type { Duplex } from "stream";
import WebSocket, { WebSocketServer } from "ws";
import { prisma } from "../../db";
import { redis } from "../../jobs/queues";
import { HttpError } from "../../lib/http";
import { virtualizorFor } from "../provisioning/provisioner";

/**
 * Browser console for Virtualizor VPSes. Like the official WHMCS module we ask Virtualizor for a
 * console password (act=vnc) and connect noVNC to the master's websocket (port 4083,
 * /novnc/?virttoken=<vpsid>). The browser talks to the panel, which relays to the master — so it works
 * even when customers can't reach the master or its certificate is self-signed.
 */
const KEY = (t: string) => `crapplet:console:${t}`;
const ERR = (t: string) => `crapplet:console:err:${t}`;
type Ticket = { hosts: string[]; port: number; token: string; verifyTls: boolean; serviceId: string };

const bareHost = (h: string) => h.replace(/^https?:\/\//, "").replace(/[:/].*$/, "");

export async function openConsole(serviceId: string, who: { userId: string; staff: boolean; ip?: string }) {
  const svc = await prisma.service.findUniqueOrThrow({ where: { id: serviceId }, include: { server: true, product: { select: { provisioner: true } } } });
  if (svc.product.provisioner !== "VIRTUALIZOR") throw new HttpError(400, "The browser console is available for Virtualizor VPSes");
  if (!svc.server || !svc.remoteId) throw new HttpError(409, "This VPS hasn't been created yet");
  if (!who.staff && svc.status !== "ACTIVE") throw new HttpError(409, `The console isn't available while the service is ${svc.status.toLowerCase()}`);
  const info = await virtualizorFor(svc.server)
    .vncInfo(svc.remoteId)
    .catch((e: Error) => {
      // show the real reason instead of a generic 500
      throw new HttpError(502, e.message);
    });
  const master = bareHost(svc.server.hostname);
  const node = info.host ? bareHost(info.host) : "";
  // Same as the WHMCS module: the websocket lives on the MASTER (https 4083, /novnc/?virttoken=<vpsid>).
  // Only XCP uses the node's host and "<vpsid>-<password>" as the token. The other host is kept as a fallback.
  const xcp = info.virt === "xcp";
  const hosts = [...new Set((xcp ? [node, master] : [master, node]).filter(Boolean))];
  const token = xcp ? `${svc.remoteId}-${info.password}` : svc.remoteId;
  const ticket = crypto.randomBytes(24).toString("base64url");
  const t: Ticket = { hosts, port: 4083, token, verifyTls: svc.server.verifyTls, serviceId: svc.id };
  await redis().set(KEY(ticket), JSON.stringify(t), "EX", 60);
  await prisma.provisioningLog.create({ data: { serviceId: svc.id, action: "console", success: true, message: `Console opened by ${who.staff ? "staff" : "customer"}${who.ip ? ` from ${who.ip}` : ""} (${info.virt ?? "kvm"}, via ${hosts[0]}:4083)` } });
  return { path: `/api/console/ws?t=${ticket}`, statusPath: `/api/console/status?t=${ticket}`, password: info.password, vpsid: svc.remoteId };
}

/** Why the last console connection for this ticket failed (shown in the console instead of "connection closed"). */
export async function consoleError(ticket: string) {
  return ticket ? redis().get(ERR(ticket)) : null;
}

async function recordFailure(ticket: string, t: Ticket, reason: string) {
  await redis().set(ERR(ticket), reason, "EX", 600).catch(() => null);
  await prisma.provisioningLog.create({ data: { serviceId: t.serviceId, action: "console", success: false, message: reason.slice(0, 500) } }).catch(() => null);
}

function connectUpstream(t: Ticket, host: string, protocols: string[]): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`wss://${host}:${t.port}/novnc/?virttoken=${encodeURIComponent(t.token)}`, protocols, {
      rejectUnauthorized: t.verifyTls,
      handshakeTimeout: 15_000,
      perMessageDeflate: false,
      origin: `https://${host}:${t.port}`,
    });
    ws.once("open", () => resolve(ws));
    ws.once("unexpected-response", (_req, res) => {
      reject(new Error(`${host}:${t.port} answered HTTP ${res.statusCode}${res.statusCode === 404 ? " (no noVNC websocket there)" : ""}`));
      ws.terminate();
    });
    ws.once("error", (e) => reject(new Error(`${host}:${t.port} — ${(e as Error).message}`)));
  });
}

/** Relays /api/console/ws?t=<ticket> websocket upgrades to the Virtualizor master. */
export function attachConsoleProxy(server: HttpServer) {
  const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false, handleProtocols: (protocols) => (protocols.has("binary") ? "binary" : [...protocols][0] ?? false) });
  server.on("upgrade", async (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const url = new URL(req.url ?? "/", "http://x");
    if (url.pathname !== "/api/console/ws") return; // not ours
    const tk = url.searchParams.get("t") ?? "";
    const raw = tk ? await redis().getdel(KEY(tk)).catch(() => null) : null;
    if (!raw) {
      socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      return socket.destroy();
    }
    const ticket = JSON.parse(raw) as Ticket;
    wss.handleUpgrade(req, socket, head, async (client) => {
      const protocols = String(req.headers["sec-websocket-protocol"] ?? "binary").split(",").map((x) => x.trim()).filter(Boolean);
      const pending: { m: Buffer | string; bin: boolean }[] = [];
      let upstream: WebSocket | null = null;
      let closed = false;
      client.on("message", (data, isBinary) => {
        const m = isBinary ? (data as Buffer) : data.toString();
        upstream?.readyState === WebSocket.OPEN ? upstream.send(m, { binary: isBinary }) : pending.push({ m, bin: isBinary });
      });
      client.on("close", () => {
        closed = true;
        upstream?.terminate();
      });
      client.on("error", () => upstream?.terminate());

      const errors: string[] = [];
      for (const host of ticket.hosts) {
        try {
          upstream = await connectUpstream(ticket, host, protocols);
          break;
        } catch (e) {
          errors.push((e as Error).message);
        }
      }
      if (closed) return upstream?.terminate();
      if (!upstream) {
        const reason = `Couldn't open the console websocket: ${errors.join("; ")}. The panel server must reach the Virtualizor master on port 4083${ticket.verifyTls ? " (and its SSL certificate must be valid — or turn off 'Verify SSL' for this server)" : ""}.`;
        await recordFailure(tk, ticket, reason);
        return client.close(1011, "console unreachable");
      }
      const up = upstream;
      for (const p of pending.splice(0)) up.send(p.m, { binary: p.bin });
      up.on("message", (data, isBinary) => client.readyState === WebSocket.OPEN && client.send(data, { binary: isBinary }));
      const opened = Date.now();
      let bytes = 0;
      up.on("message", (d) => (bytes += (d as Buffer).length ?? 0));
      up.on("close", async (code, reason) => {
        if (Date.now() - opened < 5000 && bytes < 64) await recordFailure(tk, ticket, `Virtualizor closed the console right away (code ${code}${reason.length ? `: ${reason.toString()}` : ""}). Usually the VPS is powered off, VNC is disabled for it, or the node's VNC service isn't reachable from the master.`);
        if (client.readyState === WebSocket.OPEN) client.close(code === 1005 || code === 1006 ? 1000 : code, reason.toString().slice(0, 120));
      });
      up.on("error", () => client.readyState === WebSocket.OPEN && client.close(1011));
    });
  });
}
