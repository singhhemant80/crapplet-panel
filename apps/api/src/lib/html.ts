/**
 * Removes anything that can run code from HTML written in the panel (campaign emails, email templates):
 * <script>/<iframe>/<object>/<embed>/<form>/<base>/<link>/<meta> elements, on…= event attributes and
 * javascript:/vbscript:/data:text/html links. Layout and inline styles are left alone — emails need them.
 * Used where staff HTML is stored, so a draft can't carry a script into another admin's browser.
 */
const BLOCK = ["script", "iframe", "object", "embed", "applet", "frameset", "frame", "noscript", "template"];
const VOID = ["base", "link", "meta", "form", "input", "button", "textarea", "select"];

export function stripActiveHtml(html: string): string {
  let s = String(html ?? "");
  for (let i = 0; i < 3; i++) {
    const before = s;
    for (const t of BLOCK) s = s.replace(new RegExp(`<${t}\\b[\\s\\S]*?<\\/${t}\\s*>`, "gi"), "").replace(new RegExp(`<\\/?${t}\\b[^>]*>`, "gi"), "");
    for (const t of VOID) s = s.replace(new RegExp(`<\\/?${t}\\b[^>]*>`, "gi"), "");
    s = s.replace(/[\s/"']on[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, (m) => (/^[\s/"']/.test(m) ? m[0] === "/" || m[0] === "\"" || m[0] === "'" ? m[0] : " " : ""));
    s = s.replace(/\b(href|src|action|formaction|xlink:href|background|poster)\s*=\s*(["']?)\s*(?:javascript|vbscript|data\s*:\s*text\/html)[^"'\s>]*\2/gi, '$1="#"');
    s = s.replace(/(["'(;:\s])\s*(?:javascript|vbscript):/gi, "$1");
    if (s === before) break;
  }
  return s;
}
