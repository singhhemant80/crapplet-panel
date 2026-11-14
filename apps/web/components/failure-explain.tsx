"use client";
import Link from "next/link";
import { useState } from "react";
import { Icon, cx } from "@/components/ui";

export type Explained = { category: string; title: string; cause: string; fix: string; link?: { label: string; href: string }; customer: string; raw: string };

/** A setup failure in plain words: what went wrong, why, how to fix it — and the original message on demand. */
export function FailureExplain({ x, compact, className }: { x: Explained; compact?: boolean; className?: string }) {
  const [raw, setRaw] = useState(false);
  return (
    <div className={cx("min-w-0 text-sm", className)}>
      {!compact && <div className="font-extrabold text-rose-800">{x.title}</div>}
      <dl className={cx("grid gap-x-3 gap-y-1 sm:grid-cols-[110px_1fr]", !compact && "mt-2")}>
        <dt className="text-[11px] font-bold uppercase tracking-wider text-rose-700/80 sm:pt-0.5">Why</dt>
        <dd className="break-words text-rose-900">{x.cause}</dd>
        <dt className="text-[11px] font-bold uppercase tracking-wider text-rose-700/80 sm:pt-0.5">What to do</dt>
        <dd className="break-words text-slate-800">
          {x.fix}
          {x.link && <> <Link href={x.link.href} className="inline-flex items-center gap-0.5 whitespace-nowrap font-bold text-primary-dark hover:underline">{x.link.label}<Icon name="arrow_forward" className="text-[15px]" /></Link></>}
        </dd>
      </dl>
      {x.raw && x.raw !== x.cause && (
        <div className="mt-1.5">
          <button type="button" onClick={() => setRaw(!raw)} className="text-xs font-semibold text-rose-700/80 hover:underline">{raw ? "Hide" : "Show"} the original error</button>
          {raw && <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-white/80 p-2 font-mono text-[11.5px] text-slate-700 ring-1 ring-rose-100">{x.raw}</pre>}
        </div>
      )}
    </div>
  );
}
