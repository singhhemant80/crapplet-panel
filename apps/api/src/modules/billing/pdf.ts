import path from "path";
import fs from "fs";
import PDFDocument from "pdfkit";
import { prisma } from "../../db";
import { getSettings } from "../../lib/settings";
import { CYCLE_LABEL } from "../../lib/money";

// resolved from the API working directory (apps/api) — PM2 and npm scripts run from there
const ASSETS = path.resolve(process.env.ASSETS_DIR ?? path.join(process.cwd(), "assets"));
const font = (f: string) => path.join(ASSETS, "fonts", f);

const SYMBOL: Record<string, string> = { INR: "₹", USD: "$", EUR: "€", GBP: "£" };
const money = (minor: number, currency: string) =>
  (SYMBOL[currency] ?? currency + " ") + (minor / 100).toLocaleString(currency === "INR" ? "en-IN" : "en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const UNIT_NAMES: Record<string, [string, string]> = { USD: ["US Dollars", "Cents"], EUR: ["Euros", "Cents"], GBP: ["Pounds Sterling", "Pence"] };
const date = (d: Date | null | undefined) => (d ? d.toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata", day: "2-digit", month: "short", year: "numeric" }) : "—");

function amountInWords(rupees: number): string {
  const a = ["", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten", "Eleven", "Twelve", "Thirteen", "Fourteen", "Fifteen", "Sixteen", "Seventeen", "Eighteen", "Nineteen"];
  const b = ["", "", "Twenty", "Thirty", "Forty", "Fifty", "Sixty", "Seventy", "Eighty", "Ninety"];
  const two = (n: number) => (n < 20 ? a[n] : b[Math.floor(n / 10)] + (n % 10 ? " " + a[n % 10] : ""));
  const three = (n: number) => (n >= 100 ? a[Math.floor(n / 100)] + " Hundred" + (n % 100 ? " " + two(n % 100) : "") : two(n));
  if (rupees === 0) return "Zero";
  const parts: string[] = [];
  const crore = Math.floor(rupees / 10000000);
  const lakh = Math.floor((rupees % 10000000) / 100000);
  const thousand = Math.floor((rupees % 100000) / 1000);
  const rest = rupees % 1000;
  if (crore) parts.push(three(crore) + " Crore");
  if (lakh) parts.push(two(lakh) + " Lakh");
  if (thousand) parts.push(two(thousand) + " Thousand");
  if (rest) parts.push(three(rest));
  return parts.join(" ");
}

/**
 * Invoice PDF — drawn to match the on-screen invoice (components/invoice-sheet.tsx in the web app):
 * purple gradient header with logo, supplier and status, a facts strip, billed-to / invoice details,
 * the items table, amount in words + totals card with a gradient Total bar, payment history and footer.
 */
export async function renderInvoicePdf(invoiceId: string): Promise<Buffer> {
  const inv = await prisma.invoice.findUniqueOrThrow({ where: { id: invoiceId }, include: { items: true, transactions: { orderBy: { createdAt: "asc" } } } });
  const s = await getSettings();
  const c = s.company as typeof s.company & { billingEmail?: string };
  const bill = (inv.billingSnapshot ?? {}) as Record<string, string | null>;
  const cur = inv.currency ?? "INR";
  const m = (v: number) => money(v, cur);
  const overdue = inv.status === "UNPAID" && inv.dueDate < new Date();
  const kind = inv.isWalletTopup ? "Receipt voucher" : inv.number ? "Tax invoice" : "Proforma invoice";
  const exportInv = cur !== "INR" && !inv.taxTotal && inv.placeOfSupplyCode === "96";
  const due = inv.total - inv.amountPaid;

  const doc = new PDFDocument({ size: "A4", margin: 0, info: { Title: `${kind} ${inv.number ?? inv.proformaNumber}`, Author: c.legalName } });
  doc.registerFont("R", font("Inter-Regular.otf"));
  doc.registerFont("S", font("Inter-SemiBold.otf"));
  doc.registerFont("B", font("Inter-Bold.otf"));
  const chunks: Buffer[] = [];
  doc.on("data", (d: Buffer) => chunks.push(d));
  const done = new Promise<Buffer>((res) => doc.on("end", () => res(Buffer.concat(chunks))));

  const PW = doc.page.width;
  const PH = doc.page.height;
  const X = 28; // card left
  const W = PW - 56; // card width
  const P = 26; // inner padding
  const ink = "#0f172a";
  const mute = "#64748b";
  const purple = "#6d28d9";
  const line = "#ece4fb";
  const tint = "#fbf9ff";

  // page background + card outline
  // light page, white rounded card (continuation pages get the same card)
  const card = (top: number) => {
    doc.rect(0, 0, PW, PH).fill("#f5f3fb");
    doc.roundedRect(X, top, W, PH - 28 - top, 18).fill("#ffffff");
  };
  const newPage = () => {
    doc.addPage({ size: "A4", margin: 0 });
    card(28);
    return 48;
  };
  card(28);

  // ── header band ─────────────────────────────────────────────
  const HY = 28;
  const HH = 150;
  doc.save();
  doc.roundedRect(X, HY, W, HH + 20, 18).clip();
  const g = doc.linearGradient(X, HY, X + W, HY + HH);
  g.stop(0, "#8b5cf6").stop(0.55, "#6d28d9").stop(1, "#3b0f7a");
  doc.rect(X, HY, W, HH).fill(g);
  // grid texture and soft glow
  doc.lineWidth(0.4).strokeColor("#ffffff").strokeOpacity(0.07);
  for (let gx = X; gx < X + W; gx += 18) doc.moveTo(gx, HY).lineTo(gx, HY + HH).stroke();
  for (let gy = HY; gy < HY + HH; gy += 18) doc.moveTo(X, gy).lineTo(X + W, gy).stroke();
  doc.strokeOpacity(1);
  doc.circle(X + W - 30, HY - 10, 90).fillOpacity(0.08).fill("#ffffff");
  doc.fillOpacity(1);
  doc.restore();

  const logo = path.join(ASSETS, "img", "Crapplet_logo_white.png");
  const logoColour = path.join(ASSETS, "img", "Crapplet_logo.png");
  if (fs.existsSync(logo)) doc.image(logo, X + P, HY + 24, { height: 30 });
  else if (fs.existsSync(logoColour)) doc.image(logoColour, X + P, HY + 24, { height: 30 });
  doc.font("B").fontSize(11).fillColor("#ffffff").text(c.legalName, X + P, HY + 66, { width: 280 });
  doc.font("R").fontSize(8.2).fillColor("#ede9fe").text(c.address ?? "", X + P, HY + 81, { width: 270, lineGap: 1 });
  doc.font("R").fontSize(8.2).fillColor("#ede9fe").text(`GSTIN `, X + P, doc.y + 3, { continued: true }).font("B").fillColor("#ffffff").text(c.gstin ?? "", { continued: !!c.pan }).font("R").fillColor("#ede9fe").text(c.pan ? `  ·  PAN ${c.pan}` : "");

  const RX = X + W - P - 240;
  doc.font("B").fontSize(8).fillColor("#ddd6fe").text(kind.toUpperCase(), RX, HY + 26, { width: 240, align: "right", characterSpacing: 2.2 });
  doc.font("B").fontSize(21).fillColor("#ffffff").text(inv.number ?? inv.proformaNumber, RX - 40, HY + 40, { width: 280, align: "right" });
  if (inv.number && inv.proformaNumber) doc.font("R").fontSize(8.5).fillColor("#ddd6fe").text(`Proforma ${inv.proformaNumber}`, RX, HY + 68, { width: 240, align: "right" });
  const ST: Record<string, [string, string, string]> = {
    PAID: ["PAID", "#10b981", "#ffffff"],
    UNPAID: ["UNPAID", "#fbbf24", "#451a03"],
    OVERDUE: ["OVERDUE", "#f43f5e", "#ffffff"],
    CANCELLED: ["CANCELLED", "#94a3b8", "#ffffff"],
    REFUNDED: ["REFUNDED", "#0ea5e9", "#ffffff"],
    PARTIALLY_REFUNDED: ["PART REFUNDED", "#0ea5e9", "#ffffff"],
    DRAFT: ["DRAFT", "#cbd5e1", "#1e293b"],
  };
  const [sl, sbg, sfg] = ST[overdue ? "OVERDUE" : inv.status] ?? ST.UNPAID;
  doc.font("B").fontSize(8.5);
  const pillW = doc.widthOfString(sl, { characterSpacing: 1 }) + 26;
  const pillX = X + W - P - pillW;
  doc.roundedRect(pillX, HY + 88, pillW, 22, 11).fill(sbg);
  doc.fillColor(sfg).text(sl, pillX, HY + 95, { width: pillW, align: "center", characterSpacing: 1 });

  // ── facts strip ─────────────────────────────────────────────
  let y = HY + HH;
  const SH = 50;
  doc.rect(X, y, W, SH).fill(tint);
  const facts: [string, string][] = [
    ["ISSUED", date(inv.issueDate)],
    [inv.status === "PAID" ? "PAID ON" : "DUE DATE", inv.status === "PAID" ? date(inv.paidAt) : date(inv.dueDate)],
    ["PLACE OF SUPPLY", inv.placeOfSupply ?? "—"],
    [inv.status === "UNPAID" ? "AMOUNT DUE" : "TOTAL", inv.status === "UNPAID" ? m(due) : m(inv.total)],
  ];
  const cw = W / 4;
  doc.rect(X + cw * 3, y, cw, SH).fill("#f3ecff");
  facts.forEach(([l, v], i) => {
    const cx = X + cw * i;
    if (i) doc.moveTo(cx, y).lineTo(cx, y + SH).lineWidth(0.6).strokeColor(line).stroke();
    doc.font("B").fontSize(7).fillColor(mute).text(l, cx + 14, y + 11, { width: cw - 24, characterSpacing: 0.8 });
    doc.font("B").fontSize(i === 3 ? 13 : 10).fillColor(i === 3 ? purple : overdue && i === 1 ? "#e11d48" : ink).text(v, cx + 14, y + (i === 3 ? 23 : 25), { width: cw - 24 });
  });
  doc.moveTo(X, y + SH).lineTo(X + W, y + SH).lineWidth(0.6).strokeColor(line).stroke();
  y += SH;


  // ── parties ─────────────────────────────────────────────────
  y += 20;
  const label = (t: string, x: number, yy: number, w: number, align: "left" | "right" = "left") => doc.font("B").fontSize(7.5).fillColor(purple).text(t, x, yy, { width: w, align, characterSpacing: 1.6 });
  const half = (W - P * 2) / 2;
  label("BILLED TO", X + P, y, half);
  doc.font("B").fontSize(11.5).fillColor(ink).text(bill.companyName || bill.name || "", X + P, y + 14, { width: half });
  let ly = doc.y + 1;
  const addr = [bill.companyName ? bill.name : null, [bill.address1, bill.address2].filter(Boolean).join(", "), [bill.city, bill.state, bill.postcode].filter(Boolean).join(", "), bill.country === "IN" ? "India" : bill.country, bill.email]
    .filter(Boolean)
    .join("\n");
  doc.font("R").fontSize(8.6).fillColor(mute).text(addr, X + P, ly, { width: half - 10, lineGap: 1.5 });
  ly = doc.y + 6;
  const gst = `GSTIN  ${inv.customerGstin ?? "Unregistered (B2C)"}`;
  doc.font("S").fontSize(8);
  const gw = doc.widthOfString(gst) + 18;
  doc.roundedRect(X + P, ly, gw, 18, 6).lineWidth(0.6).fillAndStroke("#f8fafc", "#e2e8f0");
  doc.fillColor("#334155").text(gst, X + P + 9, ly + 5);
  const leftEnd = ly + 18;

  const RX2 = X + P + half;
  label("INVOICE DETAILS", RX2, y, half, "right");
  const det: [string, string][] = [
    ["Currency", cur],
    ["GST", exportInv ? "Zero-rated export" : inv.taxTotal ? `${inv.gstRate}% ${inv.taxInclusive ? "inclusive" : "exclusive"}` : "Not applicable"],
  ];
  if (cur !== "INR") det.push(["Exchange rate", `₹${Number(inv.exchangeRate || 1).toFixed(4)} / ${cur}`]);
  let dy = y + 16;
  for (const [k, v] of det) {
    doc.font("B").fontSize(9).fillColor(ink).text(v, RX2, dy, { width: half, align: "right" });
    const vw = doc.widthOfString(v);
    doc.font("R").fontSize(9).fillColor(mute).text(k, RX2, dy, { width: half - vw - 12, align: "right" });
    dy += 15;
  }
  y = Math.max(leftEnd, dy) + 18;

  // ── items ───────────────────────────────────────────────────
  const TX = X + 16;
  const TW = W - 32;
  const cols = [
    { k: "#", w: 30, a: "left" as const },
    { k: "DESCRIPTION", w: TW - 30 - 62 - 44 - 82 - 88, a: "left" as const },
    { k: "SAC", w: 62, a: "left" as const },
    { k: "QTY", w: 44, a: "right" as const },
    { k: "RATE", w: 82, a: "right" as const },
    { k: "AMOUNT", w: 88, a: "right" as const },
  ];
  const tableTop = y;
  doc.save();
  doc.roundedRect(TX, y, TW, 26, 10).clip();
  doc.rect(TX, y, TW, 26).fill("#f6f1ff");
  doc.restore();
  doc.rect(TX, y + 13, TW, 13).fill("#f6f1ff");
  let x = TX;
  for (const col of cols) {
    doc.font("B").fontSize(7.5).fillColor(purple).text(col.k, x + 10, y + 9, { width: col.w - 20, align: col.a, characterSpacing: 0.8 });
    x += col.w;
  }
  y += 26;
  inv.items.forEach((it, idx) => {
    const [first, ...rest] = it.description.split("\n");
    const sub = [rest.join(" · "), it.periodStart && it.periodEnd ? `${date(it.periodStart)} – ${date(it.periodEnd)}` : ""].filter(Boolean).join("\n");
    doc.font("S").fontSize(9.2);
    const h1 = doc.heightOfString(first, { width: cols[1].w - 20 });
    doc.font("R").fontSize(8);
    const h2 = sub ? doc.heightOfString(sub, { width: cols[1].w - 20 }) + 2 : 0;
    const h = Math.max(30, h1 + h2 + 18);
    if (y + h > PH - 220) {
      doc.moveTo(TX, y).lineTo(TX + TW, y).lineWidth(0.6).strokeColor(line).stroke();
      y = newPage();
    }
    doc.moveTo(TX, y).lineTo(TX + TW, y).lineWidth(0.6).strokeColor("#f1ecfb").stroke();
    x = TX;
    doc.font("B").fontSize(8).fillColor(mute).text(String(idx + 1).padStart(2, "0"), x + 10, y + 10, { width: cols[0].w - 12 });
    x += cols[0].w;
    doc.font("S").fontSize(9.2).fillColor(ink).text(first, x + 10, y + 9, { width: cols[1].w - 20 });
    if (sub) doc.font("R").fontSize(8).fillColor(mute).text(sub, x + 10, doc.y + 2, { width: cols[1].w - 20 });
    x += cols[1].w;
    doc.font("R").fontSize(8).fillColor(mute).text(it.hsnSac ?? "", x + 10, y + 10, { width: cols[2].w - 20 });
    x += cols[2].w;
    doc.font("R").fontSize(9).fillColor(mute).text(String(it.quantity), x + 6, y + 9, { width: cols[3].w - 16, align: "right" });
    x += cols[3].w;
    doc.font("R").fontSize(9).fillColor(mute).text(m(it.unitPrice), x + 6, y + 9, { width: cols[4].w - 16, align: "right" });
    x += cols[4].w;
    doc.font("B").fontSize(9.2).fillColor(ink).text(m(it.amount), x + 6, y + 9, { width: cols[5].w - 16, align: "right" });
    y += h;
  });
  // table outline
  doc.roundedRect(TX, tableTop, TW, y - tableTop, 10).lineWidth(0.8).strokeColor(line).stroke();
  y += 20;

  // ── words + totals ──────────────────────────────────────────
  if (y > PH - 230) y = newPage();
  const TOTW = 220;
  const totX = X + W - P - TOTW;
  const leftW = totX - (X + P) - 18;
  // amount in words
  const words =
    cur === "INR"
      ? `Indian Rupees ${amountInWords(Math.floor(inv.total / 100))}${inv.total % 100 ? ` and ${amountInWords(inv.total % 100)} Paise` : ""} Only`
      : (() => {
          const [major, minorName] = UNIT_NAMES[cur] ?? [cur, "cents"];
          return `${major} ${amountInWords(Math.floor(inv.total / 100))}${inv.total % 100 ? ` and ${amountInWords(inv.total % 100)} ${minorName}` : ""} Only`;
        })();
  doc.font("S").fontSize(9);
  const wordsH = doc.heightOfString(words, { width: leftW - 24 }) + (cur !== "INR" ? 14 : 0);
  doc.roundedRect(X + P, y, leftW, wordsH + 32, 10).lineWidth(0.6).fillAndStroke("#f8fafc", "#e2e8f0");
  doc.font("B").fontSize(7).fillColor(mute).text("AMOUNT IN WORDS", X + P + 12, y + 10, { characterSpacing: 0.8 });
  doc.font("S").fontSize(9).fillColor(ink).text(words, X + P + 12, y + 22, { width: leftW - 24 });
  if (cur !== "INR") doc.font("R").fontSize(7.8).fillColor(mute).text(`INR equivalent ${money(Math.round(inv.total * (inv.exchangeRate || 1)), "INR")} @ ₹${(inv.exchangeRate || 1).toFixed(4)} per ${cur}`, X + P + 12, doc.y + 3, { width: leftW - 24 });
  let ny = y + wordsH + 40;
  if (exportInv) {
    const t = `Supply meant for export of services under LUT without payment of IGST${s.currency?.lutArn ? ` (LUT ARN ${s.currency.lutArn})` : ""}.`;
    doc.font("R").fontSize(8);
    const th = doc.heightOfString(t, { width: leftW - 24 });
    doc.roundedRect(X + P, ny, leftW, th + 18, 10).lineWidth(0.6).fillAndStroke("#f0f9ff", "#e0f2fe");
    doc.fillColor("#0c4a6e").text(t, X + P + 12, ny + 9, { width: leftW - 24 });
    ny += th + 26;
  }
  if (inv.notes) {
    const t = `Note: ${inv.notes}`;
    doc.font("R").fontSize(8);
    const th = doc.heightOfString(t, { width: leftW - 24 });
    doc.roundedRect(X + P, ny, leftW, th + 18, 10).lineWidth(0.6).fillAndStroke("#fffbeb", "#fef3c7");
    doc.fillColor("#78350f").text(t, X + P + 12, ny + 9, { width: leftW - 24 });
    ny += th + 26;
  }

  // totals card
  const rows: [string, string, boolean?][] = [["Subtotal", m(inv.subtotal)]];
  if (inv.discount > 0) rows.push(["Discount", m(-inv.discount), true]);
  if (inv.taxTotal > 0) rows.push(["Taxable value", m(inv.taxableAmount)]);
  if (inv.cgst > 0) rows.push([`CGST @ ${inv.gstRate / 2}%`, m(inv.cgst)]);
  if (inv.sgst > 0) rows.push([`SGST @ ${inv.gstRate / 2}%`, m(inv.sgst)]);
  if (inv.igst > 0) rows.push([`IGST @ ${inv.gstRate}%`, m(inv.igst)]);
  if (exportInv) rows.push(["IGST", "0.00 (LUT)"]);
  const after: [string, string, string][] = [];
  if (inv.amountPaid > 0) after.push(["Paid", m(inv.amountPaid), "#047857"]);
  if (inv.creditApplied > 0) after.push(["  incl. account credit", m(inv.creditApplied), ink]);
  const boxH = 16 + rows.length * 16 + 8 + 40 + (after.length ? 8 + after.length * 15 : 0) + (inv.status === "UNPAID" ? 26 : 0) + 12;
  doc.roundedRect(totX, y, TOTW, boxH, 12).lineWidth(0.6).fillAndStroke(tint, line);
  let ty = y + 14;
  for (const [l, v, green] of rows) {
    doc.font("R").fontSize(9).fillColor(mute).text(l, totX + 14, ty, { width: 110 });
    doc.font("S").fontSize(9).fillColor(green ? "#047857" : ink).text(v, totX + 14, ty, { width: TOTW - 28, align: "right" });
    ty += 16;
  }
  ty += 6;
  doc.save();
  const tg = doc.linearGradient(totX + 12, ty, totX + TOTW - 12, ty + 38);
  tg.stop(0, "#8b5cf6").stop(1, "#6d28d9");
  doc.roundedRect(totX + 12, ty, TOTW - 24, 38, 9).fill(tg);
  doc.restore();
  doc.font("B").fontSize(8).fillColor("#ede9fe").text("TOTAL", totX + 24, ty + 15, { characterSpacing: 1 });
  doc.font("B").fontSize(16).fillColor("#ffffff").text(m(inv.total), totX + 24, ty + 10, { width: TOTW - 48, align: "right" });
  ty += 46;
  if (after.length) {
    ty += 4;
    for (const [l, v, col] of after) {
      doc.font("R").fontSize(9).fillColor(mute).text(l, totX + 14, ty, { width: 110 });
      doc.font("S").fontSize(9).fillColor(col).text(v, totX + 14, ty, { width: TOTW - 28, align: "right" });
      ty += 15;
    }
  }
  if (inv.status === "UNPAID") {
    doc.moveTo(totX + 14, ty + 2).lineTo(totX + TOTW - 14, ty + 2).lineWidth(0.6).strokeColor(line).stroke();
    doc.font("B").fontSize(10.5).fillColor(purple).text("Balance due", totX + 14, ty + 9);
    doc.text(m(due), totX + 14, ty + 9, { width: TOTW - 28, align: "right" });
  }
  y = Math.max(ny, y + boxH) + 18;

  // ── payment history ─────────────────────────────────────────
  const pays = inv.transactions.filter((t) => t.type === "PAYMENT" || t.type === "CREDIT_APPLIED" || t.type === "REFUND");
  if (pays.length) {
    if (y + 40 + pays.length * 34 > PH - 90) y = newPage();
    doc.moveTo(X, y - 6).lineTo(X + W, y - 6).lineWidth(0.6).strokeColor("#eef0f4").stroke();
    label("PAYMENT HISTORY", X + P, y + 6, 200);
    y += 22;
    for (const t of pays) {
      const refund = t.type === "REFUND";
      doc.roundedRect(X + P, y, W - P * 2, 28, 8).lineWidth(0.6).fillAndStroke("#f8fafc", "#e2e8f0");
      doc.roundedRect(X + P + 8, y + 5, 18, 18, 5).fill(refund ? "#e0f2fe" : "#d1fae5");
      const ix = X + P + 8;
      doc.lineWidth(1.6).lineCap("round").lineJoin("round").strokeColor(refund ? "#0369a1" : "#047857");
      if (refund) doc.moveTo(ix + 12.5, y + 14).lineTo(ix + 5.5, y + 14).moveTo(ix + 8.5, y + 11).lineTo(ix + 5.5, y + 14).lineTo(ix + 8.5, y + 17).stroke();
      else doc.moveTo(ix + 5, y + 14.2).lineTo(ix + 8, y + 17).lineTo(ix + 13, y + 11).stroke();
      doc.lineCap("butt").lineJoin("miter");
      doc.font("B").fontSize(8.6).fillColor(ink).text((t.gateway === "credit" ? "ACCOUNT CREDIT" : t.gateway.toUpperCase()) + (refund ? "  ·  REFUND" : ""), X + P + 34, y + 6);
      doc.font("R").fontSize(7.4).fillColor(mute).text(`${t.gatewayTxnId.slice(0, 40)} · ${date(t.createdAt)}`, X + P + 34, y + 17);
      doc.font("B").fontSize(9.5).fillColor(refund ? "#0369a1" : "#047857").text(`${refund ? "−" : ""}${money(Math.abs(t.amount), t.currency ?? cur)}`, X + P, y + 9, { width: W - P * 2 - 12, align: "right" });
      y += 34;
    }
    y += 6;
  }

  // ── bank details for unpaid INR invoices ───────────────────
  if (s.invoice.bankDetails && inv.status === "UNPAID" && cur === "INR") {
    doc.moveTo(X, y).lineTo(X + W, y).lineWidth(0.6).strokeColor("#eef0f4").stroke();
    label("BANK TRANSFER DETAILS", X + P, y + 12, 300);
    doc.font("R").fontSize(8.5).fillColor("#475569").text(s.invoice.bankDetails, X + P, y + 26, { width: W - P * 2, lineGap: 1.5 });
    y = doc.y + 10;
  }

  // ── footer (bottom of the last page) ───────────────────────
  const FH = 40;
  const fy = PH - 28 - FH;
  doc.save();
  doc.roundedRect(X, 28, W, PH - 56, 18).clip();
  doc.rect(X, fy, W, FH).fill(tint);
  doc.restore();
  doc.moveTo(X, fy).lineTo(X + W, fy).lineWidth(0.6).strokeColor("#eef0f4").stroke();
  doc.font("R").fontSize(7.4).fillColor(mute).text(`${s.invoice.footerNote ?? "This is a computer generated invoice and does not require a signature."} Tax payable on reverse charge: No.`, X + P, fy + 10, { width: W * 0.62 });
  doc.font("S").fontSize(7.6).fillColor(mute).text(`${(c.website ?? "").replace(/^https?:\/\//, "")} · ${c.billingEmail ?? c.email ?? ""}`, X + W * 0.62, fy + 15, { width: W * 0.38 - P, align: "right" });
  doc.lineWidth(0.8).strokeColor("#e9e4f5").roundedRect(X, 28, W, PH - 56, 18).stroke();

  doc.end();
  return done;
}

export { CYCLE_LABEL };
