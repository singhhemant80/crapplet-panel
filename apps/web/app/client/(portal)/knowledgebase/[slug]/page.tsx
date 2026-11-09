"use client";
import { useParams } from "next/navigation";
import { date } from "@/lib/api";
import { Card, Loading, PageHeader, useApi } from "@/components/ui";

export default function Article() {
  const { slug } = useParams<{ slug: string }>();
  const { data, loading, error } = useApi(`/content/kb/${slug}`);
  if (loading) return <Loading />;
  if (error || !data) return <Card>Article not found.</Card>;
  const a = data.article;
  return (
    <>
      <PageHeader back="/client/knowledgebase" title={a.title} subtitle={`${a.category.name} · updated ${date(a.updatedAt)}`} />
      <Card><div className="prose-kb text-[15px] text-slate-700">{a.body}</div></Card>
    </>
  );
}
