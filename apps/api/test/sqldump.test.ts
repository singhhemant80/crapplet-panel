/**
 * Reading WHMCS from a .sql dump: the parsed tables must equal the original rows, and an import
 * dry run from the dump must match one from a live database.
 *   npx tsx --test test/sqldump.test.ts
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { prisma } from "../src/db";
import { closeQueues } from "../src/jobs/queues";
import { runWhmcsImport, ENTITIES, type Row, type SourceDb } from "../src/modules/migration/whmcs";
import { dumpSource, parseTuples, scanDump } from "../src/modules/migration/sqldump";
import { CC, fakeWhmcs, writeDump } from "./whmcs-fixture";

after(async () => {
  await closeQueues().catch(() => undefined);
  await prisma.$disconnect();
});

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "whmcs-dump-"));

/** Same value? Dumps don't keep JS types: decimals come back as strings, ints as numbers. */
function same(a: unknown, b: unknown) {
  if (a === undefined) a = null;
  if (a === null || b === null) return a === b;
  return String(a) === String(b);
}

function compare(data: Record<string, Row[]>, read: (t: string) => Row[]) {
  for (const [t, rows] of Object.entries(data)) {
    const got = read(t);
    assert.equal(got.length, rows.length, `${t}: row count`);
    rows.forEach((r, i) => {
      for (const [k, v] of Object.entries(r)) assert.ok(same(v, got[i][k]), `${t}[${i}].${k}: expected ${JSON.stringify(v)}, got ${JSON.stringify(got[i][k])}`);
    });
  }
}

test("tuple parser handles escapes, quotes, NULL, numbers, hex and charset introducers", () => {
  const rows = parseTuples(`(1,'it\\'s','a''b',NULL,-5,'12.50',0x414243,_binary'xyz','tab\\there','back\\\\slash','new\\nline',X'4142'),(2,'',NULL,NULL,0,'0',0x,'' ,'','','',x'')`);
  assert.deepEqual(rows[0], [1, "it's", "a'b", null, -5, "12.50", "ABC", "xyz", "tab\there", "back\\slash", "new\nline", "AB"]);
  assert.equal(rows[1][0], 2);
  assert.equal(rows.length, 2);
});

for (const style of ["mysqldump", "phpmyadmin"] as const) {
  for (const gz of [false, true]) {
    test(`reads every WHMCS row from a ${style} dump${gz ? " (.sql.gz)" : ""}`, async () => {
      const data = fakeWhmcs();
      const sql = writeDump(data, style);
      const file = path.join(dir, `${style}${gz ? ".sql.gz" : ".sql"}`);
      fs.writeFileSync(file, gz ? zlib.gzipSync(sql) : sql);
      const scan = await scanDump(file);
      compare(data, (t) => scan.tables.get(t) ?? []);
      assert.ok(scan.seen.has("tblactivitylog"), "unneeded tables are seen…");
      assert.ok(!scan.tables.has("tblactivitylog"), "…but not kept");
    });
  }
}

test("dump is read correctly however the file is split into chunks", async () => {
  const data = fakeWhmcs();
  const sql = writeDump(data, "mysqldump");
  // feed the same file through tiny reads: every comment/quote/escape lands on a chunk boundary somewhere
  const file = path.join(dir, "chunks.sql");
  fs.writeFileSync(file, sql);
  for (const size of [1, 2, 3, 7, 64, 1000]) {
    const scan = await scanDump(file, undefined, undefined, size);
    compare(data, (t) => scan.tables.get(t) ?? []);
  }
});

test("comment markers split across chunks don't swallow the next statement", async () => {
  // a comment right before the tblclients INSERT, with its 2nd character at the start of a chunk
  const data = fakeWhmcs();
  const body = writeDump(data, "mysqldump");
  const p = body.indexOf("INSERT INTO `tblclients`");
  assert.ok(p > 0);
  for (let size = 2; size <= 40; size++) {
    for (const marker of ["-- note\n", "/* note */ "]) {
      let f = 0;
      while ((p + f + 1) % size !== 0) f++;
      const sql = body.slice(0, p) + " ".repeat(f) + marker + body.slice(p);
      const file = path.join(dir, `split-${size}.sql`);
      fs.writeFileSync(file, sql);
      const scan = await scanDump(file, undefined, undefined, size);
      compare(data, (t) => scan.tables.get(t) ?? []);
    }
  }
});

test("import dry run from a dump matches a dry run from the live database", async () => {
  const data = fakeWhmcs();
  const file = path.join(dir, "import.sql");
  fs.writeFileSync(file, writeDump(data, "mysqldump"));
  const mem: SourceDb = { table: async (n) => structuredClone(data[n] ?? []) as never, close: async () => {} };
  const opts = { entities: [...ENTITIES], ccEncryptionHash: CC, overwritePricing: false, dryRun: true };
  const fromDb = await runWhmcsImport(mem, opts);
  const src = await dumpSource(file);
  const fromDump = await runWhmcsImport(src, opts);
  await src.close();
  assert.deepEqual(fromDump.counts, fromDb.counts);
  assert.equal(fromDump.warnings.length, fromDb.warnings.length);
});
