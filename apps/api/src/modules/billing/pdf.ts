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

export async function renderInvoicePdf(invoiceId: string): Promise<Buffer> {
  const inv = await prisma.invoice.findUniqueOrThrow({ where: { id: invoiceId }, include: { items: true, transactions: true } });
  const s = await getSettings();
  const c = s.company;
  const bill = (inv.billingSnapshot ?? {}) as Record<string, string | null>;
  const isTax = inv.status === "PAID" && !!inv.number;
  const title = inv.isWalletTopup ? "RECEIPT VOUCHER" : isTax ? "TAX INVOICE" : "PROFORMA INVOICE";

  const doc = new PDFDocument({ size: "A4", margin: 40, info: { Title: `${title} ${inv.number ?? inv.proformaNumber}`, Author: c.legalName } });
  doc.registerFont("R", font("Inter-Regular.otf"));
  doc.registerFont("S", font("Inter-SemiBold.otf"));
  doc.registerFont("B", font("Inter-Bold.otf"));
  const chunks: Buffer[] = [];
  doc.on("data", (d: Buffer) => chunks.push(d));
  const done = new Promise<Buffer>((res) => doc.on("end", () => res(Buffer.concat(chunks))));

  const W = doc.page.width - 80;
  const purple = "#7c3aed";
  const ink = "#0f172a";
  const mute = "#64748b";

  // header band
  doc.rect(0, 0, doc.page.width, 6).fill(purple);
  const logo = path.join(ASSETS, "img", "Crapplet_logo.png");
  if (fs.existsSync(logo)) doc.image(logo, 40, 28, { height: 34 });
  doc.font("B").fontSize(18).fillColor(ink).text(title, 40, 30, { width: W, align: "right" });
  doc.font("R").fontSize(9).fillColor(mute).text(`${isTax || inv.isWalletTopup ? "No." : "Ref."} ${inv.number ?? inv.proformaNumber}`, 40, 54, { width: W, align: "right" });

  // supplier / meta
  let y = 84;
  doc.font("B").fontSize(10).fillColor(ink).text(c.legalName, 40, y);
  doc.font("R").fontSize(8.5).fillColor(mute).text([c.address, `GSTIN: ${c.gstin}   PAN: ${c.pan}`, `${c.email} · ${c.phone} · ${c.website}`].join("\n"), 40, y + 14, { width: 300, lineGap: 1.5 });
  const meta: [string, string][] = [
    ["Invoice date", date(inv.paidAt && isTax ? inv.paidAt : inv.issueDate)],
    ["Due date", date(inv.dueDate)],
    ["Status", inv.status === "PAID" ? "PAID" : inv.status],
    ["Place of supply", inv.placeOfSupply ?? "—"],
  ];
  if (inv.number && inv.proformaNumber) meta.push(["Proforma ref.", inv.proformaNumber]);
  meta.forEach(([k, v], i) => {
    doc.font("R").fontSize(8.5).fillColor(mute).text(k, 360, y + i * 14, { width: 80 });
    doc.font("S").fontSize(8.5).fillColor(ink).text(v, 440, y + i * 14, { width: W - 400, align: "right" });
  });

  // bill to
  y = 170;
  doc.roundedRect(40, y, W, 78, 8).fill("#faf7ff");
  doc.font("S").fontSize(8).fillColor(purple).text("BILL TO", 54, y + 10);
  doc.font("B").fontSize(10).fillColor(ink).text(bill.companyName || bill.name || "", 54, y + 22, { width: W / 2 });
  const addr = [bill.companyName ? bill.name : null, [bill.address1, bill.address2].filter(Boolean).join(", "), [bill.city, bill.state, bill.postcode].filter(Boolean).join(", "), bill.country === "IN" ? "India" : bill.country]
    .filter(Boolean)
    .join("\n");
  doc.font("R").fontSize(8.5).fillColor(mute).text(addr, 54, y + 36, { width: W / 2 - 20, lineGap: 1 });
  doc.font("R").fontSize(8.5).fillColor(mute).text(`GSTIN: ${inv.customerGstin ?? "Unregistered"}`, 40 + W / 2, y + 22, { width: W / 2 - 14, align: "right" });
  doc.text(`State code: ${inv.placeOfSupplyCode ?? "—"}`, 40 + W / 2, y + 36, { width: W / 2 - 14, align: "right" });
  doc.text(bill.email ?? "", 40 + W / 2, y + 50, { width: W / 2 - 14, align: "right" });

  // items table
  y = 266;
  const cols = [
    { k: "#", w: 22, a: "left" as const },
    { k: "Description", w: W - 22 - 62 - 34 - 80 - 86, a: "left" as const },
    { k: "HSN/SAC", w: 62, a: "left" as const },
    { k: "Qty", w: 34, a: "right" as const },
    { k: "Rate", w: 80, a: "right" as const },
    { k: "Amount", w: 86, a: "right" as const },
  ];
  doc.rect(40, y, W, 22).fill(purple);
  let x = 40;
  cols.forEach((col) => {
    doc.font("S").fontSize(8.5).fillColor("#fff").text(col.k, x + 6, y + 7, { width: col.w - 12, align: col.a });
    x += col.w;
  });
  y += 22;
  inv.items.forEach((it, idx) => {
    let desc = it.description;
    if (it.periodStart && it.periodEnd) desc += `\n${date(it.periodStart)} – ${date(it.periodEnd)}`;
    const h = Math.max(22, doc.font("R").fontSize(8.5).heightOfString(desc, { width: cols[1].w - 12 }) + 12);
    if (y + h > doc.page.height - 200) {
      doc.addPage();
      y = 40;
    }
    if (idx % 2 === 1) doc.rect(40, y, W, h).fill("#fbf9ff");
    const vals = [String(idx + 1), desc, it.hsnSac ?? "", String(it.quantity), money(it.unitPrice, inv.currency), money(it.amount, inv.currency)];
    x = 40;
    cols.forEach((col, i) => {
      doc.font(i === 1 ? "S" : "R").fontSize(8.5).fillColor(ink).text(vals[i], x + 6, y + 6, { width: col.w - 12, align: col.a });
      x += col.w;
    });
    y += h;
    doc.moveTo(40, y).lineTo(40 + W, y).strokeColor("#ece4fb").lineWidth(0.6).stroke();
  });

  // totals
  y += 12;
  const tx = 40 + W - 230;
  const row = (label: string, value: string, bold = false) => {
    doc.font(bold ? "B" : "R").fontSize(bold ? 10 : 8.5).fillColor(bold ? ink : mute).text(label, tx, y, { width: 130 });
    doc.font(bold ? "B" : "S").fontSize(bold ? 10 : 8.5).fillColor(ink).text(value, tx + 130, y, { width: 100, align: "right" });
    y += bold ? 18 : 14;
  };
  row("Subtotal", money(inv.subtotal, inv.currency));
  if (inv.discount) row("Discount", "− " + money(inv.discount, inv.currency));
  if (inv.taxInclusive) row("Taxable value", money(inv.taxableAmount, inv.currency));
  if (inv.cgst) row(`CGST @ ${inv.gstRate / 2}%`, money(inv.cgst, inv.currency));
  if (inv.sgst) row(`SGST @ ${inv.gstRate / 2}%`, money(inv.sgst, inv.currency));
  if (inv.igst) row(`IGST @ ${inv.gstRate}%`, money(inv.igst, inv.currency));
  if (!inv.taxTotal && inv.placeOfSupplyCode === "96") row("IGST", "Zero-rated (export)");
  doc.moveTo(tx, y).lineTo(tx + 230, y).strokeColor(purple).lineWidth(1).stroke();
  y += 6;
  row("Total", money(inv.total, inv.currency), true);
  if (inv.amountPaid) row("Amount paid", money(inv.amountPaid, inv.currency));
  if (inv.total - inv.amountPaid > 0 && inv.status === "UNPAID") row("Balance due", money(inv.total - inv.amountPaid, inv.currency), true);

  if (inv.currency === "INR") {
    doc.font("R").fontSize(8).fillColor(mute).text(`Amount in words: Indian Rupees ${amountInWords(Math.floor(inv.total / 100))}${inv.total % 100 ? ` and ${amountInWords(inv.total % 100)} Paise` : ""} Only`, 40, y + 6, { width: W - 240 });
  } else {
    // export invoice: words in the billed currency + INR value at the invoice-date rate (GST Rule 34 / FEMA)
    const [major, minorName] = UNIT_NAMES[inv.currency] ?? [inv.currency, "cents"];
    const inrValue = Math.round(inv.total * (inv.exchangeRate || 1));
    const lines = [
      `Amount in words: ${major} ${amountInWords(Math.floor(inv.total / 100))}${inv.total % 100 ? ` and ${amountInWords(inv.total % 100)} ${minorName}` : ""} Only`,
      `INR equivalent: ${money(inrValue, "INR")} @ ₹${(inv.exchangeRate || 1).toFixed(4)} per ${inv.currency}`,
    ];
    if (!inv.taxTotal && inv.placeOfSupplyCode === "96")
      lines.push(`Supply meant for export of services under LUT without payment of IGST${s.currency?.lutArn ? ` (LUT ARN ${s.currency.lutArn})` : ""}.`);
    doc.font("R").fontSize(8).fillColor(mute).text(lines.join("\n"), 40, y + 6, { width: W - 240 });
  }

  // payments
  y = Math.max(y + 24, doc.y + 16);
  const pays = inv.transactions.filter((t) => t.type === "PAYMENT" || t.type === "CREDIT_APPLIED");
  if (pays.length) {
    doc.font("S").fontSize(9).fillColor(ink).text("Payments", 40, y);
    y += 14;
    for (const p of pays) {
      doc.font("R").fontSize(8).fillColor(mute).text(`${date(p.createdAt)} · ${p.gateway.toUpperCase()} · ${p.gatewayTxnId}`, 40, y, { width: W - 120 });
      doc.font("S").fontSize(8).fillColor(ink).text(money(p.amount, p.currency), 40 + W - 120, y, { width: 120, align: "right" });
      y += 12;
    }
  }
  if (s.invoice.bankDetails && inv.status === "UNPAID" && inv.currency === "INR") {
    y += 8;
    doc.font("S").fontSize(9).fillColor(ink).text("Bank transfer details", 40, y);
    doc.font("R").fontSize(8).fillColor(mute).text(s.invoice.bankDetails, 40, y + 13, { width: W });
  }
  if (inv.notes) doc.font("R").fontSize(8).fillColor(mute).text(`Notes: ${inv.notes}`, 40, doc.y + 10, { width: W });

  // footer
  const fy = doc.page.height - 60;
  doc.moveTo(40, fy).lineTo(40 + W, fy).strokeColor("#ece4fb").lineWidth(0.6).stroke();
  doc.font("R").fontSize(7.5).fillColor(mute).text(`${s.invoice.footerNote}  Whether tax is payable on reverse charge: No.`, 40, fy + 8, { width: W, align: "center" });
  doc.text(`${c.brand} · ${c.website}`, 40, fy + 20, { width: W, align: "center" });

  doc.end();
  return done;
}

export { CYCLE_LABEL };
