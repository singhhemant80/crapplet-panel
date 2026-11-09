"use client";
import { Card, Empty, Icon, Loading, PageHeader, useApi } from "@/components/ui";

export default function Downloads() {
  const { data, loading } = useApi("/client/downloads");
  return (
    <>
      <PageHeader title="Downloads" />
      <Card pad={false}>
        {loading ? <Loading /> : !data?.downloads.length ? <Empty icon="download" title="Nothing to download yet" /> : (
          <ul className="divide-y divide-[#f3effb]">
            {data.downloads.map((d: any) => (
              <li key={d.id} className="flex items-center justify-between gap-4 px-5 py-4">
                <div><div className="font-bold text-ink">{d.title}</div><div className="text-sm text-mute">{d.category}{d.description ? ` · ${d.description}` : ""}</div></div>
                <a href={d.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-sm font-bold text-primary-dark"><Icon name="download" /> Download</a>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </>
  );
}
