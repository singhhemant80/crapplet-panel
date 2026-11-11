"use client";
import Link from "next/link";
import { Suspense, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { api } from "@/lib/api";
import { Badge, Card, Icon, Input, Loading, PageHeader } from "@/components/ui";
import { toHits, type SearchResults } from "@/components/admin/global-search";

function SearchPage() {
  const sp = useSearchParams();
  const router = useRouter();
  const q = sp.get("q") ?? "";
  const [v, setV] = useState(q);
  const [r, setR] = useState<SearchResults | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    setV(q);
    if (q.trim().length < 2) return setR(null);
    setBusy(true);
    api<SearchResults>(`/admin/search?q=${encodeURIComponent(q)}&take=25`).then(setR).finally(() => setBusy(false));
  }, [q]);
  const hits = toHits(r);
  const groups = [...new Set(hits.map((h) => h.group))];
  return (
    <>
      <PageHeader title="Search" subtitle="IP address, hostname, VPS id, cPanel user, name, email, mobile, GSTIN, PAN, company, order, invoice, ticket or payment reference." />
      <form className="mb-6 max-w-2xl" onSubmit={(e) => { e.preventDefault(); router.push(`/admin/search?q=${encodeURIComponent(v.trim())}`); }}>
        <div className="relative">
          <Icon name="search" className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-mute" />
          <Input autoFocus value={v} onChange={(e) => setV(e.target.value)} className="h-12 pl-10 text-base" placeholder="e.g. 163.5.191.150, web2.example.com, 9876543210, 23ABCDE1234F1Z5" />
        </div>
      </form>
      {busy ? <Loading /> : !r ? null : !hits.length ? (
        <Card><p className="py-6 text-center text-sm text-mute">Nothing found for “{q}”.</p></Card>
      ) : (
        <div className="grid items-start gap-5 xl:grid-cols-2">
          {groups.map((g) => (
            <Card key={g} title={`${g} (${hits.filter((h) => h.group === g).length})`} pad={false}>
              <ul className="divide-y divide-line">
                {hits.filter((h) => h.group === g).map((h, i) => (
                  <li key={h.href + i}>
                    <Link href={h.href} className="flex items-center gap-3 px-5 py-3 hover:bg-primary-tint">
                      <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-primary-soft text-primary-dark"><Icon name={h.icon} className="text-[18px]" /></span>
                      <span className="min-w-0 flex-1"><span className="block truncate text-sm font-bold text-ink">{h.title}</span><span className="block truncate text-xs text-mute">{h.sub}</span></span>
                      {h.status && <Badge status={h.status} />}
                    </Link>
                  </li>
                ))}
              </ul>
            </Card>
          ))}
        </div>
      )}
    </>
  );
}

export default function Page() {
  return (
    <Suspense fallback={<Loading />}>
      <SearchPage />
    </Suspense>
  );
}
