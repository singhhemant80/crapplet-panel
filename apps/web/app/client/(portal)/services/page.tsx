"use client";
import { ProvisioningTracker } from "@/components/provisioning-tracker";
import { LiveBadge, useLiveStates } from "@/components/live-state";
import { OsLogo } from "@/components/os-logo";
import Link from "next/link";
import { Suspense, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { CYCLES, date, gb, money } from "@/lib/api";
import { Badge, Copy, Icon, Input, Loading, cx, useApi } from "@/components/ui";

const TABS: [string, string][] = [
  ["", "All"],
  ["ACTIVE", "Active"],
  ["PENDING", "Pending"],
  ["SUSPENDED", "Suspended"],
  ["TERMINATED", "Terminated"],
];
const kindOf = (s: any) => (s.product.provisioner === "CPANEL" ? "hosting" : s.product.provisioner === "PROXMOX" || s.product.provisioner === "VIRTUALIZOR" ? "vps" : "other");

function Services() {
  const sp = useSearchParams();
  const status = sp.get("status") ?? "";
  const { data, loading } = useApi(`/client/services`);
  const live = useLiveStates("/client/services-live");
  const [q, setQ] = useState("");
  const [view, setView] = useState<"grid" | "list">("grid");
  const all: any[] = data?.services ?? [];
  const counts = useMemo(() => {
    const c: Record<string, number> = { "": all.length };
    for (const s of all) {
      const k = s.status === "PROVISIONING" || s.status === "FAILED" ? "PENDING" : s.status;
      c[k] = (c[k] ?? 0) + 1;
    }
    return c;
  }, [all]);
  const list = all.filter((s) => {
    const st = s.status === "PROVISIONING" || s.status === "FAILED" ? "PENDING" : s.status;
    if (status && st !== status) return false;
    if (!q.trim()) return true;
    const t = q.trim().toLowerCase();
    return [s.product.name, s.hostname, ...s.ips.map((i: any) => i.address)].some((x) => String(x ?? "").toLowerCase().includes(t));
  });

  return (
    <>
      <div className="mb-6 flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <h1 className="text-2xl font-extrabold tracking-tight text-ink">My services</h1>
          <p className="mt-1 text-sm text-mute">Your VPS servers, hosting accounts and other services.</p>
        </div>
        <Link href="/order" className="inline-flex h-11 items-center gap-2 self-start rounded-xl bg-gradient-to-r from-primary to-primary-dark px-5 text-sm font-bold text-white shadow-glow hover:-translate-y-px">
          <Icon name="add" className="text-[19px]" /> Order new service
        </Link>
      </div>

      <div className="mb-5 flex flex-col gap-3 rounded-2xl border border-[#ece7f7] bg-white p-2 shadow-card md:flex-row md:items-center">
        <div className="flex gap-1 overflow-x-auto">
          {TABS.map(([k, l]) => (
            <Link key={k} href={k ? `/client/services?status=${k}` : "/client/services"} className={cx("inline-flex shrink-0 items-center gap-1.5 rounded-xl px-3.5 py-2 text-[13px] font-bold transition", status === k ? "bg-primary-dark text-white shadow" : "text-slate-600 hover:bg-primary-tint hover:text-primary-dark")}>
              {l}
              <span className={cx("rounded-full px-1.5 text-[11px]", status === k ? "bg-white/20" : "bg-slate-100 text-slate-500")}>{counts[k] ?? 0}</span>
            </Link>
          ))}
        </div>
        <div className="flex flex-1 items-center gap-2 md:justify-end">
          <div className="relative flex-1 md:max-w-xs">
            <Icon name="search" className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[19px] text-mute" />
            <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search name, domain or IP" className="h-10 pl-10" />
          </div>
          <div className="hidden rounded-xl bg-slate-100 p-1 sm:flex">
            {(["grid", "list"] as const).map((v) => (
              <button key={v} onClick={() => setView(v)} className={cx("grid h-8 w-8 place-items-center rounded-lg", view === v ? "bg-white text-primary-dark shadow" : "text-slate-500")} aria-label={`${v} view`}>
                <Icon name={v === "grid" ? "grid_view" : "view_list"} className="text-[19px]" />
              </button>
            ))}
          </div>
        </div>
      </div>

      {loading ? (
        <Loading />
      ) : !list.length ? (
        <div className="flex flex-col items-center rounded-2xl border border-dashed border-[#dccafb] bg-white px-6 py-14 text-center">
          <span className="grid h-16 w-16 place-items-center rounded-2xl bg-primary-soft text-primary-dark"><Icon name={q ? "search_off" : "dns"} className="text-[32px]" /></span>
          <div className="mt-4 text-lg font-extrabold text-ink">{q ? "No matches" : "No services here"}</div>
          <p className="mt-1 max-w-sm text-sm text-mute">{q ? "Try another name, domain or IP address." : "Order a VPS or hosting plan — it's set up within minutes of payment."}</p>
          {!q && <Link href="/order" className="mt-5 inline-flex h-10 items-center gap-2 rounded-xl bg-primary-dark px-4 text-sm font-bold text-white">Browse plans</Link>}
        </div>
      ) : view === "grid" ? (
        <div className="grid gap-5 md:grid-cols-2 2xl:grid-cols-3">
          {list.map((s) => <ServiceCard key={s.id} s={s} st={live.states[s.id]} />)}
        </div>
      ) : (
        <div className="overflow-hidden rounded-2xl border border-[#ece7f7] bg-white shadow-card">
          <ul className="divide-y divide-[#f1edf9]">
            {list.map((s) => {
              const ip = s.ips.find((i: any) => i.isPrimary)?.address ?? s.ips[0]?.address;
              const kind = kindOf(s);
              return (
                <li key={s.id}>
                  <Link href={`/client/services/${s.id}`} className="group flex flex-wrap items-center gap-4 px-5 py-4 hover:bg-[#fbf9ff] sm:flex-nowrap">
                    <KindIcon kind={kind} os={s.osTemplate} />
                    <span className="min-w-0 flex-1"><span className="block truncate font-bold text-ink group-hover:text-primary-dark">{s.product.name}</span><span className="block truncate text-xs text-mute">{s.hostname ?? "—"}</span></span>
                    <span className="hidden w-36 font-mono text-[12.5px] text-slate-700 md:block">{ip ?? "—"}</span>
                    <span className="w-24">{live.states[s.id] ? <LiveBadge state={live.states[s.id].state} /> : <Badge status={s.status} />}</span>
                    <span className="hidden w-32 text-right text-xs text-mute sm:block">{s.nextDueDate ? `due ${date(s.nextDueDate)}` : "—"}</span>
                    <Icon name="chevron_right" className="text-mute" />
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </>
  );
}

function KindIcon({ kind, os, size = 44 }: { kind: string; os?: any; size?: number }) {
  if (kind === "vps" && os) return <OsLogo os={os} size={size} className="rounded-xl" />;
  return (
    <span className={cx("grid shrink-0 place-items-center rounded-xl", kind === "hosting" ? "bg-sky-50 text-sky-600" : kind === "vps" ? "bg-primary-soft text-primary-dark" : "bg-slate-100 text-slate-600")} style={{ width: size, height: size }}>
      <Icon name={kind === "hosting" ? "language" : kind === "vps" ? "terminal" : "widgets"} />
    </span>
  );
}

function ServiceCard({ s, st }: { s: any; st?: { state: string; reason?: string } }) {
  const ip = s.ips.find((i: any) => i.isPrimary)?.address ?? s.ips[0]?.address;
  const kind = kindOf(s);
  const setup = ["PENDING", "PROVISIONING", "FAILED"].includes(s.status) && kind !== "other";
  const days = s.nextDueDate ? Math.ceil((new Date(s.nextDueDate).getTime() - Date.now()) / 86400_000) : null;
  const specs =
    kind === "vps"
      ? [["memory", `${s.product.cpuCores ?? "—"} vCPU`], ["memory_alt", gb(s.product.ramMb)], ["hard_drive", `${s.product.diskGb ?? "—"} GB NVMe`]]
      : kind === "hosting"
        ? [["hard_drive", s.product.diskGb ? `${s.product.diskGb} GB disk` : "Unlimited disk"], ["swap_vert", s.product.bandwidthGb ? `${s.product.bandwidthGb} GB bandwidth` : "Unmetered"], ["mail", "Email & SSL"]]
        : [];
  return (
    <div className="group flex flex-col overflow-hidden rounded-2xl border border-[#ece7f7] bg-white shadow-card transition hover:-translate-y-0.5 hover:border-[#dccafb] hover:shadow-lg">
      <div className={cx("h-1", s.status === "ACTIVE" ? "bg-gradient-to-r from-emerald-400 to-teal-400" : s.status === "SUSPENDED" ? "bg-gradient-to-r from-amber-400 to-orange-400" : setup ? "bg-gradient-to-r from-primary to-fuchsia-400" : "bg-slate-200")} />
      <Link href={`/client/services/${s.id}`} className="flex items-start justify-between gap-3 p-5 pb-0">
        <div className="flex min-w-0 items-center gap-3">
          <KindIcon kind={kind} os={s.osTemplate} />
          <div className="min-w-0">
            <div className="truncate text-[15px] font-extrabold text-ink group-hover:text-primary-dark">{s.product.name}</div>
            <div className="truncate text-[13px] text-mute">{s.hostname ?? (kind === "vps" ? "Hostname not set" : "—")}</div>
          </div>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1">
          {st && s.status === "ACTIVE" ? <LiveBadge state={st.state} reason={st.reason} /> : <Badge status={s.status} />}
          <span className="text-[11px] font-semibold uppercase tracking-wide text-mute">{kind === "hosting" ? (s.product.type === "RESELLER_HOSTING" ? "Reseller" : "cPanel hosting") : kind === "vps" ? `${s.product.virtType ?? "KVM"} VPS` : "Service"}</span>
        </div>
      </Link>
      {setup ? (
        <div className="mx-5 mt-4 rounded-xl bg-[#fbf9ff] px-3 py-2.5">
          <ProvisioningTracker path={`/client/services/${s.id}/provisioning`} audience="client" compact />
        </div>
      ) : (
        specs.length > 0 && (
          <div className="mx-5 mt-4 flex flex-wrap gap-1.5">
            {specs.map(([ic, t]) => <span key={t} className="inline-flex items-center gap-1 rounded-lg bg-[#f6f3fd] px-2 py-1 text-[11.5px] font-semibold text-slate-600"><Icon name={ic} className="text-[14px] text-primary" />{t}</span>)}
          </div>
        )
      )}
      <div className="mx-5 mt-4 grid grid-cols-2 gap-3 rounded-xl border border-[#f1edf9] p-3 text-xs">
        <div className="min-w-0">
          <div className="font-semibold text-mute">{kind === "hosting" ? "Domain" : "IP address"}</div>
          <div className="mt-0.5 flex items-center gap-1 truncate font-bold text-ink">{kind === "hosting" ? s.hostname ?? "—" : <><span className="truncate font-mono">{ip ?? "—"}</span>{ip && <Copy text={ip} />}</>}</div>
        </div>
        <div className="min-w-0">
          <div className="font-semibold text-mute">{kind === "vps" ? "Operating system" : "Billing"}</div>
          <div className="mt-0.5 truncate font-bold text-ink">{kind === "vps" ? s.osTemplate?.name ?? "—" : CYCLES[s.billingCycle]}</div>
        </div>
      </div>
      <div className="mt-auto flex items-center justify-between gap-3 px-5 py-4">
        <div className="text-xs">
          <div className="font-bold text-ink">{money(s.recurringAmount, s.currency)} <span className="font-medium text-mute">/ {CYCLES[s.billingCycle]?.toLowerCase()}</span></div>
          <div className={cx(days !== null && days <= 7 && s.status === "ACTIVE" ? "font-semibold text-rose-600" : "text-mute")}>{s.nextDueDate ? `Renews ${date(s.nextDueDate)}${days !== null && days >= 0 && days <= 30 ? ` · ${days}d` : ""}` : "—"}</div>
        </div>
        <Link href={`/client/services/${s.id}`} className="inline-flex h-9 items-center gap-1.5 rounded-xl bg-primary-tint px-3.5 text-[13px] font-bold text-primary-dark transition group-hover:bg-primary-dark group-hover:text-white">
          Manage <Icon name="arrow_forward" className="text-[16px]" />
        </Link>
      </div>
    </div>
  );
}

export default function Page() {
  return (
    <Suspense>
      <Services />
    </Suspense>
  );
}
