"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { api, CYCLES, money } from "@/lib/api";
import { useSession } from "@/lib/session";
import { readCart, toApiCart, writeCart, type Cart } from "@/lib/cart";
import { Alert, Button, Card, Empty, Icon, Input, Loading, toast } from "@/components/ui";
import { OrderSteps } from "@/components/order-steps";

export default function CartPage() {
  const router = useRouter();
  const { me, loading: sessionLoading } = useSession();
  const [cart, setCart] = useState<Cart | null>(null);
  const [quote, setQuote] = useState<any>(null);
  const [qErr, setQErr] = useState<string | null>(null);
  const [promo, setPromo] = useState("");
  const [tos, setTos] = useState(false);
  const [busy, setBusy] = useState(false);
  const [, tick] = useState(0);

  useEffect(() => {
    const c = readCart();
    setCart(c);
    setPromo(c.promoCode ?? "");
    const t = setInterval(() => tick((x) => x + 1), 1000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    if (!cart || (!cart.items.length && !cart.domains.length)) return setQuote(null);
    api("/catalog/cart/quote", { body: toApiCart(cart) })
      .then((q) => { setQuote(q); setQErr(null); })
      .catch((e) => { setQErr(e.message); if (cart.promoCode && /promo/i.test(e.message)) { const c = { ...cart, promoCode: undefined }; writeCart(c); setCart(c); } });
  }, [cart, me?.id]);

  if (!cart) return <Loading />;
  const update = (c: Cart) => { writeCart(c); setCart(c); };
  const empty = !cart.items.length && !cart.domains.length;
  const expired = cart.items.some((i) => i.ipExpiresAt && new Date(i.ipExpiresAt) < new Date());

  async function checkout() {
    if (!me || me.type !== "CLIENT") return router.push(`/client/login?next=/order/cart`);
    setBusy(true);
    try {
      const r = await api("/catalog/cart/checkout", { body: { ...toApiCart(cart!), acceptTos: tos, useCredit: true } });
      writeCart({ items: [], domains: [] });
      router.push(r.paid ? `/client/services?ordered=1` : `/client/invoices/${r.invoiceId}`);
    } catch (e: any) {
      toast.error(e.message);
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto max-w-[1180px] px-4 py-10 sm:px-6">
      <OrderSteps step={3} />
      <h1 className="mb-6 text-3xl font-extrabold tracking-tight text-ink">Review your order</h1>
      {empty ? (
        <Card><Empty icon="shopping_cart" title="Your cart is empty"><Button href="/order" className="mt-4">Browse plans</Button></Empty></Card>
      ) : (
        <div className="grid gap-8 lg:grid-cols-[1fr_380px]">
          <div className="space-y-4">
            {expired && <Alert tone="warn">An IP reservation in your cart has expired. Remove the item and pick the IP again, or check out and we'll assign the next free address.</Alert>}
            {cart.items.map((i) => {
              const left = i.ipExpiresAt ? Math.max(0, Math.floor((new Date(i.ipExpiresAt).getTime() - Date.now()) / 1000)) : null;
              return (
                <Card key={i.key}>
                  <div className="flex flex-wrap items-start justify-between gap-4">
                    <div className="flex gap-3">
                      <span className="grid h-11 w-11 place-items-center rounded-xl bg-primary-soft text-primary-dark"><Icon name="dns" /></span>
                      <div>
                        <div className="font-extrabold text-ink">{i.productName}</div>
                        <div className="text-sm text-mute">{CYCLES[i.cycle]}{i.location ? ` · ${i.location}` : ""}{i.osName ? ` · ${i.osName}` : ""}</div>
                        {i.hostname && <div className="text-sm text-mute">{i.hostname}</div>}
                        {i.ipAddress && (
                          <div className="mt-2 inline-flex items-center gap-2 rounded-lg bg-primary-tint px-2.5 py-1 text-xs font-bold text-primary-dark ring-1 ring-[#e9d5ff]">
                            <Icon name="lock" className="text-[15px]" /> {i.ipAddress}
                            {left !== null && <span className={left < 120 ? "text-rose-600" : "text-mute"}>{left > 0 ? `held ${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}` : "hold expired"}</span>}
                          </div>
                        )}
                      </div>
                    </div>
                    <button className="text-sm font-bold text-rose-600 hover:underline" onClick={() => { if (i.ipId) api(`/catalog/ips/${i.ipId}/reserve`, { method: "DELETE" }).catch(() => {}); update({ ...cart, items: cart.items.filter((x) => x.key !== i.key) }); }}>Remove</button>
                  </div>
                </Card>
              );
            })}
            {cart.domains.map((d) => (
              <Card key={d.name}>
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3"><span className="grid h-11 w-11 place-items-center rounded-xl bg-primary-soft text-primary-dark"><Icon name="language" /></span><div><div className="font-extrabold text-ink">{d.name}</div><div className="text-sm capitalize text-mute">{d.action} · {d.years} year</div></div></div>
                  <button className="text-sm font-bold text-rose-600" onClick={() => update({ ...cart, domains: cart.domains.filter((x) => x.name !== d.name) })}>Remove</button>
                </div>
              </Card>
            ))}
            <Link href="/order" className="inline-flex items-center gap-1 text-sm font-bold text-primary-dark"><Icon name="add" className="text-[18px]" /> Add another service</Link>
          </div>

          <aside className="space-y-4">
            <Card title="Summary">
              {qErr && <Alert tone="error" className="mb-3">{qErr}</Alert>}
              {!quote ? <Loading /> : (
                <dl className="space-y-2 text-sm">
                  {quote.lines.map((l: any, idx: number) => (
                    <div key={idx} className="flex justify-between gap-3"><dt className="text-mute">{l.description.split("\n")[0]}</dt><dd className={l.amount < 0 ? "font-semibold text-emerald-600" : "font-semibold"}>{l.amount < 0 ? "−" : ""}{money(Math.abs(l.amount))}</dd></div>
                  ))}
                  {quote.totals.cgst > 0 && <div className="flex justify-between"><dt className="text-mute">CGST 9%</dt><dd className="font-semibold">{money(quote.totals.cgst)}</dd></div>}
                  {quote.totals.sgst > 0 && <div className="flex justify-between"><dt className="text-mute">SGST 9%</dt><dd className="font-semibold">{money(quote.totals.sgst)}</dd></div>}
                  {quote.totals.igst > 0 && <div className="flex justify-between"><dt className="text-mute">IGST 18%</dt><dd className="font-semibold">{money(quote.totals.igst)}</dd></div>}
                  <div className="flex justify-between border-t border-line pt-3 text-lg"><dt className="font-extrabold text-ink">Total</dt><dd className="font-extrabold text-ink">{money(quote.totals.total)}</dd></div>
                  {!me && <p className="text-xs text-mute">GST shown for Madhya Pradesh; it is recalculated for your billing state after sign-in.</p>}
                </dl>
              )}
              <form className="mt-4 flex gap-2" onSubmit={(e) => { e.preventDefault(); update({ ...cart, promoCode: promo.trim().toUpperCase() || undefined }); }}>
                <Input value={promo} onChange={(e) => setPromo(e.target.value)} placeholder="Promo code" className="h-10" />
                <Button size="sm" variant="secondary" type="submit" className="h-10">Apply</Button>
              </form>
              {quote?.promo && <p className="mt-2 text-xs font-bold text-emerald-600">{quote.promo.code} applied — you save {money(quote.promo.discount)}</p>}
            </Card>
            {!sessionLoading && (!me || me.type !== "CLIENT") ? (
              <Card>
                <p className="mb-3 text-sm text-mute">Sign in or create an account to place your order.</p>
                <div className="grid grid-cols-2 gap-2">
                  <Button variant="outline" href="/client/login?next=/order/cart">Sign in</Button>
                  <Button href="/client/register?next=/order/cart">Create account</Button>
                </div>
              </Card>
            ) : (
              <Card>
                <label className="flex items-start gap-2 text-sm text-slate-600">
                  <input type="checkbox" className="mt-0.5 accent-[#7c3aed]" checked={tos} onChange={(e) => setTos(e.target.checked)} />
                  <span>I agree to the <a className="font-bold text-primary-dark underline" href="/terms-and-conditions.html" target="_blank">Terms of Service</a> and <a className="font-bold text-primary-dark underline" href="/refund-policy.html" target="_blank">Refund Policy</a>.</span>
                </label>
                <Button size="lg" className="mt-4 w-full" icon="lock" disabled={!tos || !quote} loading={busy} onClick={checkout}>Place order</Button>
                <p className="mt-2 text-center text-xs text-mute">Wallet credit is applied first. Pay the rest by UPI, card or netbanking.</p>
              </Card>
            )}
          </aside>
        </div>
      )}
    </div>
  );
}
