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
type Ticket = { host: string; port: number; vpsid: string; verifyTls: boolean; serviceId: string };

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
  const ticket = crypto.randomBytes(24).toString("base64url");
  const t: Ticket = { host: info.host || svc.server.hostname.replace(/^https?:\/\//, "").replace(/[:/].*$/, ""), port: 4083, vpsid: svc.remoteId, verifyTls: svc.server.verifyTls, serviceId: svc.id };
  await redis().set(KEY(ticket), JSON.stringify(t), "EX", 60);
  await prisma.provisioningLog.create({ data: { serviceId: svc.id, action: "console", success: true, message: `Console opened by ${who.staff ? "staff" : "customer"}${who.ip ? ` from ${who.ip}` : ""}` } });
  return { path: `/api/console/ws?t=${ticket}`, password: info.password, vpsid: svc.remoteId };
}

/** Relays /api/console/ws?t=<ticket> websocket upgrades to the Virtualizor master. */
export function attachConsoleProxy(server: HttpServer) {
  const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false, handleProtocols: (protocols) => (protocols.has("binary") ? "binary" : [...protocols][0] ?? false) });
  server.on("upgrade", async (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const url = new URL(req.url ?? "/", "http://x");
    if (url.pathname !== "/api/console/ws") return; // not ours
    const t = url.searchParams.get("t") ?? "";
    const raw = t ? await redis().getdel(KEY(t)).catch(() => null) : null;
    if (!raw) {
      socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      return socket.destroy();
    }
    const ticket = JSON.parse(raw) as Ticket;
    wss.handleUpgrade(req, socket, head, (client) => {
      const protocols = String(req.headers["sec-websocket-protocol"] ?? "binary").split(",").map((x) => x.trim()).filter(Boolean);
      const upstream = new WebSocket(`wss://${ticket.host}:${ticket.port}/novnc/?virttoken=${encodeURIComponent(ticket.vpsid)}`, protocols, {
        rejectUnauthorized: ticket.verifyTls,
        handshakeTimeout: 15_000,
        perMessageDeflate: false,
      });
      const pending: (Buffer | string)[] = [];
      upstream.on("open", () => {
        for (const m of pending.splice(0)) upstream.send(m);
      });
      upstream.on("message", (data, isBinary) => client.readyState === WebSocket.OPEN && client.send(data, { binary: isBinary }));
      client.on("message", (data, isBinary) => {
        const m = isBinary ? (data as Buffer) : data.toString();
        upstream.readyState === WebSocket.OPEN ? upstream.send(m, { binary: isBinary }) : pending.push(m);
      });
      const end = (code = 1000, reason = "") => {
        if (client.readyState === WebSocket.OPEN) client.close(code, reason.slice(0, 120));
        if (upstream.readyState === WebSocket.OPEN || upstream.readyState === WebSocket.CONNECTING) upstream.terminate();
      };
      upstream.on("error", (e) => end(1011, `Can't reach the console on ${ticket.host}:${ticket.port} (${(e as Error).message})`));
      upstream.on("close", (code, reason) => end(code === 1005 || code === 1006 ? 1000 : code, reason.toString()));
      client.on("close", () => end());
      client.on("error", () => end());
    });
  });
}
