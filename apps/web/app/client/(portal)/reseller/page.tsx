"use client";
import { useState } from "react";
import { api, CYCLES, date, gb, money } from "@/lib/api";
import { useSession } from "@/lib/session";
import { Alert, Badge, Button, Card, Copy, Empty, Field, Input, Loading, Modal, PageHeader, Select, Stat, Table, Td, Textarea, cx, toast, useApi } from "@/components/ui";

export default function ResellerPage() {
  const { me, reload } = useSession();
  const r = me?.reseller;
  if (!r) return <Apply onDone={reload} />;
  if (r.status !== "APPROVED")
    return (
      <>
        <PageHeader title="VPS Reseller" />
        <Alert tone={r.status === "PENDING" ? "info" : "error"}>
          Your reseller application for <b>{r.brandName}</b> is <b>{r.status.toLowerCase()}</b>.{r.status === "PENDING" && " We usually review applications within one business day."}
        </Alert>
      </>
    );
  return <Dashboard />;
}

function Apply({ onDone }: { onDone: () => void }) {
  const [v, setV] = useState({ brandName: "", website: "", notes: "" });
  return (
    <>
      <PageHeader title="Become a VPS reseller" subtitle="Wholesale pricing, a prepaid wallet and a REST API to deploy VPS for your own customers." />
      <Card>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Brand / company name"><Input value={v.brandName} onChange={(e) => setV({ ...v, brandName: e.target.value })} /></Field>
          <Field label="Website (optional)"><Input value={v.website} onChange={(e) => setV({ ...v, website: e.target.value })} placeholder="https://" /></Field>
          <Field label="Tell us about your business" className="sm:col-span-2"><Textarea rows={4} value={v.notes} onChange={(e) => setV({ ...v, notes: e.target.value })} /></Field>
        </div>
        <Button className="mt-4" onClick={() => api("/client/reseller/apply", { body: v }).then(() => { toast.success("Application submitted"); onDone(); }).catch((e) => toast.error(e.message))}>Submit application</Button>
      </Card>
    </>
  );
}

function Dashboard() {
  const dash = useApi("/reseller/dashboard");
  const plans = useApi("/reseller/plans");
  const vps = useApi("/reseller/vps");
  const customers = useApi("/reseller/customers");
  const keys = useApi("/auth/api-keys");
  const [tab, setTab] = useState<"vps" | "plans" | "customers" | "api">("vps");
  const [deploy, setDeploy] = useState(false);
  const [newKey, setNewKey] = useState<string | null>(null);
  if (dash.loading || !dash.data) return <Loading />;
  const d = dash.data;
  return (
    <>
      <PageHeader title={`${d.reseller.brandName} · Reseller`} subtitle={`Wholesale discount ${d.reseller.discountPct}% on top of wholesale prices`} actions={<><Button variant="outline" href="/client/wallet" icon="account_balance_wallet">Top up wallet</Button><Button icon="rocket_launch" onClick={() => setDeploy(true)}>Deploy VPS</Button></>} />
      <div className="mb-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Stat label="Wallet balance" value={money(d.wallet)} icon="account_balance_wallet" tone="green" />
        <Stat label="Active VPS" value={d.stats.active} icon="dns" />
        <Stat label="Customers" value={d.stats.customers} icon="groups" tone="sky" />
        <Stat label="Monthly margin" value={money(d.stats.monthlyRetail - d.stats.monthlyCost)} icon="trending_up" tone="amber" hint={`cost ${money(d.stats.monthlyCost)}/mo`} />
      </div>
      <div className="mb-4 flex gap-2 overflow-x-auto">
        {(["vps", "plans", "customers", "api"] as const).map((t) => (
          <button key={t} onClick={() => setTab(t)} className={cx("rounded-full px-4 py-2 text-sm font-bold capitalize", tab === t ? "bg-primary-dark text-white" : "bg-white text-slate-600 ring-1 ring-line")}>{t === "api" ? "API access" : t === "vps" ? "VPS" : t}</button>
        ))}
      </div>
      {tab === "vps" && (
        <Card pad={false}>
          {!vps.data?.vps.length ? <Empty icon="dns" title="No VPS yet" /> : (
            <Table head={["Hostname", "Plan", "IP", "Status", "Next due", "Cost / Retail", ""]}>
              {vps.data.vps.map((v: any) => (
                <tr key={v.id}>
                  <Td className="font-bold text-ink">{v.hostname}</Td>
                  <Td>{v.plan}</Td>
                  <Td className="font-mono text-xs">{v.ip ?? "—"}</Td>
                  <Td><Badge status={v.status} /></Td>
                  <Td className="whitespace-nowrap text-mute">{date(v.nextDueDate)}</Td>
                  <Td>{money(v.wholesaleAmount)} / {v.retailAmount != null ? money(v.retailAmount) : "—"}</Td>
                  <Td className="whitespace-nowrap text-right">
                    {["reboot", v.status === "SUSPENDED" ? "unsuspend" : "suspend"].map((a) => (
                      <button key={a} className="ml-3 text-xs font-bold capitalize text-primary-dark hover:underline" onClick={() => api(`/reseller/vps/${v.id}/action`, { body: { action: a } }).then(() => { toast.success(`${a} queued`); setTimeout(vps.reload, 3000); }).catch((e) => toast.error(e.message))}>{a}</button>
                    ))}
                  </Td>
                </tr>
              ))}
            </Table>
          )}
        </Card>
      )}
      {tab === "plans" && <Plans plans={plans.data?.plans ?? []} onSaved={plans.reload} />}
      {tab === "customers" && <Customers list={customers.data?.customers ?? []} reload={customers.reload} />}
      {tab === "api" && <ApiTab keys={keys} newKey={newKey} setNewKey={setNewKey} />}
      <DeployModal open={deploy} onClose={() => setDeploy(false)} plans={plans.data?.plans ?? []} customers={customers.data?.customers ?? []} onDone={() => { setDeploy(false); vps.reload(); dash.reload(); }} />
    </>
  );
}

function Plans({ plans, onSaved }: { plans: any[]; onSaved: () => void }) {
  const [edits, setEdits] = useState<Record<string, string>>({});
  return (
    <Card pad={false}>
      <Table head={["Plan", "Specs", "Cycle", "List price", "Your cost", "Your retail price"]}>
        {plans.flatMap((p) =>
          p.prices.filter((x: any) => x.cycle === "MONTHLY" || x.cycle === "ANNUAL").map((x: any) => {
            const k = `${p.id}:${x.cycle}`;
            return (
              <tr key={k}>
                <Td className="font-bold text-ink">{p.name}</Td>
                <Td className="text-xs text-mute">{p.specs.cpuCores} vCPU · {gb(p.specs.ramMb)} · {p.specs.diskGb} GB</Td>
                <Td>{CYCLES[x.cycle]}</Td>
                <Td className="text-mute">{money(x.retailList)}</Td>
                <Td className="font-bold text-emerald-700">{money(x.wholesale)}</Td>
                <Td><Input className="h-9 w-32" type="number" placeholder={x.yourRetail != null ? String(x.yourRetail / 100) : "₹"} value={edits[k] ?? ""} onChange={(e) => setEdits({ ...edits, [k]: e.target.value })} /></Td>
              </tr>
            );
          }),
        )}
      </Table>
      <div className="border-t border-line p-4">
        <Button disabled={!Object.keys(edits).length} onClick={() => api("/reseller/prices", { method: "PUT", body: { prices: Object.entries(edits).filter(([, v]) => v !== "").map(([k, v]) => { const [productId, cycle] = k.split(":"); return { productId, cycle, retail: Math.round(Number(v) * 100) }; }) } }).then(() => { toast.success("Retail prices saved"); setEdits({}); onSaved(); }).catch((e) => toast.error(e.message))}>Save retail prices</Button>
      </div>
    </Card>
  );
}

function Customers({ list, reload }: { list: any[]; reload: () => void }) {
  const [v, setV] = useState({ email: "", firstName: "", lastName: "", companyName: "" });
  return (
    <Card pad={false}>
      <div className="grid gap-3 border-b border-line p-4 sm:grid-cols-5">
        <Input placeholder="Email" value={v.email} onChange={(e) => setV({ ...v, email: e.target.value })} />
        <Input placeholder="First name" value={v.firstName} onChange={(e) => setV({ ...v, firstName: e.target.value })} />
        <Input placeholder="Last name" value={v.lastName} onChange={(e) => setV({ ...v, lastName: e.target.value })} />
        <Input placeholder="Company" value={v.companyName} onChange={(e) => setV({ ...v, companyName: e.target.value })} />
        <Button onClick={() => api("/reseller/customers", { body: v }).then(() => { setV({ email: "", firstName: "", lastName: "", companyName: "" }); reload(); }).catch((e) => toast.error(e.message))}>Add customer</Button>
      </div>
      {!list.length ? <Empty icon="groups" title="No customers yet" /> : (
        <Table head={["Name", "Email", "Company", "Added"]}>
          {list.map((c) => <tr key={c.id}><Td className="font-semibold">{c.firstName} {c.lastName}</Td><Td>{c.email}</Td><Td className="text-mute">{c.profile?.companyName ?? "—"}</Td><Td className="whitespace-nowrap text-mute">{date(c.createdAt)}</Td></tr>)}
        </Table>
      )}
    </Card>
  );
}

function DeployModal({ open, onClose, plans, customers, onDone }: { open: boolean; onClose: () => void; plans: any[]; customers: any[]; onDone: () => void }) {
  const [planId, setPlanId] = useState("");
  const [os, setOs] = useState("");
  const [hostname, setHostname] = useState("");
  const [customerId, setCustomerId] = useState("");
  const [ips, setIps] = useState<any[]>([]);
  const [ipId, setIpId] = useState("");
  const [busy, setBusy] = useState(false);
  const plan = plans.find((p) => p.id === planId);
  return (
    <Modal open={open} onClose={onClose} title="Deploy a VPS" wide>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Plan"><Select value={planId} onChange={(e) => { setPlanId(e.target.value); setOs(""); setIpId(""); const p = plans.find((x) => x.id === e.target.value); if (p?.allowIpSelection) api(`/reseller/ips?productId=${p.id}`).then((r) => setIps(r.ips)); else setIps([]); }}><option value="">Select…</option>{plans.map((p) => <option key={p.id} value={p.id}>{p.name} — {money(p.prices.find((x: any) => x.cycle === "MONTHLY")?.wholesale)}/mo</option>)}</Select></Field>
        <Field label="Operating system"><Select value={os} onChange={(e) => setOs(e.target.value)} disabled={!plan}><option value="">Select…</option>{plan?.os.map((o: any) => <option key={o.id} value={o.id}>{o.name}</option>)}</Select></Field>
        <Field label="Hostname"><Input value={hostname} onChange={(e) => setHostname(e.target.value)} placeholder="vps1.yourbrand.com" /></Field>
        <Field label="Customer (optional)"><Select value={customerId} onChange={(e) => setCustomerId(e.target.value)}><option value="">—</option>{customers.map((c) => <option key={c.id} value={c.id}>{c.firstName} {c.lastName} ({c.email})</option>)}</Select></Field>
        {plan?.allowIpSelection && <Field label="IPv4 address" className="sm:col-span-2"><Select value={ipId} onChange={(e) => setIpId(e.target.value)}><option value="">Assign automatically</option>{ips.map((i) => <option key={i.id} value={i.id}>{i.address}</option>)}</Select></Field>}
      </div>
      <Button className="mt-5 w-full" loading={busy} disabled={!planId || !os || hostname.length < 3} onClick={async () => {
        setBusy(true);
        try {
          if (ipId) await api(`/reseller/ips/${ipId}/reserve`, { body: { productId: planId } });
          await api("/reseller/vps", { body: { planId, osTemplateId: os, hostname, customerId: customerId || undefined, ipId: ipId || undefined } });
          toast.success("VPS is being deployed — paid from your wallet");
          onDone();
        } catch (e: any) { toast.error(e.message); } finally { setBusy(false); }
      }}>Deploy &amp; pay from wallet</Button>
    </Modal>
  );
}


/** API keys, webhook and docs — everything a reseller's website needs to sell our plans. */
function ApiTab({ keys, newKey, setNewKey }: { keys: any; newKey: string | null; setNewKey: (k: string | null) => void }) {
  const hook = useApi("/reseller/webhook");
  const [url, setUrl] = useState("");
  const [secret, setSecret] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const origin = typeof window !== "undefined" ? window.location.origin : "";
  async function createKey() {
    const name = prompt("Key name (e.g. my website)", "website");
    if (!name) return;
    const ips = prompt("Only allow these server IPs (comma-separated) — leave empty to allow any", "") ?? "";
    try {
      const r = await api("/auth/api-keys", { body: { name, scopes: ["reseller"], allowedIps: ips.split(/[\s,]+/).map((x) => x.trim()).filter(Boolean) } });
      setNewKey(r.key);
      keys.reload();
    } catch (e: any) {
      toast.error(e.message);
    }
  }
  async function saveHook() {
    setBusy("save");
    try {
      const r = await api("/reseller/webhook", { method: "PUT", body: { url } });
      setSecret(r.secret);
      setUrl("");
      hook.reload();
    } catch (e: any) {
      toast.error(e.message);
    }
    setBusy(null);
  }
  return (
    <div className="space-y-5">
      <Alert tone="info">
        Sell our plans on your own website: your site calls our API with a key, the order is paid from your wallet at your wholesale price, and we notify your site when the server is ready.{" "}
        <a href="/api-docs" target="_blank" rel="noreferrer" className="font-bold underline">Read the API documentation →</a>
      </Alert>
      <Card title="API keys">
        {newKey && <Alert tone="success" className="mb-4"><div className="font-bold">Copy your key now — it won't be shown again.</div><div className="mt-1 flex items-center gap-2 break-all font-mono text-xs">{newKey}<Copy text={newKey} /></div></Alert>}
        <Table head={["Name", "Key", "Allowed IPs", "Last used", ""]}>
          {keys.data?.keys.map((k: any) => (
            <tr key={k.id}>
              <Td className="font-semibold">{k.name}</Td>
              <Td className="font-mono text-xs">ck_{k.keyPrefix}_…</Td>
              <Td className="text-xs text-mute">{k.allowedIps?.length ? k.allowedIps.join(", ") : "any"}</Td>
              <Td className="whitespace-nowrap text-mute">{date(k.lastUsedAt, true)}</Td>
              <Td className="text-right"><button className="text-xs font-bold text-rose-600" onClick={() => confirm(`Revoke ${k.name}? Anything using it stops working.`) && api(`/auth/api-keys/${k.id}`, { method: "DELETE" }).then(keys.reload)}>Revoke</button></Td>
            </tr>
          ))}
        </Table>
        <Button className="mt-4" icon="key" onClick={createKey}>Create API key</Button>
        <p className="mt-2 text-xs text-mute">Keep keys on your server only — never in browser JavaScript. Limit a key to your web server's IP for extra safety.</p>
      </Card>
      <Card title="Webhook — get told when things change">
        {secret && <Alert tone="success" className="mb-4"><div className="font-bold">Signing secret — copy it now, it won't be shown again.</div><div className="mt-1 flex items-center gap-2 break-all font-mono text-xs">{secret}<Copy text={secret} /></div></Alert>}
        <p className="mb-3 text-sm text-slate-600">We POST signed JSON to your URL when a service becomes active, fails, is suspended, unsuspended, terminated or reinstalled, and when an invoice is paid.</p>
        {hook.data?.url ? (
          <div className="mb-4 rounded-xl border border-line p-3 text-sm">
            <div className="flex flex-wrap items-center justify-between gap-2"><span className="break-all font-mono text-xs">{hook.data.url}</span>
              <span className="flex gap-2">
                <Button size="sm" variant="secondary" loading={busy === "test"} onClick={async () => { setBusy("test"); try { const r = await api("/reseller/webhook/test", { body: {} }); toast[/delivered/.test(r.lastDelivery ?? "") ? "success" : "error"](r.lastDelivery ?? "No answer"); hook.reload(); } catch (e: any) { toast.error(e.message); } setBusy(null); }}>Send test</Button>
                <Button size="sm" variant="ghost" onClick={() => confirm("Stop sending events?") && api("/reseller/webhook", { method: "DELETE" }).then(() => hook.reload())}>Remove</Button>
              </span>
            </div>
            {hook.data.lastDelivery && <div className="mt-1 text-xs text-mute">Last: {hook.data.lastDelivery} · {date(hook.data.lastDeliveryAt, true)}</div>}
          </div>
        ) : null}
        <div className="flex flex-wrap gap-2">
          <Input className="min-w-0 flex-1" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://yourwebsite.com/crapplet-webhook" />
          <Button icon="save" loading={busy === "save"} disabled={!url.trim()} onClick={saveHook}>{hook.data?.url ? "Change URL" : "Save URL"}</Button>
        </div>
        <p className="mt-2 text-xs text-mute">https only. Saving a URL creates a new signing secret.</p>
      </Card>
      <Card title="Quick start">
        <div className="rounded-xl bg-ink p-4 font-mono text-[12.5px] leading-relaxed text-violet-100">
          <div className="text-violet-300"># Plans you can sell, with your wholesale prices</div>
          curl -H &quot;Authorization: Bearer ck_…&quot; {origin}/api/v1/reseller/plans<br /><br />
          <div className="text-violet-300"># Order (paid from your wallet; reference makes retries safe)</div>
          curl -X POST -H &quot;Authorization: Bearer ck_…&quot; -H &quot;Content-Type: application/json&quot; \<br />
          &nbsp;&nbsp;-d &apos;{`{"planId":"PLAN_ID","cycle":"MONTHLY","hostname":"vps1.example.com","osTemplateId":"OS_ID","reference":"YOUR-ORDER-1001"}`}&apos; \<br />
          &nbsp;&nbsp;{origin}/api/v1/reseller/orders<br /><br />
          <div className="text-violet-300"># Then: GET /services/:id · POST /services/:id/action · GET /invoices · POST /invoices/:id/pay</div>
        </div>
      </Card>
    </div>
  );
}
