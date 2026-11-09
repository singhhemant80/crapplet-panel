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
  automation: {
    invoiceDaysBeforeDue: 10,
    reminderDaysBefore: [7, 3],
    overdueReminderDaysAfter: [1, 3, 5],
    suspendDaysAfterDue: 3,
    terminateDaysAfterDue: 15,
    autoSuspend: true,
    autoUnsuspend: true,
    autoTerminate: true,
    lateFeePct: 0,
    applyCreditAutomatically: true,
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
