import crypto from "crypto";
import { config } from "../config";

function key(): Buffer {
  const k = config.encryptionKey;
  const buf = /^[0-9a-f]{64}$/i.test(k) ? Buffer.from(k, "hex") : Buffer.from(k, "base64");
  if (buf.length !== 32) throw new Error("APP_ENCRYPTION_KEY must be 32 bytes (64 hex chars or base64)");
  return buf;
}

/** AES-256-GCM. Output: v1.<iv>.<tag>.<ciphertext> (base64url). */
export function encrypt(plain: string): string {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", key(), iv);
  const enc = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return ["v1", iv.toString("base64url"), c.getAuthTag().toString("base64url"), enc.toString("base64url")].join(".");
}

export function decrypt(blob: string | null | undefined): string {
  if (!blob) return "";
  const [v, iv, tag, data] = blob.split(".");
  if (v !== "v1") throw new Error("Unsupported ciphertext version");
  const d = crypto.createDecipheriv("aes-256-gcm", key(), Buffer.from(iv, "base64url"));
  d.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([d.update(Buffer.from(data, "base64url")), d.final()]).toString("utf8");
}

export function encryptJson(obj: unknown): string {
  return encrypt(JSON.stringify(obj ?? {}));
}
export function decryptJson<T = Record<string, string>>(blob: string | null | undefined): T {
  if (!blob) return {} as T;
  return JSON.parse(decrypt(blob)) as T;
}

export const sha256 = (s: string | Buffer) => crypto.createHash("sha256").update(s).digest("hex");
export const hmacHex = (algo: string, secret: string, data: string | Buffer) => crypto.createHmac(algo, secret).update(data).digest("hex");
export const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString("base64url");

/** Constant-time comparison of two strings. */
export function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

/** Strong random password for VPS root accounts. */
export function generatePassword(len = 16): string {
  const sets = ["ABCDEFGHJKLMNPQRSTUVWXYZ", "abcdefghijkmnpqrstuvwxyz", "23456789", "@#%+=_"];
  const all = sets.join("");
  const chars = sets.map((s) => s[crypto.randomInt(s.length)]);
  while (chars.length < len) chars.push(all[crypto.randomInt(all.length)]);
  for (let i = chars.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join("");
}
