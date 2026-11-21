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

type Line = { key: number; productId: string; cycle: string; os: string; hostname: string; password: string; qty: number };
let nextKey = 1;
const blank = (): Line => ({ key: nextKey++, productId: "", cycle: "", os: "", hostname: "", password: "", qty: 1 });
const HOST = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i;

/** Staff place an order for a customer — same checkout as the shop: one or more plans, an optional promo code. */
function NewOrder() {
  const router = useRouter();
  const sp = useSearchParams();
  const { data: pd, loading } = useApi<{ products: any[] }>("/admin/products");
  const [q, setQ] = useState("");
  const [found, setFound] = useState<any[]>([]);
  const [client, setClient] = useState<any>(null);
  const [lines, setLines] = useState<Line[]>(() => [blank()]);
  const [markPaid, setMarkPaid] = useState(false);
  const [reference, setReference] = useState("");
  const [notes, setNotes] = useState("");
  const [promo, setPromo] = useState("");
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
  const productOf = (l: Line) => products.find((x: any) => x.id === l.productId);
  const cyclesOf = (p: any) => (p?.pricing ?? []).filter((x: any) => x.currency === "INR" && x.enabled);
  const osesOf = (p: any) => (p?.osTemplates ?? []).map((x: any) => x.osTemplate).filter((o: any) => o.enabled);
  const vps = (p: any) => p && (p.provisioner === "PROXMOX" || p.provisioner === "VIRTUALIZOR");
  const update = (key: number, patch: Partial<Line>) => setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  const pickPlan = (key: number, productId: string) => {
    const p = products.find((x: any) => x.id === productId);
    const cs = cyclesOf(p);
    update(key, { productId, cycle: cs.find((c: any) => c.cycle === "MONTHLY")?.cycle ?? cs[0]?.cycle ?? "", os: osesOf(p)[0]?.id ?? "" });
  };

  const chosen = lines.filter((l) => l.productId && l.cycle);
  const pairs = chosen.map((l) => `${l.productId}:${l.cycle}`).join(",");
  const promoQs = new URLSearchParams({ ...(pairs ? { items: pairs } : {}), ...(client?.id ? { userId: client.id } : {}) }).toString();
  const { data: pc } = useApi<{ codes: any[] }>(`/admin/order-promo-codes?${promoQs}`, [promoQs]);
  const promoCodes = pc?.codes ?? [];
  const chosenPromo = promoCodes.find((c) => c.code === promo);
  // a code that stopped fitting (other plans / cycles / customer) is cleared
  useEffect(() => {
    if (promo && pc && !promoCodes.some((c) => c.code === promo && c.eligible)) setPromo("");
  }, [pc]); // eslint-disable-line react-hooks/exhaustive-deps
  const promoLabel = (c: any) => `${c.type === "PERCENT" ? `${c.value}% off` : `${money(c.value, "INR")} off`}${c.recurring ? " every renewal" : " first invoice"}`;

  const priced = useMemo(
    () =>
      chosen.map((l) => {
        const p = productOf(l);
        const price = cyclesOf(p).find((c: any) => c.cycle === l.cycle)?.price ?? 0;
        const fits = chosenPromo && (!chosenPromo.productIds?.length || chosenPromo.productIds.includes(l.productId)) && (!chosenPromo.cycles?.length || chosenPromo.cycles.includes(l.cycle));
        const amount = price * l.qty;
        const off = fits ? (chosenPromo.type === "PERCENT" ? Math.round((amount * chosenPromo.value) / 100) : Math.min(chosenPromo.value, amount)) : 0;
        return { l, p, amount, off };
      }),
    [chosen, chosenPromo], // eslint-disable-line react-hooks/exhaustive-deps
  );
  const subtotal = priced.reduce((n, x) => n + x.amount, 0);
  const discount = priced.reduce((n, x) => n + x.off, 0);

  if (loading) return <Loading />;

  async function submit() {
    if (!client) return toast.error("Choose the customer");
    if (!chosen.length) return toast.error("Choose at least one plan and billing cycle");
    for (const [n, l] of lines.entries()) {
      const p = productOf(l);
      if (!p || !l.cycle) return toast.error(`Item ${n + 1}: choose a plan and billing cycle — or remove it`);
      if (vps(p) && p.requireHostname && !HOST.test(l.hostname)) return toast.error(`Item ${n + 1}: enter a hostname like server1.example.com`);
      const pw = vps(p) ? passwordProblem(l.password) : null;
      if (pw) return toast.error(`Item ${n + 1} root password: ${pw}`);
    }
    setBusy(true);
    try {
      const r = await api("/admin/orders", {
        body: {
          userId: client.id,
          items: lines.map((l) => {
            const p = productOf(l);
            return { productId: l.productId, cycle: l.cycle, osTemplateId: vps(p) ? l.os || null : null, hostname: l.hostname || null, rootPassword: vps(p) ? l.password || null : null, quantity: l.qty, config: {}, addonIds: [] };
          }),
          domains: [],
          notes: notes || undefined,
          promoCode: promo || null,
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

  return (
    <>
      <PageHeader back="/admin/orders" title="New order" subtitle="Place an order for a customer — one or more plans in a single order. It goes through the normal checkout: invoice, tax, emails and automatic setup." />
      <div className="grid gap-6 xl:grid-cols-[1fr_360px]">
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

          {lines.map((l, n) => {
            const p = productOf(l);
            const cycles = cyclesOf(p);
            const oses = osesOf(p);
            const os = oses.find((o: any) => o.id === l.os);
            return (
              <Card
                key={l.key}
                title={`2 · ${lines.length > 1 ? `Item ${n + 1}` : "Plan"}${p ? ` — ${p.name}` : ""}`}
                action={lines.length > 1 ? <Button size="sm" variant="ghost" icon="delete" onClick={() => setLines((ls) => ls.filter((x) => x.key !== l.key))}>Remove</Button> : undefined}
              >
                <div className="grid gap-4 sm:grid-cols-[1fr_200px_110px]">
                  <Field label="Plan">
                    <Select value={l.productId} onChange={(e) => pickPlan(l.key, e.target.value)}>
                      <option value="">Choose…</option>
                      {products.map((x: any) => <option key={x.id} value={x.id}>{x.name}</option>)}
                    </Select>
                  </Field>
                  <Field label="Billing cycle">
                    <Select value={l.cycle} onChange={(e) => update(l.key, { cycle: e.target.value })} disabled={!p}>
                      {p && !cycles.length && <option value="">No INR price set for this plan</option>}
                      {cycles.map((c: any) => <option key={c.cycle} value={c.cycle}>{CYCLES[c.cycle] ?? c.cycle} — {money(c.price, "INR")}</option>)}
                    </Select>
                  </Field>
                  <Field label="Quantity"><Input type="number" min={1} max={10} value={l.qty} onChange={(e) => update(l.key, { qty: Math.max(1, Math.min(10, Number(e.target.value) || 1)) })} /></Field>
                </div>
                {vps(p) && (
                  <div className="mt-4 border-t border-line pt-4">
                    <div className="grid gap-4 sm:grid-cols-2">
                      <Field label="Hostname"><Input value={l.hostname} onChange={(e) => update(l.key, { hostname: e.target.value.toLowerCase().trim() })} placeholder="server1.example.com" /></Field>
                      <Field label="Operating system">
                        <Select value={l.os} onChange={(e) => update(l.key, { os: e.target.value })}>{oses.map((o: any) => <option key={o.id} value={o.id}>{o.name}</option>)}</Select>
                      </Field>
                    </div>
                    {os && <div className="mt-2 flex items-center gap-2 text-xs text-mute"><OsLogo os={os} size={20} />{os.name}</div>}
                    <div className="mt-4">
                      <div className="mb-1.5 text-sm font-bold text-ink">Root password{l.qty > 1 ? ` (used for all ${l.qty} servers)` : ""}</div>
                      <PasswordField value={l.password} onChange={(v) => update(l.key, { password: v })} optionalHint="Leave empty to generate one — it's emailed to the customer when the server is ready" />
                    </div>
                  </div>
                )}
              </Card>
            );
          })}
          <button
            type="button"
            onClick={() => setLines((ls) => [...ls, blank()])}
            disabled={lines.length >= 20}
            className="flex w-full items-center justify-center gap-2 rounded-2xl border-2 border-dashed border-[#dccafb] bg-white/60 py-4 text-sm font-bold text-primary-dark transition hover:border-primary hover:bg-primary-tint disabled:opacity-50"
          >
            <Icon name="add_circle" className="text-[20px]" />Add another plan to this order
          </button>

          <Card title="3 · Promo code">
            <Field
              label="Apply a promo code (optional)"
              hint={chosenPromo ? `${promoLabel(chosenPromo)}${chosenPromo.usesLeft !== null ? ` · ${chosenPromo.usesLeft} use${chosenPromo.usesLeft === 1 ? "" : "s"} left` : ""}${chosenPromo.expiresAt ? ` · until ${new Date(chosenPromo.expiresAt).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" })}` : ""}` : promoCodes.length ? `${promoCodes.filter((c) => c.eligible).length} of ${promoCodes.length} active codes fit this order` : "No active promo codes — create them under Catalogue → Promo Codes"}
            >
              <Select value={promo} onChange={(e) => setPromo(e.target.value)} disabled={!promoCodes.length}>
                <option value="">No promo code</option>
                {promoCodes.filter((c) => c.eligible).map((c) => <option key={c.code} value={c.code}>{c.code} — {promoLabel(c)}</option>)}
                {promoCodes.some((c) => !c.eligible) && (
                  <optgroup label="Don't fit this order">
                    {promoCodes.filter((c) => !c.eligible).map((c) => <option key={c.code} value={c.code} disabled>{c.code} — {c.reason}</option>)}
                  </optgroup>
                )}
              </Select>
            </Field>
          </Card>

          <Card title="4 · Payment">
            <Toggle checked={markPaid} onChange={setMarkPaid} label="Mark the invoice as paid now (payment received offline) — setup starts right away" />
            {markPaid && <Field label="Payment reference (optional)" className="mt-3 max-w-sm"><Input value={reference} onChange={(e) => setReference(e.target.value)} placeholder="UTR / cheque no." /></Field>}
            {!markPaid && <p className="mt-2 text-xs text-mute">The customer gets one invoice for the whole order by email; setup starts when it's paid.</p>}
            <Field label="Note on the order (optional)" className="mt-4"><Textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} /></Field>
          </Card>
        </div>

        <aside>
          <Card title="Summary" className="xl:sticky xl:top-24">
            <dl className="space-y-2 text-sm">
              <div className="flex justify-between gap-3"><dt className="text-mute">Customer</dt><dd className="truncate text-right font-semibold">{client?.email ?? "—"}</dd></div>
              {priced.length ? (
                priced.map(({ l, p, amount }) => (
                  <div key={l.key} className="flex justify-between gap-3">
                    <dt className="min-w-0 text-mute"><span className="block truncate">{p?.name}{l.qty > 1 ? ` × ${l.qty}` : ""}</span><span className="text-[11.5px]">{CYCLES[l.cycle] ?? l.cycle}{vps(p) ? ` · ${l.password ? "password set" : "password generated"}` : ""}</span></dt>
                    <dd className="shrink-0 text-right font-semibold">{money(amount, "INR")}</dd>
                  </div>
                ))
              ) : (
                <div className="flex justify-between gap-3"><dt className="text-mute">Plan</dt><dd className="text-right font-semibold">—</dd></div>
              )}
              {discount > 0 && (
                <div className="flex justify-between gap-3 text-emerald-700"><dt>Promo {chosenPromo?.code}</dt><dd className="text-right font-semibold">−{money(discount, "INR")}</dd></div>
              )}
              {priced.length > 0 && (
                <div className={cx("flex justify-between gap-3 border-t border-line pt-2")}><dt className="font-bold text-ink">Before tax</dt><dd className="text-right font-extrabold text-ink">{money(subtotal - discount, "INR")}</dd></div>
              )}
            </dl>
            <p className="mt-3 text-xs text-mute">Tax, setup fees and the final total are worked out by the invoice, as in the shop.</p>
            <Button className="mt-4 w-full" icon="shopping_cart_checkout" loading={busy} onClick={submit}>
              Create order{chosen.length > 1 ? ` (${chosen.length} plans)` : ""}
            </Button>
            {!client && <Alert className="mt-3" tone="info">Choose a customer first.</Alert>}
          </Card>
        </aside>
      </div>
    </>
  );
}
