"use client";
import { Suspense, useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { api, CYCLES, CYCLE_MONTHS, gb, money } from "@/lib/api";
import { useSession } from "@/lib/session";
import { readCart, writeCart, type CartItem } from "@/lib/cart";
import { Alert, Button, Card, Field, Icon, Input, Loading, Select, Spinner, cx, toast, useApi } from "@/components/ui";
import { OrderSteps } from "@/components/order-steps";
import { CurrencySwitch, pick, priceRow, rowsIn, taxNote, useCurrency } from "@/lib/currency";

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

  const [cycle, setCycle] = useState("MONTHLY");
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
    if (p.osTemplates.length && !os) setOs(p.osTemplates[0].id);
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

  if (loading) return <Loading />;
  if (error || !p) return <div className="mx-auto max-w-3xl px-4 py-16"><Alert tone="error">This plan is not available. <a className="font-bold underline" href="/order">Browse plans</a></Alert></div>;

  const total = (price?.price ?? 0) + optionsMonthly * months + (price?.setupFee ?? 0) + addonSetup;

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
    if (p.requireHostname && !/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i.test(hostname)) return toast.error("Enter a valid hostname like server1.example.com");
    const loc = locs.data?.locations.find((l: any) => l.serverId === serverId);
    const item: CartItem = {
      key: `${p.id}-${Date.now()}`,
      productId: p.slug,
      productName: p.name,
      cycle,
      osTemplateId: os || null,
      osName: p.osTemplates.find((o: any) => o.id === os)?.name,
      hostname: hostname || null,
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
    writeCart({ ...c, items: [...c.items, item] });
    sessionStorage.removeItem(`cc_pick_${p.slug}`);
    router.push("/order/cart");
  }

  const filtered = ips;
  return (
    <div className="mx-auto max-w-[1280px] px-4 py-10 sm:px-6">
      <OrderSteps step={2} />
      <div className="grid gap-8 lg:grid-cols-[1fr_360px]">
        <div className="space-y-6">
          <div>
            <div className="text-sm font-bold text-primary-dark">{p.group?.name}</div>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h1 className="text-3xl font-extrabold tracking-tight text-ink">{p.name}</h1>
              <CurrencySwitch />
            </div>
            <p className="mt-1 text-mute">{p.tagline}</p>
            {p.isVps && (
              <div className="mt-4 flex flex-wrap gap-2 text-sm font-semibold text-slate-700">
                {[["developer_board", `${p.specs.cpuCores} vCPU`], ["memory", gb(p.specs.ramMb)], ["database", `${p.specs.diskGb} GB SSD`], ["public", `${p.specs.ipv4Count} × IPv4`]].map(([i, t]) => (
                  <span key={t} className="inline-flex items-center gap-1.5 rounded-full bg-white px-3 py-1.5 ring-1 ring-line"><Icon name={i} className="text-[18px] text-primary-dark" />{t}</span>
                ))}
              </div>
            )}
          </div>

          <Card title="1. Billing cycle">
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
          </Card>

          {p.isVps && (
            <Card title="2. Location">
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
            </Card>
          )}

          {p.allowIpSelection && serverId && (
            <Card title="3. Choose your IPv4 address" action={reservation && countdown && <span className="inline-flex items-center gap-1.5 rounded-full bg-amber-50 px-3 py-1 text-xs font-extrabold text-amber-700 ring-1 ring-amber-200"><Icon name="timer" className="text-[16px]" />held {countdown.label}</span>}>
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
                <div className="grid max-h-[340px] grid-cols-2 gap-2 overflow-y-auto pr-1 sm:grid-cols-3 md:grid-cols-4">
                  {filtered.map((ip: any) => {
                    const mine = reservation?.ipId === ip.id;
                    return (
                      <button key={ip.id} disabled={!!reserving} onClick={() => !mine && pickIp(ip)} className={cx("flex items-center justify-center gap-1.5 rounded-xl border px-2 py-2.5 font-mono text-[13px] font-bold transition", mine ? "border-primary-dark bg-primary-dark text-white" : "border-line bg-white text-slate-700 hover:border-primary hover:text-primary-dark")}>
                        {reserving === ip.id ? <Spinner className="h-3.5 w-3.5" /> : mine ? <Icon name="check" className="text-[16px]" /> : null}
                        {ip.address}
                      </button>
                    );
                  })}
                </div>
              )}
              {!me && <p className="mt-3 text-xs text-mute">You'll be asked to sign in or create an account to hold an IP.</p>}
            </Card>
          )}

          {(p.osTemplates.length > 0 || p.requireHostname) && (
            <Card title={`${p.allowIpSelection ? 4 : 3}. Server setup`}>
              <div className="grid gap-4 sm:grid-cols-2">
                {p.osTemplates.length > 0 && (
                  <Field label="Operating system" className="sm:col-span-2">
                    <div className="grid gap-2 sm:grid-cols-3">
                      {p.osTemplates.map((o: any) => (
                        <button key={o.id} onClick={() => setOs(o.id)} className={cx("flex items-center gap-2 rounded-xl border p-3 text-left text-sm font-bold", os === o.id ? "border-primary bg-primary-tint text-primary-dark ring-2 ring-primary/20" : "border-line bg-white text-slate-700")}>
                          <Icon name={o.family === "windows" ? "desktop_windows" : "terminal"} />{o.name}
                        </button>
                      ))}
                    </div>
                  </Field>
                )}
                <Field label="Hostname" hint="e.g. server1.yourdomain.com" className="sm:col-span-2">
                  <Input value={hostname} onChange={(e) => setHostname(e.target.value.toLowerCase().trim())} placeholder="server1.example.com" />
                </Field>
              </div>
            </Card>
          )}

          {(p.configOptions.length > 0 || p.addons.length > 0) && (
            <Card title="Extras">
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
            </Card>
          )}
        </div>

        <aside>
          <div className="sticky top-[150px] rounded-2xl border border-line bg-white p-5 shadow-card">
            <h3 className="font-extrabold text-ink">Order summary</h3>
            <dl className="mt-4 space-y-2 text-sm">
              <div className="flex justify-between"><dt className="text-mute">{p.name}</dt><dd className="font-semibold">{cm(price?.price)}</dd></div>
              {optionsMonthly > 0 && <div className="flex justify-between"><dt className="text-mute">Extras × {months} mo</dt><dd className="font-semibold">{cm(optionsMonthly * months)}</dd></div>}
              {price?.setupFee + addonSetup > 0 && <div className="flex justify-between"><dt className="text-mute">Setup fee</dt><dd className="font-semibold">{cm((price?.setupFee ?? 0) + addonSetup)}</dd></div>}
              {reservation && <div className="flex justify-between"><dt className="text-mute">IPv4</dt><dd className="font-mono font-semibold">{reservation.address}</dd></div>}
              <div className="flex justify-between border-t border-line pt-3 text-base"><dt className="font-extrabold text-ink">Due today</dt><dd className="font-extrabold text-ink">{cm(total)}</dd></div>
              <div className="text-right text-xs text-mute">{taxNote(currency)} · {CYCLES[cycle]}</div>
            </dl>
            <Button size="lg" className="mt-5 w-full" icon="shopping_cart_checkout" onClick={addToCart}>Continue</Button>
            <ul className="mt-5 space-y-2 text-xs font-semibold text-slate-600">
              <li className="flex items-center gap-2"><Icon name="bolt" className="text-primary" /> Deployed automatically after payment</li>
              <li className="flex items-center gap-2"><Icon name="shield" className="text-primary" /> DDoS protected network</li>
              <li className="flex items-center gap-2"><Icon name="receipt_long" className="text-primary" /> {currency === "INR" ? "GST invoice with your GSTIN" : `Invoice in ${currency} · cards & PayPal`}</li>
            </ul>
          </div>
        </aside>
      </div>
    </div>
  );
}

export default function Page() {
  return <Suspense><Configure /></Suspense>;
}
