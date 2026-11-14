import { prisma, type Db } from "../db";

/** Atomically increments and returns the next value of a named sequence (gap-free within a committed tx). */
export async function nextSequence(name: string, db: Db = prisma): Promise<number> {
  const rows = await db.$queryRaw<{ value: number }[]>`
    INSERT INTO "Sequence" ("name", "value") VALUES (${name}, 1)
    ON CONFLICT ("name") DO UPDATE SET "value" = "Sequence"."value" + 1
    RETURNING "value"`;
  return Number(rows[0].value);
}

/**
 * Next value whose rendered number isn't used yet — e.g. after a WHMCS import, or after staff moved the
 * series — so a duplicate number never stops an invoice from being created or paid.
 */
export async function nextFreeSequence(name: string, taken: (n: number) => Promise<boolean>, db: Db = prisma): Promise<number> {
  for (let i = 0; i < 10_000; i++) {
    const n = await nextSequence(name, db);
    if (!(await taken(n))) return n;
  }
  throw new Error(`Couldn't find a free number in series ${name}`);
}
