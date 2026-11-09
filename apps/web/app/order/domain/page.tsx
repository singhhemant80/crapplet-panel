"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { api, money } from "@/lib/api";
import { readCart, writeCart } from "@/lib/cart";
import { Alert, Button, Card, Icon, Input, Select, useApi } from "@/components/ui";

export default function DomainSearch() {
  const router = useRouter();
  const tlds = useApi("/catalog/domains/pricing");
  const [q, setQ] = useState("");
  const [res, setRes] = useState<any>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [years, setYears] = useState(1);
  const [epp, setEpp] = useState("");

  async function search(e: React.FormEvent) {
    e.preventDefault();
    let name = q.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "");
    if (name && !name.includes(".")) name += ".in";
    setBusy(true);
    setErr(null);
    try {
      setRes(await api(`/catalog/domains/check?name=${encodeURIComponent(name)}`));
    } catch (e: any) {
      setErr(e.message);
      setRes(null);
    } finally {
      setBusy(false);
    }
  }
  function add(action: "register" | "transfer") {
    const c = readCart();
    writeCart({ ...c, domains: [...c.domains.filter((d) => d.name !== res.name), { name: res.name, action, years, eppCode: action === "transfer" ? epp : undefined }] });
    router.push("/order/cart");
  }
  return (
    <div className="mx-auto max-w-3xl px-4 py-12 sm:px-6">
      <div className="text-center">
        <h1 className="text-3xl font-extrabold tracking-tight text-ink sm:text-4xl">Find your perfect domain</h1>
        <p className="mt-2 text-mute">Register or transfer .in, .co.in, .com and more.</p>
      </div>
      <form onSubmit={search} className="mt-8 flex gap-2">
        <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="yourbrand.in" className="h-14 text-lg" />
        <Button size="lg" className="h-14" loading={busy} icon="search">Search</Button>
      </form>
      {err && <Alert tone="error" className="mt-4">{err}</Alert>}
      {res && (
        <Card className="mt-6">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div className="flex items-center gap-3">
              <Icon name={res.available ? "check_circle" : res.available === false ? "cancel" : "help"} className={`text-[32px] ${res.available ? "text-emerald-500" : res.available === false ? "text-rose-500" : "text-amber-500"}`} />
              <div>
                <div className="text-lg font-extrabold text-ink">{res.name}</div>
                <div className="text-sm text-mute">{res.available ? "is available!" : res.available === false ? "is already registered — transfer it to us?" : "availability could not be confirmed — we'll verify after ordering"}</div>
              </div>
            </div>
            {res.pricing ? (
              <div className="flex flex-wrap items-center gap-2">
                <Select value={years} onChange={(e) => setYears(Number(e.target.value))} className="h-10 w-28">{[1, 2, 3, 5].map((y) => <option key={y} value={y}>{y} year{y > 1 ? "s" : ""}</option>)}</Select>
                {res.available !== false ? (
                  <Button onClick={() => add("register")}>Register · {money(res.pricing.register * years)}</Button>
                ) : (
                  <>
                    <Input value={epp} onChange={(e) => setEpp(e.target.value)} placeholder="EPP / auth code" className="h-10 w-40" />
                    <Button disabled={!epp} onClick={() => add("transfer")}>Transfer · {money(res.pricing.transfer)}</Button>
                  </>
                )}
              </div>
            ) : (
              <Alert tone="warn">We don't sell {res.tld} yet.</Alert>
            )}
          </div>
        </Card>
      )}
      {tlds.data?.tlds?.length > 0 && (
        <div className="mt-10 grid grid-cols-2 gap-3 sm:grid-cols-4">
          {tlds.data.tlds.map((t: any) => (
            <div key={t.tld} className="rounded-2xl border border-line bg-white p-4 text-center shadow-card">
              <div className="text-xl font-extrabold text-primary-dark">{t.tld}</div>
              <div className="mt-1 text-sm font-semibold text-ink">{money(t.register)}/yr</div>
              <div className="text-xs text-mute">renews {money(t.renew)}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
