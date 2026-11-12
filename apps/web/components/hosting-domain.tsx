"use client";
/**
 * WHMCS-style "Choose a domain" step for hosting plans: register a new domain, transfer one in, or
 * use a domain the customer already owns (they point its nameservers to us).
 */
import { useEffect, useState } from "react";
import { api, money } from "@/lib/api";
import { pick } from "@/lib/currency";
import { Alert, Button, Icon, Input, Select, cx } from "@/components/ui";

export type DomainChoice = { name: string; action: "register" | "transfer" | "existing"; years: number; eppCode?: string };
type Mode = DomainChoice["action"];

const CLEAN = (v: string) => v.toLowerCase().trim().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/.*$/, "").replace(/\s+/g, "");
export const DOMAIN_OK = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/;
const tldOf = (d: string) => "." + d.split(".").slice(1).join(".");

/** Free domain offer text, e.g. "Free .com or .in with annual billing" */
export function freeDomainText(fd: any, cycleLabels: Record<string, string>) {
  if (!fd) return null;
  const tlds = fd.tlds?.length ? fd.tlds.slice(0, 4).join(" / ") : "domain";
  const WORD: Record<string, string> = { MONTHLY: "monthly", QUARTERLY: "quarterly", SEMIANNUAL: "6-monthly", ANNUAL: "annual", BIENNIAL: "2-year", TRIENNIAL: "3-year" };
  const cycles = fd.cycles?.length ? ` with ${fd.cycles.map((c: string) => WORD[c] ?? (cycleLabels[c] ?? c).toLowerCase()).join(" or ")} billing` : "";
  return `Free ${tlds}${cycles}${fd.type === "recurring" ? " — renews free while you keep the plan" : ""}`;
}
export function freeDomainApplies(fd: any, cycle: string, domain: string) {
  if (!fd || !domain) return false;
  if (fd.cycles?.length && !fd.cycles.includes(cycle)) return false;
  if (fd.tlds?.length && !fd.tlds.includes(tldOf(domain))) return false;
  return true;
}

export function HostingDomainStep({ product, currency, initial, onChoose, cycleLabels }: { product: any; currency: string; initial?: DomainChoice | null; onChoose: (c: DomainChoice) => void; cycleLabels: Record<string, string> }) {
  const [mode, setMode] = useState<Mode>(initial?.action ?? "register");
  // a name typed in one box carries over when switching ("taken — it's mine" / "transfer it")
  const [seed, setSeed] = useState<string>(initial?.name ?? "");
  const go = (m: Mode) => (name?: string) => { if (name) setSeed(name); setMode(m); };
  const [tlds, setTlds] = useState<any[]>([]);
  const cm = (v: number) => money(v, currency).replace(/\.00$/, "");
  const offer = freeDomainText(product.freeDomain, cycleLabels);

  useEffect(() => {
    api("/catalog/domains/pricing").then((r) => setTlds(r.tlds)).catch(() => setTlds([]));
  }, []);

  const opts: [Mode, string, string, string][] = [
    ["register", "travel_explore", "Register a new domain", "Search and register a domain with your hosting"],
    ["transfer", "swap_horiz", "Transfer your domain to us", "Move a domain from another registrar"],
    ["existing", "link", "I already have a domain", "Use it and update its nameservers"],
  ];
  return (
    <section className="rounded-2xl border border-line bg-white shadow-card">
      <header className="flex flex-wrap items-center gap-3 border-b border-line px-6 py-4">
        <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-gradient-to-br from-primary to-primary-dark text-sm font-extrabold text-white shadow-glow">1</span>
        <div className="min-w-0 flex-1">
          <h2 className="text-[15.5px] font-extrabold text-ink">Choose a domain</h2>
          <p className="text-[12.5px] text-mute">Your hosting account is created for this domain — it's the main website on the plan.</p>
        </div>
      </header>
      <div className="p-6">
        {offer && (
          <div className="mb-5 flex items-center gap-2.5 rounded-xl bg-gradient-to-r from-emerald-50 to-white px-4 py-3 text-[13.5px] font-bold text-emerald-800 ring-1 ring-emerald-200">
            <Icon name="redeem" className="text-[22px] text-emerald-600" />
            {offer}
          </div>
        )}
        <div role="radiogroup" className="grid gap-3 sm:grid-cols-3">
          {opts.map(([k, icon, title, sub]) => (
            <button key={k} type="button" role="radio" aria-checked={mode === k} onClick={() => setMode(k)} className={cx("flex items-start gap-3 rounded-xl border p-4 text-left transition", mode === k ? "border-primary bg-primary-tint ring-2 ring-primary/20" : "border-line bg-white hover:border-primary/40")}>
              <span className={cx("grid h-9 w-9 shrink-0 place-items-center rounded-lg", mode === k ? "bg-primary-dark text-white" : "bg-primary-soft text-primary-dark")}><Icon name={icon} className="text-[20px]" /></span>
              <span className="min-w-0">
                <span className="block text-[13.5px] font-extrabold leading-5 text-ink">{title}</span>
                <span className="block text-[12px] leading-4 text-mute">{sub}</span>
              </span>
            </button>
          ))}
        </div>
        <div className="mt-6">
          {mode === "register" && <RegisterBox key="r" tlds={tlds} product={product} currency={currency} cm={cm} initial={initial?.action === "register" ? initial : null} seed={seed} onChoose={onChoose} onTransfer={go("transfer")} onExisting={go("existing")} />}
          {mode === "transfer" && <TransferBox key="t" tlds={tlds} currency={currency} cm={cm} initial={initial?.action === "transfer" ? initial : null} seed={seed} onChoose={onChoose} onRegister={go("register")} />}
          {mode === "existing" && <ExistingBox key="e" initial={initial?.action === "existing" ? initial : null} seed={seed} onChoose={onChoose} />}
        </div>
      </div>
    </section>
  );
}

function YearsSelect({ value, onChange }: { value: number; onChange: (v: number) => void }) {
  return (
    <div className="w-[124px] shrink-0">
      <Select value={value} onChange={(e) => onChange(Number(e.target.value))} className="h-10" aria-label="Registration period">
        {[1, 2, 3, 5].map((y) => <option key={y} value={y}>{y} year{y > 1 ? "s" : ""}</option>)}
      </Select>
    </div>
  );
}

function SearchRow({ sld, setSld, tld, setTld, tlds, busy, onSubmit, cta }: { sld: string; setSld: (v: string) => void; tld: string; setTld: (v: string) => void; tlds: any[]; busy: boolean; onSubmit: () => void; cta: string }) {
  return (
    <form onSubmit={(e) => { e.preventDefault(); onSubmit(); }} className="flex flex-col gap-2 sm:flex-row">
      <div className="relative flex min-w-0 flex-1 items-center rounded-xl border border-line bg-white focus-within:border-primary focus-within:ring-2 focus-within:ring-primary/20">
        <span className="pl-3.5 text-[15px] font-semibold text-mute">www.</span>
        <input
          value={sld}
          onChange={(e) => {
            const v = CLEAN(e.target.value);
            // typing "name.com" picks the TLD for them
            const dot = v.indexOf(".");
            if (dot > 0 && tlds.some((t) => t.tld === v.slice(dot))) { setSld(v.slice(0, dot)); setTld(v.slice(dot)); } else setSld(v.replace(/[^a-z0-9-]/g, ""));
          }}
          placeholder="yourbusiness"
          className="h-12 min-w-0 flex-1 bg-transparent px-1 text-[16px] font-semibold text-ink outline-none placeholder:font-normal placeholder:text-slate-400"
          autoFocus
          aria-label="Domain name"
        />
        <select value={tld} onChange={(e) => setTld(e.target.value)} className="h-12 shrink-0 rounded-r-xl border-l border-line bg-[#faf7ff] px-3 text-[15px] font-bold text-primary-dark outline-none" aria-label="Extension">
          {tlds.map((t) => <option key={t.tld} value={t.tld}>{t.tld}</option>)}
        </select>
      </div>
      <Button size="lg" className="h-12 shrink-0" icon="search" loading={busy} disabled={!sld}>{cta}</Button>
    </form>
  );
}

function RegisterBox({ tlds, product, currency, cm, initial, seed, onChoose, onTransfer, onExisting }: any) {
  const start: string = initial?.name ?? seed ?? "";
  const [sld, setSld] = useState(start.split(".")[0] ?? "");
  const [tld, setTld] = useState(start.includes(".") ? tldOf(start) : "");
  const [years, setYears] = useState(initial?.years ?? 1);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [res, setRes] = useState<any>(null);
  useEffect(() => {
    if (!tld && tlds.length) setTld((tlds.find((t: any) => t.tld === ".com") ?? tlds[0]).tld);
  }, [tlds, tld]);

  async function search() {
    setBusy(true);
    setErr(null);
    try {
      setRes(await api(`/catalog/domains/search?name=${encodeURIComponent(`${sld}${tld}`)}`));
    } catch (e: any) {
      setErr(e.message);
      setRes(null);
    } finally {
      setBusy(false);
    }
  }
  // coming back to change the domain: show the earlier search again
  useEffect(() => {
    if (start && tld && sld && !res && !busy) search();
  }, [tld]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!tlds.length) return <Alert tone="warn">Domain registration isn't available right now — choose “I already have a domain”.</Alert>;
  const r = res?.result;
  const free = (name: string) => product.freeDomain && (!product.freeDomain.tlds?.length || product.freeDomain.tlds.includes(tldOf(name)));
  const price = (x: any) => pick(x.prices?.register, currency, x.pricing?.register);
  return (
    <div>
      <SearchRow sld={sld} setSld={setSld} tld={tld} setTld={setTld} tlds={tlds} busy={busy} onSubmit={search} cta="Check" />
      {err && <Alert tone="error" className="mt-3">{err}</Alert>}
      {r && (
        <div className={cx("mt-4 rounded-xl p-4 ring-1", r.available === false ? "bg-rose-50/60 ring-rose-200" : r.available ? "bg-emerald-50/60 ring-emerald-200" : "bg-amber-50/60 ring-amber-200")}>
          <div className="flex flex-wrap items-center gap-3">
            <Icon name={r.available === false ? "cancel" : r.available ? "check_circle" : "help"} className={cx("text-[30px]", r.available === false ? "text-rose-500" : r.available ? "text-emerald-600" : "text-amber-500")} />
            <div className="min-w-0 flex-1">
              <div className="break-all text-lg font-extrabold text-ink">{r.name}</div>
              <div className="text-[13px] text-slate-600">
                {r.available === false ? "is already registered." : r.available ? "is available!" : "We couldn't confirm availability right now — we'll check it when we register it."}
              </div>
            </div>
            {r.available !== false && r.pricing && (
              <div className="flex w-full flex-wrap items-center justify-end gap-3 sm:w-auto sm:flex-nowrap">
                <div className="mr-auto text-left sm:mr-0 sm:text-right">
                  {free(r.name) ? (
                    <><div className="text-lg font-extrabold text-emerald-700">FREE*</div><div className="text-[11px] text-mute">{cm(price(r))}/yr otherwise</div></>
                  ) : (
                    <><div className="text-lg font-extrabold text-ink">{cm(price(r) * years)}</div><div className="text-[11px] text-mute">renews {cm(pick(r.prices?.renew, currency, r.pricing.renew))}/yr</div></>
                  )}
                </div>
                <YearsSelect value={years} onChange={setYears} />
                <Button icon="arrow_forward" onClick={() => onChoose({ name: r.name, action: "register", years })}>Continue</Button>
              </div>
            )}
          </div>
          {r.available === false && (
            <div className="mt-3 flex flex-wrap gap-2 border-t border-rose-200/70 pt-3">
              <Button size="sm" variant="secondary" icon="link" onClick={() => onExisting(r.name)}>It's mine — use it with this hosting</Button>
              <Button size="sm" variant="ghost" icon="swap_horiz" onClick={() => onTransfer(r.name)}>Transfer it to us</Button>
            </div>
          )}
          {!r.pricing && <p className="mt-2 text-[13px] text-amber-700">We don't sell {r.tld} domains — pick another extension, or use a domain you already own.</p>}
        </div>
      )}
      {res?.suggestions?.length > 0 && (
        <div className="mt-4">
          <div className="mb-2 text-[12px] font-bold uppercase tracking-wider text-mute">Other extensions</div>
          <ul className="divide-y divide-line overflow-hidden rounded-xl ring-1 ring-line">
            {res.suggestions.map((s: any) => (
              <li key={s.name} className="flex items-center gap-3 bg-white px-4 py-2.5">
                <Icon name={s.available ? "check_circle" : "help"} className={cx("text-[20px]", s.available ? "text-emerald-600" : "text-amber-500")} />
                <span className="min-w-0 flex-1 truncate font-bold text-ink">{s.name}</span>
                {free(s.name) ? <span className="text-[13px] font-extrabold text-emerald-700">FREE*</span> : <span className="text-[13px] font-bold text-slate-700">{cm(price(s))}<span className="font-normal text-mute">/yr</span></span>}
                <Button size="sm" variant="outline" onClick={() => onChoose({ name: s.name, action: "register", years: 1 })}>Select</Button>
              </li>
            ))}
          </ul>
        </div>
      )}
      {product.freeDomain && r && <p className="mt-3 text-[11.5px] text-mute">* Free for the first year when you choose a qualifying billing cycle — the order summary shows the final price.</p>}
    </div>
  );
}

function TransferBox({ tlds, currency, cm, initial, seed, onChoose, onRegister }: any) {
  const [name, setName] = useState(initial?.name ?? (seed?.includes(".") ? seed : ""));
  const [epp, setEpp] = useState(initial?.eppCode ?? "");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [res, setRes] = useState<any>(null);
  async function check() {
    const n = CLEAN(name);
    if (!DOMAIN_OK.test(n)) return setErr("Enter the full domain, like yourbusiness.com");
    setBusy(true);
    setErr(null);
    try {
      setRes(await api(`/catalog/domains/check?name=${encodeURIComponent(n)}`));
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div>
      <form onSubmit={(e) => { e.preventDefault(); check(); }} className="flex flex-col gap-2 sm:flex-row">
        <div className="relative min-w-0 flex-1">
          <Icon name="language" className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-[20px] text-mute" />
          <Input className="h-12 pl-11 text-[16px] font-semibold" value={name} onChange={(e) => { setName(CLEAN(e.target.value)); setRes(null); }} placeholder="yourbusiness.com" aria-label="Domain to transfer" />
        </div>
        <Button size="lg" className="h-12 shrink-0" icon="search" loading={busy} disabled={!name}>Check</Button>
      </form>
      {err && <Alert tone="error" className="mt-3">{err}</Alert>}
      {res && !res.pricing && <Alert tone="warn" className="mt-3">We don't handle {res.tld} transfers — choose “I already have a domain” to use it with your hosting.</Alert>}
      {res?.pricing && res.available === true && (
        <Alert tone="warn" className="mt-3">
          <b>{res.name}</b> isn't registered yet, so it can't be transferred. <button className="font-bold underline" onClick={() => onRegister(res.name)}>Register it instead</button>
        </Alert>
      )}
      {res?.pricing && res.available !== true && (
        <div className="mt-4 rounded-xl bg-[#faf7ff] p-4 ring-1 ring-[#ede4ff]">
          <div className="flex flex-wrap items-end gap-3">
            <div className="min-w-0 flex-1">
              <div className="break-all text-lg font-extrabold text-ink">{res.name}</div>
              <div className="text-[13px] text-mute">Transfer includes 1 year renewal · {cm(pick(res.prices?.transfer, currency, res.pricing.transfer))}</div>
            </div>
          </div>
          <div className="mt-3 grid gap-2 sm:grid-cols-[1fr_auto]">
            <Input value={epp} onChange={(e) => setEpp(e.target.value.trim())} placeholder="EPP / authorisation code (you can add it later)" aria-label="EPP code" />
            <Button icon="arrow_forward" onClick={() => onChoose({ name: res.name, action: "transfer", years: 1, eppCode: epp || undefined })}>Continue</Button>
          </div>
          <p className="mt-2 text-[12px] text-mute">Get the EPP code from your current registrar and unlock the domain. The transfer starts after payment.</p>
        </div>
      )}
      {!tlds.length && <p className="mt-3 text-[12px] text-mute">Domain transfers aren't available right now.</p>}
    </div>
  );
}

function ExistingBox({ initial, seed, onChoose }: any) {
  const [name, setName] = useState(initial?.name ?? (seed?.includes(".") ? seed : ""));
  const [err, setErr] = useState<string | null>(null);
  function go() {
    const n = CLEAN(name);
    if (!DOMAIN_OK.test(n)) return setErr("Enter the full domain, like yourbusiness.com");
    onChoose({ name: n, action: "existing", years: 0 });
  }
  return (
    <div>
      <form onSubmit={(e) => { e.preventDefault(); go(); }} className="flex flex-col gap-2 sm:flex-row">
        <div className="relative min-w-0 flex-1">
          <Icon name="language" className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-[20px] text-mute" />
          <Input className="h-12 pl-11 text-[16px] font-semibold" value={name} onChange={(e) => { setName(CLEAN(e.target.value)); setErr(null); }} placeholder="yourbusiness.com" aria-label="Your domain" autoFocus />
        </div>
        <Button size="lg" className="h-12 shrink-0" icon="arrow_forward" disabled={!name}>Use this domain</Button>
      </form>
      {err && <Alert tone="error" className="mt-3">{err}</Alert>}
      <p className="mt-3 flex items-start gap-1.5 text-[12.5px] text-mute"><Icon name="info" className="mt-px text-[16px]" />After setup, point the domain to our nameservers (they're in your welcome email). Nothing changes at your registrar until you do.</p>
    </div>
  );
}

/** The chosen domain, shown at the top of the configure step. */
export function DomainSummary({ choice, onChange, free, cm, price }: { choice: DomainChoice; onChange: () => void; free: boolean; cm: (v: number) => string; price: number | null }) {
  const label = choice.action === "register" ? `New registration · ${choice.years} year${choice.years > 1 ? "s" : ""}` : choice.action === "transfer" ? `Transfer to us${choice.eppCode ? "" : " · EPP code needed"}` : "Your existing domain — update its nameservers after setup";
  return (
    <section className="flex flex-wrap items-center gap-3 rounded-2xl border border-line bg-white px-6 py-4 shadow-card">
      <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-emerald-500 text-white"><Icon name="check" className="text-[18px]" /></span>
      <div className="min-w-0 flex-1 basis-[calc(100%-3rem)] sm:basis-auto">
        <div className="text-[11px] font-bold uppercase tracking-wider text-mute">Domain</div>
        <div className="break-all text-[16px] font-extrabold text-ink">{choice.name}</div>
        <div className="text-[12.5px] text-mute">{label}</div>
      </div>
      <div className="ml-11 flex flex-1 items-center justify-between gap-3 sm:ml-0 sm:flex-none">
        {choice.action !== "existing" && price != null ? (
          <div className="sm:text-right">
            {free ? <div className="text-[15px] font-extrabold text-emerald-700">FREE</div> : <div className="text-[15px] font-extrabold text-ink">{cm(price)}</div>}
            {free && <div className="text-[11px] text-mute">with this plan</div>}
          </div>
        ) : <span />}
        <Button size="sm" variant="outline" icon="edit" onClick={onChange}>Change</Button>
      </div>
    </section>
  );
}

