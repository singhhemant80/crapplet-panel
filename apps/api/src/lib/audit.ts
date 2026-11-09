import { prisma, type Db } from "../db";

export async function audit(
  entry: { actorId?: string | null; userId?: string | null; action: string; entity?: string; entityId?: string; ip?: string; details?: unknown },
  db: Db = prisma,
) {
  try {
    await db.activityLog.create({
      data: {
        actorId: entry.actorId ?? null,
        userId: entry.userId ?? null,
        action: entry.action,
        entity: entry.entity,
        entityId: entry.entityId,
        ip: entry.ip,
        details: (entry.details ?? undefined) as object | undefined,
      },
    });
  } catch (e) {
    console.error("[audit] failed", e);
  }
}
