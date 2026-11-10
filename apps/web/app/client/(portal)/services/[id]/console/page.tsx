"use client";
import { useParams } from "next/navigation";
import { PageHeader, useApi } from "@/components/ui";
import { VncConsole } from "@/components/vnc-console";

export default function ClientConsole() {
  const { id } = useParams<{ id: string }>();
  const { data } = useApi<any>(`/client/services/${id}`);
  const s = data?.service;
  return (
    <>
      <PageHeader back={`/client/services/${id}`} title="Console" subtitle={s ? `${s.hostname ?? s.product?.name ?? ""}` : undefined} />
      <VncConsole sessionPath={`/client/services/${id}/console`} title={s?.hostname ?? "Server console"} />
      <p className="mt-3 text-xs text-mute">The console works even when SSH or the network inside the server is down. Log in with your root password.</p>
    </>
  );
}
