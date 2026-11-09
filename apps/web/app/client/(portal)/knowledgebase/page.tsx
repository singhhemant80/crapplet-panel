"use client";
import Link from "next/link";
import { useState } from "react";
import { Card, Empty, Icon, Input, Loading, PageHeader, useApi } from "@/components/ui";

export default function Kb() {
  const [q, setQ] = useState("");
  const [query, setQuery] = useState("");
  const { data, loading } = useApi(`/content/kb${query ? `?q=${encodeURIComponent(query)}` : ""}`, [query]);
  return (
    <>
      <PageHeader title="Knowledgebase" subtitle="Guides for VPS, hosting, billing and more." />
      <form onSubmit={(e) => { e.preventDefault(); setQuery(q); }} className="mb-6"><Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search articles… (press Enter)" /></form>
      {loading ? <Loading /> : !data?.categories.length ? <Card><Empty icon="menu_book" title="No articles found" /></Card> : (
        <div className="grid gap-5 md:grid-cols-2">
          {data.categories.map((c: any) => (
            <Card key={c.id} title={c.name}>
              <ul className="space-y-2">
                {c.articles.map((a: any) => (
                  <li key={a.id}><Link href={`/client/knowledgebase/${a.slug}`} className="flex items-center gap-2 text-sm font-semibold text-slate-700 hover:text-primary-dark"><Icon name="article" className="text-primary" />{a.title}</Link></li>
                ))}
                {!c.articles.length && <li className="text-sm text-mute">No articles yet.</li>}
              </ul>
            </Card>
          ))}
        </div>
      )}
    </>
  );
}
