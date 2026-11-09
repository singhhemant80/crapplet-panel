"use client";
import { useState } from "react";

/** Small dependency-free area chart with hover readout. */
export function Sparkline({ values, suffix = "", height = 90, labels }: { values: number[]; suffix?: string; height?: number; labels?: string[] }) {
  const [hover, setHover] = useState<number | null>(null);
  if (values.length < 2) return null;
  const W = 600;
  const max = Math.max(...values, 0.0001);
  const pts = values.map((v, i) => [(i / (values.length - 1)) * W, height - 6 - (v / max) * (height - 16)] as const);
  const line = pts.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
  const fmt = (v: number) => (v >= 100 ? v.toFixed(0) : v.toFixed(1)) + suffix;
  return (
    <div className="relative rounded-xl border border-line bg-white p-2">
      <svg
        viewBox={`0 0 ${W} ${height}`}
        className="h-[90px] w-full"
        preserveAspectRatio="none"
        onMouseMove={(e) => {
          const r = (e.currentTarget as SVGSVGElement).getBoundingClientRect();
          setHover(Math.round(((e.clientX - r.left) / r.width) * (values.length - 1)));
        }}
        onMouseLeave={() => setHover(null)}
      >
        <defs>
          <linearGradient id="spark" x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stopColor="#a365fe" stopOpacity=".35" />
            <stop offset="100%" stopColor="#a365fe" stopOpacity="0" />
          </linearGradient>
        </defs>
        <path d={`${line} L${W},${height} L0,${height} Z`} fill="url(#spark)" />
        <path d={line} fill="none" stroke="#7c3aed" strokeWidth="2" vectorEffect="non-scaling-stroke" />
        {hover !== null && <line x1={pts[hover][0]} x2={pts[hover][0]} y1="0" y2={height} stroke="#7c3aed" strokeDasharray="3 3" vectorEffect="non-scaling-stroke" />}
      </svg>
      <div className="pointer-events-none absolute right-3 top-2 rounded-md bg-white/90 px-1.5 text-xs font-bold text-primary-dark">
        {hover !== null ? `${labels?.[hover] ? labels[hover] + " · " : ""}${fmt(values[hover])}` : `peak ${fmt(max)}`}
      </div>
    </div>
  );
}
