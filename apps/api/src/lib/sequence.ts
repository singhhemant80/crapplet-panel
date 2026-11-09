import { prisma, type Db } from "../db";

/** Atomically increments and returns the next value of a named sequence (gap-free within a committed tx). */
export async function nextSequence(name: string, db: Db = prisma): Promise<number> {
  const rows = await db.$queryRaw<{ value: number }[]>`
    INSERT INTO "Sequence" ("name", "value") VALUES (${name}, 1)
    ON CONFLICT ("name") DO UPDATE SET "value" = "Sequence"."value" + 1
    RETURNING "value"`;
  return Number(rows[0].value);
}
