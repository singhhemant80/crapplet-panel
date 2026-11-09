"use client";

export class ApiError extends Error {
  constructor(public status: number, message: string, public body?: any) {
    super(message);
  }
}

let refreshing: Promise<boolean> | null = null;
async function refresh(): Promise<boolean> {
  if (!refreshing) {
    refreshing = fetch("/api/auth/refresh", { method: "POST", credentials: "include", headers: { "X-Requested-With": "crapplet" } })
      .then((r) => r.ok)
      .catch(() => false)
      .finally(() => setTimeout(() => (refreshing = null), 1000));
  }
  return refreshing;
}

export async function api<T = any>(path: string, opts: { method?: string; body?: unknown; form?: FormData; retry?: boolean } = {}): Promise<T> {
  const headers: Record<string, string> = { "X-Requested-With": "crapplet" };
  let body: BodyInit | undefined;
  if (opts.form) body = opts.form;
  else if (opts.body !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(opts.body);
  }
  const res = await fetch(`/api${path}`, { method: opts.method ?? (body ? "POST" : "GET"), headers, body, credentials: "include", cache: "no-store" });
  if (res.status === 401 && opts.retry !== false && !path.startsWith("/auth/")) {
    if (await refresh()) return api<T>(path, { ...opts, retry: false });
  }
  const text = await res.text();
  let data: any = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (!res.ok) {
    let msg = data?.error ?? `Request failed (${res.status})`;
    const fe = data?.details?.fieldErrors;
    if (fe && Object.keys(fe).length) msg += ": " + Object.entries(fe).map(([k, v]) => `${k} — ${(v as string[]).join(", ")}`).join("; ");
    throw new ApiError(res.status, msg, data);
  }
  return data as T;
}

export const get = <T = any>(p: string) => api<T>(p);
export const post = <T = any>(p: string, body?: unknown) => api<T>(p, { method: "POST", body: body ?? {} });
export const put = <T = any>(p: string, body?: unknown) => api<T>(p, { method: "PUT", body: body ?? {} });
export const del = <T = any>(p: string) => api<T>(p, { method: "DELETE" });

// ── formatting ──
export function money(minor: number | null | undefined, currency = "INR"): string {
  const m = minor ?? 0;
  if (m < 0) return "−" + money(-m, currency); // −₹59.85, not ₹-59.85
  const v = m / 100;
  if (currency === "INR") return "₹" + v.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return new Intl.NumberFormat("en-US", { style: "currency", currency: currency || "INR" }).format(v);
}
export const rupees = (minor: number) => "₹" + (minor / 100).toLocaleString("en-IN", { maximumFractionDigits: 2 });
export function date(d: string | Date | null | undefined, withTime = false) {
  if (!d) return "—";
  return new Date(d).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", day: "2-digit", month: "short", year: "numeric", ...(withTime ? { hour: "2-digit", minute: "2-digit" } : {}) });
}
export function ago(d: string | Date) {
  const s = (Date.now() - new Date(d).getTime()) / 1000;
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}
export const CYCLES: Record<string, string> = { ONETIME: "One time", MONTHLY: "Monthly", QUARTERLY: "Quarterly", SEMIANNUAL: "Semi-annually", ANNUAL: "Annually", BIENNIAL: "Biennially", TRIENNIAL: "Triennially" };
export const CYCLE_MONTHS: Record<string, number> = { ONETIME: 1, MONTHLY: 1, QUARTERLY: 3, SEMIANNUAL: 6, ANNUAL: 12, BIENNIAL: 24, TRIENNIAL: 36 };
export const invNo = (i: { number?: string | null; proformaNumber: string }) => i.number ?? i.proformaNumber;
export const gb = (mb?: number | null) => (mb ? (mb >= 1024 ? `${mb / 1024} GB` : `${mb} MB`) : "—");

export const INDIAN_STATES = [
  "Andaman and Nicobar Islands", "Andhra Pradesh", "Arunachal Pradesh", "Assam", "Bihar", "Chandigarh", "Chhattisgarh", "Dadra and Nagar Haveli and Daman and Diu", "Delhi", "Goa", "Gujarat",
  "Haryana", "Himachal Pradesh", "Jammu and Kashmir", "Jharkhand", "Karnataka", "Kerala", "Ladakh", "Lakshadweep", "Madhya Pradesh", "Maharashtra", "Manipur", "Meghalaya", "Mizoram",
  "Nagaland", "Odisha", "Puducherry", "Punjab", "Rajasthan", "Sikkim", "Tamil Nadu", "Telangana", "Tripura", "Uttar Pradesh", "Uttarakhand", "West Bengal",
];
export const COUNTRIES: [string, string][] = [["IN", "India"], ["US", "United States"], ["GB", "United Kingdom"], ["AE", "United Arab Emirates"], ["SG", "Singapore"], ["DE", "Germany"], ["CA", "Canada"], ["AU", "Australia"], ["NP", "Nepal"], ["BD", "Bangladesh"], ["LK", "Sri Lanka"], ["NL", "Netherlands"], ["FR", "France"]];
