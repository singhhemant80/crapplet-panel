// Builds the Tailwind CSS for every website page, so visitors don't download and run Tailwind in the browser.
//
//   cd public-site/tools && npm install && npm run build-css
//
// Each page keeps its Tailwind settings in <script type="application/json" id="tailwind-config"> (not executed)
// and links /css/<page>.css. Run this again after changing classes in a page. The first run also converts
// pages that still load https://cdn.tailwindcss.com.
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postcss from "postcss";
import tailwindcss from "tailwindcss";
import forms from "@tailwindcss/forms";
import containerQueries from "@tailwindcss/container-queries";
import cssnano from "cssnano";

const SITE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(SITE, "css");
fs.mkdirSync(OUT, { recursive: true });
// classes added by the shared scripts
// (every site script except the old browser build of Tailwind — plans.js builds the plan cards, header.js the menus …)
const SHARED = fs.readdirSync(SITE).filter((f) => f.endsWith(".js") && f !== "tailwind.js").map((f) => path.join(SITE, f));

const CDN = /<script\s+src="https:\/\/cdn\.tailwindcss\.com([^"]*)"\s*><\/script>\s*/i;
const INLINE_CFG = /<script(?:\s+id="tailwind-config")?\s*>\s*tailwind\.config\s*=\s*([\s\S]*?)<\/script>\s*/i;
const JSON_CFG = /<script type="application\/json" id="tailwind-config"(?: data-plugins="([^"]*)")?>([\s\S]*?)<\/script>/i;
const LINK = /<link rel="stylesheet" href="\/css\/[^"]+\.css(?:\?v=[a-f0-9]+)?" data-tailwind\/>\s*/i;

function migrate(html, file) {
  const cdn = html.match(CDN);
  if (!cdn) return html;
  const plugins = /plugins=([^"&]+)/.exec(cdn[1])?.[1] ?? "";
  let cfg = {};
  const inline = html.match(INLINE_CFG);
  if (inline) {
    const src = inline[1].trim().replace(/;\s*$/, "");
    cfg = new Function(`return (${src});`)();
    if (JSON.stringify(cfg).includes("function")) throw new Error(`${file}: config has functions`);
  }
  html = html.replace(CDN, "");
  if (inline) html = html.replace(INLINE_CFG, "");
  const tag = `<script type="application/json" id="tailwind-config"${plugins ? ` data-plugins="${plugins}"` : ""}>${JSON.stringify(cfg)}</script>\n`;
  return html.replace(/<\/head>/i, `${tag}</head>`);
}

let built = 0;
for (const name of fs.readdirSync(SITE).filter((f) => f.endsWith(".html")).sort()) {
  const file = path.join(SITE, name);
  let html = fs.readFileSync(file, "utf8");
  const before = html;
  html = migrate(html, name);
  const m = html.match(JSON_CFG);
  if (!m) continue;
  const plugins = (m[1] ?? "").split(",").filter(Boolean);
  const user = JSON.parse(m[2]);
  const config = {
    ...user,
    content: [{ raw: html, extension: "html" }, ...SHARED],
    plugins: [...(plugins.includes("forms") ? [forms] : []), ...(plugins.includes("container-queries") ? [containerQueries] : [])],
  };
  const result = await postcss([tailwindcss(config), cssnano({ preset: "default" })]).process("@tailwind base;\n@tailwind components;\n@tailwind utilities;\n", { from: undefined });
  const slug = name.replace(/\.html$/, "");
  fs.writeFileSync(path.join(OUT, `${slug}.css`), result.css);
  const v = createHash("sha1").update(result.css).digest("hex").slice(0, 8);
  const link = `<link rel="stylesheet" href="/css/${slug}.css?v=${v}" data-tailwind/>\n`;
  const INLINE = new RegExp(`<style data-tailwind="${slug}">[\\s\\S]*?</style>`);
  // pages inline their CSS (fewer round trips on mobile); otherwise it's linked last in <head>,
  // where the browser build of Tailwind used to put its styles (same cascade order)
  if (INLINE.test(html)) html = html.replace(INLINE, () => `<style data-tailwind="${slug}">${result.css}</style>`);
  else html = LINK.test(html) ? html.replace(LINK, link) : html.replace(/<\/head>/i, `${link}</head>`);
  if (html !== before) fs.writeFileSync(file, html);
  built++;
  console.log(`${name.padEnd(30)} ${(result.css.length / 1024).toFixed(1).padStart(6)} KB`);
}
console.log(`built ${built} page stylesheets`);
