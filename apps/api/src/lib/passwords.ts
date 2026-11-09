import bcrypt from "bcryptjs";
import crypto from "crypto";
import { prisma } from "../db";
import { safeEqual } from "./crypto";

/**
 * Verifies a password against our bcrypt hashes and the formats WHMCS used, so migrated customers keep their
 * existing passwords:
 *   - $2y$… (PHP password_hash, WHMCS 5.3.9+) — identical to $2a$/$2b$
 *   - "md5hash:salt" (WHMCS ≤ 5.3: md5(salt . password))
 *   - plain 32-char md5 (very old installs)
 * Legacy hashes are upgraded to bcrypt(12) on the first successful login.
 */
export async function verifyPassword(user: { id: string; passwordHash: string }, plain: string): Promise<boolean> {
  const h = user.passwordHash ?? "";
  if (/^\$2[aby]\$/.test(h)) {
    const ok = await bcrypt.compare(plain, h.replace(/^\$2y\$/, "$2a$"));
    if (ok && h.startsWith("$2y$")) await upgrade(user.id, plain);
    return ok;
  }
  const md5 = (s: string) => crypto.createHash("md5").update(s).digest("hex");
  let ok = false;
  const salted = h.match(/^([a-f0-9]{32}):(.+)$/i);
  if (salted) ok = safeEqual(md5(salted[2] + plain), salted[1].toLowerCase());
  else if (/^[a-f0-9]{32}$/i.test(h)) ok = safeEqual(md5(plain), h.toLowerCase());
  if (ok) await upgrade(user.id, plain);
  return ok;
}

async function upgrade(userId: string, plain: string) {
  await prisma.user.update({ where: { id: userId }, data: { passwordHash: await bcrypt.hash(plain, 12) } }).catch(() => undefined);
}
