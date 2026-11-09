"use client";
import { Suspense, useEffect, useRef, useState } from "react";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { api, date, invNo, money } from "@/lib/api";
import { useSession } from "@/lib/session";
import { Alert, Badge, Button, Card, Field, Icon, Input, Loading, PageHeader, Table, Td, cx, toast, useApi } from "@/components/ui";

declare global {
  interface Window {
    Razorpay?: any;
    Cashfree?: any;
  }
}

function loadScript(src: string) {
  return new Promise<void>((res, rej) => {
    if (document.querySelector(`script[src="${src}"]`)) return res();
    const s = document.createElement("script");
    s.src = src;
    s.onload = () => res();
    s.onerror = () => rej(new Error(`Could not load ${src}`));
    document.body.appendChild(s);
  });
}

function InvoiceView() {
  const { id } = useParams<{ id: string }>();
  const sp = useSearchParams();
  const router = useRouter();
  const { me } = useSession();
  const { data, loading, reload } = useApi(`/client/invoices/${id}`);
  const methods = useApi("/payments/methods");
  const [method, setMethod] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const [offline, setOffline] = useState<any>(null);
  const [ref, setRef] = useState("");
  const [verifying, setVerifying] = useState(false);
  const verified = useRef(false);

  useEffect(() => {
    if (methods.data?.methods?.length && !method) setMethod(methods.data.methods[0].code);
  }, [methods.data, method]);

  // returning from Stripe / Cashfree / PayU
  useEffect(() => {
    const gateway = sp.get("gateway");
    const orderId = sp.get("session_id") || sp.get("order_id");
    if (verified.current) return;
    if (gateway && orderId) {
      verified.current = true;
      setVerifying(true);
      api("/payments/verify-return", { body: { gateway, orderId } })
        .then((r) => (r.paid ? toast.success("Payment received — thank you!") : toast.info("Payment is still processing. We'll update this invoice automatically.")))
        .catch((e) => toast.error(e.message))
        .finally(() => {
          setVerifying(false);
          router.replace(`/client/invoices/${id}`);
          reload();
        });
    } else if (sp.get("payment") === "success") toast.success("Payment received — thank you!");
    else if (sp.get("payment") === "failed") toast.error("Payment failed or was cancelled.");
  }, [sp, id, router, reload]);

  if (loading || !data) return <Loading />;
  const inv = data.invoice;
  const due = inv.total - inv.amountPaid;
  const credit = me?.profile?.creditBalance ?? 0;
  const pendingReview = inv.paymentIntents?.length > 0;

  async function pay() {
    setBusy(true);
    try {
      const r = await api("/payments/start", { body: { invoiceId: id, gateway: method } });
      if (r.type === "razorpay") {
        await loadScript("https://checkout.razorpay.com/v1/checkout.js");
        const rz = new window.Razorpay({
          key: r.keyId,
          order_id: r.orderId,
          amount: r.amount,
          currency: r.currency,
          name: "Crapplet Cloud",
          description: r.description,
          image: "/Crapplet_Icon.png",
          prefill: r.prefill,
          theme: { color: "#7c3aed" },
          handler: async (resp: any) => {
            setVerifying(true);
            try {
              const v = await api(`/payments/${r.intentId}/verify`, { body: resp });
              v.paid ? toast.success("Payment received — thank you!") : toast.info("Payment is processing.");
            } catch (e: any) {
              toast.error(e.message);
            } finally {
              setVerifying(false);
              reload();
            }
          },
          modal: { ondismiss: () => setBusy(false) },
        });
        rz.open();
        return;
      }
      if (r.type === "cashfree") {
        await loadScript("https://sdk.cashfree.com/js/v3/cashfree.js");
        const cf = window.Cashfree({ mode: r.mode });
        cf.checkout({ paymentSessionId: r.sessionId, redirectTarget: "_self" });
        return;
      }
      if (r.type === "redirect") {
        window.location.href = r.url;
        return;
      }
      if (r.type === "form") {
        const f = document.createElement("form");
        f.method = "POST";
        f.action = r.action;
        for (const [k, v] of Object.entries(r.fields)) {
          const i = document.createElement("input");
          i.type = "hidden";
          i.name = k;
          i.value = String(v);
          f.appendChild(i);
        }
        document.body.appendChild(f);
        f.submit();
        return;
      }
      if (r.type === "instructions") setOffline(r);
    } catch (e: any) {
      toast.error(e.message);
    } finally {
      setBusy(false);
    }
  }

  const bill = inv.billingSnapshot ?? {};
  return (
    <>
      <PageHeader
        back="/client/invoices"
        title={
          <span className="flex flex-wrap items-center gap-3">
            {inv.isWalletTopup ? "Wallet top-up" : inv.number ? "Tax invoice" : "Proforma invoice"} {invNo(inv)} <Badge status={inv.status} />
          </span>
        }
        actions={
          <Button variant="outline" icon="picture_as_pdf" onClick={() => window.open(`/api/client/invoices/${id}/pdf`, "_blank")}>
            Download PDF
          </Button>
        }
      />
      {verifying && (
        <Alert className="mb-5">
          <span className="font-semibold">Confirming your payment with the gateway…</span>
        </Alert>
      )}
      <div className="grid gap-6 xl:grid-cols-[1fr_360px]">
        <Card pad={false}>
          <div className="grid gap-6 border-b border-line p-5 sm:grid-cols-2">
            <div>
              <div className="text-xs font-bold uppercase tracking-wider text-primary-dark">Billed to</div>
              <div className="mt-1 font-bold text-ink">{bill.companyName || bill.name}</div>
              <div className="text-sm text-mute">
                {bill.address1}
                {bill.address2 ? `, ${bill.address2}` : ""}
                <br />
                {[bill.city, bill.state, bill.postcode].filter(Boolean).join(", ")}
                {inv.customerGstin && (
                  <>
                    <br />
                    GSTIN: {inv.customerGstin}
                  </>
                )}
              </div>
            </div>
            <div className="text-sm sm:text-right">
              <div className="text-xs font-bold uppercase tracking-wider text-primary-dark">From</div>
              <div className="mt-1 font-bold text-ink">{data.company.legalName}</div>
              <div className="text-mute">GSTIN: {data.company.gstin}</div>
              <div className="mt-2 text-mute">
                Issued {date(inv.issueDate)} · Due {date(inv.dueDate)}
                <br />
                Place of supply: {inv.placeOfSupply ?? "—"}
              </div>
            </div>
          </div>
          <Table head={["Description", "SAC", "Amount"]}>
            {inv.items.map((it: any) => (
              <tr key={it.id}>
                <Td>
                  <div className="font-semibold text-ink">{it.description}</div>
                  {it.periodStart && it.periodEnd && (
                    <div className="text-xs text-mute">
                      {date(it.periodStart)} – {date(it.periodEnd)}
                    </div>
                  )}
                </Td>
                <Td className="text-mute">{it.hsnSac}</Td>
                <Td className="text-right font-semibold">{money(it.amount, inv.currency)}</Td>
              </tr>
            ))}
          </Table>
          <div className="ml-auto max-w-sm space-y-1.5 p-5 text-sm">
            <Row l="Subtotal" v={money(inv.subtotal, inv.currency)} />
            {inv.discount > 0 && <Row l="Discount" v={`− ${money(inv.discount, inv.currency)}`} />}
            {inv.cgst > 0 && <Row l={`CGST @ ${inv.gstRate / 2}%`} v={money(inv.cgst, inv.currency)} />}
            {inv.sgst > 0 && <Row l={`SGST @ ${inv.gstRate / 2}%`} v={money(inv.sgst, inv.currency)} />}
            {inv.igst > 0 && <Row l={`IGST @ ${inv.gstRate}%`} v={money(inv.igst, inv.currency)} />}
            <div className="flex justify-between border-t border-line pt-2 text-base font-extrabold text-ink">
              <span>Total</span>
              <span>{money(inv.total, inv.currency)}</span>
            </div>
            {inv.amountPaid > 0 && <Row l="Paid" v={money(inv.amountPaid, inv.currency)} />}
            {inv.status === "UNPAID" && (
              <div className="flex justify-between font-extrabold text-primary-dark">
                <span>Balance due</span>
                <span>{money(due, inv.currency)}</span>
              </div>
            )}
          </div>
          {inv.transactions.length > 0 && (
            <div className="border-t border-line p-5">
              <div className="mb-2 text-xs font-bold uppercase tracking-wider text-mute">Transactions</div>
              {inv.transactions.map((t: any) => (
                <div key={t.id} className="flex justify-between py-1 text-sm">
                  <span className="text-mute">
                    {date(t.createdAt, true)} · {t.gateway.toUpperCase()} · {t.gatewayTxnId.slice(0, 24)}
                  </span>
                  <span className="font-semibold">{money(t.amount, t.currency)}</span>
                </div>
              ))}
            </div>
          )}
        </Card>

        {inv.status === "UNPAID" && (
          <div className="space-y-4">
            <Card title="Pay this invoice">
              {pendingReview ? (
                <Alert tone="info">Your payment reference has been submitted and is being verified by our billing team. Services activate automatically once confirmed.</Alert>
              ) : offline ? (
                <OfflinePanel offline={offline} refValue={ref} setRef={setRef} onDone={() => { setOffline(null); reload(); }} />
              ) : (
                <div className="space-y-3">
                  {credit > 0 && !inv.isWalletTopup && (
                    <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-3 text-sm">
                      <div className="font-bold text-emerald-800">You have {money(credit)} wallet credit</div>
                      <Button
                        size="sm"
                        className="mt-2"
                        variant="outline"
                        onClick={() =>
                          api(`/client/invoices/${id}/apply-credit`, { body: {} })
                            .then((r) => {
                              toast.success(r.paid ? "Invoice paid from credit" : `Applied ${money(r.applied)} credit`);
                              reload();
                            })
                            .catch((e) => toast.error(e.message))
                        }
                      >
                        Apply credit
                      </Button>
                    </div>
                  )}
                  {!methods.data?.methods?.length && <Alert tone="warn">Online payments are being set up. Please contact billing@crapplet.co.in.</Alert>}
                  {methods.data?.methods?.map((m: any) => (
                    <label key={m.code} className={cx("flex cursor-pointer items-center gap-3 rounded-xl border p-3.5 transition", method === m.code ? "border-primary bg-primary-tint ring-2 ring-primary/20" : "border-line hover:border-primary/40")}>
                      <input type="radio" className="accent-[#7c3aed]" checked={method === m.code} onChange={() => setMethod(m.code)} />
                      <Icon name={m.code === "upi" ? "qr_code_2" : m.code === "bank" ? "account_balance" : m.code === "stripe" ? "credit_card" : m.offline ? "payments" : "bolt"} className="text-primary-dark" />
                      <span className="text-sm font-semibold text-ink">{m.name}</span>
                    </label>
                  ))}
                  {methods.data?.methods?.length > 0 && (
                    <Button size="lg" className="w-full" loading={busy} onClick={pay} icon="lock">
                      Pay {money(due, inv.currency)}
                    </Button>
                  )}
                  <p className="text-center text-xs text-mute">Services are activated automatically once the payment is verified by the gateway.</p>
                </div>
              )}
            </Card>
          </div>
        )}
      </div>
    </>
  );
}

function OfflinePanel({ offline, refValue, setRef, onDone }: { offline: any; refValue: string; setRef: (s: string) => void; onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  return (
    <div className="space-y-4">
      <div className="text-sm font-extrabold text-ink">{offline.title}</div>
      {offline.qr && (
        <div className="text-center">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={offline.qr} alt="UPI QR code" className="mx-auto h-52 w-52 rounded-xl border border-line" />
          <a href={offline.upiUri} className="mt-2 inline-block text-sm font-bold text-primary-dark underline sm:hidden">
            Open UPI app
          </a>
        </div>
      )}
      <p className="whitespace-pre-wrap text-sm text-slate-600">{offline.details}</p>
      {offline.reference && (
        <p className="text-sm">
          Payment reference: <b className="font-mono">{offline.reference}</b>
        </p>
      )}
      <Field label="UTR / transaction reference" hint="Find it in your bank or UPI app after paying.">
        <Input value={refValue} onChange={(e) => setRef(e.target.value)} placeholder="e.g. 431234567890" />
      </Field>
      <Button
        className="w-full"
        loading={busy}
        disabled={refValue.trim().length < 6}
        onClick={async () => {
          setBusy(true);
          try {
            await api(`/payments/${offline.intentId}/reference`, { body: { reference: refValue.trim() } });
            toast.success("Thanks! We'll verify your payment shortly.");
            onDone();
          } catch (e: any) {
            toast.error(e.message);
          } finally {
            setBusy(false);
          }
        }}
      >
        I have paid — submit reference
      </Button>
    </div>
  );
}

const Row = ({ l, v }: { l: string; v: string }) => (
  <div className="flex justify-between text-slate-600">
    <span>{l}</span>
    <span className="font-semibold text-ink">{v}</span>
  </div>
);

export default function Page() {
  return (
    <Suspense>
      <InvoiceView />
    </Suspense>
  );
}
