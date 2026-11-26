"use client";
/** Admin → Identity verification: switch Aadhaar KYC (Cashfree SecureID / DigiLocker) on or off, and see the checks. */
import { useEffect, useState } from "react";
import Link from "next/link";
import { api } from "@/lib/api";
import { KycPill } from "@/components/admin/kyc";
import { Alert, Button, Card, Field, Icon, Input, Loading, PageHeader, Pager, Select, Table, Td, Toggle, cx, toast, useApi } from "@/components/ui";

export default function KycAdmin() {
  const { data, loading, reload } = useApi("/admin/kyc/settings");
  const [f, setF] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const [testing, setTesting] = useState(false);
  useEffect(() => { if (data) setF({ ...data.settings }); }, [data]);
  if (loading || !f) return <Loading />;

  async function save(patch?: object) {
    const body = { ...f, ...patch };
    setBusy(true);
    try {
      const r = await api("/admin/kyc/settings", { method: "PUT", body });
      setF({ ...r.settings });
      toast.success(r.settings.enabled ? "Identity verification is ON" : "Identity verification is OFF");
      reload();
    } catch (e: any) {
      toast.error(e.message);
    }
    setBusy(false);
  }
  const c = data.counts;
  return (
    <>
      <PageHeader title="Identity verification" subtitle="Aadhaar KYC through Cashfree SecureID (DigiLocker)" icon="badge" />
      {/* the master switch */}
      <div className={cx("mb-5 flex flex-wrap items-center gap-4 rounded-2xl border p-5", f.enabled ? "border-emerald-200 bg-emerald-50/60" : "border-line bg-white")}>
        <span className={cx("grid h-12 w-12 place-items-center rounded-2xl", f.enabled ? "bg-emerald-600 text-white" : "bg-slate-100 text-slate-500")}><Icon name={f.enabled ? "verified_user" : "gpp_maybe"} className="text-[26px]" /></span>
        <div className="min-w-0 flex-1">
          <div className="text-lg font-extrabold text-ink">{f.enabled ? "Verification is ON" : "Verification is OFF"}</div>
          <div className="text-sm text-mute">
            {f.enabled
              ? f.require === "optional" ? "Customers can verify from their account; no order is blocked." : f.require === "servers" ? "Customers must verify before ordering a VPS or server." : "Customers must verify before placing any order."
              : "Customers aren't asked to verify and no order is blocked. Turn it on any time — and off again whenever you want."}
            {f.enabled && f.sandbox && <b className="ml-1 text-amber-700">Sandbox (test) mode.</b>}
          </div>
        </div>
        <Button variant={f.enabled ? "outline" : "primary"} icon={f.enabled ? "toggle_off" : "toggle_on"} loading={busy} onClick={() => save({ enabled: !f.enabled })}>{f.enabled ? "Turn off" : "Turn on"}</Button>
      </div>

      <div className="mb-5 grid gap-3 sm:grid-cols-3">
        {[["Verified", c.verified, "verified", "text-emerald-600", "VERIFIED"], ["Needs review", c.review, "rate_review", "text-amber-600", "REVIEW"], ["In progress", c.pending, "hourglass_top", "text-sky-600", "PENDING"]].map(([l, n, ic, tone]) => (
          <div key={l as string} className="flex items-center gap-3 rounded-2xl border border-line bg-white p-4"><Icon name={ic as string} className={cx("text-[26px]", tone as string)} /><div><div className="text-2xl font-extrabold text-ink">{n as number}</div><div className="text-[13px] text-mute">{l as string} customers</div></div></div>
        ))}
      </div>

      <Card title="Settings">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Who must verify" hint="Staff-placed orders are never blocked. You can also require or exempt single customers from their profile.">
            <Select value={f.require} onChange={(e) => setF({ ...f, require: e.target.value })}>
              <option value="optional">Nobody — optional, customers verify for a badge</option>
              <option value="servers">Before ordering a VPS / dedicated / GPU / colocation</option>
              <option value="all_orders">Before placing any order</option>
            </Select>
          </Field>
          <Field label="When the Aadhaar name doesn't match the account name">
            <Select value={f.onMismatch} onChange={(e) => setF({ ...f, onMismatch: e.target.value })}>
              <option value="review">Send to staff for review (recommended)</option>
              <option value="accept">Accept it anyway</option>
            </Select>
          </Field>
          <Field label="Cashfree SecureID Client ID"><Input value={f.clientId} autoComplete="off" onChange={(e) => setF({ ...f, clientId: e.target.value.trim() })} placeholder="CF…" /></Field>
          <Field label="Client Secret" hint="Stored encrypted. Leave as is to keep the saved one."><Input type="password" value={f.clientSecret} autoComplete="new-password" onChange={(e) => setF({ ...f, clientSecret: e.target.value })} /></Field>
          <div className="sm:col-span-2"><Toggle checked={f.sandbox} onChange={(x) => setF({ ...f, sandbox: x })} label="Sandbox mode (Cashfree test keys — no real Aadhaar is checked)" /></div>
        </div>
        <Alert className="mt-4">
          Use the <b>Verification (SecureID)</b> keys from the Cashfree dashboard — not the Payment Gateway keys. If your Cashfree account has IP whitelisting on, add this server's IP there. Only the last 4 digits of a customer's Aadhaar are stored, never the full number or photo.
        </Alert>
        <div className="mt-5 flex flex-wrap gap-2">
          <Button icon="save" loading={busy} onClick={() => save()}>Save settings</Button>
          <Button variant="outline" icon="lan" loading={testing} onClick={async () => {
            setTesting(true);
            try { const r = await api("/admin/kyc/test", { body: {} }); (r.ok ? toast.success : toast.error)(r.message); } catch (e: any) { toast.error(e.message); }
            setTesting(false);
          }}>Test connection</Button>
        </div>
        <p className="mt-2 text-xs text-mute">Save first, then test — the test uses the saved keys.</p>
      </Card>

      <Checks />
    </>
  );
}

function Checks() {
  const [status, setStatus] = useState("");
  const [page, setPage] = useState(1);
  const { data } = useApi(`/admin/kyc/checks?page=${page}&pageSize=25${status ? `&status=${status}` : ""}`, [status, page]);
  return (
    <Card title="Recent checks" className="mt-6" pad={false} action={
      <Select className="!h-9 !w-44 text-sm" value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }}>
        <option value="">All</option>
        {["REVIEW", "VERIFIED", "PENDING", "REJECTED", "EXPIRED", "CONSENT_DENIED", "FAILED"].map((s) => <option key={s} value={s}>{s.replace(/_/g, " ").toLowerCase()}</option>)}
      </Select>
    }>
      {!data ? <Loading /> : (
        <>
          <Table head={["Customer", "Status", "Aadhaar name", "Aadhaar", "Match", "Started"]} empty={!data.checks.length ? <div className="p-6 text-center text-sm text-mute">No checks yet</div> : undefined}>
            {data.checks.map((v: any) => (
              <tr key={v.id} className="border-t border-line">
                <Td><Link href={`/admin/clients/${v.user.id}`} className="font-bold text-ink hover:text-primary-dark">{[v.user.firstName, v.user.lastName].filter(Boolean).join(" ") || v.user.email}</Link><div className="text-xs text-mute">{v.user.profile?.companyName ?? v.user.email}</div></Td>
                <Td><KycPill s={v.status} />{v.sandbox && <span className="ml-1.5 text-[11px] font-bold text-amber-600">TEST</span>}</Td>
                <Td>{v.nameOnAadhaar ?? "—"}</Td>
                <Td className="font-mono">{v.aadhaarLast4 ? `XXXX XXXX ${v.aadhaarLast4}` : "—"}</Td>
                <Td>{v.nameScore != null ? `${v.nameScore}%` : "—"}</Td>
                <Td className="whitespace-nowrap text-mute">{new Date(v.createdAt).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" })}</Td>
              </tr>
            ))}
          </Table>
          <div className="px-4 pb-4"><Pager page={page} pageSize={25} total={data.total} onPage={setPage} /></div>
        </>
      )}
    </Card>
  );
}
