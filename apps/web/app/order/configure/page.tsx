"use client";
import { Suspense, useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { api, CYCLES, CYCLE_MONTHS, gb, money } from "@/lib/api";
import { useSession } from "@/lib/session";
import { readCart, writeCart, type CartItem } from "@/lib/cart";
import { Alert, Button, Field, Icon, Input, Loading, Select, Spinner, cx, toast, useApi } from "@/components/ui";
import { OrderSteps } from "@/components/order-steps";
import { OsChooser } from "@/components/os-chooser";
import { CurrencySwitch, pick, priceRow, rowsIn, useCurrency } from "@/lib/currency";
import { DomainSummary, HostingDomainStep, freeDomainApplies, freeDomainText, DOMAIN_OK, type DomainChoice } from "@/components/hosting-domain";

/** WHMCS link names for billing cycles (cart.php?...&billingcycle=annually) */
const WHMCS_CYCLE: Record<string, string> = { monthly: "MONTHLY", quarterly: "QUARTERLY", semiannually: "SEMIANNUAL", annually: "ANNUAL", biennially: "BIENNIAL", triennially: "TRIENNIAL", onetime: "ONETIME" };

/** A numbered configuration step. */
function Step({ n, title, sub, action, children }: { n?: number; title: string; sub?: string; action?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="rounded-2xl border border-line bg-white shadow-card">
      <header className="flex flex-wrap items-center gap-3 border-b border-line px-6 py-4">
        {n != null && <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-gradient-to-br from-primary to-primary-dark text-sm font-extrabold text-white shadow-glow">{n}</span>}
        <div className="min-w-0 flex-1"><h2 className="text-[15.5px] font-extrabold text-ink">{title}</h2>{sub && <p className="text-[12.5px] text-mute">{sub}</p>}</div>
        {action}
      </header>
      <div className="p-6">{children}</div>
    </section>
  );
}

function useCountdown(until?: string | null) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!until) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [until]);
  if (!until) return null;
  const s = Math.max(0, Math.floor((new Date(until).getTime() - now) / 1000));
  const c = Math.min(s, 15 * 60);
  return { s, label: `${Math.floor(c / 60)}:${String(c % 60).padStart(2, "0")}` };
}

/** Pre-select the newest Ubuntu (most popular), else the first Linux image. */
function defaultOs(list: any[]): string {
  const ubuntu = list.filter((o) => /ubuntu/i.test(o.distro ?? o.name)).sort((a, b) => b.name.localeCompare(a.name, undefined, { numeric: true }));
  return (ubuntu[0] ?? list.find((o) => o.family !== "windows") ?? list[0]).id;
}

function Configure() {
  const sp = useSearchParams();
  const router = useRouter();
  const { me } = useSession();
  const { currency } = useCurrency();
  const cm = (v: number | null | undefined) => money(v, currency);
  const key = sp.get("product") ?? sp.get("pid") ?? "";
  const { data, loading, error } = useApi(key ? `/catalog/products/${key}` : null, [key]);
  const p = data?.product;
  const locs = useApi(p?.isVps ? `/catalog/products/${p.slug}/locations` : null, [p?.slug]);

  const [cycle, setCycle] = useState(WHMCS_CYCLE[(sp.get("billingcycle") ?? "").toLowerCase()] ?? ((sp.get("cycle") ?? "").toUpperCase() || "MONTHLY"));
  // hosting: the domain chosen in the first step (kept per plan so "back" / sign-in doesn't lose it)
  const [dom, setDom] = useState<DomainChoice | null>(null);
  const [pickingDomain, setPickingDomain] = useState(false);
  const tldPrices = useApi(p?.isHosting && dom && dom.action !== "existing" ? "/catalog/domains/pricing" : null, [p?.isHosting, dom?.action]);
  const [serverId, setServerId] = useState<string>("");
  const [os, setOs] = useState("");
  const [hostname, setHostname] = useState("");
  const [cfg, setCfg] = useState<Record<string, any>>({});
  const [addons, setAddons] = useState<string[]>([]);
  const [ips, setIps] = useState<any[]>([]);
  const [ipsLoading, setIpsLoading] = useState(false);
  const [search, setSearch] = useState("");
  const [reservation, setReservation] = useState<{ ipId: string; address: string; expiresAt: string } | null>(null);
  const [reserving, setReserving] = useState<string | null>(null);
  const countdown = useCountdown(reservation?.expiresAt);

  // restore an in-progress reservation for this product (e.g. after signing in)
  useEffect(() => {
    if (!p) return;
    const rows = rowsIn(p.pricing, currency);
    if (rows.length && !rows.some((x: any) => x.cycle === cycle)) setCycle(rows[0].cycle);
    if (p.isHosting && !dom) {
      // WHMCS-style links: ?sld=name&tld=.com&domainoption=register|transfer|owndomain, or ?domain=example.com
      const sld = sp.get("sld"), tld = sp.get("tld"), q = (sp.get("domain") ?? sp.get("query") ?? "").toLowerCase();
      const name = sld && tld ? `${sld}${tld.startsWith(".") ? tld : `.${tld}`}`.toLowerCase() : DOMAIN_OK.test(q) ? q : "";
      const opt = (sp.get("domainoption") ?? "").toLowerCase();
      let saved: DomainChoice | null = null;
      try { saved = JSON.parse(sessionStorage.getItem(`cc_dom_${p.slug}`) ?? "null"); } catch { /* ignore */ }
      if (name && (opt === "owndomain" || opt === "existing")) setDom({ name, action: "existing", years: 0 });
      else if (saved && !name) setDom(saved);
      else if (name) { setDom(null); setPickingDomain(true); sessionStorage.setItem(`cc_dom_seed_${p.slug}`, JSON.stringify({ name, action: opt === "transfer" ? "transfer" : "register", years: 1 })); }
    }
    if (p.osTemplates.length && !os) setOs(defaultOs(p.osTemplates));
    try {
      const pending = JSON.parse(sessionStorage.getItem(`cc_pick_${p.slug}`) ?? "null");
      if (pending && new Date(pending.expiresAt) > new Date()) {
        setReservation(pending);
        setServerId(pending.serverId ?? "");
      }
    } catch {
      /* ignore */
    }
  }, [p, currency]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (locs.data?.locations?.length && !serverId) setServerId(locs.data.locations[0].serverId);
  }, [locs.data, serverId]);

  useEffect(() => {
    if (!p?.allowIpSelection || !serverId) return;
    setIpsLoading(true);
    const t = setTimeout(() => {
      api(`/catalog/products/${p.slug}/ips?serverId=${serverId}${search ? `&search=${encodeURIComponent(search)}` : ""}`)
        .then((r) => setIps(r.ips))
        .catch(() => setIps([]))
        .finally(() => setIpsLoading(false));
    }, 250);
    return () => clearTimeout(t);
  }, [p?.slug, p?.allowIpSelection, serverId, search]);

  useEffect(() => {
    if (countdown && countdown.s === 0 && reservation) {
      toast.info(`Your hold on ${reservation.address} expired. Please pick an IP again.`);
      setReservation(null);
    }
  }, [countdown, reservation]);

  // templates synced from a specific Virtualizor master only install there
  const osOptions = (p?.osTemplates ?? []).filter((o: any) => !o.serverId || !serverId || o.serverId === serverId);
  useEffect(() => {
    if (osOptions.length && !osOptions.some((o: any) => o.id === os)) setOs(defaultOs(osOptions));
  }, [serverId, p]); // eslint-disable-line react-hooks/exhaustive-deps
  const months = CYCLE_MONTHS[cycle] ?? 1;
  const price = p ? priceRow(p.pricing, cycle, currency) : undefined;
  const optionsMonthly = useMemo(() => {
    if (!p) return 0;
    let m = 0;
    for (const o of p.configOptions) {
      const v = cfg[o.key];
      const choice = o.type === "SELECT" ? o.choices.find((c: any) => c.value === v) : null;
      if (choice) m += pick(choice.prices, currency, choice.monthly);
      else if (o.type === "QUANTITY") m += (Number(v) || 0) * pick(o.unitPrices, currency, o.unitMonthly);
      else if (o.type === "YESNO" && v) m += pick(o.unitPrices, currency, o.unitMonthly);
    }
    for (const a of p.addons) if (addons.includes(a.id)) m += pick(a.prices?.monthly, currency, a.monthly);
    return m;
  }, [p, cfg, addons, currency]);
  const addonSetup = p ? p.addons.filter((a: any) => addons.includes(a.id)).reduce((t: number, a: any) => t + pick(a.prices?.setupFee, currency, a.setupFee), 0) : 0;

  const chooseDomain = (c: DomainChoice) => {
    setDom(c);
    setPickingDomain(false);
    try { sessionStorage.setItem(`cc_dom_${p.slug}`, JSON.stringify(c)); } catch { /* ignore */ }
    window.scrollTo({ top: 0, behavior: "smooth" });
  };
  // price of the chosen domain (first payment) and whether this plan + cycle makes it free
  const tldRow = dom && dom.action !== "existing" ? tldPrices.data?.tlds?.find((t: any) => t.tld === "." + dom.name.split(".").slice(1).join(".")) : null;
  const domainFree = !!(p?.freeDomain && dom && dom.action !== "existing" && freeDomainApplies(p.freeDomain, cycle, dom.name));
  const domainPrice = !tldRow || !dom ? null : dom.action === "transfer" ? pick(tldRow.prices?.transfer, currency, tldRow.transfer) : pick(tldRow.prices?.register, currency, tldRow.register) * dom.years;
  const domainCharge = domainPrice == null ? 0 : domainFree ? (dom!.action === "register" ? pick(tldRow.prices?.renew, currency, tldRow.renew) * (dom!.years - 1) : 0) : domainPrice;

  if (loading) return <Loading />;
  if (error || !p) return <div className="mx-auto max-w-3xl px-4 py-16"><Alert tone="error">This plan is not available. <a className="font-bold underline" href="/order">Browse plans</a></Alert></div>;

  const total = (price?.price ?? 0) + optionsMonthly * months + (price?.setupFee ?? 0) + addonSetup + (p.isHosting ? domainCharge : 0);

  async function pickIp(ip: any) {
    if (!me || me.type !== "CLIENT") {
      router.push(`/client/login?next=${encodeURIComponent(`/order/configure?product=${p.slug}`)}`);
      return;
    }
    setReserving(ip.id);
    try {
      if (reservation && reservation.ipId !== ip.id) await api(`/catalog/ips/${reservation.ipId}/reserve`, { method: "DELETE" }).catch(() => {});
      const r = await api(`/catalog/ips/${ip.id}/reserve`, { body: { productId: p.slug } });
      const res = { ...r.reservation, serverId };
      setReservation(res);
      sessionStorage.setItem(`cc_pick_${p.slug}`, JSON.stringify(res));
      toast.success(`${ip.address} is held for you for 15 minutes`);
    } catch (e: any) {
      toast.error(e.message);
      setIps((x) => x.filter((i) => i.id !== ip.id));
    } finally {
      setReserving(null);
    }
  }

  function addToCart() {
    if (p.isVps && p.osTemplates.length && !os) return toast.error("Choose an operating system");
    if (p.isHosting && !dom) { setPickingDomain(true); return toast.error("Choose a domain for your hosting first"); }
    if (!p.isHosting && p.requireHostname && !/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i.test(hostname)) return toast.error("Enter a valid hostname like server1.example.com");
    const loc = locs.data?.locations.find((l: any) => l.serverId === serverId);
    const key = `${p.id}-${Date.now()}`;
    const item: CartItem = {
      key,
      productId: p.slug,
      productName: p.name,
      cycle,
      osTemplateId: os || null,
      osName: p.osTemplates.find((o: any) => o.id === os)?.name,
      hostname: p.isHosting ? dom!.name : hostname || null,
      domainAction: p.isHosting ? dom!.action : undefined,
      serverId: serverId || null,
      location: loc?.name,
      ipId: reservation?.ipId ?? null,
      ipAddress: reservation?.address,
      ipExpiresAt: reservation?.expiresAt,
      config: cfg,
      addonIds: addons,
      quantity: 1,
    };
    const c = readCart();
    // a domain registered / transferred for this hosting goes in the cart with it (replacing any earlier copy)
    const domains = p.isHosting && dom && dom.action !== "existing" ? [...c.domains.filter((d) => d.name !== dom.name), { name: dom.name, action: dom.action, years: dom.years, eppCode: dom.eppCode, forItem: key }] : c.domains;
    writeCart({ ...c, items: [...c.items, item], domains });
    sessionStorage.removeItem(`cc_pick_${p.slug}`);
    sessionStorage.removeItem(`cc_dom_${p.slug}`);
    router.push("/order/cart");
  }

  const filtered = ips;
  // number the steps that are shown
  const order = [p.isHosting && "domain", "cycle", p.isVps && "location", p.allowIpSelection && serverId && "ip", !p.isHosting && (p.osTemplates.length > 0 || p.requireHostname) && "setup", (p.configOptions.length > 0 || p.addons.length > 0) && "extras"].filter(Boolean) as string[];
  const domainStep = p.isHosting && (!dom || pickingDomain);
  let seed: DomainChoice | null = dom;
  if (!seed) try { seed = JSON.parse(sessionStorage.getItem(`cc_dom_seed_${p.slug}`) ?? "null"); } catch { /* ignore */ }
  const num = (k: string) => order.indexOf(k) + 1;
  const loc = locs.data?.locations.find((l: any) => l.serverId === serverId);
  const osName = p.osTemplates.find((o: any) => o.id === os)?.name;
  const gst = currency === "INR" ? Math.round(total * 0.18) : 0;
  return (
    <div className="mx-auto max-w-[1280px] px-4 py-10 sm:px-6">
      <OrderSteps step={p.isHosting ? (domainStep ? 2 : 3) : 2} hosting={p.isHosting} />
      <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_360px]">
        <div className="min-w-0 space-y-6">
          <div className="rounded-2xl border border-line bg-white p-6 shadow-card">
            <a href={`/order${p.group?.slug ? `?group=${p.group.slug}` : ""}`} className="inline-flex items-center gap-1 text-[13px] font-bold text-primary-dark hover:underline"><Icon name="arrow_back" className="text-[16px]" />{p.group?.name ?? "All plans"}</a>
            <div className="mt-1 flex flex-wrap items-center justify-between gap-3">
              <h1 className="text-3xl font-extrabold tracking-tight text-ink">{p.name}</h1>
              <CurrencySwitch />
            </div>
            <p className="mt-1 text-mute">{p.tagline}</p>
            {p.isHosting && p.features?.length > 0 && (
              <ul className="mt-4 flex flex-wrap gap-2 text-[12.5px] font-semibold text-slate-700">
                {p.features.slice(0, 6).map((f: string) => <li key={f} className="inline-flex items-center gap-1.5 rounded-lg bg-[#faf7ff] px-2.5 py-1 ring-1 ring-[#ede4ff]"><Icon name="check" className="text-[16px] text-primary-dark" />{f}</li>)}
              </ul>
            )}
            {p.isVps && (
              <div className="mt-4 flex flex-wrap gap-2 text-sm font-semibold text-slate-700">
                {[["developer_board", `${p.specs.cpuCores} vCPU`], ["memory", gb(p.specs.ramMb)], ["database", `${p.specs.diskGb} GB SSD`], ["public", `${p.specs.ipv4Count} × IPv4`]].map(([i, t]) => (
                  <span key={t} className="inline-flex items-center gap-1.5 rounded-lg bg-[#faf7ff] px-3 py-1.5 ring-1 ring-[#ede4ff]"><Icon name={i} className="text-[18px] text-primary-dark" />{t}</span>
                ))}
              </div>
            )}
          </div>

          {domainStep ? (
            <HostingDomainStep product={p} currency={currency} initial={seed} onChoose={chooseDomain} cycleLabels={CYCLES} />
          ) : (
          <>
          {p.isHosting && dom && <DomainSummary choice={dom} onChange={() => setPickingDomain(true)} free={domainFree} cm={(v) => cm(v).replace(".00", "")} price={domainPrice} />}

          <Step n={num("cycle")} title="Billing cycle" sub={p.freeDomain && p.isHosting ? (freeDomainText(p.freeDomain, CYCLES) ?? undefined) : "Pay for longer and save — you can change it at renewal."}>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              {rowsIn(p.pricing, currency).map((x: any) => {
                const monthlyBase = priceRow(p.pricing, "MONTHLY", currency)?.price;
                const perMonth = x.price / (CYCLE_MONTHS[x.cycle] || 1);
                const save = monthlyBase && x.cycle !== "MONTHLY" ? Math.round((1 - perMonth / monthlyBase) * 100) : 0;
                return (
                  <button key={x.cycle} onClick={() => setCycle(x.cycle)} className={cx("rounded-xl border p-4 text-left transition", cycle === x.cycle ? "border-primary bg-primary-tint ring-2 ring-primary/20" : "border-line bg-white hover:border-primary/40")}>
                    <div className="text-sm font-bold text-ink">{CYCLES[x.cycle]}</div>
                    <div className="mt-1 text-lg font-extrabold text-ink">{cm(x.price).replace(".00", "")}</div>
                    <div className="text-xs text-mute">{cm(perMonth).replace(".00", "")}/mo{save > 0 && <span className="ml-1 font-bold text-emerald-600">save {save}%</span>}</div>
                  </button>
                );
              })}
            </div>
          </Step>

          {p.isVps && (
            <Step n={num("location")} title="Location" sub="Where your server will run.">
              {!locs.data ? <Loading /> : !locs.data.locations.length ? <Alert tone="warn">No locations available for this plan right now.</Alert> : (
                <div className="grid gap-3 sm:grid-cols-2">
                  {locs.data.locations.map((l: any) => (
                    <button key={l.serverId} onClick={() => { setServerId(l.serverId); if (reservation) { api(`/catalog/ips/${reservation.ipId}/reserve`, { method: "DELETE" }).catch(() => {}); setReservation(null); } }} className={cx("flex items-center gap-3 rounded-xl border p-4 text-left", serverId === l.serverId ? "border-primary bg-primary-tint ring-2 ring-primary/20" : "border-line bg-white")}>
                      <span className="text-2xl">{l.country === "IN" ? "🇮🇳" : "🌐"}</span>
                      <div><div className="font-bold text-ink">{l.name}</div><div className="text-xs text-mute">{l.freeIps} IPv4 addresses available</div></div>
                    </button>
                  ))}
                </div>
              )}
            </Step>
          )}

          {p.allowIpSelection && serverId && (
            <Step n={num("ip")} title="Choose your IPv4 address" sub="Optional — skip it and we'll assign one." action={reservation && countdown && <span className="inline-flex items-center gap-1.5 rounded-full bg-amber-50 px-3 py-1 text-xs font-extrabold text-amber-700 ring-1 ring-amber-200"><Icon name="timer" className="text-[16px]" />held {countdown.label}</span>}>
              {reservation ? (
                <div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-xl bg-gradient-to-r from-primary-soft to-white p-4 ring-1 ring-[#e9d5ff]">
                  <div className="flex items-center gap-3">
                    <span className="grid h-10 w-10 place-items-center rounded-xl bg-primary-dark text-white"><Icon name="lock" /></span>
                    <div><div className="font-mono text-lg font-extrabold text-ink">{reservation.address}</div><div className="text-xs text-mute">Reserved for you — complete payment within the hold time.</div></div>
                  </div>
                  <Button size="sm" variant="ghost" onClick={async () => { await api(`/catalog/ips/${reservation.ipId}/reserve`, { method: "DELETE" }).catch(() => {}); setReservation(null); sessionStorage.removeItem(`cc_pick_${p.slug}`); }}>Release</Button>
                </div>
              ) : (
                <p className="mb-4 text-sm text-mute">Pick any free address — it's held exclusively for you for 15 minutes while you check out. Or skip this and we'll assign one automatically.</p>
              )}
              <Input value={search} onChange={(e) => setSearch(e.target.value.replace(/[^0-9.]/g, ""))} placeholder="Search e.g. 203.0.113.4" className="mb-4" />
              {ipsLoading ? <div className="flex justify-center py-8"><Spinner className="h-6 w-6 text-primary-dark" /></div> : !filtered.length ? <p className="py-6 text-center text-sm text-mute">No free addresses match.</p> : (
                <div className="grid max-h-[300px] grid-cols-2 gap-2 overflow-y-auto pr-1 sm:grid-cols-3 md:grid-cols-4 xl:grid-cols-5">
                  {filtered.map((ip: any) => {
                    const mine = reservation?.ipId === ip.id;
                    return (
                      <button key={ip.id} disabled={!!reserving} onClick={() => !mine && pickIp(ip)} className={cx("flex items-center justify-center gap-1.5 rounded-lg border px-2 py-2 font-mono text-[12.5px] font-semibold transition", mine ? "border-primary-dark bg-primary-dark text-white" : "border-line bg-white text-slate-700 hover:border-primary hover:text-primary-dark")}>
                        {reserving === ip.id ? <Spinner className="h-3.5 w-3.5" /> : mine ? <Icon name="check" className="text-[16px]" /> : null}
                        {ip.address}
                      </button>
                    );
                  })}
                </div>
              )}
              {!me && <p className="mt-3 text-xs text-mute">You'll be asked to sign in or create an account to hold an IP.</p>}
            </Step>
          )}

          {!p.isHosting && (p.osTemplates.length > 0 || p.requireHostname) && (
            <Step n={num("setup")} title="Server setup" sub="Operating system and hostname — you can reinstall another OS later.">
              <div className="grid gap-4 sm:grid-cols-2">
                {p.osTemplates.length > 0 && (
                  <Field label="Operating system" className="sm:col-span-2">
                    <OsChooser options={osOptions} value={os} onChange={setOs} />
                  </Field>
                )}
                <Field label="Hostname" hint="e.g. server1.yourdomain.com" className="sm:col-span-2">
                  <Input value={hostname} onChange={(e) => setHostname(e.target.value.toLowerCase().trim())} placeholder="server1.example.com" />
                </Field>
              </div>
            </Step>
          )}

          {(p.configOptions.length > 0 || p.addons.length > 0) && (
            <Step n={num("extras")} title="Extras" sub="Optional upgrades, billed with your plan.">
              <div className="grid gap-4 sm:grid-cols-2">
                {p.configOptions.map((o: any) => (
                  <Field key={o.key} label={o.label}>
                    {o.type === "SELECT" ? (
                      <Select value={cfg[o.key] ?? ""} onChange={(e) => setCfg({ ...cfg, [o.key]: e.target.value })}>
                        <option value="">Default</option>
                        {o.choices.map((c: any) => <option key={c.value} value={c.value}>{c.label}{pick(c.prices, currency, c.monthly) ? ` (+${cm(pick(c.prices, currency, c.monthly))}/mo)` : ""}</option>)}
                      </Select>
                    ) : o.type === "QUANTITY" ? (
                      <Input type="number" min={o.minQty} max={o.maxQty} value={cfg[o.key] ?? o.minQty} onChange={(e) => setCfg({ ...cfg, [o.key]: Number(e.target.value) })} />
                    ) : (
                      <label className="flex items-center gap-2 text-sm"><input type="checkbox" className="accent-[#7c3aed]" checked={!!cfg[o.key]} onChange={(e) => setCfg({ ...cfg, [o.key]: e.target.checked })} /> +{cm(pick(o.unitPrices, currency, o.unitMonthly))}/mo</label>
                    )}
                  </Field>
                ))}
                {p.addons.map((a: any) => (
                  <label key={a.id} className={cx("flex cursor-pointer items-start gap-3 rounded-xl border p-3", addons.includes(a.id) ? "border-primary bg-primary-tint" : "border-line")}>
                    <input type="checkbox" className="mt-1 accent-[#7c3aed]" checked={addons.includes(a.id)} onChange={(e) => setAddons(e.target.checked ? [...addons, a.id] : addons.filter((x) => x !== a.id))} />
                    <span><span className="block text-sm font-bold text-ink">{a.name} · {cm(pick(a.prices?.monthly, currency, a.monthly))}/mo</span><span className="text-xs text-mute">{a.description}</span></span>
                  </label>
                ))}
              </div>
            </Step>
          )}
          </>
          )}
        </div>

        <aside>
          <div className="sticky top-[150px] overflow-hidden rounded-2xl border border-line bg-white shadow-card">
            <div className="bg-gradient-to-br from-[#2e1065] via-[#4c1d95] to-[#6d28d9] px-5 py-4 text-white">
              <div className="text-[11px] font-bold uppercase tracking-wider text-white/60">Order summary</div>
              <div className="mt-0.5 text-lg font-extrabold">{p.name}</div>
              <div className="text-xs text-white/70">{p.group?.name} · {CYCLES[cycle]}</div>
            </div>
            <div className="p-5">
              <dl className="space-y-2.5 text-[13px]">
                {p.isVps && <div className="flex justify-between gap-3"><dt className="text-mute">Resources</dt><dd className="text-right font-semibold text-ink">{p.specs.cpuCores} vCPU · {gb(p.specs.ramMb)} · {p.specs.diskGb} GB</dd></div>}
                {loc && <div className="flex justify-between gap-3"><dt className="text-mute">Location</dt><dd className="font-semibold text-ink">{loc.name}</dd></div>}
                {osName && <div className="flex justify-between gap-3"><dt className="text-mute">OS</dt><dd className="truncate font-semibold text-ink">{osName}</dd></div>}
                {!p.isHosting && hostname && <div className="flex justify-between gap-3"><dt className="text-mute">Hostname</dt><dd className="truncate font-semibold text-ink">{hostname}</dd></div>}
                {p.isHosting && <div className="flex justify-between gap-3"><dt className="text-mute">Domain</dt><dd className="min-w-0 truncate font-semibold text-ink">{dom?.name ?? <span className="text-mute">not chosen yet</span>}</dd></div>}
                {!p.isHosting && <div className="flex justify-between gap-3"><dt className="text-mute">IPv4</dt><dd className="font-mono font-semibold text-ink">{reservation?.address ?? (p.isVps ? "Auto-assigned" : "Shared")}</dd></div>}
              </dl>
              <div className="my-4 border-t border-dashed border-line" />
              <dl className="space-y-2 text-[13px]">
                <div className="flex justify-between"><dt className="text-mute">Plan ({CYCLES[cycle].toLowerCase()})</dt><dd className="font-semibold text-ink">{cm(price?.price)}</dd></div>
                {p.isHosting && dom && dom.action !== "existing" && domainPrice != null && (
                  <div className="flex justify-between gap-3"><dt className="min-w-0 truncate text-mute">{dom.action === "transfer" ? "Domain transfer" : `Domain (${dom.years} yr)`}</dt><dd className={cx("font-semibold", domainFree ? "text-emerald-600" : "text-ink")}>{domainFree && domainCharge === 0 ? "FREE" : cm(domainCharge)}</dd></div>
                )}
                {optionsMonthly > 0 && <div className="flex justify-between"><dt className="text-mute">Extras × {months} mo</dt><dd className="font-semibold text-ink">{cm(optionsMonthly * months)}</dd></div>}
                {(price?.setupFee ?? 0) + addonSetup > 0 && <div className="flex justify-between"><dt className="text-mute">Setup fee</dt><dd className="font-semibold text-ink">{cm((price?.setupFee ?? 0) + addonSetup)}</dd></div>}
                <div className="flex justify-between"><dt className="text-mute">Subtotal</dt><dd className="font-semibold text-ink">{cm(total)}</dd></div>
                {currency === "INR" && <div className="flex justify-between"><dt className="text-mute">GST 18% <span className="text-[11px]">(estimate)</span></dt><dd className="font-semibold text-ink">{cm(gst)}</dd></div>}
              </dl>
              <div className="mt-4 flex items-end justify-between rounded-xl bg-[#faf7ff] px-4 py-3 ring-1 ring-[#ede4ff]">
                <div><div className="text-[11px] font-bold uppercase tracking-wider text-mute">Due today</div><div className="text-[11px] text-mute">{currency === "INR" ? "incl. GST" : "no Indian GST"}</div></div>
                <div className="text-2xl font-extrabold tracking-tight text-primary-dark">{cm(total + gst)}</div>
              </div>
              {reservation && countdown && <div className="mt-3 flex items-center gap-1.5 rounded-lg bg-amber-50 px-3 py-2 text-xs font-bold text-amber-700 ring-1 ring-amber-200"><Icon name="timer" className="text-[16px]" />{reservation.address} held for {countdown.label}</div>}
              {domainStep ? (
                <Button size="lg" className="mt-4 w-full" icon="language" variant="secondary" disabled>Choose a domain first</Button>
              ) : (
                <Button size="lg" className="mt-4 w-full" icon="shopping_cart_checkout" onClick={addToCart}>Continue to checkout</Button>
              )}
              <p className="mt-2 text-center text-[11.5px] text-mute">Review your cart and apply a promo code next.</p>
              <ul className="mt-4 space-y-2 border-t border-line pt-4 text-xs font-semibold text-slate-600">
                <li className="flex items-center gap-2"><Icon name="bolt" className="text-[18px] text-primary" /> {p.isHosting ? "Account set up after payment" : "Deployed automatically after payment"}</li>
                <li className="flex items-center gap-2"><Icon name={p.isHosting ? "lock" : "shield"} className="text-[18px] text-primary" /> {p.isHosting ? "Free SSL for your domain" : "DDoS protected network"}</li>
                <li className="flex items-center gap-2"><Icon name="receipt_long" className="text-[18px] text-primary" /> {currency === "INR" ? "GST invoice with your GSTIN" : `Invoice in ${currency} · cards & PayPal`}</li>
              </ul>
            </div>
          </div>
        </aside>
      </div>
    </div>
  );
}

export default function Page() {
  return <Suspense><Configure /></Suspense>;
}
