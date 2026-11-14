/**
 * Document number series (tax invoices, proformas, credit notes, receipts, quotes): what comes next, and
 * setting the next number — never back onto a number that's already been used (GST: no duplicates).
 */
import { prisma, type Db } from "../../db";
import { badRequest, conflict } from "../../lib/http";
import { getSettings } from "../../lib/settings";
import { financialYear } from "../../lib/money";

export const SERIES = ["tax", "proforma", "creditnote", "receipt", "quote"] as const;
export type SeriesKey = (typeof SERIES)[number];

async function defs(db: Db = prisma) {
  const s = await getSettings(db);
  const fy = financialYear(new Date());
  const pad = (n: number, w: number) => String(n).padStart(w, "0");
  return {
    tax: { label: "Tax invoice", seq: `invoice:${fy}`, prefix: s.invoice.taxPrefix.replace("{FY}", fy), render: (n: number) => s.invoice.taxPrefix.replace("{FY}", fy) + pad(n, s.invoice.taxNumberPad), perYear: true },
    proforma: { label: "Proforma (unpaid invoice)", seq: "proforma", prefix: s.invoice.proformaPrefix, render: (n: number) => s.invoice.proformaPrefix + pad(n, 6), perYear: false },
    creditnote: { label: "Credit note", seq: `creditnote:${fy}`, prefix: s.invoice.creditNotePrefix.replace("{FY}", fy), render: (n: number) => s.invoice.creditNotePrefix.replace("{FY}", fy) + pad(n, 5), perYear: true },
    receipt: { label: "Receipt (wallet top-up)", seq: `receipt:${fy}`, prefix: `RV/${fy}/`, render: (n: number) => `RV/${fy}/` + pad(n, s.invoice.taxNumberPad), perYear: true },
    quote: { label: "Quote", seq: "quote", prefix: "Q-", render: (n: number) => "Q-" + pad(n, 6), perYear: false },
  } as const;
}

/** The highest number already used in a series (by its current prefix). */
async function highestUsed(key: SeriesKey, prefix: string, db: Db = prisma) {
  const rows: { n: string }[] =
    key === "proforma"
      ? (await db.invoice.findMany({ where: { proformaNumber: { startsWith: prefix } }, select: { proformaNumber: true } })).map((r) => ({ n: r.proformaNumber }))
      : key === "creditnote"
        ? (await db.creditNote.findMany({ where: { number: { startsWith: prefix } }, select: { number: true } })).map((r) => ({ n: r.number }))
        : key === "quote"
          ? (await db.quote.findMany({ where: { number: { startsWith: prefix } }, select: { number: true } })).map((r) => ({ n: r.number }))
          : (await db.invoice.findMany({ where: { number: { startsWith: prefix } }, select: { number: true } })).map((r) => ({ n: r.number ?? "" }));
  let max = 0;
  for (const r of rows) {
    const m = r.n.slice(prefix.length).match(/^(\d+)$/);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return max;
}

export async function numberingStatus() {
  const d = await defs();
  const seqs = await prisma.sequence.findMany({ where: { name: { in: Object.values(d).map((x) => x.seq) } } });
  const out = [];
  for (const key of SERIES) {
    const x = d[key];
    const current = seqs.find((q) => q.name === x.seq)?.value ?? 0;
    const used = await highestUsed(key, x.prefix);
    // the next number generation will actually hand out (it skips numbers that already exist)
    const next = Math.max(current, used) + 1;
    out.push({ key, label: x.label, perYear: x.perYear, prefix: x.prefix, next, preview: x.render(next), highestUsed: used, lastUsedNumber: used ? x.render(used) : null });
  }
  return { financialYear: financialYear(new Date()), series: out };
}

export async function setNextNumber(key: SeriesKey, next: number) {
  if (!SERIES.includes(key)) throw badRequest("Unknown series");
  if (!Number.isInteger(next) || next < 1 || next > 99_999_999) throw badRequest("Enter a whole number from 1");
  const d = await defs();
  const x = d[key];
  const used = await highestUsed(key, x.prefix);
  if (next <= used) throw conflict(`${x.render(used)} has already been used — the next ${x.label.toLowerCase()} number must be ${used + 1} or higher`);
  await prisma.$executeRaw`INSERT INTO "Sequence" ("name", "value") VALUES (${x.seq}, ${next - 1}) ON CONFLICT ("name") DO UPDATE SET "value" = ${next - 1}`;
  return { preview: x.render(next) };
}
