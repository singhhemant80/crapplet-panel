"use client";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { api, CYCLES } from "@/lib/api";
import { Alert, Button, Card, Field, Input, Loading, PageHeader, Select, Textarea, Toggle, Icon, cx, toast, useApi } from "@/components/ui";

const TYPES = ["SHARED", "RESELLER_HOSTING", "WORDPRESS", "VPS_LINUX", "VPS_WINDOWS", "VPS_FOREX", "TALLY", "VPS_N8N", "VPS_MINECRAFT", "VPS_GOLD", "DEDICATED", "GPU", "COLOCATION", "CUSTOM"];
const CYC = ["MONTHLY", "QUARTERLY", "SEMIANNUAL", "ANNUAL", "BIENNIAL", "TRIENNIAL", "ONETIME"];

export default function ProductEditor() {
  const { id } = useParams<{ id: string }>();
  const isNew = id === "new";
  const router = useRouter();
  const prod = useApi(isNew ? null : `/admin/products/${id}`);
  const groups = useApi("/admin/product-groups");
  const servers = useApi("/admin/servers");
  const os = useApi("/admin/os-templates");
  const addons = useApi("/admin/addons");
  const [p, setP] = useState<any>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (isNew) setP({ name: "", slug: "", type: "VPS_LINUX", groupId: "", provisioner: "PROXMOX", virtType: "KVM", features: "", ipv4Count: 1, allowIpSelection: true, requireHostname: true, ipv6Enabled: false, hsnSac: "998315", taxable: true, enabled: true, hidden: false, featured: false, autoSetup: "ON_PAYMENT", sortOrder: 0, resellerEnabled: false, stockControl: false, stockQty: 0, moduleConfig: { proxmox: { storage: "", bridge: "", disk: "scsi0", cpuType: "host" }, virtualizor: { planId: "", virt: "kvm" } }, pricing: {}, wholesale: {}, serverIds: [], osTemplateIds: [], addonIds: [], configOptions: [] });
    else if (prod.data) {
      const x = prod.data.product;
      setP({
        ...x,
        features: x.features.join("\n"),
        pricing: Object.fromEntries(x.pricing.map((r: any) => [r.cycle, { price: r.price / 100, setupFee: r.setupFee / 100, enabled: r.enabled }])),
        wholesale: Object.fromEntries(x.wholesalePricing.map((r: any) => [r.cycle, r.price / 100])),
        serverIds: x.servers.map((s: any) => s.serverId),
        osTemplateIds: x.osTemplates.map((o: any) => o.osTemplateId),
        addonIds: x.addons.map((a: any) => a.addonId),
        moduleConfig: { proxmox: {}, virtualizor: {}, ...x.moduleConfig },
      });
    }
  }, [isNew, prod.data]);

  if (!p) return <Loading />;
  const set = (patch: any) => setP({ ...p, ...patch });
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
      resellerEnabled: p.resellerEnabled, moduleConfig: { proxmox: { ...p.moduleConfig.proxmox }, virtualizor: { ...p.moduleConfig.virtualizor, planId: num(p.moduleConfig.virtualizor?.planId) } },
      pricing: Object.entries(p.pricing).filter(([, v]: any) => v && v.price !== "" && v.price !== undefined).map(([cycle, v]: any) => ({ cycle, currency: "INR", price: Math.round(Number(v.price) * 100), setupFee: Math.round(Number(v.setupFee || 0) * 100), enabled: v.enabled !== false })),
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
        <Card title="Pricing (₹, excl. GST)">
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
              </>}
            </>}
          </div>
        </Card>
        <Card title="Servers, operating systems & add-ons">
          {isVps && !p.serverIds.length && <Alert tone="warn" className="mb-3">Assign at least one {srvType === "PROXMOX" ? "Proxmox" : "Virtualizor"} server — its IP pool is what customers choose from.</Alert>}
          <div className="space-y-4">
            <Chips label="Servers" items={(servers.data?.servers ?? []).filter((s: any) => !isVps || s.type === srvType).map((s: any) => ({ id: s.id, label: `${s.name} · ${s.freeIps} free IPs` }))} selected={p.serverIds} onToggle={(v) => toggleIn("serverIds", v)} />
            {isVps && <Chips label="Operating systems" items={(os.data?.items ?? []).map((o: any) => ({ id: o.id, label: o.name }))} selected={p.osTemplateIds} onToggle={(v) => toggleIn("osTemplateIds", v)} />}
            <Chips label="Add-ons" items={(addons.data?.items ?? []).map((a: any) => ({ id: a.id, label: a.name }))} selected={p.addonIds} onToggle={(v) => toggleIn("addonIds", v)} />
          </div>
        </Card>
        <Card title="Configurable options" className="xl:col-span-2">
          <p className="mb-3 text-sm text-mute">Monthly prices are multiplied by the billing cycle. Keys <code>extra_ipv4</code> and <code>extra_ram_gb</code> are applied automatically by the Proxmox module.</p>
          {p.configOptions.map((o: any, i: number) => (
            <div key={i} className="mb-2 grid items-center gap-2 rounded-xl border border-line p-3 md:grid-cols-[150px_1fr_130px_90px_90px_120px_auto]">
              <Input className="h-9" placeholder="key" value={o.key} onChange={(e) => set({ configOptions: p.configOptions.map((x: any, j: number) => (j === i ? { ...x, key: e.target.value } : x)) })} />
              <Input className="h-9" placeholder="Label" value={o.label} onChange={(e) => set({ configOptions: p.configOptions.map((x: any, j: number) => (j === i ? { ...x, label: e.target.value } : x)) })} />
              <Select className="h-9" value={o.type} onChange={(e) => set({ configOptions: p.configOptions.map((x: any, j: number) => (j === i ? { ...x, type: e.target.value } : x)) })}><option value="QUANTITY">Quantity</option><option value="YESNO">Yes / No</option><option value="SELECT">Dropdown</option></Select>
              <Input className="h-9" type="number" placeholder="min" value={o.minQty} onChange={(e) => set({ configOptions: p.configOptions.map((x: any, j: number) => (j === i ? { ...x, minQty: Number(e.target.value) } : x)) })} />
              <Input className="h-9" type="number" placeholder="max" value={o.maxQty} onChange={(e) => set({ configOptions: p.configOptions.map((x: any, j: number) => (j === i ? { ...x, maxQty: Number(e.target.value) } : x)) })} />
              <Input className="h-9" type="number" placeholder="₹/unit/mo" value={o.unitMonthly / 100} onChange={(e) => set({ configOptions: p.configOptions.map((x: any, j: number) => (j === i ? { ...x, unitMonthly: Math.round(Number(e.target.value) * 100) } : x)) })} />
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
