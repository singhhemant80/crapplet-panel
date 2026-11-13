import type { ReactNode } from "react";
import { Icon } from "@/components/ui";

const POINTS = [
  { icon: "dashboard", title: "Your whole business in one place", text: "Customers, orders, billing, servers and support — one console." },
  { icon: "verified_user", title: "Built for staff security", text: "Two-factor sign-in, password re-check for sensitive areas, roles & permissions." },
  { icon: "history", title: "Every change on record", text: "The Activity Log shows who did what, and when." },
];

/** Staff sign-in, forgot password and reset password. */
export function AdminAuthCard({ title, subtitle, eyebrow = "Admin console", children }: { title: string; subtitle?: ReactNode; eyebrow?: string; children: ReactNode }) {
  const year = new Date().getFullYear();
  return (
    <div className="min-h-screen bg-white lg:grid lg:grid-cols-[minmax(0,1.05fr)_minmax(0,1fr)]">
      {/* brand side */}
      <aside className="relative hidden overflow-hidden bg-[#0b0f2a] text-white lg:flex lg:flex-col">
        <div className="pointer-events-none absolute -left-32 -top-32 h-[520px] w-[520px] rounded-full bg-sky-500/25 blur-[110px]" />
        <div className="pointer-events-none absolute -bottom-40 -right-24 h-[560px] w-[560px] rounded-full bg-violet-600/30 blur-[120px]" />
        <div className="pointer-events-none absolute inset-0 bg-[linear-gradient(rgba(255,255,255,.05)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,.05)_1px,transparent_1px)] [background-size:56px_56px] [mask-image:radial-gradient(ellipse_at_30%_40%,#000_10%,transparent_70%)]" />

        <div className="relative flex flex-1 flex-col px-12 py-10 xl:px-16">
          <a href="/" className="flex items-center gap-3">
            <span className="grid h-12 w-12 place-items-center rounded-2xl bg-white shadow-[0_10px_30px_-8px_rgba(56,189,248,.6)]">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src="/Crapplet_Icon.png" alt="" className="h-10 w-10" />
            </span>
            <span className="leading-tight">
              <span className="block text-xl font-extrabold tracking-tight">
                Crapplet <span className="bg-gradient-to-r from-sky-400 to-violet-400 bg-clip-text text-transparent">Cloud</span>
              </span>
              <span className="text-[11px] font-bold uppercase tracking-[.2em] text-slate-400">Web hosting · VPS · Servers</span>
            </span>
          </a>

          <div className="my-auto max-w-[520px] py-12">
            <span className="inline-flex items-center gap-2 rounded-full bg-white/[.07] px-3 py-1 text-[12px] font-bold text-sky-200 ring-1 ring-white/10">
              <Icon name="admin_panel_settings" className="text-[16px]" /> Staff only
            </span>
            <h2 className="mt-5 text-[40px] font-extrabold leading-[1.1] tracking-tight xl:text-[46px]">
              Run your hosting business from{" "}
              <span className="bg-gradient-to-r from-sky-300 via-indigo-300 to-violet-300 bg-clip-text text-transparent">one console.</span>
            </h2>
            <ul className="mt-9 space-y-5">
              {POINTS.map((p) => (
                <li key={p.title} className="flex gap-4">
                  <span className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-gradient-to-br from-sky-400/20 to-violet-500/25 text-sky-200 ring-1 ring-white/10">
                    <Icon name={p.icon} className="text-[22px]" />
                  </span>
                  <span>
                    <span className="block text-[15px] font-extrabold text-white">{p.title}</span>
                    <span className="mt-0.5 block text-[13.5px] leading-relaxed text-slate-400">{p.text}</span>
                  </span>
                </li>
              ))}
            </ul>
          </div>

          <div className="flex flex-wrap items-center gap-3 text-[12.5px] text-slate-400">
            <span className="inline-flex items-center gap-2 rounded-full bg-white/[.06] px-3 py-1.5 font-bold text-slate-200 ring-1 ring-white/10">
              <span className="h-2 w-2 rounded-full bg-emerald-400 shadow-[0_0_10px_#34d399]" /> Tier III data centre · Noida
            </span>
            <span className="inline-flex items-center gap-2 rounded-full bg-white/[.04] px-3 py-1.5 font-bold ring-1 ring-white/10">
              <span className="h-2 w-2 rounded-full bg-amber-300" /> Mumbai · coming soon
            </span>
          </div>
        </div>
      </aside>

      {/* form side */}
      <main className="relative flex min-h-screen flex-col bg-[radial-gradient(circle_at_100%_0%,#eef6ff_0,transparent_40%),radial-gradient(circle_at_0%_100%,#f5efff_0,transparent_45%)] px-5 py-8 sm:px-10">
        <div className="flex items-center justify-between">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/Crapplet_logo.png" alt="Crapplet Cloud" className="h-9 sm:h-10 lg:invisible" />
          <a href="/" className="inline-flex items-center gap-1 rounded-full px-3 py-1.5 text-[13px] font-bold text-slate-500 transition hover:bg-slate-100 hover:text-ink">
            <Icon name="arrow_back" className="text-[17px]" /> Website
          </a>
        </div>

        <div className="mx-auto my-auto w-full max-w-[420px] py-10 fade-up">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/Crapplet_logo.png" alt="Crapplet Cloud" className="mb-9 hidden h-12 lg:block" />
          <div className="mb-7">
            <div className="inline-flex items-center gap-1.5 text-[12px] font-extrabold uppercase tracking-[.18em] text-indigo-600">
              <span className="h-1.5 w-5 rounded-full bg-gradient-to-r from-sky-400 to-violet-500" />
              {eyebrow}
            </div>
            <h1 className="mt-2.5 text-[30px] font-extrabold leading-tight tracking-tight text-ink">{title}</h1>
            {subtitle && <p className="mt-1.5 text-[15px] text-mute">{subtitle}</p>}
          </div>
          {children}
          <div className="mt-8 flex items-start gap-2.5 rounded-xl border border-slate-200/80 bg-white/70 px-3.5 py-3 text-[12.5px] leading-relaxed text-slate-500">
            <Icon name="lock" className="mt-px text-[17px] text-slate-400" />
            <span>For Crapplet staff only. Sign-ins and changes are recorded in the Activity Log.</span>
          </div>
        </div>

        <div className="text-center text-[12px] text-slate-400">© {year} Crapplet Infotech Private Limited</div>
      </main>
    </div>
  );
}
