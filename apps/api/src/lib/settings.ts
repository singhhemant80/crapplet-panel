import { prisma, type Db } from "../db";

export const DEFAULT_SETTINGS = {
  company: {
    legalName: "Crapplet Infotech Private Limited",
    brand: "Crapplet Cloud",
    website: "https://crapplet.co.in",
    altDomain: "https://primocloud.in",
    email: "info@crapplet.in",
    billingEmail: "billing@crapplet.co.in",
    phone: "+91 90395 73607",
    address: "City Center, Gwalior, Madhya Pradesh 474011, India",
    city: "Gwalior",
    state: "Madhya Pradesh",
    stateCode: "23",
    country: "IN",
    gstin: "23AAHCC8426G1ZR",
    pan: "AAHCC8426G",
    logoPath: "Crapplet_logo.png",
    timezone: "Asia/Kolkata",
  },
  tax: {
    enabled: true,
    gstRate: 18, // percent
    pricesIncludeTax: false,
    defaultSac: "998315", // IT infrastructure & network management / hosting
    domainSac: "998319",
    applyToForeign: false, // export of services: zero-rated (LUT) by default
  },
  invoice: {
    proformaPrefix: "PF-",
    taxPrefix: "CC/{FY}/",
    taxNumberPad: 5,
    dueDays: 7,
    creditNotePrefix: "CN/{FY}/",
    footerNote: "This is a computer generated invoice and does not require a signature.",
    bankDetails: "",
  },
  currency: {
    /** derive missing USD (etc.) prices from INR with the exchange rate */
    autoConvert: true,
    /** extra % on converted prices to cover FX / card fees */
    markupPct: 0,
    /** cent | whole | nice99 (4.99) */
    rounding: "nice99",
    /** refresh Currency.rate daily from a public FX API */
    autoUpdateRates: false,
    /** GST LUT ARN printed on export invoices (zero-rated supply) */
    lutArn: "",
  },
  automation: {
    /** master switch for the daily run */
    enabled: true,
    /** daily run time, IST (HH:MM) — a missed run is caught up as soon as the worker is back */
    runAt: "09:00",
    // invoices
    invoiceDaysBeforeDue: 10,
    domainInvoiceDaysBeforeDue: 30,
    invoiceCreatedEmail: true,
    applyCreditAutomatically: true,
    // UPI AutoPay (Razorpay): offered when paying an order with renewals; renewals are charged to it
    upiAutopay: true,
    /** which gateway sets up new mandates: auto = Razorpay when it's on, else Cashfree */
    autopayGateway: "auto" as "auto" | "razorpay" | "cashfree",
    /** start the AutoPay debit this many days before the due date (the bank notifies 24 h before, debits ~25 h after) */
    autopayDaysBeforeDue: 3,
    // reminders
    reminderDaysBefore: [7, 3],
    overdueReminderDaysAfter: [1, 3, 5],
    // late fees
    lateFeeEnabled: false,
    lateFeeType: "percent" as "percent" | "fixed",
    /** percent of the invoice subtotal, or a fixed amount in the invoice currency (rupees / dollars) */
    lateFeeAmount: 0,
    lateFeeMinimum: 0,
    lateFeeDaysAfterDue: 3,
    /** legacy (pre-automation-page) setting: a percentage > 0 turns late fees on */
    lateFeePct: 0,
    // suspension / termination
    autoSuspend: true,
    suspendDaysAfterDue: 3,
    suspendEmail: true,
    autoUnsuspend: true,
    unsuspendEmail: true,
    autoTerminate: true,
    terminateDaysAfterDue: 15,
    terminateEmail: true,
    /** when a service is terminated or cancelled, cancel its unpaid invoices (or remove its lines from shared ones) */
    cancelInvoicesOnTerminate: true,
    // orders
    /** cancel orders still unpaid after N days (0 = never) — releases held IPs */
    cancelUnpaidOrdersAfterDays: 0,
    // domains
    domainExpiryNoticeDays: [30, 7, 1],
    // housekeeping
    historyDays: 180,
  },
  orders: {
    ipReservationMinutes: 15,
    requireEmailVerification: false,
    allowGuestCart: true,
  },
  support: {
    autoCloseHours: 72,
    defaultSlaHours: 4,
  },
  affiliates: {
    enabled: true,
    defaultCommissionPct: 10,
    payoutThreshold: 100000,
  },
};

export type Settings = typeof DEFAULT_SETTINGS;
export type SettingKey = keyof Settings;

let cache: { at: number; data: Settings } | null = null;

export async function getSettings(db: Db = prisma): Promise<Settings> {
  if (cache && Date.now() - cache.at < 15_000) return cache.data;
  const rows = await db.setting.findMany();
  const data = structuredClone(DEFAULT_SETTINGS) as Settings;
  for (const r of rows) {
    const k = r.key as SettingKey;
    if (k in data) (data as Record<string, unknown>)[k] = { ...(data[k] as object), ...(r.value as object) };
  }
  cache = { at: Date.now(), data };
  return data;
}

export async function updateSettings<K extends SettingKey>(key: K, value: Partial<Settings[K]>) {
  const current = await getSettings();
  const merged = { ...(current[key] as object), ...(value as object) };
  await prisma.setting.upsert({ where: { key }, update: { value: merged }, create: { key, value: merged } });
  cache = null;
  return merged;
}

export function clearSettingsCache() {
  cache = null;
}
