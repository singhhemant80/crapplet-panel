/**
 * IP address management.
 *
 * Concurrency guarantees
 *  - Every state transition is a single conditional UPDATE (`WHERE status = ...`), so Postgres' row lock
 *    decides the winner when two customers race for the same address; the loser gets 0 rows back.
 *  - Allocation runs inside the provisioning transaction with SELECT ... FOR UPDATE (SKIP LOCKED for auto-pick),
 *    and an address row can only ever point at one serviceId, so one IP can never be allocated twice.
 */
import { prisma, type Db, type Tx, IpStatus } from "../../db";
import { config } from "../../config";
import { badRequest, conflict, HttpError } from "../../lib/http";
import { expandIpv4Cidr, isIpv4, isIpv6, parseCidr, compressIpv6, expandIpv6 } from "../../lib/ip";
import { getSettings } from "../../lib/settings";

const MAX_ACTIVE_RESERVATIONS_PER_USER = 5;

export async function logIp(
  db: Db,
  e: { ipId: string; action: string; from?: IpStatus | null; to?: IpStatus | null; userId?: string | null; serviceId?: string | null; actorId?: string | null; note?: string },
) {
  await db.ipHistory.create({
    data: { ipId: e.ipId, action: e.action, fromStatus: e.from ?? null, toStatus: e.to ?? null, userId: e.userId ?? null, serviceId: e.serviceId ?? null, actorId: e.actorId ?? null, note: e.note },
  });
}

type Row = { id: string; address: string; status: IpStatus; reservedUntil: Date | null; serverId: string | null };

/** Available IPv4 addresses a customer may pick for a server (or any server attached to the product). */
export async function listAvailableIps(opts: { serverIds: string[]; search?: string; limit?: number }) {
  if (!opts.serverIds.length) return [];
  const limit = Math.min(opts.limit ?? 100, 500);
  const like = opts.search ? `%${opts.search.replace(/[%_]/g, "")}%` : "%";
  return prisma.$queryRaw<{ id: string; address: string; serverId: string; subnet: string | null }[]>`
    SELECT ip."id", ip."address", ip."serverId", s."cidr" AS "subnet"
    FROM "IpAddress" ip LEFT JOIN "IpSubnet" s ON s."id" = ip."subnetId"
    WHERE ip."version" = 4
      AND ip."serverId" = ANY(${opts.serverIds})
      AND ip."address" LIKE ${like}
      AND (ip."status" = 'AVAILABLE'::"IpStatus" OR (ip."status" = 'RESERVED'::"IpStatus" AND ip."reservedUntil" < now() AND ip."serviceId" IS NULL))
    ORDER BY ip."address"::inet
    LIMIT ${limit}`;
}

/** Temporarily reserve an IP for a customer (default 15 minutes). Throws 409 if someone else has it. */
export async function reserveIp(args: { ipId: string; userId: string; serverIds?: string[]; minutes?: number }) {
  const settings = await getSettings();
  const minutes = args.minutes ?? settings.orders.ipReservationMinutes ?? config.ipReservationMinutes;

  const active = await prisma.ipAddress.count({
    where: { reservedById: args.userId, status: "RESERVED", reservedUntil: { gt: new Date() }, NOT: { id: args.ipId } },
  });
  if (active >= MAX_ACTIVE_RESERVATIONS_PER_USER) throw new HttpError(429, "You are holding too many IP reservations. Complete or cancel an order first.");

  const serverFilter = args.serverIds?.length ? args.serverIds : null;
  const rows = await prisma.$queryRaw<Row[]>`
    UPDATE "IpAddress" SET
      "status" = 'RESERVED'::"IpStatus",
      "reservedById" = ${args.userId},
      "reservedOrderId" = NULL,
      "reservedUntil" = now() + make_interval(mins => ${minutes}::int),
      "updatedAt" = now()
    WHERE "id" = ${args.ipId}
      AND "version" = 4
      AND "serviceId" IS NULL
      AND (${serverFilter}::text[] IS NULL OR "serverId" = ANY(${serverFilter}::text[]))
      AND (
        "status" = 'AVAILABLE'::"IpStatus"
        OR ("status" = 'RESERVED'::"IpStatus" AND ("reservedUntil" < now() OR "reservedById" = ${args.userId}))
      )
    RETURNING "id", "address", "status", "reservedUntil", "serverId"`;
  if (!rows.length) throw conflict("That IP address was just taken. Please choose another one.");
  await logIp(prisma, { ipId: rows[0].id, action: "reserved", from: "AVAILABLE", to: "RESERVED", userId: args.userId, note: `${minutes} minute hold` });
  return rows[0];
}

/** Ties a reservation to an order (called at checkout). Re-validates ownership and refreshes the hold. */
export async function attachReservationToOrder(tx: Tx, args: { ipId: string; userId: string; orderId: string }) {
  const settings = await getSettings();
  const minutes = settings.orders.ipReservationMinutes ?? config.ipReservationMinutes;
  const rows = await tx.$queryRaw<Row[]>`
    UPDATE "IpAddress" SET "reservedOrderId" = ${args.orderId},
      "reservedUntil" = GREATEST("reservedUntil", now() + make_interval(mins => ${minutes}::int)), "updatedAt" = now()
    WHERE "id" = ${args.ipId} AND "status" = 'RESERVED'::"IpStatus" AND "reservedById" = ${args.userId}
      AND "reservedUntil" > now() AND "serviceId" IS NULL
    RETURNING "id", "address", "status", "reservedUntil", "serverId"`;
  if (!rows.length) throw conflict("Your IP reservation has expired. Please select an IP address again.");
  return rows[0];
}

export async function releaseIpReservation(ipId: string, userId: string) {
  const rows = await prisma.$queryRaw<Row[]>`
    UPDATE "IpAddress" SET "status" = 'AVAILABLE'::"IpStatus", "reservedById" = NULL, "reservedOrderId" = NULL, "reservedUntil" = NULL, "updatedAt" = now()
    WHERE "id" = ${ipId} AND "status" = 'RESERVED'::"IpStatus" AND "reservedById" = ${userId} AND "serviceId" IS NULL
    RETURNING "id", "address", "status", "reservedUntil", "serverId"`;
  if (rows.length) await logIp(prisma, { ipId, action: "released", from: "RESERVED", to: "AVAILABLE", userId, note: "released by customer" });
  return rows.length > 0;
}

/** Release every reservation held for an order (cancelled / failed / fraud). */
export async function releaseOrderReservations(orderId: string, db: Db = prisma, note = "order cancelled") {
  const rows = await db.$queryRaw<Row[]>`
    UPDATE "IpAddress" SET "status" = 'AVAILABLE'::"IpStatus", "reservedById" = NULL, "reservedOrderId" = NULL, "reservedUntil" = NULL, "updatedAt" = now()
    WHERE "reservedOrderId" = ${orderId} AND "status" = 'RESERVED'::"IpStatus" AND "serviceId" IS NULL
    RETURNING "id", "address", "status", "reservedUntil", "serverId"`;
  for (const r of rows) await logIp(db, { ipId: r.id, action: "released", from: "RESERVED", to: "AVAILABLE", note });
  return rows.length;
}

/** Background job: expire stale holds. */
export async function expireReservations() {
  const rows = await prisma.$queryRaw<Row[]>`
    UPDATE "IpAddress" SET "status" = 'AVAILABLE'::"IpStatus", "reservedById" = NULL, "reservedOrderId" = NULL, "reservedUntil" = NULL, "updatedAt" = now()
    WHERE "status" = 'RESERVED'::"IpStatus" AND "reservedUntil" < now() AND "serviceId" IS NULL
    RETURNING "id", "address", "status", "reservedUntil", "serverId"`;
  for (const r of rows) await logIp(prisma, { ipId: r.id, action: "reservation_expired", from: "RESERVED", to: "AVAILABLE" });
  return rows.length;
}

/**
 * Allocate IPv4 addresses to a service inside a transaction.
 * 1. The customer's chosen IP if it is still reserved for this order/user or still available.
 * 2. Otherwise (hold expired and taken meanwhile) the next free IP on the same server, flagged in the log.
 */
export async function allocateIpsForService(
  tx: Tx,
  args: { serviceId: string; userId: string; serverId: string; orderId?: string | null; requestedIpId?: string | null; count: number },
) {
  const allocated: { id: string; address: string; fallback: boolean }[] = [];
  // serialise allocation per service: a second concurrent job waits here and then sees the first job's IPs
  await tx.$queryRaw`SELECT "id" FROM "Service" WHERE "id" = ${args.serviceId} FOR UPDATE`;
  const existing = await tx.ipAddress.findMany({ where: { serviceId: args.serviceId, status: "ALLOCATED" } });
  if (existing.length >= args.count) return existing.map((e) => ({ id: e.id, address: e.address, fallback: false }));
  let needed = args.count - existing.length;

  if (args.requestedIpId && !existing.some((e) => e.id === args.requestedIpId)) {
    const locked = await tx.$queryRaw<(Row & { reservedById: string | null; reservedOrderId: string | null; serviceId: string | null })[]>`
      SELECT "id", "address", "status", "reservedUntil", "serverId", "reservedById", "reservedOrderId", "serviceId"
      FROM "IpAddress" WHERE "id" = ${args.requestedIpId} FOR UPDATE`;
    const ip = locked[0];
    const mine =
      ip &&
      ip.serviceId === null &&
      ip.serverId === args.serverId &&
      (ip.status === "AVAILABLE" ||
        (ip.status === "RESERVED" && (ip.reservedById === args.userId || (args.orderId && ip.reservedOrderId === args.orderId))) ||
        (ip.status === "RESERVED" && ip.reservedUntil !== null && ip.reservedUntil < new Date()));
    if (mine) {
      await tx.$executeRaw`
        UPDATE "IpAddress" SET "status" = 'ALLOCATED'::"IpStatus", "serviceId" = ${args.serviceId}, "isPrimary" = ${existing.length === 0},
          "reservedById" = NULL, "reservedOrderId" = NULL, "reservedUntil" = NULL, "updatedAt" = now()
        WHERE "id" = ${ip.id}`;
      await logIp(tx, { ipId: ip.id, action: "allocated", from: ip.status, to: "ALLOCATED", userId: args.userId, serviceId: args.serviceId, note: "customer selected" });
      allocated.push({ id: ip.id, address: ip.address, fallback: false });
      needed--;
    }
  }

  while (needed > 0) {
    const free = await tx.$queryRaw<Row[]>`
      SELECT "id", "address", "status", "reservedUntil", "serverId" FROM "IpAddress"
      WHERE "serverId" = ${args.serverId} AND "version" = 4 AND "serviceId" IS NULL
        AND ("status" = 'AVAILABLE'::"IpStatus" OR ("status" = 'RESERVED'::"IpStatus" AND "reservedUntil" < now()))
      ORDER BY "address"::inet
      LIMIT 1 FOR UPDATE SKIP LOCKED`;
    if (!free.length) throw new HttpError(503, `No free IPv4 addresses left on this server`, "IP_POOL_EXHAUSTED");
    const ip = free[0];
    await tx.$executeRaw`
      UPDATE "IpAddress" SET "status" = 'ALLOCATED'::"IpStatus", "serviceId" = ${args.serviceId}, "isPrimary" = ${existing.length + allocated.length === 0},
        "reservedById" = NULL, "reservedOrderId" = NULL, "reservedUntil" = NULL, "updatedAt" = now()
      WHERE "id" = ${ip.id}`;
    const fallback = !!args.requestedIpId && allocated.length === 0;
    await logIp(tx, {
      ipId: ip.id, action: "allocated", from: ip.status, to: "ALLOCATED", userId: args.userId, serviceId: args.serviceId,
      note: fallback ? "auto-assigned: requested IP was no longer available" : "auto-assigned",
    });
    allocated.push({ id: ip.id, address: ip.address, fallback });
    needed--;
  }
  return [...existing.map((e) => ({ id: e.id, address: e.address, fallback: false })), ...allocated];
}

/** Return a service's IPs to the pool (QUARANTINED for a cool-off period by default to avoid instant reuse). */
export async function releaseServiceIps(db: Db, serviceId: string, opts: { quarantine?: boolean; actorId?: string } = {}) {
  const ips = await db.ipAddress.findMany({ where: { serviceId } });
  const to: IpStatus = opts.quarantine === false ? "AVAILABLE" : "QUARANTINED";
  for (const ip of ips) {
    await db.ipAddress.update({ where: { id: ip.id }, data: { status: to, serviceId: null, isPrimary: false, rdns: null } });
    await logIp(db, { ipId: ip.id, action: "released", from: ip.status, to, serviceId, actorId: opts.actorId, note: "service terminated" });
  }
  return ips.length;
}

// ───── Admin import helpers ─────

export async function importCidr(args: {
  cidr: string;
  serverId?: string | null;
  locationId?: string | null;
  gateway?: string | null;
  vlan?: number | null;
  notes?: string | null;
  expand?: boolean;
  actorId?: string;
}) {
  const p = parseCidr(args.cidr);
  const subnet = await prisma.ipSubnet.upsert({
    where: { cidr: p.cidr },
    update: { serverId: args.serverId ?? undefined, locationId: args.locationId ?? undefined, gateway: args.gateway ?? undefined, vlan: args.vlan ?? undefined, notes: args.notes ?? undefined },
    create: { cidr: p.cidr, version: p.version, prefix: p.prefix, gateway: args.gateway, serverId: args.serverId, locationId: args.locationId, vlan: args.vlan, notes: args.notes },
  });
  if (p.version === 6 || args.expand === false) return { subnet, created: 0, skipped: 0 };

  const { hosts, gateway } = expandIpv4Cidr(p.cidr, { gateway: args.gateway });
  if (!subnet.gateway) await prisma.ipSubnet.update({ where: { id: subnet.id }, data: { gateway } });
  const r = await prisma.ipAddress.createMany({
    data: hosts.map((address) => ({ address, version: 4, subnetId: subnet.id, serverId: args.serverId ?? null })),
    skipDuplicates: true,
  });
  return { subnet, created: r.count, skipped: hosts.length - r.count };
}

/** CSV columns: address,server(optional name or id),status(optional),rdns(optional),notes(optional) */
export async function importCsv(rows: Record<string, string>[], defaults: { serverId?: string | null }) {
  const servers = await prisma.server.findMany({ select: { id: true, name: true } });
  const subnets = await prisma.ipSubnet.findMany({ where: { version: 4 } });
  const { ipv4InCidr } = await import("../../lib/ip");
  let created = 0;
  const errors: { line: number; error: string }[] = [];
  for (const [i, row] of rows.entries()) {
    const raw = (row.address ?? row.ip ?? "").trim();
    const version = isIpv4(raw) ? 4 : isIpv6(raw) ? 6 : 0;
    if (!version) {
      errors.push({ line: i + 2, error: `Invalid IP "${raw}"` });
      continue;
    }
    const address = version === 6 ? compressIpv6(expandIpv6(raw)!) : raw;
    const srv = row.server ? servers.find((s) => s.id === row.server || s.name.toLowerCase() === row.server.toLowerCase()) : null;
    if (row.server && !srv) {
      errors.push({ line: i + 2, error: `Unknown server "${row.server}"` });
      continue;
    }
    const status = (row.status?.toUpperCase() as IpStatus) || "AVAILABLE";
    if (!Object.values(IpStatus).includes(status) || status === "ALLOCATED" || status === "RESERVED") {
      errors.push({ line: i + 2, error: `Status must be AVAILABLE, BLOCKED, MAINTENANCE or QUARANTINED` });
      continue;
    }
    const subnet = version === 4 ? subnets.find((s) => ipv4InCidr(address, s.cidr)) : undefined;
    try {
      await prisma.ipAddress.create({
        data: { address, version, status, serverId: srv?.id ?? defaults.serverId ?? null, subnetId: subnet?.id, rdns: row.rdns || null, notes: row.notes || null },
      });
      created++;
    } catch {
      errors.push({ line: i + 2, error: `${address} already exists` });
    }
  }
  return { created, errors };
}

export async function setIpStatus(ipId: string, status: IpStatus, actorId: string, note?: string) {
  if (status === "ALLOCATED" || status === "RESERVED") throw badRequest("Use service assignment to allocate IPs");
  const ip = await prisma.ipAddress.findUniqueOrThrow({ where: { id: ipId } });
  if (ip.status === "ALLOCATED" && ip.serviceId) throw conflict("IP is allocated to a service. Unassign it first.");
  const updated = await prisma.ipAddress.update({
    where: { id: ipId },
    data: { status, reservedById: null, reservedOrderId: null, reservedUntil: null },
  });
  await logIp(prisma, { ipId, action: "status_changed", from: ip.status, to: status, actorId, note });
  return updated;
}

/** Admin: manually assign an IP to a service (e.g. additional IP). */
export async function adminAssignIp(ipId: string, serviceId: string, actorId: string) {
  return prisma.$transaction(async (tx) => {
    const svc = await tx.service.findUniqueOrThrow({ where: { id: serviceId } });
    const rows = await tx.$queryRaw<Row[]>`
      UPDATE "IpAddress" SET "status" = 'ALLOCATED'::"IpStatus", "serviceId" = ${serviceId},
        "reservedById" = NULL, "reservedOrderId" = NULL, "reservedUntil" = NULL, "updatedAt" = now()
      WHERE "id" = ${ipId} AND "serviceId" IS NULL AND ("status" = 'AVAILABLE'::"IpStatus" OR ("status" = 'RESERVED'::"IpStatus" AND "reservedUntil" < now()))
      RETURNING "id", "address", "status", "reservedUntil", "serverId"`;
    if (!rows.length) throw conflict("IP is not available");
    await logIp(tx, { ipId, action: "allocated", to: "ALLOCATED", userId: svc.userId, serviceId, actorId, note: "assigned by staff" });
    return rows[0];
  });
}
