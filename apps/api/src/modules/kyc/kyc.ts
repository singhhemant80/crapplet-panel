/**
 * Aadhaar KYC through Cashfree SecureID (DigiLocker).
 *
 *  1. the customer starts → we ask Cashfree for a DigiLocker link (valid 10 min) and send them there,
 *  2. they sign in to DigiLocker (Aadhaar + OTP) and consent to share their Aadhaar,
 *  3. DigiLocker returns them to the panel → we ask Cashfree for the status and, once AUTHENTICATED,
 *     the Aadhaar details (name, DOB, gender, address, masked number),
 *  4. the Aadhaar name is compared with the account name: a close match is VERIFIED, anything else
 *     goes to staff (REVIEW) or is VERIFIED anyway, as set in Admin → Identity verification.
 *
 * Staff switch the whole thing on and off at any time. Off = nothing is asked and nothing is blocked.
 * Only the last 4 digits of the Aadhaar number are kept (UIDAI rules) — never the full number, photo or XML.
 */
import { prisma } from "../../db";
import { config } from "../../config";
import { decrypt, encrypt, randomToken } from "../../lib/crypto";
import { HttpError } from "../../lib/http";

export type KycRequire = "optional" | "all_orders" | "servers";
export interface KycSettings {
  enabled: boolean;
  sandbox: boolean;
  clientId: string;
  /** decrypted; never sent to the browser */
  clientSecret: string;
  /** who must verify before ordering */
  require: KycRequire;
  /** names that don't match: send to staff for review, or accept */
  onMismatch: "review" | "accept";
}
type Stored = Omit<KycSettings, "clientSecret"> & { clientSecretEnc?: string };

export const KYC_DEFAULTS: Omit<KycSettings, "clientSecret"> = { enabled: false, sandbox: true, clientId: "", require: "optional", onMismatch: "review" };
/** product types that count as "servers" for require = servers */
export const SERVER_TYPES = ["VPS_LINUX", "VPS_WINDOWS", "VPS_FOREX", "TALLY", "VPS_N8N", "VPS_MINECRAFT", "VPS_GOLD", "DEDICATED", "GPU", "COLOCATION"];

let cache: { at: number; s: KycSettings } | null = null;
export async function getKycSettings(): Promise<KycSettings> {
  if (cache && Date.now() - cache.at < 15_000) return cache.s;
  const row = await prisma.setting.findUnique({ where: { key: "kyc" } });
  const st = { ...KYC_DEFAULTS, ...((row?.value ?? {}) as Partial<Stored>) } as Stored;
  let clientSecret = "";
  try {
    clientSecret = st.clientSecretEnc ? decrypt(st.clientSecretEnc) : "";
  } catch {
    clientSecret = "";
  }
  const { clientSecretEnc: _drop, ...rest } = st;
  const s: KycSettings = { ...rest, clientSecret };
  cache = { at: Date.now(), s };
  return s;
}

/** Save; an empty / "••••" secret keeps the current one. */
export async function saveKycSettings(input: Partial<KycSettings>) {
  const cur = await getKycSettings();
  const next = { ...cur, ...input };
  if (!input.clientSecret || input.clientSecret.startsWith("••")) next.clientSecret = cur.clientSecret;
  if (next.enabled && (!next.clientId || !next.clientSecret)) throw new HttpError(400, "Enter the Cashfree SecureID Client ID and Client Secret before switching verification on");
  const { clientSecret, ...rest } = next;
  const stored: Stored = { ...rest, clientSecretEnc: clientSecret ? encrypt(clientSecret) : "" };
  await prisma.setting.upsert({ where: { key: "kyc" }, update: { value: stored as never }, create: { key: "kyc", value: stored as never } });
  cache = null;
  return getKycSettings();
}
export const clearKycCache = () => {
  cache = null;
};

/** What the browser may see. */
export const publicKycSettings = (s: KycSettings) => ({ ...s, clientSecret: s.clientSecret ? "••••••••" + s.clientSecret.slice(-4) : "" });

// ───── Cashfree SecureID API ─────
function base(s: KycSettings) {
  // tests point this at a stand-in Cashfree; never in production
  if (process.env.NODE_ENV !== "production" && process.env.CASHFREE_KYC_BASE) return process.env.CASHFREE_KYC_BASE;
  return s.sandbox ? "https://sandbox.cashfree.com/verification" : "https://api.cashfree.com/verification";
}
async function cf<T>(s: KycSettings, method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(base(s) + path, {
      method,
      headers: { "Content-Type": "application/json", "x-client-id": s.clientId, "x-client-secret": s.clientSecret },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(20_000),
    });
  } catch {
    throw new HttpError(502, "Couldn't reach Cashfree — please try again in a minute", "KYC_PROVIDER_DOWN");
  }
  const t = await res.text();
  let j: any = null;
  try {
    j = JSON.parse(t);
  } catch {
    j = { message: t.slice(0, 200) };
  }
  if (!res.ok) {
    const msg = String(j?.message ?? `HTTP ${res.status}`);
    // staff-facing detail goes to the log; customers get a plain message
    console.warn(`[kyc] Cashfree ${method} ${path} → ${res.status}: ${msg}`);
    const err = new HttpError(502, "Identity verification is unavailable right now — please try again later", "KYC_PROVIDER_ERROR");
    (err as any).providerMessage = `${res.status}: ${msg}`;
    throw err;
  }
  return j as T;
}

/** Staff "Test connection": an unknown id answers 404 with good keys, 401/403 with bad keys or a blocked IP. */
export async function testKycConnection() {
  const s = await getKycSettings();
  if (!s.clientId || !s.clientSecret) return { ok: false, message: "Enter the Client ID and Client Secret first" };
  try {
    const res = await fetch(base(s) + `/digilocker?verification_id=cc_connection_test_${Date.now()}`, { headers: { "x-client-id": s.clientId, "x-client-secret": s.clientSecret }, signal: AbortSignal.timeout(15_000) });
    const j: any = await res.json().catch(() => ({}));
    if (res.ok || res.status === 404 || res.status === 400) return { ok: true, message: `Connected to Cashfree ${s.sandbox ? "sandbox" : "production"} — keys accepted` };
    if (res.status === 401) return { ok: false, message: "Cashfree refused the Client ID / Secret — check they're the SecureID (Verification) keys for " + (s.sandbox ? "sandbox" : "production") };
    if (res.status === 403) return { ok: false, message: `Cashfree refused this server: ${j.message ?? "IP not whitelisted"} — add this server's IP in Cashfree → Developers → IP whitelisting` };
    return { ok: false, message: `Cashfree answered ${res.status}: ${String(j.message ?? "").slice(0, 200)}` };
  } catch {
    return { ok: false, message: "Couldn't reach Cashfree from this server" };
  }
}

// ───── name match ─────
const norm = (v: string) =>
  v
    .toLowerCase()
    .replace(/\b(mr|mrs|ms|miss|dr|shri|smt|sri|kumari|km)\.?\b/g, " ")
    .replace(/[^a-z\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
/** 0–100: share of the account name's words found in the Aadhaar name (initials count). */
export function nameScore(account: string, aadhaar: string) {
  const a = norm(account);
  const b = norm(aadhaar);
  if (!a.length || !b.length) return 0;
  let hit = 0;
  for (const w of a) if (b.includes(w) || (w.length === 1 && b.some((x) => x[0] === w)) || b.some((x) => x.length === 1 && x === w[0])) hit++;
  // first name must match for a full score
  const firstOk = b.includes(a[0]) || (a[0].length === 1 && b[0][0] === a[0]) || (b[0].length === 1 && a[0][0] === b[0]);
  const score = Math.round((hit / a.length) * 100);
  return firstOk ? score : Math.min(score, 60);
}

// ───── flow ─────
/** Does this customer have to verify before this order? */
export async function kycNeededFor(userId: string, productTypes: string[]) {
  const s = await getKycSettings();
  if (!s.enabled) return false;
  const p = await prisma.clientProfile.findUnique({ where: { userId }, select: { kycStatus: true, kycExempt: true, kycRequired: true } });
  if (!p || p.kycExempt || p.kycStatus === "VERIFIED") return false;
  if (p.kycRequired) return true;
  if (s.require === "all_orders") return productTypes.length > 0;
  if (s.require === "servers") return productTypes.some((t) => SERVER_TYPES.includes(t));
  return false;
}

export async function startKyc(userId: string) {
  const s = await getKycSettings();
  if (!s.enabled) throw new HttpError(400, "Identity verification isn't available right now");
  const u = await prisma.user.findUniqueOrThrow({ where: { id: userId }, include: { profile: { select: { kycStatus: true, kycExempt: true } } } });
  if (u.type !== "CLIENT" || u.ownerResellerId) throw new HttpError(403, "Not available for this account");
  if (u.profile?.kycStatus === "VERIFIED") throw new HttpError(409, "Your identity is already verified");
  if (u.profile?.kycStatus === "REVIEW") throw new HttpError(409, "Your verification is with our team for review — we'll email you once it's done");
  const recent = await prisma.kycVerification.count({ where: { userId, createdAt: { gt: new Date(Date.now() - 3600_000) } } });
  if (recent >= 5) throw new HttpError(429, "Too many attempts — please try again in an hour", "TOO_MANY");
  const verificationId = `cc_${randomToken(10).replace(/[^a-zA-Z0-9]/g, "").slice(0, 16)}_${Date.now().toString(36)}`;
  const r = await cf<{ reference_id?: number; url: string; status: string }>(s, "POST", "/digilocker", {
    verification_id: verificationId,
    document_requested: ["AADHAAR"],
    redirect_url: `${config.appUrl}/client/kyc?vid=${verificationId}`,
    user_flow: "signup",
  });
  await prisma.kycVerification.create({ data: { userId, verificationId, referenceId: r.reference_id != null ? String(r.reference_id) : null, sandbox: s.sandbox } });
  await prisma.clientProfile.update({ where: { userId }, data: { kycStatus: "PENDING" } });
  return { url: r.url, verificationId };
}

const FINAL = ["VERIFIED", "REVIEW", "REJECTED", "EXPIRED", "CONSENT_DENIED", "FAILED"];

/** Ask Cashfree how the check went; on success fetch the Aadhaar and decide. Safe to call repeatedly. */
export async function refreshKyc(userId: string, verificationId: string) {
  const v = await prisma.kycVerification.findUnique({ where: { verificationId }, include: { user: { select: { firstName: true, lastName: true } } } });
  if (!v || v.userId !== userId) throw new HttpError(404, "Verification not found");
  if (FINAL.includes(v.status)) return v;
  const s = await getKycSettings();
  if (!s.clientId) throw new HttpError(400, "Identity verification isn't set up");
  const st = await cf<{ status: string }>(s, "GET", `/digilocker?verification_id=${encodeURIComponent(verificationId)}`);
  const status = String(st.status ?? "").toUpperCase();
  if (status === "PENDING") return v;
  if (status === "EXPIRED" || status === "CONSENT_DENIED") return finish(v.id, userId, { status, message: status === "EXPIRED" ? "The DigiLocker link expired" : "Consent to share Aadhaar was declined" });
  if (status !== "AUTHENTICATED") return finish(v.id, userId, { status: "FAILED", message: `DigiLocker status ${status || "unknown"}` });

  const d = await cf<any>(s, "GET", `/digilocker/document/AADHAAR?verification_id=${encodeURIComponent(verificationId)}`);
  if (String(d.status ?? "").toUpperCase() !== "SUCCESS" || !d.name) return finish(v.id, userId, { status: "FAILED", message: d.message ? String(d.message).slice(0, 200) : "Aadhaar not available in DigiLocker" });
  const uid = String(d.uid ?? "").replace(/\D/g, "");
  const account = `${v.user.firstName ?? ""} ${v.user.lastName ?? ""}`.trim();
  const score = nameScore(account, String(d.name));
  const ok = score >= 80;
  return finish(v.id, userId, {
    status: ok || s.onMismatch === "accept" ? "VERIFIED" : "REVIEW",
    message: ok ? "Name matches the account" : `Aadhaar name "${String(d.name).slice(0, 80)}" doesn't closely match the account name "${account}"`,
    nameOnAadhaar: String(d.name).slice(0, 120),
    dob: d.dob ? String(d.dob).slice(0, 20) : d.year_of_birth ? String(d.year_of_birth) : null,
    gender: d.gender ? String(d.gender).slice(0, 10) : null,
    state: d.split_address?.state ? String(d.split_address.state).slice(0, 60) : null,
    pincode: d.split_address?.pincode ? String(d.split_address.pincode).slice(0, 10) : null,
    aadhaarLast4: uid.length >= 4 ? uid.slice(-4) : null,
    nameScore: score,
  });
}

async function finish(id: string, userId: string, data: { status: string; message?: string; [k: string]: unknown }) {
  const v = await prisma.kycVerification.update({ where: { id }, data: { ...(data as object), completedAt: new Date() } as never, include: { user: { select: { firstName: true, lastName: true } } } });
  const profile =
    data.status === "VERIFIED" ? { kycStatus: "VERIFIED", kycVerifiedAt: new Date(), kycRequired: false }
    : data.status === "REVIEW" ? { kycStatus: "REVIEW" }
    : { kycStatus: "NONE" }; // expired / declined / failed: they can try again
  const cur = await prisma.clientProfile.findUnique({ where: { userId }, select: { kycStatus: true } });
  // a later failed attempt never undoes a verification
  if (cur?.kycStatus !== "VERIFIED") await prisma.clientProfile.update({ where: { userId }, data: profile });
  return v;
}

/** The customer's view: status, and whether they must verify. */
export async function kycSummary(userId: string) {
  const s = await getKycSettings();
  const p = await prisma.clientProfile.findUnique({ where: { userId }, select: { kycStatus: true, kycVerifiedAt: true, kycExempt: true, kycRequired: true } });
  const last = await prisma.kycVerification.findFirst({ where: { userId }, orderBy: { createdAt: "desc" }, select: { verificationId: true, status: true, aadhaarLast4: true, nameOnAadhaar: true, completedAt: true, createdAt: true } });
  return {
    enabled: s.enabled,
    status: p?.kycStatus ?? "NONE",
    verifiedAt: p?.kycVerifiedAt ?? null,
    exempt: !!p?.kycExempt,
    /** what must be verified before ordering */
    requiredFor: !s.enabled || p?.kycExempt ? "nothing" : p?.kycRequired ? "all_orders" : s.require === "optional" ? "nothing" : s.require,
    last: last ? { ...last, nameOnAadhaar: last.status === "VERIFIED" || last.status === "REVIEW" ? last.nameOnAadhaar : null } : null,
  };
}
