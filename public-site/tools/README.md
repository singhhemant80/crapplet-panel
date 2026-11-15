# Website build tools

The website pages are plain HTML. Two things are pre-built so pages load fast:

| What | File | Rebuild when |
|---|---|---|
| Tailwind CSS for each page | `css/<page>.css` | you add or change Tailwind classes in a page |
| Icon font (only the icons we use) | `fonts/material-symbols-outlined-subset.woff2` | you add a new Material Symbols icon |

```bash
cd public-site/tools
npm install
npm run build-css                     # all pages; updates each page's ?v= link
pip install fonttools brotli beautifulsoup4 lxml
npm pack material-symbols && tar xzf material-symbols-*.tgz
python3 build-icons.py package/material-symbols-outlined.woff2
```

A page's Tailwind settings (colours, fonts) live in its `<script type="application/json" id="tailwind-config">`.
New page: copy an existing page's `<head>`, then run `npm run build-css`.
