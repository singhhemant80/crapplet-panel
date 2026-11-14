/**
 * Read a WHMCS database from a MySQL dump file (.sql or .sql.gz from mysqldump, phpMyAdmin or
 * cPanel backups) — no MySQL server needed.
 *
 * The file is streamed once. Only the tables the importer uses are kept; everything else
 * (activity logs, email logs, …) is skipped without being held in memory. Values come back the
 * way mysql2 returns them with dateStrings/bigNumberStrings: integers as numbers, decimals and
 * dates as strings, NULL as null.
 */
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import zlib from "node:zlib";
import type { Row, SourceDb } from "./whmcs";

/** Tables the WHMCS importer reads. */
export const WHMCS_TABLES = [
  "tblaccounts", "tbladdons", "tbladmins", "tblaffiliates", "tblannouncements", "tblclients", "tblconfiguration", "tblcurrencies", "tblcustomfields",
  "tblcustomfieldsvalues", "tbldomains", "tblhosting", "tblhostingaddons", "tblinvoiceitems", "tblinvoices", "tblknowledgebase", "tblknowledgebasecats",
  "tblknowledgebaselinks", "tblorders", "tblpricing", "tblproductgroups", "tblproducts", "tblpromotions", "tblservergroupsrel", "tblservers",
  "tblticketdepartments", "tblticketnotes", "tblticketreplies", "tbltickets",
  // WHMCS 8+: logins (email + password) live here, linked to client accounts
  "tblusers", "tblusers_clients",
];
/** Tables added to WHMCS_TABLES after the first release — dumps prepared before that get them extracted on demand. */
const ADDED_LATER = ["tblusers", "tblusers_clients"];

export interface DumpScan {
  tables: Map<string, Row[]>;
  /** tables seen in the file (any table, wanted or not) */
  seen: Set<string>;
}

const INSERT_RE = /^\s*(?:INSERT(?:\s+(?:IGNORE|LOW_PRIORITY|DELAYED|HIGH_PRIORITY))*|REPLACE)\s+(?:INTO\s+)?(?:`[^`]+`\.)?`?([A-Za-z0-9_$]+)`?/i;
const CREATE_RE = /^\s*CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:`[^`]+`\.)?`?([A-Za-z0-9_$]+)`?\s*\(/i;

/** Leftover comment characters (a `--` or `/*` split across read chunks) in front of a statement. */
const clean = (s: string) => s.replace(/^[\s\-/]+/, "");

/** Stream a dump and collect the rows of `wanted` tables. */
export async function scanDump(file: string, wanted: string[] = WHMCS_TABLES, onProgress?: (bytes: number) => void, chunkSize?: number, sink?: (table: string, row: Row) => void): Promise<DumpScan> {
  const want = new Set(wanted.map((t) => t.toLowerCase()));
  const tables = new Map<string, Row[]>();
  const columns = new Map<string, string[]>();
  const seen = new Set<string>();

  // statement splitter state (survives chunk boundaries)
  let buf: string[] = [];
  let head = ""; // first part of the statement, to classify it
  let skip = false; // statement belongs to a table we don't need
  let classified = false;
  let quote: string | null = null;
  let esc = false;
  let lineComment = false;
  let blockComment = false;
  let prev = "";

  const classify = () => {
    classified = true;
    const h = clean(head);
    const m = INSERT_RE.exec(h) ?? CREATE_RE.exec(h);
    if (m) {
      const t = m[1].toLowerCase();
      seen.add(t);
      if (!want.has(t)) skip = true;
    } else if (!/^\s*(INSERT|REPLACE|CREATE)/i.test(h)) skip = true; // SET, LOCK, DROP, ALTER… — not needed
  };

  const finish = () => {
    if (!skip) {
      const sql = clean(buf.join(""));
      handleStatement(sql);
    }
    buf = [];
    head = "";
    skip = false;
    classified = false;
  };

  const handleStatement = (sql: string) => {
    let m = CREATE_RE.exec(sql);
    if (m) {
      const t = m[1].toLowerCase();
      const cols: string[] = [];
      for (const line of sql.slice(m[0].length).split("\n")) {
        const c = /^\s*`([^`]+)`\s+\w/.exec(line);
        if (c) cols.push(c[1]);
      }
      columns.set(t, cols);
      if (!tables.has(t)) tables.set(t, []);
      return;
    }
    m = INSERT_RE.exec(sql);
    if (!m) return;
    const t = m[1].toLowerCase();
    let rest = sql.slice(m[0].length);
    // optional explicit column list
    let cols = columns.get(t);
    const colList = /^\s*\(([^)]*)\)\s*VALUES/i.exec(rest);
    if (colList) {
      cols = colList[1].split(",").map((c) => c.trim().replace(/^`|`$/g, ""));
      rest = rest.slice(colList[0].length);
    } else {
      const v = /^\s*VALUES?/i.exec(rest);
      if (!v) return;
      rest = rest.slice(v[0].length);
    }
    if (!cols?.length) throw new Error(`The dump has rows for ${t} but no CREATE TABLE for it — export with structure ("Structure and data")`);
    const rows = sink ? null : tables.get(t) ?? [];
    for (const tuple of parseTuples(rest)) {
      const row: Row = {};
      for (let i = 0; i < cols.length; i++) row[cols[i]] = tuple[i] ?? null;
      if (sink) sink(t, row);
      else rows!.push(row);
    }
    if (rows) tables.set(t, rows);
  };

  const feed = (chunk: string) => {
    let start = 0; // start of the slice of `chunk` that belongs to the current statement
    const n = chunk.length;
    for (let i = 0; i < n; i++) {
      const ch = chunk[i];
      if (lineComment) {
        if (ch === "\n") {
          lineComment = false;
          start = i + 1;
        }
        prev = ch;
        continue;
      }
      if (blockComment) {
        if (prev === "*" && ch === "/") {
          blockComment = false;
          start = i + 1;
          prev = "";
          continue;
        }
        prev = ch;
        continue;
      }
      if (quote) {
        if (esc) esc = false;
        else if (ch === "\\" && quote !== "`") esc = true;
        else if (ch === quote) quote = null;
        prev = ch;
        continue;
      }
      if (ch === "'" || ch === '"' || ch === "`") {
        quote = ch;
      } else if (ch === ";") {
        if (!skip) buf.push(chunk.slice(start, i));
        if (!classified) {
          head += chunk.slice(start, i);
          classify();
        }
        finish();
        start = i + 1;
      } else if ((ch === "-" && prev === "-" && (chunk[i + 1] === " " || chunk[i + 1] === "\n" || chunk[i + 1] === "\t" || chunk[i + 1] === "\r" || i + 1 === n)) || ch === "#") {
        // "-- comment" or "# comment": drop the comment (and the first '-' already copied)
        const upto = ch === "#" ? i : Math.max(start, i - 1); // the first "-" may have been in the previous chunk
        if (!skip) buf.push(chunk.slice(start, upto));
        if (!classified) head += chunk.slice(start, upto);
        lineComment = true;
      } else if (ch === "*" && prev === "/") {
        const upto = Math.max(start, i - 1); // the "/" may have been in the previous chunk
        if (!skip) buf.push(chunk.slice(start, upto));
        if (!classified) head += chunk.slice(start, upto);
        blockComment = true;
        prev = "";
        continue;
      }
      prev = ch;
    }
    if (!lineComment && !blockComment && start < n) {
      const tail = chunk.slice(start);
      if (!skip) buf.push(tail);
      if (!classified) {
        head += tail;
        if (head.trim().length > 160) classify();
        if (skip) buf = [];
      }
    }
  };

  let stream: NodeJS.ReadableStream = fs.createReadStream(file, chunkSize ? { highWaterMark: chunkSize } : undefined);
  if (await isGzip(file)) stream = stream.pipe(zlib.createGunzip(chunkSize ? { chunkSize: Math.max(64, chunkSize) } : undefined));
  (stream as any).setEncoding?.("utf8");
  let bytes = 0;
  for await (const chunk of stream as AsyncIterable<string | Buffer>) {
    const s = typeof chunk === "string" ? chunk : chunk.toString("utf8");
    bytes += s.length;
    feed(s);
    onProgress?.(bytes);
  }
  if (buf.join("").trim()) {
    if (!classified) classify();
    finish();
  }
  return { tables, seen };
}

async function isGzip(file: string) {
  const fh = await fs.promises.open(file, "r");
  try {
    const b = Buffer.alloc(2);
    await fh.read(b, 0, 2, 0);
    return b[0] === 0x1f && b[1] === 0x8b;
  } finally {
    await fh.close();
  }
}

/** Parse `(a,'b',NULL),(…)` into arrays of values. */
export function parseTuples(s: string): unknown[][] {
  const out: unknown[][] = [];
  let i = 0;
  const n = s.length;
  const ws = () => {
    while (i < n && /\s/.test(s[i])) i++;
  };
  for (;;) {
    ws();
    if (i >= n) break;
    if (s[i] === ",") {
      i++;
      continue;
    }
    if (s[i] !== "(") break; // ON DUPLICATE KEY … or trailing text
    i++;
    const row: unknown[] = [];
    for (;;) {
      ws();
      const ch = s[i];
      if (ch === "'" || ch === '"') {
        row.push(readString(ch));
      } else if (ch === "_" || ch === "N" || ch === "n" || ch === "b" || ch === "B" || ch === "x" || ch === "X" || /[A-Za-z]/.test(ch)) {
        // NULL, TRUE/FALSE, charset introducers (_binary'…', _utf8mb4'…'), x'…', b'…'
        const m = /^[A-Za-z_0-9]+/.exec(s.slice(i, i + 40));
        const word = m ? m[0] : "";
        i += word.length;
        if (s[i] === "'") {
          const str = readString("'");
          if (/^x$/i.test(word)) row.push(Buffer.from(str, "hex").toString("utf8"));
          else if (/^b$/i.test(word)) row.push(parseInt(str || "0", 2));
          else row.push(str);
        } else if (/^null$/i.test(word)) row.push(null);
        else if (/^true$/i.test(word)) row.push(1);
        else if (/^false$/i.test(word)) row.push(0);
        else row.push(word);
      } else {
        // number or 0x hex
        const start = i;
        while (i < n && s[i] !== "," && s[i] !== ")" && !/\s/.test(s[i])) i++;
        const raw = s.slice(start, i);
        if (/^0x[0-9a-f]*$/i.test(raw)) row.push(Buffer.from(raw.slice(2), "hex").toString("utf8"));
        else if (/^-?\d+$/.test(raw) && Number.isSafeInteger(Number(raw))) row.push(Number(raw));
        else row.push(raw); // decimals stay strings, like mysql2
      }
      ws();
      if (s[i] === ",") {
        i++;
        continue;
      }
      if (s[i] === ")") {
        i++;
        break;
      }
      throw new Error(`Couldn't read the dump near: ${s.slice(Math.max(0, i - 40), i + 40)}`);
    }
    out.push(row);
  }
  return out;

  function readString(q: string) {
    i++; // opening quote
    let r = "";
    let from = i;
    for (;;) {
      if (i >= n) throw new Error("Unterminated string in the dump");
      const c = s[i];
      if (c === "\\") {
        r += s.slice(from, i);
        const e = s[i + 1];
        r += e === "0" ? "\0" : e === "n" ? "\n" : e === "r" ? "\r" : e === "t" ? "\t" : e === "b" ? "\b" : e === "Z" ? "\x1a" : e === "%" || e === "_" ? "\\" + e : e;
        i += 2;
        from = i;
        continue;
      }
      if (c === q) {
        if (s[i + 1] === q) {
          // doubled quote
          r += s.slice(from, i) + q;
          i += 2;
          from = i;
          continue;
        }
        r += s.slice(from, i);
        i++;
        return r;
      }
      i++;
    }
  }
}

export interface DumpMeta {
  version: string;
  company: string;
  counts: Record<string, number>;
  /** every table found in the file */
  tables: string[];
  /** the tables written out when the dump was prepared (absent = before ADDED_LATER existed) */
  extracted?: string[];
  bytes: number;
  preparedAt: string;
}

const tablesDir = (file: string) => `${file}.tables`;

/**
 * Scan the dump once and write each WHMCS table to its own file (one JSON row per line), so the
 * import can load one table at a time instead of holding the whole database in memory.
 */
export async function prepareDump(file: string, onProgress?: (bytes: number) => void): Promise<DumpMeta> {
  const dir = tablesDir(file);
  await fs.promises.rm(dir, { recursive: true, force: true });
  await fs.promises.mkdir(dir, { recursive: true });
  const pending = new Map<string, string[]>();
  const sizes = new Map<string, number>();
  const counts: Record<string, number> = {};
  const flush = (t: string) => {
    const lines = pending.get(t);
    if (lines?.length) fs.appendFileSync(path.join(dir, `${t}.jsonl`), lines.join(""));
    pending.set(t, []);
    sizes.set(t, 0);
  };
  const cfg: Row[] = [];
  const scan = await scanDump(file, WHMCS_TABLES, onProgress, undefined, (t, row) => {
    const line = JSON.stringify(row) + "\n";
    const list = pending.get(t) ?? [];
    list.push(line);
    pending.set(t, list);
    counts[t] = (counts[t] ?? 0) + 1;
    if (t === "tblconfiguration") cfg.push(row);
    const size = (sizes.get(t) ?? 0) + line.length;
    sizes.set(t, size);
    if (size > 4 * 1024 * 1024) flush(t);
  });
  for (const t of pending.keys()) flush(t);
  if (!counts.tblclients && !scan.seen.has("tblclients"))
    throw new Error("This file doesn't look like a WHMCS database dump — no tblclients table was found. Export the whole WHMCS database (structure and data) as .sql or .sql.gz.");
  const meta: DumpMeta = {
    version: String(cfg.find((r) => r.setting === "Version")?.value ?? "unknown"),
    company: String(cfg.find((r) => r.setting === "CompanyName")?.value ?? ""),
    counts,
    tables: [...scan.seen].sort(),
    extracted: [...WHMCS_TABLES],
    bytes: (await fs.promises.stat(file)).size,
    preparedAt: new Date().toISOString(),
  };
  await fs.promises.writeFile(path.join(dir, "meta.json"), JSON.stringify(meta));
  return meta;
}

export async function readDumpMeta(file: string): Promise<DumpMeta | null> {
  try {
    return JSON.parse(await fs.promises.readFile(path.join(tablesDir(file), "meta.json"), "utf8"));
  } catch {
    return null;
  }
}

/** A SourceDb backed by a dump file. Tables are loaded from disk one at a time, on request. */
export async function dumpSource(file: string): Promise<SourceDb & { meta: DumpMeta }> {
  const meta = (await readDumpMeta(file)) ?? (await prepareDump(file));
  const dir = tablesDir(file);
  // a dump prepared by an older version: pull out the tables the importer reads now (one pass over the file)
  const done = meta.extracted ?? WHMCS_TABLES.filter((t) => !ADDED_LATER.includes(t));
  const missing = WHMCS_TABLES.filter((t) => !done.includes(t) && meta.tables.map((x) => x.toLowerCase()).includes(t));
  if (missing.length && fs.existsSync(file)) {
    const out = new Map<string, string[]>();
    await scanDump(file, missing, undefined, undefined, (t, row) => {
      const l = out.get(t) ?? [];
      l.push(JSON.stringify(row) + "\n");
      out.set(t, l);
    });
    for (const t of missing) await fs.promises.writeFile(path.join(dir, `${t}.jsonl`), (out.get(t) ?? []).join(""));
    meta.extracted = [...WHMCS_TABLES];
    for (const t of missing) meta.counts[t] = out.get(t)?.length ?? 0;
    await fs.promises.writeFile(path.join(dir, "meta.json"), JSON.stringify(meta));
  }
  return {
    meta,
    async table<T>(name: string) {
      const f = path.join(dir, `${name.toLowerCase()}.jsonl`);
      if (!fs.existsSync(f)) return [] as T[];
      const rows: T[] = [];
      const rl = readline.createInterface({ input: fs.createReadStream(f, { encoding: "utf8" }), crlfDelay: Infinity });
      for await (const line of rl) if (line) rows.push(JSON.parse(line));
      return rows;
    },
    async close() {},
  };
}

/** Remove a dump and its prepared tables. */
export async function removeDump(file: string) {
  await fs.promises.rm(tablesDir(file), { recursive: true, force: true });
  await fs.promises.rm(file, { force: true });
}
