import type { ReactNode } from "react";

export function AdminAuthCard({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="grid min-h-screen place-items-center bg-[#140a2e] bg-[radial-gradient(circle_at_20%_10%,rgba(163,101,254,.35),transparent_40%),radial-gradient(circle_at_90%_90%,rgba(124,58,237,.3),transparent_40%)] px-4">
      <div className="w-full max-w-md">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/Crapplet_logo.png" alt="Crapplet" className="mx-auto mb-6 h-10 brightness-0 invert" />
        <div className="rounded-3xl bg-white p-8 shadow-2xl">
          <div className="mb-6">
            <div className="text-xs font-extrabold uppercase tracking-[.2em] text-primary-dark">Admin area</div>
            <h1 className="mt-1 text-2xl font-extrabold text-ink">{title}</h1>
          </div>
          {children}
        </div>
      </div>
    </div>
  );
}
