"use client";
import { useEffect, useState } from "react";
import { cx } from "@/components/ui";

const TZ = "Asia/Kolkata";

/** The current time, ticking on the second (null until mounted, so server and browser HTML match). */
function useNow() {
  const [now, setNow] = useState<Date | null>(null);
  useEffect(() => {
    setNow(new Date());
    let id: ReturnType<typeof setInterval> | undefined;
    const t = setTimeout(() => {
      setNow(new Date());
      id = setInterval(() => setNow(new Date()), 1000);
    }, 1000 - (Date.now() % 1000));
    return () => {
      clearTimeout(t);
      if (id) clearInterval(id);
    };
  }, []);
  return now;
}

function parts(d: Date) {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-IN", { timeZone: TZ, hour: "numeric", minute: "2-digit", second: "2-digit", hour12: true }).formatToParts(d).map((x) => [x.type, x.value]),
  ) as Record<string, string>;
  return { hm: `${p.hour}:${p.minute}`, s: p.second, ampm: (p.dayPeriod ?? "").toUpperCase() };
}

/** "Sunday, 15 November 2026" in India time. */
export function TodayDate({ className }: { className?: string }) {
  const now = useNow();
  return (
    <span className={className} suppressHydrationWarning>
      {(now ?? new Date()).toLocaleDateString("en-IN", { weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: TZ })}
    </span>
  );
}

/** A glass time card for the purple dashboard headers: big hours:minutes, smaller seconds, a live dot and "India Standard Time". */
export function ClockCard({ className, showDate = false }: { className?: string; showDate?: boolean }) {
  const now = useNow();
  const t = now ? parts(now) : null;
  const day = now?.toLocaleDateString("en-IN", { weekday: "short", day: "numeric", month: "short", timeZone: TZ });
  return (
    <div
      className={cx(
        "inline-flex items-center gap-3 rounded-2xl bg-white/[0.08] py-2.5 pl-3 pr-4 text-white ring-1 ring-white/15 backdrop-blur-md shadow-[inset_0_1px_0_rgba(255,255,255,0.12),0_8px_24px_-12px_rgba(0,0,0,0.45)]",
        className,
      )}
      role="timer"
      aria-label={t ? `${t.hm} ${t.ampm} India Standard Time` : "Current time"}
      suppressHydrationWarning
    >
      <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-white/10 ring-1 ring-white/10">
        <span className="material-symbols-outlined text-[22px] leading-none text-white/85" aria-hidden>schedule</span>
      </span>
      <span className="min-w-[124px]">
        <span className="flex items-baseline font-extrabold leading-none tracking-tight tabular-nums">
          <span className="text-[24px]">{t?.hm ?? "--:--"}</span>
          <span className="ml-[1px] text-[14px] font-bold text-white/50">:{t?.s ?? "--"}</span>
          <span className="ml-1.5 rounded-md bg-white/15 px-1.5 py-[3px] text-[10px] font-extrabold tracking-wider text-white/85">{t?.ampm ?? "  "}</span>
        </span>
        <span className="mt-1.5 flex items-center gap-1.5 whitespace-nowrap text-[10.5px] font-bold uppercase tracking-[0.12em] text-white/55">
          <span className="relative flex h-1.5 w-1.5">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-60" />
            <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-emerald-400" />
          </span>
          {showDate && day ? `${day} · IST` : "India Standard Time"}
        </span>
      </span>
    </div>
  );
}
