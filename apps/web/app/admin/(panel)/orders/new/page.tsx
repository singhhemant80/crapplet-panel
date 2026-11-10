"use client";
import { Suspense, useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { api, CYCLES, money } from "@/lib/api";
import { Alert, Button, Card, Field, Icon, Input, Loading, PageHeader, Select, Textarea, Toggle, cx, toast, useApi } from "@/components/ui";
import { OsLogo } from "@/components/os-logo";
import { PasswordField, passwordProblem } from "@/components/password-field";

export default function Page() {
  return (
    <Suspense fallback={<Loading />}>
      <NewOrder />
    </Suspense>
  );
}

/** Staff place an order for a customer — same checkout as the shop, with an optional root password. */
function NewOrder() {
  const router = useRouter();
  const sp = useSearchParams();
  const { data: pd, loading } = useApi<{ products: any[] }>("/admin/products");
  const [q, setQ] = useState("");
  const [found, setFound] = useState<any[]>([]);
  const [client, setClient] = useState<any>(null);
  const [productId, setProductId] = useState("");
  const [cycle, setCycle] = useState("");
  const [os, setOs] = useState("");
  const [hostname, setHostname] = useState("");
  const [password, setPassword] = useState("");
  const [qty, setQty] = useState(1);
  const [markPaid, setMarkPaid] = useState(false);
  const [reference, setReference] = useState("");
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);

  // preselect a customer when opened from their page (?client=<id>)
  useEffect(() => {
    const id = sp.get("client");
    if (id) api(`/admin/clients/${id}`).then((r) => setClient(r.client ?? r.user ?? r)).catch(() => {});
  }, [sp]);
  useEffect(() => {
    if (q.trim().length < 2) return setFound([]);
    const t = setTimeout(() => api(`/admin/clients?q=${encodeURIComponent(q.trim())}&pageSize=8`).then((r) => setFound(r.clients ?? [])).catch(() => {}), 250);
    return () => clearTimeout(t);
  }, [q]);

  const products = (pd?.products ?? []).filter((p: any) => p.enabled);
  const p = products.find((x: any) => x.id === productId);
  const isVps = p && (p.provisioner === "PROXMOX" || p.provisioner === "VIRTUALIZOR");
  const cycles = useMemo(() => (p?.pricing ?? []).filter((x: any) => x.currency === "INR" && x.enabled), [p]);
  const oses = (p?.osTemplates ?? []).map((x: any) => x.osTemplate).filter((o: any) => o.enabled);
  useEffect(() => {
    setCycle(cycles.find((c: any) => c.cycle === "MONTHLY")?.cycle ?? cycles[0]?.cycle ?? "");
    setOs(oses[0]?.id ?? "");
  }, [productId]); // eslint-disable-line react-hooks/exhaustive-deps

  if (loading) return <Loading />;

  async function submit() {
    if (!client) return toast.error("Choose the customer");
    if (!p || !cycle) return toast.error("Choose a plan and billing cycle");
    if (isVps && p.requireHostname && !/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i.test(hostname)) return toast.error("Enter a hostname like server1.example.com");
    const pw = passwordProblem(password);
    if (pw) return toast.error(`Root password: ${pw}`);
    setBusy(true);
    try {
      const r = await api("/admin/orders", {
        body: {
          userId: client.id,
          items: [{ productId: p.id, cycle, osTemplateId: isVps ? os || null : null, hostname: hostname || null, rootPassword: isVps ? password || null : null, quantity: qty, config: {}, addonIds: [] }],
          domains: [],
          notes: notes || undefined,
          markPaid,
          paymentReference: reference || undefined,
        },
      });
      toast.success(`Order ${r.orderNumber} created${r.paid ? " and paid — setup has started" : " — invoice sent"}`);
      router.push(`/admin/orders/${r.orderId}`);
    } catch (e: any) {
      toast.error(e.message);
      setBusy(false);
    }
  }

  const price = cycles.find((c: any) => c.cycle === cycle);
  return (
    <>
      <PageHeader back="/admin/orders" title="New order" subtitle="Place an order for a customer. It goes through the normal checkout: invoice, tax, emails and automatic setup." />
      <div className="grid gap-6 xl:grid-cols-[1fr_340px]">
        <div className="space-y-5">
          <Card title="1 · Customer">
            {client ? (
              <div className="flex items-center justify-between gap-3 rounded-xl bg-primary-tint px-4 py-3 ring-1 ring-[#e9d5ff]">
                <div><div className="font-bold text-ink">{[client.firstName, client.lastName].filter(Boolean).join(" ") || client.email}</div><div className="text-xs text-mute">{client.email}</div></div>
                <Button size="sm" variant="ghost" onClick={() => setClient(null)}>Change</Button>
              </div>
            ) : (
              <>
                <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search by name, email or GSTIN" autoFocus />
                {found.length > 0 && (
                  <div className="mt-2 divide-y divide-line overflow-hidden rounded-xl border border-line">
                    {found.map((c) => (
                      <button key={c.id} type="button" onClick={() => { setClient(c); setQ(""); setFound([]); }} className="flex w-full items-center justify-between px-4 py-2.5 text-left hover:bg-[#fbf9ff]">
                        <span><b className="text-sm text-ink">{[c.firstName, c.lastName].filter(Boolean).join(" ") || "—"}</b><span className="ml-2 text-xs text-mute">{c.email}</span></span>
                        <Icon name="chevron_right" className="text-mute" />
                      </button>
                    ))}
                  </div>
                )}
              </>
            )}
          </Card>

          <Card title="2 · Plan">
            <div className="grid gap-4 sm:grid-cols-[1fr_200px_110px]">
              <Field label="Plan">
                <Select value={productId} onChange={(e) => setProductId(e.target.value)}>
                  <option value="">Choose…</option>
                  {products.map((x: any) => <option key={x.id} value={x.id}>{x.name}</option>)}
                </Select>
              </Field>
              <Field label="Billing cycle">
                <Select value={cycle} onChange={(e) => setCycle(e.target.value)} disabled={!p}>
                  {cycles.map((c: any) => <option key={c.cycle} value={c.cycle}>{CYCLES[c.cycle] ?? c.cycle} — {money(c.price, "INR")}</option>)}
                </Select>
              </Field>
              <Field label="Quantity"><Input type="number" min={1} max={10} value={qty} onChange={(e) => setQty(Math.max(1, Math.min(10, Number(e.target.value) || 1)))} /></Field>
            </div>
          </Card>

          {isVps && (
            <Card title="3 · Server setup">
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Hostname"><Input value={hostname} onChange={(e) => setHostname(e.target.value.toLowerCase().trim())} placeholder="server1.example.com" /></Field>
                <Field label="Operating system">
                  <Select value={os} onChange={(e) => setOs(e.target.value)}>{oses.map((o: any) => <option key={o.id} value={o.id}>{o.name}</option>)}</Select>
                </Field>
              </div>
              {oses.find((o: any) => o.id === os) && <div className="mt-2 flex items-center gap-2 text-xs text-mute"><OsLogo os={oses.find((o: any) => o.id === os)} size={20} />{oses.find((o: any) => o.id === os).name}</div>}
              <div className="mt-4">
                <div className="mb-1.5 text-sm font-bold text-ink">Root password{qty > 1 ? ` (used for all ${qty} servers)` : ""}</div>
                <PasswordField value={password} onChange={setPassword} optionalHint="Leave empty to generate one — it's emailed to the customer when the server is ready" />
              </div>
            </Card>
          )}

          <Card title={isVps ? "4 · Payment" : "3 · Payment"}>
            <Toggle checked={markPaid} onChange={setMarkPaid} label="Mark the invoice as paid now (payment received offline) — setup starts right away" />
            {markPaid && <Field label="Payment reference (optional)" className="mt-3 max-w-sm"><Input value={reference} onChange={(e) => setReference(e.target.value)} placeholder="UTR / cheque no." /></Field>}
            {!markPaid && <p className="mt-2 text-xs text-mute">The customer gets the invoice by email; setup starts when it's paid.</p>}
            <Field label="Note on the order (optional)" className="mt-4"><Textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} /></Field>
          </Card>
        </div>

        <aside>
          <Card title="Summary" className="xl:sticky xl:top-24">
            <dl className="space-y-2 text-sm">
              <div className="flex justify-between gap-3"><dt className="text-mute">Customer</dt><dd className="truncate text-right font-semibold">{client?.email ?? "—"}</dd></div>
              <div className="flex justify-between gap-3"><dt className="text-mute">Plan</dt><dd className="text-right font-semibold">{p?.name ?? "—"}{qty > 1 ? ` × ${qty}` : ""}</dd></div>
              <div className="flex justify-between gap-3"><dt className="text-mute">Price</dt><dd className="text-right font-semibold">{price ? `${money(price.price * qty, "INR")} ${CYCLES[cycle]?.toLowerCase() ?? ""}` : "—"}</dd></div>
              {isVps && <div className="flex justify-between gap-3"><dt className="text-mute">Root password</dt><dd className={cx("text-right font-semibold", password ? "text-emerald-700" : "text-mute")}>{password ? "Set by staff" : "Generated"}</dd></div>}
            </dl>
            <p className="mt-3 text-xs text-mute">Tax and the final total are worked out by the invoice, as in the shop.</p>
            <Button className="mt-4 w-full" icon="shopping_cart_checkout" loading={busy} onClick={submit}>Create order</Button>
            {!client && <Alert className="mt-3" tone="info">Choose a customer first.</Alert>}
          </Card>
        </aside>
      </div>
    </>
  );
}
