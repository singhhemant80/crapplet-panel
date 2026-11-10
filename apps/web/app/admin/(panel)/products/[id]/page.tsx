"use client";
import { OsLogo } from "@/components/os-logo";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { api, CYCLES } from "@/lib/api";
import { Alert, Button, Card, Field, Input, Loading, PageHeader, Select, Textarea, Toggle, Icon, cx, toast, useApi } from "@/components/ui";

const TYPES = ["SHARED", "RESELLER_HOSTING", "WORDPRESS", "VPS_LINUX", "VPS_WINDOWS", "VPS_FOREX", "TALLY", "VPS_N8N", "VPS_MINECRAFT", "VPS_GOLD", "DEDICATED", "GPU", "COLOCATION", "CUSTOM"];
const CYC = ["MONTHLY", "QUARTERLY", "SEMIANNUAL", "ANNUAL", "BIENNIAL", "TRIENNIAL", "ONETIME"];

/** Mirrors the API's conversion (lib/currency.ts) so the editor can preview auto-converted prices. */
function makeConverter(rate: number | undefined, cfg: { autoConvert?: boolean; markupPct?: number; rounding?: string } | undefined) {
  return (inrMajor: number | string | undefined | null): number | null => {
    if (!rate || !cfg?.autoConvert || inrMajor === "" || inrMajor === null || inrMajor === undefined) return null;
    const minor = Number(inrMajor) * 100 * rate * (1 + (cfg.markupPct || 0) / 100);
    if (minor <= 0) return 0;
    const r = cfg.rounding === "whole" ? Math.ceil(minor / 100) * 100 : cfg.rounding === "nice99" ? Math.max(99, Math.ceil(minor / 100) * 100 - 1) : Math.round(minor);
    return r / 100;
  };
}

export default function ProductEditor() {
  const { id } = useParams<{ id: string }>();
  const isNew = id === "new";
  const router = useRouter();
  const prod = useApi(isNew ? null : `/admin/products/${id}`);
  const groups = useApi("/admin/product-groups");
  const servers = useApi("/admin/servers");
  const os = useApi("/admin/os-templates");
  const addons = useApi("/admin/addons");
  const currencies = useApi("/admin/currencies");
  const settings = useApi("/admin/settings");
  const [cur, setCur] = useState<"INR" | "USD">("INR");
  const [p, setP] = useState<any>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (isNew) setP({ name: "", slug: "", type: "VPS_LINUX", groupId: "", provisioner: "PROXMOX", virtType: "KVM", features: "", ipv4Count: 1, allowIpSelection: true, requireHostname: true, ipv6Enabled: false, hsnSac: "998315", taxable: true, enabled: true, hidden: false, featured: false, autoSetup: "ON_PAYMENT", sortOrder: 0, resellerEnabled: false, stockControl: false, stockQty: 0, moduleConfig: { proxmox: { storage: "", bridge: "", disk: "scsi0", cpuType: "host" }, virtualizor: { planId: "", virt: "kvm" } }, pricing: {}, pricingUsd: {}, wholesale: {}, serverIds: [], osTemplateIds: [], addonIds: [], configOptions: [] });
    else if (prod.data) {
      const x = prod.data.product;
      setP({
        ...x,
        features: x.features.join("\n"),
        pricing: Object.fromEntries(x.pricing.filter((r: any) => r.currency === "INR").map((r: any) => [r.cycle, { price: r.price / 100, setupFee: r.setupFee / 100, enabled: r.enabled }])),
        pricingUsd: Object.fromEntries(x.pricing.filter((r: any) => r.currency === "USD").map((r: any) => [r.cycle, { price: r.price / 100, setupFee: r.setupFee / 100, enabled: r.enabled }])),
        wholesale: Object.fromEntries(x.wholesalePricing.map((r: any) => [r.cycle, r.price / 100])),
        serverIds: x.servers.map((s: any) => s.serverId),
        osTemplateIds: x.osTemplates.map((o: any) => o.osTemplateId),
        addonIds: x.addons.map((a: any) => a.addonId),
        moduleConfig: { proxmox: {}, virtualizor: {}, ...x.moduleConfig },
      });
    }
  }, [isNew, prod.data]);

  const readiness = useApi(isNew ? null : `/admin/products/${id}/readiness`, [id]);
  // a VPS plan with no server ticked: pre-select the only matching server so orders can be built
  useEffect(() => {
    if (!p || !servers.data || p.serverIds.length) return;
    const type = p.provisioner === "VIRTUALIZOR" ? "VIRTUALIZOR" : p.provisioner === "PROXMOX" ? "PROXMOX" : null;
    const match = type ? servers.data.servers.filter((s: any) => s.type === type && s.enabled) : [];
    if (match.length === 1) setP((cur: any) => ({ ...cur, serverIds: [match[0].id] }));
  }, [p?.provisioner, servers.data]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!p) return <Loading />;
  const set = (patch: any) => setP({ ...p, ...patch });
  const usdRate: number | undefined = currencies.data?.items?.find((c: any) => c.code === "USD")?.rate;
  const curCfg = settings.data?.settings?.currency;
  const toUsd = makeConverter(usdRate, curCfg);
  const fillUsd = () =>
    set({ pricingUsd: Object.fromEntries(CYC.filter((c) => p.pricing[c]?.price !== undefined && p.pricing[c]?.price !== "").map((c) => [c, { price: toUsd(p.pricing[c].price) ?? "", setupFee: toUsd(p.pricing[c].setupFee || 0) ?? 0 }])) });
  const mc = (mod: string, k: string, v: any) => set({ moduleConfig: { ...p.moduleConfig, [mod]: { ...p.moduleConfig[mod], [k]: v } } });
  const toggleIn = (key: string, v: string) => set({ [key]: p[key].includes(v) ? p[key].filter((x: string) => x !== v) : [...p[key], v] });
  const num = (v: any) => (v === "" || v === null || v === undefined ? null : Number(v));

  async function save() {
    setBusy(true);
    const body = {
      groupId: p.groupId, legacyPid: num(p.legacyPid), name: p.name, slug: p.slug, type: p.type, tagline: p.tagline || null, description: p.description || null,
      features: String(p.features).split("\n").map((s: string) => s.trim()).filter(Boolean), imageUrl: p.imageUrl || null,
      provisioner: p.provisioner, virtType: p.virtType, cpuCores: num(p.cpuCores), ramMb: num(p.ramMb), diskGb: num(p.diskGb), bandwidthGb: num(p.bandwidthGb),
      ipv4Count: Number(p.ipv4Count) || 0, ipv6Enabled: p.ipv6Enabled, allowIpSelection: p.allowIpSelection, requireHostname: p.requireHostname, hsnSac: p.hsnSac, taxable: p.taxable,
      stockControl: p.stockControl, stockQty: Number(p.stockQty) || 0, enabled: p.enabled, hidden: p.hidden, featured: p.featured, autoSetup: p.autoSetup, sortOrder: Number(p.sortOrder) || 0,
      resellerEnabled: p.resellerEnabled, moduleConfig: { proxmox: { ...p.moduleConfig.proxmox }, virtualizor: { ...p.moduleConfig.virtualizor, planId: num(p.moduleConfig.virtualizor?.planId), serverGroupId: num(p.moduleConfig.virtualizor?.serverGroupId) } },
      pricing: [
        ...Object.entries(p.pricing).filter(([, v]: any) => v && v.price !== "" && v.price !== undefined).map(([cycle, v]: any) => ({ cycle, currency: "INR", price: Math.round(Number(v.price) * 100), setupFee: Math.round(Number(v.setupFee || 0) * 100), enabled: v.enabled !== false })),
        // USD rows only where staff typed a price; blank cycles fall back to auto-conversion
        ...Object.entries(p.pricingUsd ?? {}).filter(([, v]: any) => v && v.price !== "" && v.price !== undefined && v.price !== null).map(([cycle, v]: any) => ({ cycle, currency: "USD", price: Math.round(Number(v.price) * 100), setupFee: Math.round(Number(v.setupFee || 0) * 100), enabled: v.enabled !== false })),
      ],
      wholesale: Object.entries(p.wholesale).filter(([, v]) => v !== "" && v !== undefined).map(([cycle, v]) => ({ cycle, price: Math.round(Number(v) * 100) })),
      serverIds: p.serverIds, osTemplateIds: p.osTemplateIds, addonIds: p.addonIds,
      configOptions: p.configOptions,
    };
    try {
      if (isNew) {
        const r = await api("/admin/products", { body });
        toast.success("Product created");
        router.replace(`/admin/products/${r.id}`);
      } else {
        await api(`/admin/products/${id}`, { method: "PUT", body });
        toast.success("Product saved");
        prod.reload();
        readiness.reload();
      }
    } catch (e: any) {
      toast.error(e.message);
    } finally {
      setBusy(false);
    }
  }
  const isVps = p.provisioner === "PROXMOX" || p.provisioner === "VIRTUALIZOR";
  const srvType = p.provisioner === "VIRTUALIZOR" ? "VIRTUALIZOR" : "PROXMOX";
  return (
    <>
      {!isNew && readiness.data && <Readiness data={readiness.data} onRecheck={readiness.reload} loading={readiness.loading} />}
      <PageHeader back="/admin/products" title={isNew ? "New product" : p.name} actions={<>{!isNew && <Button variant="danger" size="sm" onClick={() => confirm("Delete product?") && api(`/admin/products/${id}`, { method: "DELETE" }).then(() => router.replace("/admin/products")).catch((e) => toast.error(e.message))}>Delete</Button>}<Button loading={busy} icon="save" onClick={save}>Save product</Button></>} />
      <div className="grid gap-6 xl:grid-cols-2">
        <Card title="Details">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Name"><Input value={p.name} onChange={(e) => set({ name: e.target.value })} /></Field>
            <Field label="Slug"><Input value={p.slug} onChange={(e) => set({ slug: e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, "-") })} /></Field>
            <Field label="Group"><Select value={p.groupId} onChange={(e) => set({ groupId: e.target.value })}><option value="">Select…</option>{groups.data?.items?.map((g: any) => <option key={g.id} value={g.id}>{g.name}</option>)}</Select></Field>
            <Field label="Type"><Select value={p.type} onChange={(e) => set({ type: e.target.value })}>{TYPES.map((t) => <option key={t}>{t}</option>)}</Select></Field>
            <Field label="Legacy WHMCS pid" hint="Keeps website links like cart.php?a=add&pid=2 working"><Input type="number" value={p.legacyPid ?? ""} onChange={(e) => set({ legacyPid: e.target.value })} /></Field>
            <Field label="Sort order"><Input type="number" value={p.sortOrder} onChange={(e) => set({ sortOrder: e.target.value })} /></Field>
            <Field label="Tagline" className="sm:col-span-2"><Input value={p.tagline ?? ""} onChange={(e) => set({ tagline: e.target.value })} /></Field>
            <Field label="Features (one per line)" className="sm:col-span-2"><Textarea rows={4} value={p.features} onChange={(e) => set({ features: e.target.value })} /></Field>
            <Field label="Description" className="sm:col-span-2"><Textarea rows={3} value={p.description ?? ""} onChange={(e) => set({ description: e.target.value })} /></Field>
            <Field label="Image URL" className="sm:col-span-2"><Input value={p.imageUrl ?? ""} onChange={(e) => set({ imageUrl: e.target.value })} placeholder="/Vps-Hosting-banner.jpg" /></Field>
            <div className="flex flex-wrap gap-5 sm:col-span-2">
              <Toggle checked={p.enabled} onChange={(v) => set({ enabled: v })} label="Enabled" />
              <Toggle checked={p.hidden} onChange={(v) => set({ hidden: v })} label="Hidden from order page" />
              <Toggle checked={p.featured} onChange={(v) => set({ featured: v })} label="Featured" />
              <Toggle checked={p.resellerEnabled} onChange={(v) => set({ resellerEnabled: v })} label="Available to resellers" />
            </div>
          </div>
        </Card>
        <Card
          title={cur === "INR" ? "Pricing (₹, excl. GST)" : "Pricing (US$, international)"}
          action={
            <div className="inline-flex rounded-full bg-slate-100 p-1" role="group" aria-label="Currency">
              {(["INR", "USD"] as const).map((k) => (
                <button key={k} type="button" onClick={() => setCur(k)} className={cx("rounded-full px-3 py-1 text-xs font-extrabold", cur === k ? "bg-white text-primary-dark shadow" : "text-slate-500")}>
                  {k === "INR" ? "₹ INR" : "$ USD"}
                </button>
              ))}
            </div>
          }
        >
          {cur === "INR" ? (
            <div className="space-y-2">
              <div className="grid grid-cols-[120px_1fr_1fr_1fr] gap-2 text-xs font-bold uppercase text-mute"><span>Cycle</span><span>Price</span><span>Setup fee</span><span>Wholesale</span></div>
              {CYC.map((c) => (
                <div key={c} className="grid grid-cols-[120px_1fr_1fr_1fr] items-center gap-2">
                  <span className="text-sm font-semibold">{CYCLES[c]}</span>
                  <Input className="h-10" type="number" step="0.01" placeholder="off" value={p.pricing[c]?.price ?? ""} onChange={(e) => set({ pricing: { ...p.pricing, [c]: { ...p.pricing[c], price: e.target.value } } })} />
                  <Input className="h-10" type="number" step="0.01" value={p.pricing[c]?.setupFee ?? ""} onChange={(e) => set({ pricing: { ...p.pricing, [c]: { ...p.pricing[c], setupFee: e.target.value } } })} />
                  <Input className="h-10" type="number" step="0.01" disabled={!p.resellerEnabled} value={p.wholesale[c] ?? ""} onChange={(e) => set({ wholesale: { ...p.wholesale, [c]: e.target.value } })} />
                </div>
              ))}
            </div>
          ) : (
            <div className="space-y-2">
              <Alert className="mb-3">
                {curCfg?.autoConvert
                  ? <>Leave a cycle blank to auto-convert from INR at 1 USD = ₹{usdRate ? (1 / usdRate).toFixed(2) : "?"}{curCfg?.markupPct ? ` + ${curCfg.markupPct}% markup` : ""} (grey placeholder). Type a price to fix it.</>
                  : <>Auto-conversion is off — only cycles with a USD price can be ordered in USD.</>}
                {" "}Rates &amp; rounding: Settings → Currencies.
              </Alert>
              <div className="grid grid-cols-[120px_1fr_1fr] gap-2 text-xs font-bold uppercase text-mute"><span>Cycle</span><span>Price</span><span>Setup fee</span></div>
              {CYC.map((c) => {
                const inrOn = p.pricing[c]?.price !== undefined && p.pricing[c]?.price !== "";
                const auto = inrOn ? toUsd(p.pricing[c].price) : null;
                const autoSetup = inrOn ? toUsd(p.pricing[c].setupFee || 0) : null;
                return (
                  <div key={c} className="grid grid-cols-[120px_1fr_1fr] items-center gap-2">
                    <span className="text-sm font-semibold">{CYCLES[c]}</span>
                    <Input className="h-10" type="number" step="0.01" placeholder={auto !== null ? `auto ${auto.toFixed(2)}` : "off"} value={p.pricingUsd?.[c]?.price ?? ""} onChange={(e) => set({ pricingUsd: { ...p.pricingUsd, [c]: { ...p.pricingUsd?.[c], price: e.target.value } } })} />
                    <Input className="h-10" type="number" step="0.01" placeholder={autoSetup !== null ? `auto ${autoSetup.toFixed(2)}` : ""} value={p.pricingUsd?.[c]?.setupFee ?? ""} onChange={(e) => set({ pricingUsd: { ...p.pricingUsd, [c]: { ...p.pricingUsd?.[c], setupFee: e.target.value } } })} />
                  </div>
                );
              })}
              <div className="flex flex-wrap gap-2 pt-2">
                <Button size="sm" variant="outline" icon="currency_exchange" onClick={fillUsd} disabled={!usdRate}>Fill from INR</Button>
                <Button size="sm" variant="ghost" icon="backspace" onClick={() => set({ pricingUsd: {} })}>Clear (use auto)</Button>
              </div>
            </div>
          )}
          <div className="mt-4 grid gap-4 sm:grid-cols-2">
            <Field label="SAC code"><Input value={p.hsnSac} onChange={(e) => set({ hsnSac: e.target.value })} /></Field>
            <div className="flex items-end pb-2"><Toggle checked={p.taxable} onChange={(v) => set({ taxable: v })} label="Charge GST" /></div>
            <div className="flex items-end pb-2"><Toggle checked={p.stockControl} onChange={(v) => set({ stockControl: v })} label="Stock control" /></div>
            {p.stockControl && <Field label="Stock quantity"><Input type="number" value={p.stockQty} onChange={(e) => set({ stockQty: e.target.value })} /></Field>}
          </div>
        </Card>
        <Card title="Provisioning">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Module"><Select value={p.provisioner} onChange={(e) => set({ provisioner: e.target.value })}><option value="PROXMOX">Proxmox VE</option><option value="VIRTUALIZOR">Virtualizor</option><option value="MANUAL">Manual provisioning</option><option value="NONE">None</option></Select></Field>
            <Field label="Auto-setup"><Select value={p.autoSetup} onChange={(e) => set({ autoSetup: e.target.value })}><option value="ON_PAYMENT">After payment</option><option value="ON_ORDER">On order (trials)</option><option value="MANUAL">When staff accepts</option></Select></Field>
            {isVps && <>
              {p.provisioner === "PROXMOX" && <Field label="Virtualization"><Select value={p.virtType} onChange={(e) => set({ virtType: e.target.value })}><option value="KVM">KVM virtual machine</option><option value="LXC">LXC container</option></Select></Field>}
              <Field label="vCPU cores"><Input type="number" value={p.cpuCores ?? ""} onChange={(e) => set({ cpuCores: e.target.value })} /></Field>
              <Field label="RAM (MB)"><Input type="number" value={p.ramMb ?? ""} onChange={(e) => set({ ramMb: e.target.value })} /></Field>
              <Field label="Disk (GB)"><Input type="number" value={p.diskGb ?? ""} onChange={(e) => set({ diskGb: e.target.value })} /></Field>
              <Field label="Bandwidth (GB, empty = unmetered)"><Input type="number" value={p.bandwidthGb ?? ""} onChange={(e) => set({ bandwidthGb: e.target.value })} /></Field>
              <Field label="IPv4 addresses"><Input type="number" value={p.ipv4Count} onChange={(e) => set({ ipv4Count: e.target.value })} /></Field>
              <div className="flex flex-wrap gap-5 sm:col-span-2">
                <Toggle checked={p.allowIpSelection} onChange={(v) => set({ allowIpSelection: v })} label="Customer chooses IPv4" />
                <Toggle checked={p.ipv6Enabled} onChange={(v) => set({ ipv6Enabled: v })} label="IPv6" />
                <Toggle checked={p.requireHostname} onChange={(v) => set({ requireHostname: v })} label="Require hostname" />
              </div>
              {p.provisioner === "PROXMOX" ? <>
                <Field label="Storage override" hint="Defaults to the server's storage"><Input value={p.moduleConfig.proxmox?.storage ?? ""} onChange={(e) => mc("proxmox", "storage", e.target.value)} placeholder="local-lvm" /></Field>
                <Field label="Bridge override"><Input value={p.moduleConfig.proxmox?.bridge ?? ""} onChange={(e) => mc("proxmox", "bridge", e.target.value)} placeholder="vmbr0" /></Field>
                <Field label="Boot disk (KVM)"><Input value={p.moduleConfig.proxmox?.disk ?? "scsi0"} onChange={(e) => mc("proxmox", "disk", e.target.value)} /></Field>
                <Field label="Port speed (Mbps)"><Input type="number" value={p.moduleConfig.proxmox?.rateMbps ?? ""} onChange={(e) => mc("proxmox", "rateMbps", e.target.value)} placeholder="unlimited" /></Field>
              </> : <>
                <VirtualizorPlanPicker
                  serverIds={p.serverIds}
                  planId={p.moduleConfig.virtualizor?.planId ?? ""}
                  virt={p.moduleConfig.virtualizor?.virt ?? "kvm"}
                  onPick={(plan, virt, specs) =>
                    setP((cur: any) => ({
                      ...cur,
                      ...(specs ? { cpuCores: specs.cores ?? cur.cpuCores, ramMb: specs.ramMb ?? cur.ramMb, diskGb: specs.diskGb ?? cur.diskGb, bandwidthGb: specs.bandwidthGb || cur.bandwidthGb } : {}),
                      virtType: /lxc|proxl|openvz|vzo/.test(virt) ? "LXC" : "KVM",
                      moduleConfig: { ...cur.moduleConfig, virtualizor: { ...cur.moduleConfig.virtualizor, planId: plan, virt } },
                    }))
                  }
                />
                <VirtualizorPlacement serverIds={p.serverIds} value={p.moduleConfig.virtualizor ?? {}} onChange={(patch) => set({ moduleConfig: { ...p.moduleConfig, virtualizor: { ...p.moduleConfig.virtualizor, ...patch } } })} />
              </>}
            </>}
          </div>
        </Card>
        <Card title="Servers, operating systems & add-ons">
          {isVps && !p.serverIds.length && <Alert tone="warn" className="mb-3">Assign at least one {srvType === "PROXMOX" ? "Proxmox" : "Virtualizor"} server — its IP pool is what customers choose from.</Alert>}
          <div className="space-y-4">
            <div>
              <div className="mb-1.5 flex items-center justify-between text-[13px] font-bold text-slate-700">
                <span>Servers {isVps && <span className="font-semibold text-mute">· VPS of this plan are built on the ticked server</span>}</span>
              </div>
              <div className="grid gap-2 sm:grid-cols-2">
                {(servers.data?.servers ?? []).filter((s: any) => !isVps || s.type === srvType).map((s: any) => {
                  const on = p.serverIds.includes(s.id);
                  return (
                    <button key={s.id} type="button" onClick={() => toggleIn("serverIds", s.id)}
                      className={cx("flex items-center gap-3 rounded-xl border p-3 text-left transition", on ? "border-primary bg-primary-tint ring-2 ring-primary/20" : "border-line bg-white hover:border-primary/40")}>
                      <span className={cx("grid h-5 w-5 shrink-0 place-items-center rounded-md border-2", on ? "border-primary bg-primary text-white" : "border-slate-300")}>{on && <Icon name="check" className="text-[14px]" />}</span>
                      <span className="min-w-0">
                        <span className="block truncate text-sm font-bold text-ink">{s.name}</span>
                        <span className="block text-xs text-mute">{s.type === "VIRTUALIZOR" ? "Virtualizor" : "Proxmox"} · {s.freeIps} free IPs in panel{s.enabled ? "" : " · disabled"}</span>
                      </span>
                    </button>
                  );
                })}
              </div>
              {isVps && !p.serverIds.length && <Alert tone="warn" className="mt-2">Tick the server new VPS should be built on.</Alert>}
              {!(servers.data?.servers ?? []).some((s: any) => !isVps || s.type === srvType) && <span className="text-xs text-mute">None configured — add one under Infrastructure → Servers.</span>}
            </div>
            {isVps && (
              <OsPicker
                all={os.data?.items ?? []}
                provisioner={p.provisioner}
                serverIds={p.serverIds}
                virt={p.provisioner === "VIRTUALIZOR" ? p.moduleConfig.virtualizor?.virt : null}
                selected={p.osTemplateIds}
                onChange={(ids) => set({ osTemplateIds: ids })}
                onSynced={os.reload}
              />
            )}
            <Chips label="Add-ons" items={(addons.data?.items ?? []).map((a: any) => ({ id: a.id, label: a.name }))} selected={p.addonIds} onToggle={(v) => toggleIn("addonIds", v)} />
          </div>
        </Card>
        <Card title="Configurable options" className="xl:col-span-2">
          <p className="mb-3 text-sm text-mute">Monthly prices are multiplied by the billing cycle. Keys <code>extra_ipv4</code> and <code>extra_ram_gb</code> are applied automatically by the Proxmox module.</p>
          {p.configOptions.map((o: any, i: number) => (
            <div key={i} className="mb-2 grid items-center gap-2 rounded-xl border border-line p-3 md:grid-cols-[140px_1fr_120px_80px_80px_110px_120px_auto]">
              <Input className="h-9" placeholder="key" value={o.key} onChange={(e) => set({ configOptions: p.configOptions.map((x: any, j: number) => (j === i ? { ...x, key: e.target.value } : x)) })} />
              <Input className="h-9" placeholder="Label" value={o.label} onChange={(e) => set({ configOptions: p.configOptions.map((x: any, j: number) => (j === i ? { ...x, label: e.target.value } : x)) })} />
              <Select className="h-9" value={o.type} onChange={(e) => set({ configOptions: p.configOptions.map((x: any, j: number) => (j === i ? { ...x, type: e.target.value } : x)) })}><option value="QUANTITY">Quantity</option><option value="YESNO">Yes / No</option><option value="SELECT">Dropdown</option></Select>
              <Input className="h-9" type="number" placeholder="min" value={o.minQty} onChange={(e) => set({ configOptions: p.configOptions.map((x: any, j: number) => (j === i ? { ...x, minQty: Number(e.target.value) } : x)) })} />
              <Input className="h-9" type="number" placeholder="max" value={o.maxQty} onChange={(e) => set({ configOptions: p.configOptions.map((x: any, j: number) => (j === i ? { ...x, maxQty: Number(e.target.value) } : x)) })} />
              <Input className="h-9" type="number" placeholder="₹/unit/mo" title="₹ per unit per month" value={o.unitMonthly / 100} onChange={(e) => set({ configOptions: p.configOptions.map((x: any, j: number) => (j === i ? { ...x, unitMonthly: Math.round(Number(e.target.value) * 100) } : x)) })} />
              <Input
                className="h-9"
                type="number"
                step="0.01"
                title="US$ per unit per month (blank = auto-convert)"
                placeholder={(() => { const a = toUsd(o.unitMonthly / 100); return a !== null ? `$ auto ${a.toFixed(2)}` : "$/unit/mo"; })()}
                value={o.unitPrices?.USD !== undefined ? o.unitPrices.USD / 100 : ""}
                onChange={(e) =>
                  set({
                    configOptions: p.configOptions.map((x: any, j: number) => {
                      if (j !== i) return x;
                      const { USD: _drop, ...rest } = x.unitPrices ?? {};
                      return { ...x, unitPrices: e.target.value === "" ? rest : { ...rest, USD: Math.round(Number(e.target.value) * 100) } };
                    }),
                  })
                }
              />
              <button className="text-sm font-bold text-rose-600" onClick={() => set({ configOptions: p.configOptions.filter((_: any, j: number) => j !== i) })}>Remove</button>
            </div>
          ))}
          <Button size="sm" variant="ghost" icon="add" onClick={() => set({ configOptions: [...p.configOptions, { key: "extra_ipv4", label: "Additional IPv4", type: "QUANTITY", minQty: 0, maxQty: 4, unitMonthly: 0, choices: [], sortOrder: p.configOptions.length }] })}>Add option</Button>
        </Card>
      </div>
    </>
  );
}

const VIRT_TYPES: [string, string][] = [["kvm", "KVM"], ["xen", "Xen PV"], ["xenhvm", "Xen HVM"], ["openvz", "OpenVZ"], ["vzk", "Virtuozzo KVM"], ["vzo", "Virtuozzo OpenVZ"], ["proxk", "Proxmox KVM"], ["proxl", "Proxmox LXC"], ["lxc", "LXC"]];

type VPlan = { plid: number; name: string; virt: string; ramMb: number | null; diskGb: number | null; cores: number | null; bandwidthGb: number | null; ips: number | null };

/** Lists the plans configured in Virtualizor so staff pick one instead of typing an id; picking also fills CPU/RAM/disk. */
function VirtualizorPlanPicker({ serverIds, planId, virt, onPick }: { serverIds: string[]; planId: string | number; virt: string; onPick: (planId: number | "", virt: string, specs?: Partial<VPlan>) => void }) {
  const q = serverIds.length ? `?serverIds=${serverIds.join(",")}` : "";
  const { data, loading, reload, error } = useApi(`/admin/virtualizor/plans${q}`);
  const groups: { serverId: string; serverName: string; plans: VPlan[]; error: string | null }[] = data?.servers ?? [];
  const all = groups.flatMap((g) => g.plans);
  const errors = groups.filter((g) => g.error);
  const current = all.find((x) => String(x.plid) === String(planId));
  const [manual, setManual] = useState(false);
  const showManual = manual || (!loading && !all.length) || (planId !== "" && planId !== null && !current && !loading);
  return (
    <>
      <Field
        label={<span className="flex items-center justify-between">Virtualizor plan <button type="button" onClick={reload} className="inline-flex items-center gap-1 text-xs font-bold text-primary-dark hover:underline"><Icon name="refresh" className="text-[15px]" />Refresh</button></span>}
        hint={current ? `${current.cores ?? "?"} vCPU · ${current.ramMb ?? "?"} MB RAM · ${current.diskGb ?? "?"} GB disk · ${current.bandwidthGb ? `${current.bandwidthGb} GB` : "unmetered"} bandwidth` : undefined}
        className="sm:col-span-2"
      >
        {showManual ? (
          <div className="flex gap-2">
            <Input type="number" placeholder="Plan id" value={planId ?? ""} onChange={(e) => onPick(e.target.value === "" ? "" : Number(e.target.value), virt)} />
            {all.length > 0 && <Button type="button" variant="outline" onClick={() => setManual(false)}>Choose from list</Button>}
          </div>
        ) : (
          <Select
            value={current ? String(current.plid) : ""}
            disabled={loading}
            onChange={(e) => {
              if (e.target.value === "__manual") return setManual(true);
              const pl = all.find((x) => String(x.plid) === e.target.value);
              if (pl) onPick(pl.plid, pl.virt, pl);
              else onPick("", virt);
            }}
          >
            <option value="">{loading ? "Loading plans from Virtualizor…" : "Select a plan…"}</option>
            {groups.filter((g) => g.plans.length).map((g) => (
              <optgroup key={g.serverId} label={g.serverName}>
                {g.plans.map((pl) => (
                  <option key={`${g.serverId}-${pl.plid}`} value={pl.plid}>
                    {pl.name} — {pl.virt.toUpperCase()} · {pl.cores ?? "?"} vCPU · {pl.ramMb ? (pl.ramMb >= 1024 ? `${+(pl.ramMb / 1024).toFixed(1)} GB` : `${pl.ramMb} MB`) : "?"} RAM · {pl.diskGb ?? "?"} GB (id {pl.plid})
                  </option>
                ))}
              </optgroup>
            ))}
            <option value="__manual">Enter a plan id manually…</option>
          </Select>
        )}
      </Field>
      {error && <Alert tone="error" className="sm:col-span-2">{error}</Alert>}
      {!loading && !error && !groups.length && <Alert tone="warn" className="sm:col-span-2">Add a Virtualizor server under Infrastructure → Servers to load its plans here.</Alert>}
      {errors.map((g) => <Alert key={g.serverId} tone="error" className="sm:col-span-2">Couldn't load plans from {g.serverName}: {g.error}</Alert>)}
      <Field label="Virtualizor virt type">
        <Select value={virt} onChange={(e) => onPick(planId === "" ? "" : Number(planId), e.target.value)}>
          {VIRT_TYPES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </Select>
      </Field>
    </>
  );
}

const pct = (u: number, t: number) => (t ? Math.round((u / t) * 100) : 0);

/** Where new VPS of this plan are built: automatic (panel picks node + storage), the least-loaded allowed node, or one fixed node. */
function VirtualizorPlacement({ serverIds, value, onChange }: { serverIds: string[]; value: any; onChange: (patch: any) => void }) {
  const mon = useApi("/admin/monitoring");
  const firstServer = serverIds[0];
  const groups = useApi(firstServer ? `/admin/virtualizor/${firstServer}/groups` : null, [firstServer]);
  const nodes: any[] = (mon.data?.servers ?? []).filter((s: any) => s.type === "VIRTUALIZOR" && (!serverIds.length || serverIds.includes(s.id))).flatMap((s: any) => s.nodes.map((n: any) => ({ ...n, serverName: s.name })));
  const mode = value.placement ?? (value.slaveServerId !== undefined && value.slaveServerId !== null && value.slaveServerId !== "" ? "fixed" : "auto");
  const chosen: string[] = value.nodeIds ?? (value.slaveServerId !== undefined && value.slaveServerId !== null && value.slaveServerId !== "" ? [String(value.slaveServerId)] : []);
  const toggle = (id: string) => onChange({ placement: mode, nodeIds: mode === "fixed" ? [id] : chosen.includes(id) ? chosen.filter((x) => x !== id) : [...chosen, id], slaveServerId: undefined });
  return (
    <div className="space-y-3 rounded-2xl border border-line bg-[#fbf9ff] p-4 sm:col-span-2">
      <div className="flex items-center gap-2 text-sm font-extrabold text-ink"><Icon name="hub" className="text-primary-dark" /> Node placement</div>
      <div className="grid gap-2 sm:grid-cols-3">
        {[
          ["auto", "Automatic", "Node with the most free RAM and its primary storage — optionally inside a server group"],
          ["least_loaded", "Least-loaded node", "We pick the allowed node with most free RAM, under your limits"],
          ["fixed", "Fixed node", "Always build on one node"],
        ].map(([k, t, d]) => (
          <button key={k} type="button" onClick={() => onChange({ placement: k, slaveServerId: undefined, nodeIds: k === "fixed" ? chosen.slice(0, 1) : chosen })}
            className={cx("rounded-xl border p-3 text-left transition", mode === k ? "border-primary bg-white ring-2 ring-primary/20" : "border-line bg-white/60 hover:border-primary/40")}>
            <div className="text-sm font-bold text-ink">{t}</div>
            <div className="mt-0.5 text-xs text-mute">{d}</div>
          </button>
        ))}
      </div>
      {mode === "auto" && (
        <Field label="Server group (optional)" hint={groups.error ? `Couldn't load groups: ${groups.error}` : "Leave empty to let Virtualizor choose from all nodes"}>
          <Select value={value.serverGroupId ?? ""} onChange={(e) => onChange({ serverGroupId: e.target.value === "" ? null : Number(e.target.value) })}>
            <option value="">Any node</option>
            {(groups.data?.groups ?? []).map((g: any) => <option key={g.sgid} value={g.sgid}>{g.name} (id {g.sgid})</option>)}
          </Select>
        </Field>
      )}
      {mode !== "auto" && (
        <div>
          <div className="mb-1.5 text-xs font-bold text-mute">{mode === "fixed" ? "Build on this node" : `Allowed nodes ${chosen.length ? `(${chosen.length})` : "(none ticked = all nodes)"}`}</div>
          {!nodes.length && <Alert tone="warn">No nodes yet — open Node Monitoring and click Refresh now.</Alert>}
          <div className="grid gap-2 sm:grid-cols-2">
            {nodes.map((n) => {
              const on = chosen.includes(n.externalId);
              const ram = pct(n.ramUsedMb, n.ramTotalMb);
              return (
                <button key={n.id} type="button" onClick={() => toggle(n.externalId)} disabled={n.externalId === null}
                  className={cx("flex items-center gap-3 rounded-xl border p-2.5 text-left transition", on ? "border-primary bg-white ring-2 ring-primary/20" : "border-line bg-white hover:border-primary/40", (!n.online || !n.enabled) && "opacity-60")}>
                  <span className={cx("grid h-5 w-5 shrink-0 place-items-center border-2", mode === "fixed" ? "rounded-full" : "rounded-md", on ? "border-primary bg-primary text-white" : "border-slate-300")}>{on && <Icon name="check" className="text-[14px]" />}</span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-bold text-ink">{n.name} <span className="font-mono text-xs text-mute">#{n.externalId}</span></span>
                    <span className="block text-xs text-mute">{n.online ? `RAM ${ram}% · CPU ${Math.round(n.cpuPct)}% · ${n.meta?.vpsCount ?? 0} VPS` : "offline"}{!n.enabled && " · new VPS off"}{n.meta?.locked && " · locked"}</span>
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      )}
      <Field label="IPv4 addresses come from" hint={value.ipSource === "virtualizor" ? "Virtualizor assigns IPs from its pools; the panel records them after creation. Customers can't pick an IP." : value.ipSource === "panel" ? "Always use IP Management (sync pools from Virtualizor there). Customers can pick an IP." : "Uses IP Management when it has IPs for the server, otherwise lets Virtualizor assign them."}>
        <Select value={value.ipSource ?? "auto"} onChange={(e) => onChange({ ipSource: e.target.value })}>
          <option value="auto">Automatic (recommended)</option>
          <option value="panel">IP Management (customer can choose)</option>
          <option value="virtualizor">Virtualizor assigns</option>
        </Select>
      </Field>
      <Field label="Advanced: extra Virtualizor parameters" hint="One key=value per line, sent when the VPS is created — e.g. vnc=1, nic_type=virtio, kvm_cache=writeback. # starts a comment.">
        <Textarea rows={3} className="font-mono text-xs" value={value.extraParams ?? ""} placeholder={"vnc=1\nnic_type=virtio"} onChange={(e) => onChange({ extraParams: e.target.value })} />
      </Field>
    </div>
  );
}

/** Virtualizor plans and OS templates use the same virt names (kvm, proxk, proxl…). */
const sameVirt = (a?: string | null, b?: string | null) => !a || !b || a === b || (a === "kvm" && b === "proxk") || (a === "proxk" && b === "kvm");

function OsPicker({ all, provisioner, serverIds, virt, selected, onChange, onSynced }: { all: any[]; provisioner: string; serverIds: string[]; virt?: string | null; selected: string[]; onChange: (ids: string[]) => void; onSynced: () => void }) {
  const [showAll, setShowAll] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const virtualizor = provisioner === "VIRTUALIZOR";
  // what fits this product: Virtualizor → templates of its masters with a matching virt type; Proxmox → manual templates
  const fits = (o: any) =>
    virtualizor ? o.source === "virtualizor" && (!serverIds.length || serverIds.includes(o.virtualizorServerId)) && sameVirt(virt, o.virtualizorVirt) : o.source !== "virtualizor";
  const shown = all.filter((o) => o.enabled !== false && (showAll || fits(o) || selected.includes(o.id)));
  const groups = [
    ["Linux", shown.filter((o) => o.family !== "windows")],
    ["Windows", shown.filter((o) => o.family === "windows")],
  ] as const;
  const toggle = (id: string) => onChange(selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id]);
  const fitting = all.filter((o) => o.enabled !== false && fits(o));
  const mismatched = selected.map((id) => all.find((o) => o.id === id)).filter((o) => o && !fits(o));

  async function sync() {
    setSyncing(true);
    try {
      const target = serverIds.length === 1 ? serverIds[0] : "all";
      const r = await api(`/admin/virtualizor/${target}/sync-os`, { body: {} });
      for (const x of r.results) x.ok ? toast.success(`${x.serverName}: ${x.found} templates (${x.created} new)`) : toast.error(`${x.serverName}: ${x.error}`);
      onSynced();
    } catch (e: any) {
      toast.error(e.message);
    } finally {
      setSyncing(false);
    }
  }

  return (
    <div>
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <div className="text-sm font-bold text-ink">
          Operating systems <span className="font-semibold text-mute">· {selected.length} offered</span>
        </div>
        <div className="flex flex-wrap gap-1.5">
          {virtualizor && <Button size="sm" variant="outline" icon="sync" loading={syncing} onClick={sync}>Sync from Virtualizor</Button>}
          <Button size="sm" variant="ghost" onClick={() => onChange([...new Set([...selected, ...fitting.map((o) => o.id)])])} disabled={!fitting.length}>Select all</Button>
          <Button size="sm" variant="ghost" onClick={() => onChange([])} disabled={!selected.length}>Clear</Button>
        </div>
      </div>
      {virtualizor && !fitting.length && (
        <Alert tone="warn" className="mb-2">
          No OS templates from {serverIds.length ? "the selected Virtualizor server" : "Virtualizor"}{virt ? ` for ${virt.toUpperCase()}` : ""} yet — click <b>Sync from Virtualizor</b>.
        </Alert>
      )}
      {mismatched.length > 0 && (
        <Alert tone="warn" className="mb-2">
          {mismatched.map((o: any) => o.name).join(", ")} {mismatched.length === 1 ? "doesn't" : "don't"} belong to this product's {virtualizor ? "Virtualizor server / virt type" : "module"} and may fail to install.
        </Alert>
      )}
      {groups.map(([label, list]) =>
        list.length ? (
          <div key={label} className="mb-2">
            <div className="mb-1.5 text-[11px] font-extrabold uppercase tracking-wider text-mute">{label}</div>
            <div className="flex flex-wrap gap-2">
              {list.map((o: any) => {
                const on = selected.includes(o.id);
                return (
                  <button key={o.id} type="button" onClick={() => toggle(o.id)} title={o.remoteName ? `${o.remoteName} · osid ${o.virtualizorOsId}` : undefined}
                    className={cx("inline-flex items-center gap-1.5 rounded-lg py-1 pl-1 pr-2.5 text-xs font-bold transition", on ? "bg-primary-dark text-white" : "bg-slate-100 text-slate-600 hover:bg-primary-tint")}>
                    <OsLogo os={o} size={20} className="rounded-md shadow-none ring-0" />
                    {o.name}
                    {on && <Icon name="check" className="text-[15px]" />}
                    {o.virtualizorVirt && <span className={cx("rounded px-1 text-[10px] uppercase", on ? "bg-white/20" : "bg-white text-mute")}>{o.virtualizorVirt}</span>}
                  </button>
                );
              })}
            </div>
          </div>
        ) : null,
      )}
      <button type="button" className="text-xs font-bold text-primary-dark hover:underline" onClick={() => setShowAll(!showAll)}>
        {showAll ? "Show only matching templates" : `Show all templates (${all.length})`}
      </button>
    </div>
  );
}

/** Setup checklist from /admin/products/:id/readiness — so problems show up before customers order. */
function Readiness({ data, onRecheck, loading }: { data: { ready: boolean; checks: any[] }; onRecheck: () => void; loading: boolean }) {
  const [open, setOpen] = useState(!data.ready);
  const bad = data.checks.filter((c) => c.status !== "ok");
  const tone = data.ready ? (bad.length ? "amber" : "emerald") : "rose";
  return (
    <div className={cx("mb-5 overflow-hidden rounded-2xl border", tone === "rose" ? "border-rose-200 bg-rose-50/60" : tone === "amber" ? "border-amber-200 bg-amber-50/60" : "border-emerald-200 bg-emerald-50/60")}>
      <button type="button" onClick={() => setOpen(!open)} className="flex w-full items-center gap-3 px-4 py-3 text-left">
        <Icon name={data.ready ? (bad.length ? "info" : "verified") : "error"} className={tone === "rose" ? "text-rose-600" : tone === "amber" ? "text-amber-600" : "text-emerald-600"} />
        <span className="flex-1 text-sm font-bold text-ink">
          {data.ready ? (bad.length ? `Ready to sell — ${bad.length} thing${bad.length === 1 ? "" : "s"} to look at` : "Ready to sell — every check passed") : `Not ready: ${data.checks.filter((c) => c.status === "error").length} problem(s) will stop orders from being provisioned`}
        </span>
        <span className="text-xs font-bold text-primary-dark" onClick={(e) => { e.stopPropagation(); onRecheck(); }}>{loading ? "Checking…" : "Re-check"}</span>
        <Icon name={open ? "expand_less" : "expand_more"} className="text-mute" />
      </button>
      {open && (
        <ul className="divide-y divide-black/5 border-t border-black/5 bg-white/70">
          {data.checks.map((c) => (
            <li key={c.key} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5 text-sm">
              <Icon name={c.status === "ok" ? "check_circle" : c.status === "warn" ? "warning" : "cancel"} className={cx("text-[20px]", c.status === "ok" ? "text-emerald-600" : c.status === "warn" ? "text-amber-500" : "text-rose-600")} />
              <span className="w-44 font-semibold text-ink">{c.label}</span>
              <span className="min-w-0 flex-1 text-mute">{c.detail}</span>
              {c.fix && (c.href ? <a href={c.href} className="text-xs font-bold text-primary-dark hover:underline">{c.fix} →</a> : <span className="text-xs font-bold text-primary-dark">{c.fix}</span>)}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function Chips({ label, items, selected, onToggle }: { label: string; items: { id: string; label: string }[]; selected: string[]; onToggle: (id: string) => void }) {
  return (
    <div>
      <div className="mb-1.5 text-[13px] font-bold text-slate-700">{label}</div>
      <div className="flex flex-wrap gap-2">
        {items.map((i) => <button key={i.id} type="button" onClick={() => onToggle(i.id)} className={cx("rounded-lg px-3 py-1.5 text-xs font-bold", selected.includes(i.id) ? "bg-primary-dark text-white" : "bg-slate-100 text-slate-600 hover:bg-primary-soft")}>{i.label}</button>)}
        {!items.length && <span className="text-xs text-mute">None configured.</span>}
      </div>
    </div>
  );
}
