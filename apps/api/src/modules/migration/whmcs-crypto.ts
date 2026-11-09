/**
 * Port of WHMCS's legacy encrypt()/decrypt() (used for tblhosting.password, tblservers.password, …),
 * keyed with $cc_encryption_hash from the WHMCS configuration.php.
 *
 *   key       = md5(md5(hash)) . md5(hash)
 *   hash_key  = raw sha1(key)                      (20 bytes)
 *   payload   = base64( (iv XOR hash_key) . ciphertext )
 *   the keystream starts as iv and is re-hashed every 20 bytes with the previous plaintext block.
 */
import crypto from "crypto";

const md5hex = (s: Buffer | string) => crypto.createHash("md5").update(s).digest("hex");
const rawHash = (b: Buffer) => crypto.createHash("sha1").update(b).digest();

function hashKey(ccHash: string) {
  return rawHash(Buffer.from(md5hex(md5hex(ccHash)) + md5hex(ccHash), "latin1"));
}

export function whmcsDecrypt(payload: string | null | undefined, ccHash: string): string | null {
  if (!payload || !ccHash) return null;
  const data = Buffer.from(payload, "base64");
  const hk = hashKey(ccHash);
  const L = hk.length;
  if (data.length <= L) return null;
  const iv = Buffer.alloc(L);
  for (let i = 0; i < L; i++) iv[i] = data[i] ^ hk[i];
  const body = data.subarray(L);
  const out = Buffer.alloc(body.length);
  let key = iv;
  for (let c = 0; c < body.length; c++) {
    if (c !== 0 && c % L === 0) key = rawHash(Buffer.concat([key, out.subarray(c - L, c)]));
    out[c] = key[c % L] ^ body[c];
  }
  const text = out.toString("latin1");
  // reject garbage (wrong cc_encryption_hash / not an encrypted value)
  if (!/^[\x20-\x7e]*$/.test(text)) return null;
  return Buffer.from(text, "latin1").toString("utf8");
}

/** Used by tests (and for parity checks) — identical to WHMCS encrypt() with a supplied IV. */
export function whmcsEncrypt(plain: string, ccHash: string, iv = crypto.randomBytes(20)): string {
  const hk = hashKey(ccHash);
  const L = hk.length;
  const head = Buffer.alloc(L);
  for (let i = 0; i < L; i++) head[i] = iv[i] ^ hk[i];
  const src = Buffer.from(plain, "latin1");
  const out = Buffer.alloc(src.length);
  let key: Buffer = iv;
  for (let c = 0; c < src.length; c++) {
    if (c !== 0 && c % L === 0) key = rawHash(Buffer.concat([key, src.subarray(c - L, c)]));
    out[c] = key[c % L] ^ src[c];
  }
  return Buffer.concat([head, out]).toString("base64");
}
