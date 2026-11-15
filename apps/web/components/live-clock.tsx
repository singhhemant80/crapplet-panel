"use client";
import { useEffect, useState } from "react";

const TZ = "Asia/Kolkata";

/** Today's date and a ticking clock in India time (IST), e.g. "Sunday, 15 November 2026 · 11:54:07 am IST". */
export function LiveClock({ className, showDate = true }: { className?: string; showDate?: boolean }) {
  const [now, setNow] = useState<Date | null>(null);
  useEffect(() => {
    setNow(new Date());
    let id: ReturnType<typeof setInterval> | undefined;
    // line the ticks up with the start of each second
    const t = setTimeout(() => {
      setNow(new Date());
      id = setInterval(() => setNow(new Date()), 1000);
    }, 1000 - (Date.now() % 1000));
    return () => {
      clearTimeout(t);
      if (id) clearInterval(id);
    };
  }, []);
  const d = now ?? new Date();
  const day = d.toLocaleDateString("en-IN", { weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: TZ });
  const time = d.toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit", second: "2-digit", hour12: true, timeZone: TZ });
  return (
    <span className={className} suppressHydrationWarning>
      {showDate && <>{day} · </>}
      <span className="inline-flex items-center gap-1 whitespace-nowrap font-bold tabular-nums" aria-live="off">
        <span className="material-symbols-outlined text-[15px] leading-none opacity-70">schedule</span>
        {now ? time : "--:--:--"} IST
      </span>
    </span>
  );
}
