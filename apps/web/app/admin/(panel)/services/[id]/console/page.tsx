"use client";
import { useParams } from "next/navigation";
import { PageHeader, useApi } from "@/components/ui";
import { VncConsole } from "@/components/vnc-console";

export default function AdminConsole() {
  const { id } = useParams<{ id: string }>();
  const { data } = useApi<any>(`/admin/services/${id}`);
  const s = data?.service;
  return (
    <>
      <PageHeader back={`/admin/services/${id}`} title="Console" subtitle={s ? `${s.hostname ?? s.product.name} · ${s.ips?.find((i: any) => i.isPrimary)?.address ?? ""} · VPS ${s.remoteId ?? "—"}${s.nodeName ? ` on ${s.nodeName}` : ""}` : undefined} />
      <VncConsole sessionPath={`/admin/services/${id}/console`} title={s?.hostname ?? "VPS console"} />
    </>
  );
}
