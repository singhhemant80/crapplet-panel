"use client";
import { useEffect, useState } from "react";
import { Icon, cx, toast } from "@/components/ui";

/** A site link with a copy button — for pasting into the website's pages. */
export function CopyLink({ path, label, className }: { path: string; label?: string; className?: string }) {
  const [origin, setOrigin] = useState("");
  useEffect(() => setOrigin(window.location.origin), []);
  const url = `${origin}${path}`;
  return (
    <span className={cx("inline-flex min-w-0 max-w-full items-center gap-1.5", className)}>
      {label && <span className="shrink-0 text-[12px] font-bold text-mute">{label}</span>}
      <a href={path} target="_blank" rel="noreferrer" className="min-w-0 truncate font-mono text-[12px] text-primary-dark hover:underline" title={url}>{path}</a>
      <button
        type="button"
        title="Copy full link"
        aria-label="Copy link"
        className="grid h-6 w-6 shrink-0 place-items-center rounded-md text-slate-500 hover:bg-slate-100 hover:text-primary-dark"
        onClick={(e) => {
          e.stopPropagation();
          navigator.clipboard?.writeText(url).then(() => toast.success("Link copied"), () => toast.error("Couldn't copy — select the link instead"));
        }}
      >
        <Icon name="content_copy" className="text-[15px]" />
      </button>
    </span>
  );
}
