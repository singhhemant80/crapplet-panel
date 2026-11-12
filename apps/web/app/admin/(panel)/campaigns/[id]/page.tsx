"use client";
import { useParams } from "next/navigation";
import { useEffect } from "react";
import { Loading, useApi } from "@/components/ui";
import { CampaignEditor, CampaignReport } from "@/components/admin/campaigns";

export default function CampaignPage() {
  const { id } = useParams<{ id: string }>();
  const { data, error, reload } = useApi<any>(`/admin/campaigns/${id}`);
  const status = data?.campaign?.status;
  // live numbers while it's going out
  useEffect(() => {
    if (status !== "SENDING") return;
    const t = setInterval(reload, 4000);
    return () => clearInterval(t);
  }, [status, reload]);
  if (error && !data) return <div className="p-8 text-center font-bold text-rose-600">{error}</div>;
  if (!data) return <Loading />;
  return ["DRAFT", "SCHEDULED"].includes(status) ? <CampaignEditor key={id} initial={data.campaign} onChanged={reload} /> : <CampaignReport id={id} data={data} reload={reload} />;
}
