"use client";
import { useEffect, useState } from "react";
import { useSession } from "./session";
import { cx } from "@/components/ui";

/**
 * Storefront currency.
 * - Signed-in clients always see (and pay in) their account currency.
 * - Guests pick INR / USD; the first visit guesses from the browser time zone.
 */
// same key as the public website's currency.js, so the site header toggle and the order pages always agree
const KEY = "crapplet_currency";
export const CURRENCIES = ["INR", "USD"] as const;

function guess(): string {
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone ?? "";
    return /Calcutta|Kolkata/.test(tz) ? "INR" : "USD";
  } catch {
    return "INR";
  }
}
export function readCurrency(): string {
  try {
    return localStorage.getItem(KEY) || guess();
  } catch {
    return "INR";
  }
}
export function writeCurrency(c: string) {
  try {
    localStorage.setItem(KEY, c);
  } catch {
    /* storage unavailable */
  }
  window.dispatchEvent(new Event("cc-currency"));
}

/** Keep the website header's ₹ INR / $ USD buttons in sync, and let them drive the panel too. */
function syncHeaderButtons(cur: string) {
  document.querySelectorAll<HTMLButtonElement>("button[data-currency]").forEach((b) => {
    const on = b.dataset.currency === cur;
    b.classList.toggle("is-active", on);
    b.setAttribute("aria-pressed", String(on));
  });
  document.documentElement.setAttribute("data-active-currency", cur);
}
let headerBound = false;
function bindHeader() {
  if (headerBound || typeof document === "undefined") return;
  headerBound = true;
  document.addEventListener("click", (e) => {
    const b = (e.target as HTMLElement)?.closest?.("button[data-currency]") as HTMLButtonElement | null;
    if (b?.dataset.currency) writeCurrency(b.dataset.currency);
  });
}

export function useCurrency() {
  const { me } = useSession();
  const accountCurrency: string | undefined = me?.type === "CLIENT" ? me?.profile?.currency : undefined;
  const [picked, setPicked] = useState("INR");
  useEffect(() => {
    const sync = () => setPicked(readCurrency());
    sync();
    window.addEventListener("cc-currency", sync);
    return () => window.removeEventListener("cc-currency", sync);
  }, []);
  const currency = accountCurrency ?? picked;
  useEffect(() => {
    bindHeader();
    syncHeaderButtons(currency);
    // the header markup can mount after us
    const t = setTimeout(() => syncHeaderButtons(currency), 300);
    return () => clearTimeout(t);
  }, [currency]);
  return { currency, locked: !!accountCurrency, setCurrency: writeCurrency, isInr: currency === "INR" };
}

/** Price row for a cycle in a currency from the catalogue's `pricing` list. */
export const priceRow = (pricing: any[], cycle: string, currency: string) => pricing?.find((x) => x.cycle === cycle && x.currency === currency);
/** All price rows in one currency. */
export const rowsIn = (pricing: any[], currency: string) => (pricing ?? []).filter((x) => x.currency === currency);
/** Pick a per-currency amount from a `{ INR: x, USD: y }` map. */
export const pick = (map: Record<string, number> | undefined, currency: string, fallback = 0) => map?.[currency] ?? (currency === "INR" ? fallback : 0);

/** One-line tax note under prices. */
export const taxNote = (currency: string) => (currency === "INR" ? "+ 18% GST" : "no Indian GST outside India");

export function CurrencySwitch({ className }: { className?: string }) {
  const { currency, locked, setCurrency } = useCurrency();
  if (locked)
    return (
      <span className={cx("inline-flex items-center gap-1.5 rounded-full bg-white px-3 py-1.5 text-xs font-extrabold text-primary-dark ring-1 ring-line", className)} title="Prices follow your account's billing currency">
        Billing in {currency}
      </span>
    );
  return (
    <div className={cx("inline-flex rounded-full bg-white p-1 ring-1 ring-line", className)} role="group" aria-label="Currency">
      {CURRENCIES.map((c) => (
        <button
          key={c}
          type="button"
          onClick={() => setCurrency(c)}
          className={cx("rounded-full px-3.5 py-1.5 text-xs font-extrabold transition", currency === c ? "bg-primary-dark text-white shadow" : "text-slate-600 hover:text-primary-dark")}
          aria-pressed={currency === c}
        >
          {c === "INR" ? "₹ INR" : "$ USD"}
        </button>
      ))}
    </div>
  );
}
