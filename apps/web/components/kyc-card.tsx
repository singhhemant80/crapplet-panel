"use client";
/** Customer: verify identity with Aadhaar through DigiLocker (Cashfree SecureID). Hidden while staff have it switched off. */
import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { Button, Card, Icon, cx, toast, useApi } from "@/components/ui";

export function KycCard({ compact, hideVerified }: { compact?: boolean; hideVerified?: boolean }) {
  const { data } = useApi<any>("/client/kyc");
  const [busy, setBusy] = useState(false);
  if (!data?.enabled && data?.status !== "VERIFIED") return null;
  if (data.exempt || (hideVerified && data.status === "VERIFIED")) return null;
  async function start() {
    setBusy(true);
    try {
      const r = await api("/client/kyc/start", { body: {} });
      window.location.href = r.url;
    } catch (e: any) {
      toast.error(e.message);
      setBusy(false);
    }
  }
  const verified = data.status === "VERIFIED";
  const review = data.status === "REVIEW";
  const tone = verified ? "bg-emerald-50 text-emerald-600" : review ? "bg-amber-50 text-amber-600" : "bg-primary-tint text-primary-dark";
  return (
    <Card className={cx(!compact && "mt-6")}>
      <div className="flex flex-wrap items-center gap-4">
        <span className={cx("grid h-11 w-11 shrink-0 place-items-center rounded-xl", tone)}><Icon name={verified ? "verified_user" : review ? "hourglass_top" : "badge"} fill={verified} /></span>
        <div className="min-w-0 flex-1">
          <div className="text-[15px] font-extrabold text-ink">{verified ? "Identity verified" : review ? "Verification under review" : "Verify your identity"}</div>
          <div className="text-[13px] text-mute">
            {verified
              ? `Verified with Aadhaar${data.last?.nameOnAadhaar ? ` (${data.last.nameOnAadhaar})` : ""}${data.verifiedAt ? ` on ${new Date(data.verifiedAt).toLocaleDateString("en-IN", { dateStyle: "medium" })}` : ""}.`
              : review
                ? "Your Aadhaar name is a little different from your account name — our team will confirm it shortly and email you."
                : <>Share your Aadhaar securely through <b>DigiLocker</b> (Government of India). Takes about 2 minutes — you'll need your Aadhaar-linked mobile for the OTP.{data.requiredFor === "servers" ? " Required before ordering a VPS or server." : data.requiredFor === "all_orders" ? " Required before placing an order." : ""}</>}
          </div>
          {!verified && !review && <div className="mt-1 text-[11.5px] text-slate-400">We only keep your name, date of birth, state and the last 4 digits of your Aadhaar — never the full number.</div>}
        </div>
        {!verified && !review && <Button icon="verified_user" loading={busy} onClick={start}>Verify with DigiLocker</Button>}
      </div>
    </Card>
  );
}

/**
 * Shown once after a customer signs in while Aadhaar KYC is switched on and they aren't verified yet.
 * "Later" hides it until their next sign-in (or browser session).
 */
export function KycPopup({ userId, kyc, hidden }: { userId: string; kyc?: { show: boolean; status: string; required: boolean; requiredFor: string }; hidden?: boolean }) {
  const key = `kyc.popup.${userId}`;
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (hidden || !kyc?.show || !["NONE", "REJECTED", "PENDING"].includes(kyc.status)) return setOpen(false);
    let seen = false;
    try {
      seen = sessionStorage.getItem(key) === "1";
    } catch {}
    if (!seen) setOpen(true);
  }, [kyc?.show, kyc?.status, hidden, key]);
  if (!open || !kyc) return null;
  const later = () => {
    try {
      sessionStorage.setItem(key, "1");
    } catch {}
    setOpen(false);
  };
  async function start() {
    setBusy(true);
    try {
      sessionStorage.setItem(key, "1");
    } catch {}
    try {
      const r = await api("/client/kyc/start", { body: {} });
      window.location.href = r.url;
    } catch (e: any) {
      toast.error(e.message);
      setBusy(false);
    }
  }
  const why = kyc.required ? (kyc.requiredFor === "servers" ? "It's required before you can order a VPS or server." : "It's required before you can place an order.") : "It keeps your account secure and speeds up support.";
  return (
    <div className="fixed inset-0 z-[60] grid place-items-center bg-slate-950/50 p-4 backdrop-blur-sm" role="dialog" aria-modal="true" aria-labelledby="kyc-pop-title">
      <div className="fade-up w-full max-w-[440px] overflow-hidden rounded-3xl bg-white shadow-2xl">
        <div className="relative bg-[radial-gradient(120%_140%_at_0%_0%,#7c3aed_0%,#5b21b6_55%,#2e1065_100%)] px-6 pb-6 pt-7 text-white">
          <button onClick={later} className="absolute right-4 top-4 grid h-8 w-8 place-items-center rounded-full bg-white/15 hover:bg-white/25" aria-label="Close"><Icon name="close" className="text-[18px]" /></button>
          <span className="grid h-14 w-14 place-items-center rounded-2xl bg-white text-primary-dark shadow-lg"><Icon name="badge" className="text-[30px]" /></span>
          <h2 id="kyc-pop-title" className="mt-4 text-[22px] font-extrabold tracking-tight">{kyc.status === "REJECTED" ? "Please verify your identity again" : "Verify your identity"}</h2>
          <p className="mt-1 text-sm text-white/80">Quick Aadhaar check through DigiLocker — about 2 minutes. {why}</p>
        </div>
        <div className="space-y-3 px-6 py-5 text-[13.5px] text-slate-600">
          {[
            ["account_balance", "Secure, Government of India DigiLocker"],
            ["sms", "Keep your Aadhaar-linked mobile handy for the OTP"],
            ["lock", "We keep only your name, DOB, state and the last 4 Aadhaar digits"],
          ].map(([ic, t]) => (
            <div key={ic} className="flex items-center gap-3"><span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-primary-tint text-primary-dark"><Icon name={ic} className="text-[18px]" /></span>{t}</div>
          ))}
        </div>
        <div className="flex flex-col-reverse gap-2 border-t border-line px-6 py-4 sm:flex-row sm:justify-end">
          <Button variant="outline" onClick={later}>Later</Button>
          <Button icon="verified_user" loading={busy} onClick={start}>Verify with DigiLocker</Button>
        </div>
      </div>
    </div>
  );
}
