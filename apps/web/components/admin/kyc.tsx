"use client";
/** Aadhaar KYC bits shared by the admin pages: status pill and the customer-profile panel. */
import { useState } from "react";
import Link from "next/link";
import { api } from "@/lib/api";
import { Button, Icon, Input, Modal, cx, toast, useApi } from "@/components/ui";

const KYC_TONE: Record<string, string> = {
  VERIFIED: "bg-emerald-50 text-emerald-700 ring-emerald-200",
  REVIEW: "bg-amber-50 text-amber-700 ring-amber-200",
  PENDING: "bg-sky-50 text-sky-700 ring-sky-200",
  REJECTED: "bg-rose-50 text-rose-700 ring-rose-200",
  FAILED: "bg-rose-50 text-rose-700 ring-rose-200",
  EXPIRED: "bg-slate-100 text-slate-600 ring-slate-200",
  CONSENT_DENIED: "bg-slate-100 text-slate-600 ring-slate-200",
  NONE: "bg-slate-100 text-slate-600 ring-slate-200",
};
const LABEL: Record<string, string> = { NONE: "not verified", REVIEW: "needs review", CONSENT_DENIED: "consent declined" };
export const KycPill = ({ s }: { s: string }) => (
  <span className={cx("inline-flex rounded-full px-2.5 py-0.5 text-[11.5px] font-bold uppercase tracking-wide ring-1 ring-inset", KYC_TONE[s] ?? KYC_TONE.NONE)}>{LABEL[s] ?? s.replace(/_/g, " ").toLowerCase()}</span>
);

/** Customer profile: KYC status, last check, and staff actions. */
export function KycPanel({ clientId }: { clientId: string }) {
  const { data, reload } = useApi(`/admin/clients/${clientId}/kyc`);
  const [ask, setAsk] = useState<null | { action: string; title: string; required: boolean }>(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  if (!data) return null;
  const last = data.checks[0];
  async function act(action: string, n?: string) {
    setBusy(true);
    try {
      await api(`/admin/clients/${clientId}/kyc`, { body: { action, note: n || undefined } });
      toast.success("Updated");
      setAsk(null);
      setNote("");
      reload();
    } catch (e: any) {
      toast.error(e.message);
    }
    setBusy(false);
  }
  const btn = "inline-flex h-8 items-center gap-1 rounded-lg px-2.5 text-[12.5px] font-bold ring-1 ring-line hover:bg-slate-50";
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <KycPill s={data.kycStatus} />
        {data.kycExempt && <span className="rounded-full bg-violet-50 px-2 py-0.5 text-[11px] font-bold text-violet-700 ring-1 ring-violet-200">EXEMPT</span>}
        {data.kycRequired && <span className="rounded-full bg-amber-50 px-2 py-0.5 text-[11px] font-bold text-amber-700 ring-1 ring-amber-200">REQUIRED FOR ALL ORDERS</span>}
        {!data.enabled && <span className="text-[12px] text-mute">· verification is switched off (<Link href="/admin/kyc" className="font-bold text-primary-dark">turn on</Link>)</span>}
      </div>
      {data.kycVerifiedAt && <div className="text-[13px] text-mute">Verified {new Date(data.kycVerifiedAt).toLocaleDateString("en-IN", { dateStyle: "medium" })}</div>}
      {last && (
        <div className="rounded-xl bg-slate-50 p-3 text-[13px] ring-1 ring-line">
          <div className="mb-1 flex items-center justify-between gap-2"><span className="font-bold text-ink">Last check</span><KycPill s={last.status} /></div>
          {last.nameOnAadhaar && <div>Name on Aadhaar: <b>{last.nameOnAadhaar}</b>{last.nameScore != null && <span className="text-mute"> · {last.nameScore}% match</span>}</div>}
          {last.aadhaarLast4 && <div>Aadhaar: <span className="font-mono">XXXX XXXX {last.aadhaarLast4}</span></div>}
          {(last.dob || last.gender || last.state) && <div className="text-mute">{[last.dob, last.gender, last.state].filter(Boolean).join(" · ")}</div>}
          {last.message && <div className="mt-1 text-mute">{last.message}</div>}
          {last.reviewNote && <div className="mt-1 text-mute">Staff note: {last.reviewNote}</div>}
          {last.sandbox && <div className="mt-1 text-[11px] font-bold text-amber-600">TEST (sandbox)</div>}
        </div>
      )}
      <div className="flex flex-wrap gap-1.5">
        {data.kycStatus === "REVIEW" && (
          <>
            <button className={cx(btn, "text-emerald-700")} onClick={() => act("approve")} disabled={busy}><Icon name="check" className="text-[16px]" />Approve</button>
            <button className={cx(btn, "text-rose-700")} onClick={() => setAsk({ action: "reject", title: "Reject verification", required: false })}><Icon name="close" className="text-[16px]" />Reject</button>
          </>
        )}
        {data.kycStatus !== "VERIFIED" && <button className={btn} onClick={() => setAsk({ action: "verify", title: "Mark as verified", required: true })}><Icon name="verified" className="text-[16px]" />Mark verified</button>}
        {data.kycStatus !== "NONE" && <button className={btn} onClick={() => confirm("Reset? The customer will be asked to verify again.") && act("reset")}><Icon name="restart_alt" className="text-[16px]" />Reset</button>}
        <button className={btn} onClick={() => act(data.kycRequired ? "unrequire" : "require")} disabled={busy}><Icon name="rule" className="text-[16px]" />{data.kycRequired ? "Don't require" : "Require before any order"}</button>
        <button className={btn} onClick={() => act(data.kycExempt ? "unexempt" : "exempt")} disabled={busy}><Icon name="do_not_disturb_on" className="text-[16px]" />{data.kycExempt ? "Remove exemption" : "Exempt"}</button>
      </div>
      <Modal open={!!ask} onClose={() => setAsk(null)} title={ask?.title ?? ""}>
        <div className="space-y-4">
          <Input value={note} maxLength={300} onChange={(e) => setNote(e.target.value)} placeholder={ask?.action === "verify" ? "How was this customer verified? (e.g. Aadhaar checked on video call)" : "Reason (sent to the customer)"} />
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setAsk(null)}>Cancel</Button>
            <Button loading={busy} disabled={ask?.required && note.trim().length < 3} onClick={() => act(ask!.action, note.trim())}>Save</Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
