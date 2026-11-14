/**
 * Admin: why does this service show no IP / no live state? — what Virtualizor says about it, the VPSes that
 * could be its own (by IP, hostname or the customer's email), and linking it to one with a click.
 */
import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../db";
import { ah, badRequest, notFound, parse } from "../../lib/http";
import { audit } from "../../lib/audit";
import { requireStaff } from "../../middleware/auth";
import { virtualizorFor, syncVirtualizorService } from "../provisioning/provisioner";
import { isIp, pickVps, vpsIpsOf } from "../provisioning/virtualizor";

export const adminVirtualizorCheck = Router();

/** Every IP-looking value in a VPS record with where it sits — shows how this Virtualizor lays IPs out. */
function ipPaths(v: unknown, path = "", out: { path: string; ip: string }[] = []) {
  if (out.length > 40) return out;
  if (typeof v === "string" || typeof v === "number") {
    for (const part of String(v).split(/[\s,;]+/)) if (isIp(part)) out.push({ path, ip: part });
  } else if (Array.isArray(v)) v.forEach((x, i) => ipPaths(x, `${path}[${i}]`, out));
  else if (v && typeof v === "object")
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      if (isIp(k)) out.push({ path: `${path}.${k} (key)`, ip: k });
      ipPaths(x, path ? `${path}.${k}` : k, out);
    }
  return out;
}
const SECRET = /pass|key|secret|token|hash/i;

adminVirtualizorCheck.get(
  "/services/:id/virtualizor-check",
  requireStaff("services.view"),
  ah(async (req, res) => {
    const svc = await prisma.service.findUnique({ where: { id: req.params.id }, include: { server: true, product: true, user: { select: { email: true } }, ips: { select: { address: true } } } });
    if (!svc) throw notFound();
    if (svc.product.provisioner !== "VIRTUALIZOR") throw badRequest("Not a Virtualizor service");
    const masters = svc.server?.type === "VIRTUALIZOR" ? [svc.server] : await prisma.server.findMany({ where: { type: "VIRTUALIZOR" } });
    const out: Record<string, unknown> = {
      linked: !!(svc.remoteId && svc.server?.type === "VIRTUALIZOR"),
      remoteId: svc.remoteId,
      master: svc.server?.name ?? null,
      hostname: svc.hostname,
      customerEmail: svc.user.email,
      storedIps: svc.ips.map((i) => i.address),
    };
    if (out.linked) {
      const c = virtualizorFor(svc.server!);
      try {
        const r = await c.getVps(svc.remoteId!);
        const row = pickVps(r, svc.remoteId!) as Record<string, unknown> | null;
        out.found = !!row;
        if (row) {
          out.fields = Object.keys(row).filter((k) => !SECRET.test(k)).sort();
          out.ipsRead = vpsIpsOf(row);
          out.ipsSeen = ipPaths(Object.fromEntries(Object.entries(row).filter(([k]) => !SECRET.test(k))));
          out.vpsHostname = row.hostname ?? null;
          out.vpsEmail = row.email ?? null;
        } else out.responseKeys = Object.keys(r ?? {});
        out.ipsFromIpList = (await c.ipsByVps().catch(() => new Map<string, string[]>())).get(String(svc.remoteId)) ?? [];
      } catch (e) {
        out.error = (e as Error).message;
      }
    }
    // VPSes that could be this service's (always shown when it isn't linked or its VPS wasn't found)
    if (!out.linked || out.found === false) {
      const want = { ips: new Set(svc.ips.map((i) => i.address)), host: svc.hostname?.trim().toLowerCase() ?? "", email: svc.user.email.toLowerCase() };
      const taken = new Set((await prisma.service.findMany({ where: { remoteId: { not: null }, status: { notIn: ["TERMINATED", "CANCELLED"] } }, select: { remoteId: true, serverId: true } })).map((x) => `${x.serverId}|${x.remoteId}`));
      const candidates: Record<string, unknown>[] = [];
      for (const m of masters) {
        try {
          const c = virtualizorFor(m);
          const emails = await c.userEmails().catch(() => new Map<string, string>());
          for (let page = 1; page <= 200 && candidates.length < 25; page++) {
            const list = Object.entries((await c.listVps(page, 200)).vs ?? {});
            for (const [k, row] of list) {
              const vpsid = String(row.vpsid ?? k);
              const ips = vpsIpsOf(row);
              const email = String(row.email ?? emails.get(String(row.uid)) ?? "").toLowerCase();
              const host = String(row.hostname ?? "").toLowerCase();
              const why = [ips.some((i) => want.ips.has(i)) && "same IP", want.host && host === want.host && "same hostname", email && email === want.email && "customer's email"].filter(Boolean);
              if (why.length) candidates.push({ serverId: m.id, master: m.name, vpsid, hostname: row.hostname ?? null, ips, email: email || null, why, inUse: taken.has(`${m.id}|${vpsid}`) });
            }
            if (list.length < 200) break;
          }
        } catch (e) {
          candidates.push({ master: m.name, error: (e as Error).message });
        }
      }
      out.candidates = candidates;
    }
    res.json(out);
  }),
);

adminVirtualizorCheck.post(
  "/services/:id/virtualizor-link",
  requireStaff("services.manage"),
  ah(async (req, res) => {
    const b = parse(z.object({ serverId: z.string(), vpsid: z.string().regex(/^\d+$/) }), req.body);
    const svc = await prisma.service.findUnique({ where: { id: req.params.id }, include: { product: true } });
    if (!svc) throw notFound();
    const m = await prisma.server.findUnique({ where: { id: b.serverId } });
    if (!m || m.type !== "VIRTUALIZOR") throw badRequest("Pick a Virtualizor master");
    const other = await prisma.service.findFirst({ where: { id: { not: svc.id }, serverId: m.id, remoteId: b.vpsid, status: { notIn: ["TERMINATED", "CANCELLED"] } }, select: { id: true, hostname: true } });
    if (other) throw badRequest(`VPS ${b.vpsid} already belongs to another service${other.hostname ? ` (${other.hostname})` : ""}`);
    await prisma.service.update({ where: { id: svc.id }, data: { serverId: m.id, remoteId: b.vpsid } });
    await audit({ actorId: req.user!.id, userId: svc.userId, action: "service.virtualizor_linked", entity: "service", entityId: svc.id, details: { from: svc.remoteId, to: b.vpsid, master: m.name } });
    const r = await syncVirtualizorService(svc.id);
    res.json(r);
  }),
);
