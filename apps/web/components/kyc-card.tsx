"use client";
/** Customer: verify identity with Aadhaar through DigiLocker (Cashfree SecureID). Hidden while staff have it switched off. */
import { useState } from "react";
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
