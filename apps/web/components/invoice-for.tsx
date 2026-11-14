"use client";
import Link from "next/link";
import { Icon, cx } from "@/components/ui";

type For = { kind: "service" | "domain"; id: string; label: string; product?: string; status?: string };

/** "What this invoice is for": the services / domains its lines bill, linked to their pages. */
export function InvoiceFor({ inv, audience, compact, showProduct = true }: { inv: { for?: For[]; forSummary?: string | null; isWalletTopup?: boolean }; audience: "admin" | "client"; compact?: boolean; showProduct?: boolean }) {
  const list = inv.for ?? [];
  if (!list.length) {
    const text = inv.isWalletTopup ? "Add funds" : inv.forSummary;
    return text ? <span className="block max-w-[220px] truncate text-xs text-mute" title={text}>{text}</span> : <span className="text-xs text-mute">—</span>;
  }
  const shown = compact ? list.slice(0, 1) : list.slice(0, 3);
  return (
    <span className="flex min-w-0 flex-col gap-0.5">
      {shown.map((f) => {
        const href = f.kind === "domain" ? (audience === "admin" ? `/admin/domains?q=${encodeURIComponent(f.label)}` : `/client/domains`) : audience === "admin" ? `/admin/services/${f.id}` : `/client/services/${f.id}`;
        const ended = f.status && ["TERMINATED", "CANCELLED"].includes(f.status);
        return (
          <Link key={f.kind + f.id} href={href} onClick={(e) => e.stopPropagation()} className="group flex min-w-0 max-w-[220px] items-center xl:max-w-[280px] gap-1.5 text-xs" title={f.product && f.product !== f.label ? `${f.label} · ${f.product}` : f.label}>
            <Icon name={f.kind === "domain" ? "public" : "dns"} className="shrink-0 text-[15px] text-primary-dark/70" />
            <span className="min-w-0 truncate font-semibold text-ink group-hover:text-primary-dark group-hover:underline">{f.label}</span>
            {showProduct && f.product && f.product !== f.label && <span className="hidden min-w-0 truncate text-mute 2xl:inline">· {f.product}</span>}
            {ended && <span className={cx("shrink-0 rounded px-1 text-[10px] font-bold uppercase", "bg-slate-100 text-slate-500")}>{f.status!.toLowerCase()}</span>}
          </Link>
        );
      })}
      {list.length > shown.length && <span className="text-[11px] text-mute">+{list.length - shown.length} more</span>}
    </span>
  );
}
