"use client";
import type { ReactNode } from "react";
import { date, money } from "@/lib/api";
import { Icon, cx } from "./ui";

const ONES = ["", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten", "Eleven", "Twelve", "Thirteen", "Fourteen", "Fifteen", "Sixteen", "Seventeen", "Eighteen", "Nineteen"];
const TENS = ["", "", "Twenty", "Thirty", "Forty", "Fifty", "Sixty", "Seventy", "Eighty", "Ninety"];
function words(n: number): string {
  if (n === 0) return "Zero";
  const two = (x: number) => (x < 20 ? ONES[x] : `${TENS[Math.floor(x / 10)]}${x % 10 ? " " + ONES[x % 10] : ""}`);
  const three = (x: number) => (x >= 100 ? `${ONES[Math.floor(x / 100)]} Hundred${x % 100 ? " " + two(x % 100) : ""}` : two(x));
  const parts: string[] = [];
  const crore = Math.floor(n / 1e7), lakh = Math.floor((n % 1e7) / 1e5), thousand = Math.floor((n % 1e5) / 1000), rest = n % 1000;
  if (crore) parts.push(`${three(crore)} Crore`);
  if (lakh) parts.push(`${two(lakh)} Lakh`);
  if (thousand) parts.push(`${two(thousand)} Thousand`);
  if (rest) parts.push(three(rest));
  return parts.join(" ");
}
function amountInWords(minor: number, currency: string) {
  const [major, sub] = currency === "INR" ? ["Rupees", "Paise"] : currency === "USD" ? ["US Dollars", "Cents"] : [currency, "cents"];
  const m = Math.floor(minor / 100), c = minor % 100;
  return `${currency === "INR" ? "Indian " : ""}${major} ${words(m)}${c ? ` and ${words(c)} ${sub}` : ""} Only`;
}

const STATUS: Record<string, { label: string; cls: string; icon: string }> = {
  PAID: { label: "Paid", cls: "bg-emerald-500 text-white", icon: "verified" },
  UNPAID: { label: "Unpaid", cls: "bg-amber-400 text-amber-950", icon: "schedule" },
  OVERDUE: { label: "Overdue", cls: "bg-rose-500 text-white", icon: "error" },
  CANCELLED: { label: "Cancelled", cls: "bg-slate-400 text-white", icon: "block" },
  REFUNDED: { label: "Refunded", cls: "bg-sky-500 text-white", icon: "undo" },
  PARTIALLY_REFUNDED: { label: "Part refunded", cls: "bg-sky-500 text-white", icon: "undo" },
  DRAFT: { label: "Draft", cls: "bg-slate-300 text-slate-800", icon: "edit_note" },
};

/** A print-style invoice document used by both the client area and the admin. */
export function InvoiceSheet({ data, admin, footer }: { data: any; admin?: boolean; footer?: ReactNode }) {
  const inv = data.invoice;
  const c = data.company ?? {};
  const bill = inv.billingSnapshot ?? {};
  const cur = inv.currency ?? "INR";
  const m = (v: number) => money(v, cur);
  const overdue = inv.status === "UNPAID" && new Date(inv.dueDate) < new Date();
  const st = STATUS[overdue ? "OVERDUE" : inv.status] ?? STATUS.UNPAID;
  const due = inv.total - inv.amountPaid;
  const kind = inv.isWalletTopup ? "Receipt voucher" : inv.number ? "Tax invoice" : "Proforma invoice";
  const exportInv = cur !== "INR" && !inv.taxTotal && inv.placeOfSupplyCode === "96";
  const payments = (inv.transactions ?? []).filter((t: any) => t.type === "PAYMENT" || t.type === "CREDIT_APPLIED" || t.type === "REFUND");

  return (
    <article className="min-w-0 overflow-hidden rounded-[22px] border border-line bg-white shadow-[0_24px_60px_rgba(46,16,101,.08)]">
      {/* letterhead */}
      <header className="relative overflow-hidden bg-[linear-gradient(135deg,#8b5cf6_0%,#6d28d9_55%,#3b0f7a_100%)] px-6 py-6 text-white sm:px-8">
        <div className="pointer-events-none absolute -right-16 -top-20 h-56 w-56 rounded-full bg-white/10 blur-2xl" />
        <div className="pointer-events-none absolute inset-0 opacity-[.06] [background-image:linear-gradient(#fff_1px,transparent_1px),linear-gradient(90deg,#fff_1px,transparent_1px)] [background-size:24px_24px]" />
        <div className="relative flex flex-wrap items-start justify-between gap-5">
          <div className="min-w-0">
            <img src="/Crapplet_logo.png" alt={c.brand ?? "Crapplet Cloud"} className="h-9 w-auto brightness-0 invert" />
            <div className="mt-3 text-sm font-bold">{c.legalName}</div>
            <div className="max-w-xs text-xs text-violet-100/85">{c.address}</div>
            <div className="mt-1 text-xs text-violet-100/85">
              GSTIN <span className="font-mono font-bold text-white">{c.gstin}</span>
              {c.pan && <> · PAN <span className="font-mono">{c.pan}</span></>}
            </div>
          </div>
          <div className="text-right">
            <div className="text-[11px] font-extrabold uppercase tracking-[.22em] text-violet-200">{kind}</div>
            <div className="mt-1 font-mono text-2xl font-black tracking-tight sm:text-[28px]">{inv.number ?? inv.proformaNumber}</div>
            {inv.number && <div className="text-xs text-violet-200">Proforma {inv.proformaNumber}</div>}
            <span className={cx("mt-3 inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-extrabold uppercase tracking-wider shadow", st.cls)}>
              <Icon name={st.icon} className="text-[15px]" /> {st.label}
            </span>
          </div>
        </div>
      </header>

      {/* dates & amounts strip */}
      <div className="grid grid-cols-2 divide-line border-b border-line bg-[#fbf9ff] text-sm sm:grid-cols-4 sm:divide-x">
        {[
          ["Issued", date(inv.issueDate)],
          [inv.status === "PAID" ? "Paid on" : "Due date", inv.status === "PAID" ? date(inv.paidAt) : date(inv.dueDate)],
          ["Place of supply", inv.placeOfSupply ?? "—"],
          [inv.status === "UNPAID" ? "Amount due" : "Total", inv.status === "UNPAID" ? m(due) : m(inv.total)],
        ].map(([l, v], idx) => (
          <div key={l} className={cx("px-5 py-3.5 sm:px-6", idx === 3 && "bg-primary-tint/60")}>
            <div className="text-[11px] font-bold uppercase tracking-wider text-mute">{l}</div>
            <div className={cx("mt-0.5 font-bold text-ink", idx === 3 && "text-lg font-black text-primary-dark", overdue && idx === 1 && "text-rose-600")}>{v}</div>
          </div>
        ))}
      </div>

      {/* parties */}
      <div className="grid gap-6 px-6 py-6 sm:grid-cols-2 sm:px-8">
        <div>
          <div className="mb-2 flex items-center gap-2 text-[11px] font-extrabold uppercase tracking-[.18em] text-primary-dark">
            <Icon name="person" className="text-[16px]" /> Billed to
          </div>
          <div className="text-base font-extrabold text-ink">{bill.companyName || bill.name}</div>
          {bill.companyName && <div className="text-sm text-slate-600">{bill.name}</div>}
          <div className="mt-1 text-sm leading-relaxed text-mute">
            {[bill.address1, bill.address2].filter(Boolean).join(", ")}
            <br />
            {[bill.city, bill.state, bill.postcode].filter(Boolean).join(", ")}
            {bill.country && bill.country !== "IN" ? ` · ${bill.country}` : ""}
          </div>
          <div className="mt-1 text-sm text-mute">{bill.email}</div>
          <div className="mt-2 inline-flex rounded-lg bg-slate-50 px-2.5 py-1 text-xs font-semibold text-slate-600 ring-1 ring-line">
            GSTIN {inv.customerGstin ? <b className="ml-1 font-mono text-ink">{inv.customerGstin}</b> : <span className="ml-1">Unregistered (B2C)</span>}
          </div>
        </div>
        <div className="sm:text-right">
          <div className="mb-2 flex items-center gap-2 text-[11px] font-extrabold uppercase tracking-[.18em] text-primary-dark sm:justify-end">
            <Icon name="receipt_long" className="text-[16px]" /> Invoice details
          </div>
          <dl className="space-y-1 text-sm">
            <div className="flex justify-between gap-6 sm:justify-end"><dt className="text-mute">Currency</dt><dd className="font-semibold text-ink">{cur}</dd></div>
            <div className="flex justify-between gap-6 sm:justify-end"><dt className="text-mute">GST</dt><dd className="font-semibold text-ink">{exportInv ? "Zero-rated export" : inv.taxTotal ? `${inv.gstRate}% ${inv.taxInclusive ? "inclusive" : "exclusive"}` : "Not charged"}</dd></div>
            {cur !== "INR" && <div className="flex justify-between gap-6 sm:justify-end"><dt className="text-mute">Exchange rate</dt><dd className="font-semibold text-ink">₹{Number(inv.exchangeRate).toFixed(4)} / {cur}</dd></div>}
            {admin && inv.user && <div className="flex justify-between gap-6 sm:justify-end"><dt className="text-mute">Account</dt><dd className="font-semibold text-ink">{inv.user.email}</dd></div>}
          </dl>
        </div>
      </div>

      {/* line items */}
      <div className="px-3 sm:px-5">
        <div className="overflow-x-auto rounded-2xl ring-1 ring-line">
          <table className="w-full min-w-[520px] text-sm">
            <thead>
              <tr className="bg-[#f6f1ff] text-left text-[11px] font-extrabold uppercase tracking-wider text-primary-dark">
                <th className="w-10 px-4 py-3">#</th>
                <th className="px-4 py-3">Description</th>
                <th className="px-4 py-3">SAC</th>
                <th className="px-4 py-3 text-right">Qty</th>
                <th className="px-4 py-3 text-right">Rate</th>
                <th className="px-4 py-3 text-right">Amount</th>
              </tr>
            </thead>
            <tbody>
              {inv.items.map((it: any, n: number) => (
                <tr key={it.id} className="border-t border-[#f1ecfb] align-top">
                  <td className="px-4 py-3.5 text-xs font-bold text-mute">{String(n + 1).padStart(2, "0")}</td>
                  <td className="px-4 py-3.5">
                    <div className={cx("font-semibold", it.amount < 0 ? "text-emerald-700" : "text-ink")}>{it.description.split("\n")[0]}</div>
                    {it.description.includes("\n") && <div className="text-xs text-mute">{it.description.split("\n").slice(1).join(" · ")}</div>}
                    {it.periodStart && it.periodEnd && (
                      <div className="mt-0.5 inline-flex items-center gap-1 text-xs text-mute">
                        <Icon name="date_range" className="text-[14px]" /> {date(it.periodStart)} – {date(it.periodEnd)}
                      </div>
                    )}
                    {admin && <div className="text-[11px] text-slate-400">{it.type}{it.relId ? ` · ${it.relId}` : ""}</div>}
                  </td>
                  <td className="px-4 py-3.5 font-mono text-xs text-mute">{it.hsnSac}</td>
                  <td className="px-4 py-3.5 text-right text-mute">{it.quantity}</td>
                  <td className="px-4 py-3.5 text-right text-mute">{m(it.unitPrice)}</td>
                  <td className={cx("px-4 py-3.5 text-right font-bold", it.amount < 0 ? "text-emerald-700" : "text-ink")}>{m(it.amount)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* totals */}
      <div className="grid gap-6 px-6 py-6 sm:px-8 md:grid-cols-[minmax(0,1fr)_minmax(260px,340px)]">
        <div className="space-y-3 text-sm">
          <div className="rounded-xl bg-slate-50 p-3.5 ring-1 ring-line">
            <div className="text-[11px] font-bold uppercase tracking-wider text-mute">Amount in words</div>
            <div className="mt-0.5 font-semibold text-ink">{amountInWords(inv.total, cur)}</div>
            {cur !== "INR" && <div className="mt-1 text-xs text-mute">INR equivalent {money(Math.round(inv.total * inv.exchangeRate))} @ ₹{Number(inv.exchangeRate).toFixed(4)} per {cur}</div>}
          </div>
          {exportInv && (
            <div className="flex gap-2 rounded-xl bg-sky-50 p-3.5 text-xs text-sky-900 ring-1 ring-sky-100">
              <Icon name="public" className="text-[18px]" />
              <span>Supply meant for export of services under LUT without payment of IGST{data.lutArn ? ` (LUT ARN ${data.lutArn})` : ""}.</span>
            </div>
          )}
          {inv.notes && <div className="rounded-xl bg-amber-50 p-3.5 text-amber-900 ring-1 ring-amber-100"><b>Note:</b> {inv.notes}</div>}
        </div>
        <div className="rounded-2xl bg-[#fbf9ff] p-5 ring-1 ring-[#ece4fb]">
          <dl className="space-y-2 text-sm">
            <Line l="Subtotal" v={m(inv.subtotal)} />
            {inv.discount > 0 && <Line l="Discount" v={m(-inv.discount)} green />}
            {inv.taxTotal > 0 && <Line l="Taxable value" v={m(inv.taxableAmount)} />}
            {inv.cgst > 0 && <Line l={`CGST @ ${inv.gstRate / 2}%`} v={m(inv.cgst)} />}
            {inv.sgst > 0 && <Line l={`SGST @ ${inv.gstRate / 2}%`} v={m(inv.sgst)} />}
            {inv.igst > 0 && <Line l={`IGST @ ${inv.gstRate}%`} v={m(inv.igst)} />}
            {exportInv && <Line l="IGST" v="0.00 (LUT)" />}
          </dl>
          <div className="mt-4 flex items-end justify-between rounded-xl bg-[linear-gradient(120deg,#8b5cf6,#6d28d9)] px-4 py-3.5 text-white shadow-[0_10px_24px_rgba(109,40,217,.28)]">
            <span className="text-xs font-extrabold uppercase tracking-wider text-violet-100">Total</span>
            <span className="text-2xl font-black tracking-tight">{m(inv.total)}</span>
          </div>
          {(inv.amountPaid > 0 || inv.status === "UNPAID") && (
            <dl className="mt-3 space-y-1.5 text-sm">
              {inv.amountPaid > 0 && <Line l="Paid" v={m(inv.amountPaid)} green />}
              {inv.creditApplied > 0 && <Line l="  incl. account credit" v={m(inv.creditApplied)} />}
              {inv.status === "UNPAID" && (
                <div className="flex justify-between border-t border-[#ece4fb] pt-2 text-base font-black text-primary-dark">
                  <dt>Balance due</dt>
                  <dd>{m(due)}</dd>
                </div>
              )}
            </dl>
          )}
        </div>
      </div>

      {/* payments */}
      {payments.length > 0 && (
        <div className="border-t border-line px-6 py-5 sm:px-8">
          <div className="mb-3 text-[11px] font-extrabold uppercase tracking-[.18em] text-primary-dark">Payment history</div>
          <ul className="space-y-2">
            {payments.map((t: any) => (
              <li key={t.id} className="flex flex-wrap items-center justify-between gap-2 rounded-xl bg-slate-50 px-4 py-2.5 text-sm ring-1 ring-line">
                <span className="flex items-center gap-3">
                  <span className={cx("grid h-8 w-8 place-items-center rounded-lg", t.type === "REFUND" ? "bg-sky-100 text-sky-700" : "bg-emerald-100 text-emerald-700")}>
                    <Icon name={t.type === "REFUND" ? "undo" : t.gateway === "credit" ? "account_balance_wallet" : "check_circle"} className="text-[18px]" />
                  </span>
                  <span>
                    <span className="font-bold uppercase text-ink">{t.gateway === "credit" ? "Account credit" : t.gateway}</span>
                    <span className="block font-mono text-[11px] text-mute">{t.gatewayTxnId.slice(0, 32)} · {date(t.createdAt, true)}</span>
                  </span>
                </span>
                <b className={t.type === "REFUND" ? "text-sky-700" : "text-emerald-700"}>{t.type === "REFUND" ? "−" : ""}{money(t.amount, t.currency ?? cur)}</b>
              </li>
            ))}
          </ul>
        </div>
      )}

      {inv.status === "UNPAID" && cur === "INR" && data.bankDetails && (
        <div className="border-t border-line px-6 py-5 sm:px-8">
          <div className="mb-2 text-[11px] font-extrabold uppercase tracking-[.18em] text-primary-dark">Bank transfer details</div>
          <pre className="whitespace-pre-wrap font-sans text-sm text-slate-600">{data.bankDetails}</pre>
        </div>
      )}

      {footer}

      <footer className="flex flex-wrap items-center justify-between gap-2 border-t border-line bg-[#fbf9ff] px-6 py-4 text-xs text-mute sm:px-8">
        <span>{data.footerNote ?? "This is a computer generated invoice and does not require a signature."}</span>
        <span className="font-semibold">{c.website?.replace(/^https?:\/\//, "")} · {c.billingEmail ?? c.email}</span>
      </footer>
    </article>
  );
}

function Line({ l, v, green }: { l: string; v: string; green?: boolean }) {
  return (
    <div className="flex justify-between gap-4">
      <dt className="text-mute">{l}</dt>
      <dd className={cx("font-semibold", green ? "text-emerald-700" : "text-ink")}>{v}</dd>
    </div>
  );
}
