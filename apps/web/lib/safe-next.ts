/** A ?next= target only if it's a page on this site — never another site (open redirect) or a javascript: URL. */
export function safeNext(v: string | null | undefined, fallback: string): string {
  if (!v || typeof v !== "string") return fallback;
  if (!v.startsWith("/") || v.startsWith("//") || v.startsWith("/\\") || /[\u0000-\u001f]/.test(v)) return fallback;
  try {
    const u = new URL(v, "http://x");
    if (u.origin !== "http://x") return fallback;
    return u.pathname + u.search + u.hash;
  } catch {
    return fallback;
  }
}
