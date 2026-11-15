"""Rebuild fonts/material-symbols-outlined-subset.woff2 with only the icons the website uses.

    pip install fonttools brotli beautifulsoup4 lxml
    python3 build-icons.py /path/to/material-symbols-outlined.woff2   # full font (npm package "material-symbols")

Run it after adding a new icon to any page (an icon that isn't in the subset shows as its name).
"""
import glob, os, re, sys
from bs4 import BeautifulSoup
from fontTools import subset
from fontTools.ttLib import TTFont

SITE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
full = sys.argv[1]
names = set()
# every page and every site script (plans.js builds the plan cards with icons like 'swap_vert')
for f in glob.glob(os.path.join(SITE, "*.html")) + [x for x in glob.glob(os.path.join(SITE, "*.js")) if not x.endswith("tailwind.js")]:
    if not os.path.exists(f):
        continue
    t = open(f, encoding="utf-8").read()
    if f.endswith(".html"):
        s = BeautifulSoup(t, "lxml")
        for el in s.select(".material-symbols-outlined, .ms"):
            w = el.get_text(strip=True)
            if re.fullmatch(r"[a-z0-9_]+", w or ""):
                names.add(w)
        t = " ".join(x.get_text() for x in s.find_all("script") if not x.get("type") or "javascript" in x.get("type", ""))
    # icon names that scripts switch in (e.g. 'add' ↔ 'remove'); unknown words are simply ignored below
    names.update(re.findall(r"[\"'`>]([a-z][a-z0-9_]{1,40})[\"'`<]", t))

font = TTFont(full)
cmap = font.getBestCmap()
ligs = {}
for lookup in font["GSUB"].table.LookupList.Lookup:
    for st in lookup.SubTable:
        if st.LookupType == 7:
            st = st.ExtSubTable
        if getattr(st, "LookupType", None) == 4:
            for first, lst in st.ligatures.items():
                for lg in lst:
                    ligs[tuple([first] + list(lg.Component))] = lg.LigGlyph
g = lambda ch: cmap.get(ord(ch))
keep = {ligs[tuple(g(c) for c in n)] for n in names if tuple(g(c) for c in n) in ligs}
letters = {g(c) for c in "abcdefghijklmnopqrstuvwxyz0123456789_" if g(c)}
o = subset.Options()
o.layout_closure = False
o.flavor = "woff2"
o.layout_features = ["liga", "rlig", "calt", "ccmp"]
o.name_IDs = ["*"]
o.notdef_outline = True
sub = subset.Subsetter(o)
sub.populate(glyphs=list(keep | letters | {".notdef"}))
sub.subset(font)
font.flavor = "woff2"
out = os.path.join(SITE, "fonts", "material-symbols-outlined-subset.woff2")
font.save(out)
print(f"{len(keep)} icons → {out} ({os.path.getsize(out) // 1024} KB)")

# point every page at the new file (?v=… so browsers don't keep a cached older subset)
import hashlib
v = hashlib.sha1(open(out, "rb").read()).hexdigest()[:8]
pat = re.compile(r"/fonts/material-symbols-outlined-subset\.woff2(\?v=[a-f0-9]+)?")
for f in glob.glob(os.path.join(SITE, "*.html")):
    t = open(f, encoding="utf-8").read()
    n = pat.sub(f"/fonts/material-symbols-outlined-subset.woff2?v={v}", t)
    if n != t:
        open(f, "w", encoding="utf-8").write(n)
print(f"pages now load ?v={v}")
