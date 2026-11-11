"use client";
import { useEffect, useState } from "react";
import { api, ApiError } from "@/lib/api";
import { useSession } from "@/lib/session";
import { Button, Card, Icon, Loading, PageHeader, Toggle, toast, useApi } from "@/components/ui";
import { emptyProfile, ProfileFields, type ProfileValues } from "@/components/profile-fields";

export default function Profile() {
  const { me, reload } = useSession();
  const [v, setV] = useState<ProfileValues | null>(null);
  const [errs, setErrs] = useState<Record<string, string[]>>({});
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (me) {
      const p = me.profile ?? {};
      setV({ ...emptyProfile, firstName: me.firstName, lastName: me.lastName, phone: me.phone ?? "", companyName: p.companyName ?? "", gstin: p.gstin ?? "", pan: p.pan ?? "", address1: p.address1 ?? "", address2: p.address2 ?? "", city: p.city ?? "", state: p.state ?? "", country: p.country ?? "IN", postcode: p.postcode ?? "" });
    }
  }, [me]);
  if (!v) return <Loading />;
  return (
    <>
      <PageHeader title="Profile" subtitle={`Signed in as ${me?.email}. Billing details are printed on your GST invoices.`} />
      <Card>
        <form onSubmit={async (e) => {
          e.preventDefault(); setBusy(true);
          try { await api("/client/profile", { method: "PUT", body: v }); await reload(); setErrs({}); toast.success("Profile saved"); }
          catch (e) { const err = e as ApiError; setErrs(err.body?.details?.fieldErrors ?? {}); toast.error(err.message); } finally { setBusy(false); }
        }}>
          <ProfileFields v={v} set={(p) => setV({ ...v, ...p })} errors={errs} />
          <Button type="submit" className="mt-6" loading={busy} icon="save">Save changes</Button>
        </form>
      </Card>
      <WhatsAppPref />
    </>
  );
}

/** Client's own switch for WhatsApp notifications (shown when the business has WhatsApp set up). */
function WhatsAppPref() {
  const { data, reload } = useApi<{ available: boolean; enabled: boolean }>("/client/whatsapp");
  if (!data?.available) return null;
  return (
    <Card className="mt-6">
      <div className="flex flex-wrap items-center gap-4">
        <span className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-emerald-50 text-emerald-600"><Icon name="chat" /></span>
        <div className="min-w-0 flex-1">
          <div className="text-[15px] font-extrabold text-ink">WhatsApp notifications</div>
          <div className="text-[13px] text-mute">Invoices, payment reminders and service updates on WhatsApp, to the mobile number above. Emails are always sent.</div>
        </div>
        <Toggle checked={data.enabled} onChange={(v) => api("/client/whatsapp", { method: "PUT", body: { enabled: v } }).then(() => { toast.success(v ? "WhatsApp notifications on" : "WhatsApp notifications off"); reload(); }).catch((e) => toast.error(e.message))} />
      </div>
    </Card>
  );
}
