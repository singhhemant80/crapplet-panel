/**
 * Browser-side clean-up before staff-written HTML is put into the page (the campaign editor):
 * no <script>/<iframe>/<object>/<embed>/<form>/…, no on…= handlers, no javascript: links.
 * DOMParser never runs scripts, so parsing is safe.
 */
const DROP = "script,iframe,object,embed,applet,frame,frameset,noscript,template,base,link,meta,form,input,button,textarea,select";
const URL_ATTRS = ["href", "src", "action", "formaction", "xlink:href", "background", "poster"];

export function cleanHtml(html: string): string {
  if (typeof window === "undefined" || !html) return html ?? "";
  const doc = new DOMParser().parseFromString(`<body>${html}</body>`, "text/html");
  doc.querySelectorAll(DROP).forEach((n) => n.remove());
  doc.body.querySelectorAll("*").forEach((el) => {
    for (const a of Array.from(el.attributes)) {
      const name = a.name.toLowerCase();
      const v = a.value.replace(/[\s\u0000-\u001f]+/g, "").toLowerCase();
      if (name.startsWith("on")) el.removeAttribute(a.name);
      else if (URL_ATTRS.includes(name) && /^(javascript|vbscript|data:text\/html)/.test(v)) el.setAttribute(a.name, "#");
      else if (name === "style" && /(javascript|vbscript|expression\()/i.test(v)) el.removeAttribute(a.name);
    }
  });
  return doc.body.innerHTML;
}
