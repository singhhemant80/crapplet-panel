"use client";
/** A service's IP history: what it gained and lost, and whether it happened in the panel or directly in Virtualizor. */
import { Card, Copy, Icon, cx, useApi } from "@/components/ui";

const SOURCE: Record<string, { label: string; icon: string; tone: string }> = {
  PROVISIONED: { label: "Server set up", icon: "rocket_launch", tone: "text-primary-dark bg-primary-tint" },
  CHANGE_IP: { label: "Changed from the panel", icon: "swap_horiz", tone: "text-sky-700 bg-sky-50" },
  VIRTUALIZOR: { label: "Changed directly in Virtualizor", icon: "dns", tone: "text-amber-700 bg-amber-50" },
  STAFF: { label: "Changed in IP Management", icon: "lan", tone: "text-violet-700 bg-violet-50" },
  TERMINATED: { label: "Service terminated", icon: "delete", tone: "text-rose-700 bg-rose-50" },
  SYNC: { label: "Starting point", icon: "flag", tone: "text-slate-600 bg-slate-100" },
};

export function IpHistory({ url, admin, className }: { url: string; admin?: boolean; className?: string }) {
  const { data } = useApi<{ events: any[] }>(url);
  const events = data?.events ?? [];
  if (!data || !events.length) return null;
  const Ip = ({ a, kind }: { a: string; kind: "add" | "remove" | "base" }) => (
    <span className={cx("inline-flex items-center gap-1 rounded-lg px-2 py-0.5 font-mono text-[12.5px] ring-1", kind === "add" ? "bg-emerald-50 text-emerald-800 ring-emerald-200" : kind === "remove" ? "bg-rose-50 text-rose-800 ring-rose-200 line-through decoration-rose-400" : "bg-slate-50 text-slate-700 ring-line")}>
      {kind === "add" ? "+" : kind === "remove" ? "−" : ""}{a}{kind !== "remove" && <Copy text={a} />}
    </span>
  );
  return (
    <Card title="IP history" className={className}>
      <ol className="relative space-y-4 border-l border-line pl-5">
        {events.map((e: any, i: number) => {
          const src = admin ? SOURCE[e.source] ?? { label: e.source, icon: "history", tone: "text-slate-600 bg-slate-100" } : { label: e.how, icon: e.how === "Server set up" ? "rocket_launch" : e.how === "Starting point" ? "flag" : "swap_horiz", tone: "text-primary-dark bg-primary-tint" };
          return (
            <li key={i} className="relative">
              <span className={cx("absolute -left-[33px] top-0 grid h-6 w-6 place-items-center rounded-full ring-4 ring-white", src.tone)}><Icon name={src.icon} className="text-[14px]" /></span>
              <div className="flex flex-wrap items-baseline gap-x-2 text-[13px]">
                <b className="text-ink">{src.label}</b>
                {admin && e.by && <span className="text-mute">by {e.by}</span>}
                <span className="text-mute">· {new Date(e.at).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" })}</span>
              </div>
              {admin && e.note && e.source !== "SYNC" && <div className="text-[12px] text-mute">{e.note}</div>}
              <div className="mt-1.5 flex flex-wrap gap-1.5">
                {e.removed.map((a: string) => <Ip key={`r${a}`} a={a} kind="remove" />)}
                {e.added.map((a: string) => <Ip key={`a${a}`} a={a} kind="add" />)}
                {e.baseline.map((a: string) => <Ip key={`b${a}`} a={a} kind="base" />)}
              </div>
            </li>
          );
        })}
      </ol>
    </Card>
  );
}
