"use client";
import { useEffect, useState } from "react";
import { api, ApiError } from "@/lib/api";
import { useSession } from "@/lib/session";
import { Button, Card, Loading, PageHeader, toast } from "@/components/ui";
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
    </>
  );
}
