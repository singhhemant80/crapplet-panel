"use client";
import Link from "next/link";
import { Suspense, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { api, ApiError, COUNTRIES, INDIAN_STATES } from "@/lib/api";
import { useSession } from "@/lib/session";
import { AuthShell, IconInput, PasswordInput, SectionTitle, StrengthMeter, passwordScore } from "@/components/auth-shell";
import { Alert, Button, Field, Icon, cx } from "@/components/ui";

const GSTIN_RE = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;
const STATE_BY_CODE: Record<string, string> = {
  "01": "Jammu and Kashmir", "02": "Himachal Pradesh", "03": "Punjab", "04": "Chandigarh", "05": "Uttarakhand", "06": "Haryana", "07": "Delhi", "08": "Rajasthan", "09": "Uttar Pradesh", "10": "Bihar",
  "11": "Sikkim", "12": "Arunachal Pradesh", "13": "Nagaland", "14": "Manipur", "15": "Mizoram", "16": "Tripura", "17": "Meghalaya", "18": "Assam", "19": "West Bengal", "20": "Jharkhand", "21": "Odisha",
  "22": "Chhattisgarh", "23": "Madhya Pradesh", "24": "Gujarat", "26": "Dadra and Nagar Haveli and Daman and Diu", "27": "Maharashtra", "29": "Karnataka", "30": "Goa", "31": "Lakshadweep", "32": "Kerala",
  "33": "Tamil Nadu", "34": "Puducherry", "35": "Andaman and Nicobar Islands", "36": "Telangana", "37": "Andhra Pradesh", "38": "Ladakh",
};
const selectCls = "h-12 w-full appearance-none rounded-xl border border-[#e6dcf8] bg-[#fcfaff] pl-11 pr-10 text-[15px] text-ink outline-none transition hover:border-[#d8c6fb] focus:border-primary focus:bg-white focus:ring-4 focus:ring-primary/15";

function IconSelect({ icon, children, ...p }: React.SelectHTMLAttributes<HTMLSelectElement> & { icon: string }) {
  return (
    <div className="group relative">
      <Icon name={icon} className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-[20px] text-slate-400 group-focus-within:text-primary-dark" />
      <select {...p} className={selectCls}>{children}</select>
      <Icon name="expand_more" className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-[20px] text-slate-400" />
    </div>
  );
}

function RegisterForm() {
  const router = useRouter();
  const sp = useSearchParams();
  const { reload } = useSession();
  const [business, setBusiness] = useState(false);
  const [v, setV] = useState({ firstName: "", lastName: "", email: "", phone: "", password: "", companyName: "", gstin: "", pan: "", address1: "", address2: "", city: "", state: "", country: "IN", postcode: "" });
  const [agree, setAgree] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fe, setFe] = useState<Record<string, string[]>>({});
  const [busy, setBusy] = useState(false);
  const set = (p: Partial<typeof v>) => setV((x) => ({ ...x, ...p }));
  const err = (k: string) => fe[k]?.[0];
  const india = v.country === "IN";
  const gstOk = GSTIN_RE.test(v.gstin);

  function onGstin(raw: string) {
    const g = raw.toUpperCase().replace(/\s/g, "").slice(0, 15);
    const patch: Partial<typeof v> = { gstin: g };
    if (GSTIN_RE.test(g)) {
      if (STATE_BY_CODE[g.slice(0, 2)]) patch.state = STATE_BY_CODE[g.slice(0, 2)];
      if (!v.pan) patch.pan = g.slice(2, 12);
    }
    set(patch);
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (passwordScore(v.password) < 2) return setError("Please choose a stronger password (8+ characters with letters and numbers).");
    if (business && v.gstin && !gstOk) return setError("The GSTIN doesn't look right — check it or leave it empty.");
    setBusy(true);
    setError(null);
    try {
      const body = { ...v, companyName: business ? v.companyName : "", gstin: business ? v.gstin : "", pan: v.pan, ref: sp.get("ref") ?? undefined };
      await api("/auth/register", { body });
      await reload();
      router.replace(sp.get("next") || "/client?welcome=1");
    } catch (e) {
      const x = e as ApiError;
      setError(x.message);
      setFe(x.body?.details?.fieldErrors ?? {});
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-7">
      {sp.get("next")?.startsWith("/order") && <Alert>Create your account to finish your order — your cart and IP hold are saved.</Alert>}
      {error && <Alert tone="error">{error}</Alert>}

      <div>
        <SectionTitle n={1} title="Your account" hint="You'll use these to sign in." />
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="First name" error={err("firstName")}><IconInput icon="person" required value={v.firstName} onChange={(e) => set({ firstName: e.target.value })} autoComplete="given-name" placeholder="Asha" /></Field>
          <Field label="Last name" error={err("lastName")}><IconInput icon="badge" value={v.lastName} onChange={(e) => set({ lastName: e.target.value })} autoComplete="family-name" placeholder="Verma" /></Field>
          <Field label="Email address" error={err("email")}><IconInput icon="mail" type="email" required value={v.email} onChange={(e) => set({ email: e.target.value })} autoComplete="email" placeholder="you@company.com" /></Field>
          <Field label="Mobile number" error={err("phone")}><IconInput icon="call" type="tel" required value={v.phone} onChange={(e) => set({ phone: e.target.value })} autoComplete="tel" placeholder="+91 98xxx xxxxx" /></Field>
          <Field label="Password" error={err("password")} className="sm:col-span-2">
            <PasswordInput required minLength={8} value={v.password} onChange={(e) => set({ password: e.target.value })} autoComplete="new-password" placeholder="At least 8 characters" />
            <StrengthMeter password={v.password} />
          </Field>
        </div>
      </div>

      <div>
        <SectionTitle n={2} title="Billing details" hint="Printed on your GST invoices." />
        <div className="mb-4 grid grid-cols-2 gap-2 rounded-2xl bg-[#f6f1ff] p-1.5">
          {[[false, "person", "Individual"], [true, "apartment", "Business (GST)"]].map(([b, ic, l]) => (
            <button key={String(b)} type="button" onClick={() => setBusiness(b as boolean)} className={cx("flex h-11 items-center justify-center gap-2 rounded-xl text-sm font-extrabold transition", business === b ? "bg-white text-primary-dark shadow-[0_4px_14px_rgba(124,58,237,.15)]" : "text-slate-500 hover:text-primary-dark")}>
              <Icon name={ic as string} className="text-[19px]" /> {l as string}
            </button>
          ))}
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          {business && (
            <>
              <Field label="Company name" error={err("companyName")} className="sm:col-span-2"><IconInput icon="business" required value={v.companyName} onChange={(e) => set({ companyName: e.target.value })} autoComplete="organization" placeholder="Verma Traders Pvt Ltd" /></Field>
              {india && (
                <Field label="GSTIN" error={err("gstin")} hint={gstOk ? undefined : "We'll fill your state and PAN from it automatically."}>
                  <IconInput icon="receipt_long" value={v.gstin} onChange={(e) => onGstin(e.target.value)} placeholder="23ABCDE1234F1Z5" className="font-mono uppercase tracking-wide"
                    trailing={v.gstin ? <Icon name={gstOk ? "check_circle" : "error"} fill className={cx("mr-1.5 text-[22px]", gstOk ? "text-emerald-500" : "text-amber-500")} /> : undefined} />
                  {gstOk && <span className="mt-1 block text-xs font-bold text-emerald-600">Valid GSTIN · {STATE_BY_CODE[v.gstin.slice(0, 2)]}</span>}
                </Field>
              )}
              {india && <Field label="PAN (optional)" error={err("pan")}><IconInput icon="credit_card" value={v.pan} onChange={(e) => set({ pan: e.target.value.toUpperCase().slice(0, 10) })} placeholder="ABCDE1234F" className="font-mono uppercase tracking-wide" /></Field>}
            </>
          )}
          <Field label="Address" error={err("address1")} className="sm:col-span-2"><IconInput icon="home" required value={v.address1} onChange={(e) => set({ address1: e.target.value })} autoComplete="address-line1" placeholder="House / building, street" /></Field>
          <Field label="Area / landmark (optional)" className="sm:col-span-2"><IconInput icon="signpost" value={v.address2} onChange={(e) => set({ address2: e.target.value })} autoComplete="address-line2" /></Field>
          <Field label="Country"><IconSelect icon="public" value={v.country} onChange={(e) => set({ country: e.target.value, state: "" })}>{COUNTRIES.map(([c, n]) => <option key={c} value={c}>{n}</option>)}</IconSelect></Field>
          <Field label={india ? "State" : "State / region"} error={err("state")} hint={india ? "Decides CGST + SGST or IGST on invoices." : undefined}>
            {india ? (
              <IconSelect icon="map" required value={v.state} onChange={(e) => set({ state: e.target.value })}><option value="">Select state…</option>{INDIAN_STATES.map((s) => <option key={s}>{s}</option>)}</IconSelect>
            ) : (
              <IconInput icon="map" required value={v.state} onChange={(e) => set({ state: e.target.value })} />
            )}
          </Field>
          <Field label="City" error={err("city")}><IconInput icon="location_city" required value={v.city} onChange={(e) => set({ city: e.target.value })} autoComplete="address-level2" placeholder="Gwalior" /></Field>
          <Field label={india ? "PIN code" : "Postal code"} error={err("postcode")}><IconInput icon="pin_drop" required value={v.postcode} onChange={(e) => set({ postcode: e.target.value })} autoComplete="postal-code" inputMode={india ? "numeric" : undefined} placeholder={india ? "474011" : ""} /></Field>
        </div>
      </div>

      <label className="flex cursor-pointer items-start gap-3 rounded-2xl border border-line bg-[#fcfaff] p-4 text-sm text-slate-600">
        <input type="checkbox" required checked={agree} onChange={(e) => setAgree(e.target.checked)} className="mt-0.5 h-4 w-4 accent-[#7c3aed]" />
        <span>
          I agree to the <a href="/terms-and-conditions.html" target="_blank" className="font-bold text-primary-dark underline">Terms &amp; Conditions</a>, <a href="/privacy-and-policy.html" target="_blank" className="font-bold text-primary-dark underline">Privacy Policy</a> and <a href="/refund-policy.html" target="_blank" className="font-bold text-primary-dark underline">Refund Policy</a>.
        </span>
      </label>

      <Button type="submit" size="lg" className="h-[52px] w-full text-[15px]" loading={busy} disabled={!agree} icon="rocket_launch">
        Create my account
      </Button>
      <p className="text-center text-sm text-mute">
        Already a customer?{" "}
        <Link href={`/client/login${sp.get("next") ? `?next=${encodeURIComponent(sp.get("next")!)}` : ""}`} className="font-extrabold text-primary-dark hover:underline">Sign in</Link>
      </p>
    </form>
  );
}

export default function RegisterPage() {
  return (
    <AuthShell wide eyebrow="Get started in 2 minutes" title="Create your Crapplet account" subtitle="GST-ready invoices, UPI payments and instant VPS deployment.">
      <Suspense>
        <RegisterForm />
      </Suspense>
    </AuthShell>
  );
}
