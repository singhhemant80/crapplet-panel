"use client";
import { GlobalSearch } from "@/components/admin/global-search";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { useSession } from "@/lib/session";
import { Icon, Loading, cx } from "@/components/ui";
import { AreaGate, ReauthPill, ReauthProvider } from "@/components/admin/reauth";
import { Sidebar, useRail } from "@/components/admin/sidebar";

export default function PanelLayout({ children }: { children: React.ReactNode }) {
  const { me, loading } = useSession();
  const router = useRouter();
  const path = usePathname();
  useEffect(() => {
    if (!loading && (!me || me.type !== "STAFF")) router.replace(`/admin/login?next=${encodeURIComponent(path)}`);
  }, [loading, me, path, router]);
  if (loading || !me || me.type !== "STAFF") return <Loading />;
  return (
    <ReauthProvider>
      <Panel>{children}</Panel>
    </ReauthProvider>
  );
}

function Panel({ children }: { children: React.ReactNode }) {
  const { me: maybeMe, logout } = useSession();
  const me = maybeMe!;
  const router = useRouter();
  const path = usePathname();
  const [open, setOpen] = useState(false);
  const { rail, toggle } = useRail();
  useEffect(() => setOpen(false), [path]);

  return (
    <div className={cx("min-h-screen bg-[#f6f4fb] lg:grid lg:transition-[grid-template-columns] lg:duration-300", rail ? "lg:grid-cols-[84px_1fr]" : "lg:grid-cols-[276px_1fr]")}>
      {/* desktop */}
      <aside className="sticky top-0 hidden h-screen lg:block">
        <Sidebar rail={rail} onToggleRail={toggle} />
      </aside>
      {/* phone / tablet drawer */}
      <aside className={cx("fixed inset-y-0 left-0 z-50 w-[288px] max-w-[85vw] shadow-2xl transition-transform duration-300 lg:hidden", open ? "translate-x-0" : "-translate-x-full")}>
        <Sidebar rail={false} onToggleRail={toggle} mobile />
        <button onClick={() => setOpen(false)} className="absolute right-3 top-6 grid h-8 w-8 place-items-center rounded-lg bg-white/10 text-white" aria-label="Close menu"><Icon name="close" className="text-[18px]" /></button>
      </aside>
      {open && <div className="fixed inset-0 z-40 bg-slate-950/50 backdrop-blur-[2px] lg:hidden" onClick={() => setOpen(false)} />}
      <div className="min-w-0">
        <header className="sticky top-0 z-30 flex h-16 items-center gap-3 border-b border-line bg-white/85 px-4 backdrop-blur sm:px-6">
          <button className="grid h-10 w-10 place-items-center rounded-xl border border-line lg:hidden" onClick={() => setOpen(true)} aria-label="Menu"><Icon name="menu" /></button>
          <GlobalSearch />
          <Link href="/admin/search" className="grid h-10 w-10 place-items-center rounded-xl border border-line text-slate-500 sm:hidden" aria-label="Search"><Icon name="search" /></Link>
          <div className="ml-auto flex items-center gap-3">
            <ReauthPill />
            <a href="/" target="_blank" className="hidden text-sm font-bold text-mute hover:text-primary-dark md:inline">View website ↗</a>
            <div className="text-right lg:hidden">
              <div className="text-sm font-extrabold text-ink">{me.firstName} {me.lastName}</div>
              <div className="text-[11px] font-semibold text-mute">{me.role?.name}</div>
            </div>
            <button onClick={async () => { await logout(); router.replace("/admin/login"); }} className="grid h-10 w-10 place-items-center rounded-xl border border-line text-slate-500 hover:text-rose-600 lg:hidden" title="Sign out"><Icon name="logout" /></button>
          </div>
        </header>
        <main className="mx-auto max-w-[1440px] overflow-x-clip p-4 sm:p-6 lg:p-8 fade-up"><AreaGate path={path}>{children}</AreaGate></main>
      </div>
    </div>
  );
}
