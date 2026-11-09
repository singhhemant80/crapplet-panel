"use client";
import { OsLogo } from "@/components/os-logo";
import Link from "next/link";
import { Suspense } from "react";
import { useSearchParams } from "next/navigation";
import { CYCLES, date, gb, money } from "@/lib/api";
import { Badge, Button, Card, Empty, Icon, Loading, PageHeader, cx, useApi } from "@/components/ui";

const TABS = [
  ["", "All"],
  ["ACTIVE", "Active"],
  ["PENDING", "Pending"],
  ["SUSPENDED", "Suspended"],
  ["TERMINATED", "Terminated"],
];

function Services() {
  const sp = useSearchParams();
  const status = sp.get("status") ?? "";
  const { data, loading } = useApi(`/client/services${status ? `?status=${status}` : ""}`, [status]);
  return (
    <>
      <PageHeader title="My Services" subtitle="Your VPS, hosting and other services." actions={<Button href="/order" icon="add">Order new</Button>} />
      <div className="mb-4 flex gap-2 overflow-x-auto">
        {TABS.map(([k, l]) => (
          <Link key={k} href={k ? `/client/services?status=${k}` : "/client/services"} className={cx("rounded-full px-4 py-2 text-sm font-bold", status === k ? "bg-primary-dark text-white" : "bg-white text-slate-600 ring-1 ring-line hover:text-primary-dark")}>
            {l}
          </Link>
        ))}
      </div>
      {loading ? (
        <Loading />
      ) : !data?.services.length ? (
        <Card>
          <Empty icon="dns" title="No services here">
            <Button href="/order" className="mt-4" icon="add">
              Browse plans
            </Button>
          </Empty>
        </Card>
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {data.services.map((s: any) => {
            const ip = s.ips.find((i: any) => i.isPrimary)?.address ?? s.ips[0]?.address;
            const vps = s.product.provisioner === "PROXMOX" || s.product.provisioner === "VIRTUALIZOR";
            return (
              <Link key={s.id} href={`/client/services/${s.id}`} className="group rounded-2xl border border-line bg-white p-5 shadow-card transition hover:-translate-y-0.5 hover:border-primary/50">
                <div className="flex items-start justify-between gap-3">
                  <div className="flex min-w-0 items-center gap-3">
                    {vps && s.osTemplate ? (
                      <OsLogo os={s.osTemplate} size={44} />
                    ) : (
                      <span className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-primary-soft text-primary-dark group-hover:bg-primary group-hover:text-white">
                        <Icon name={vps ? "terminal" : "cloud"} />
                      </span>
                    )}
                    <div className="min-w-0">
                      <div className="truncate font-extrabold text-ink">{s.product.name}</div>
                      <div className="truncate text-sm text-mute">{s.hostname ?? "—"}</div>
                    </div>
                  </div>
                  <Badge status={s.status} />
                </div>
                <div className="mt-4 grid grid-cols-3 gap-2 rounded-xl bg-[#fbf9ff] p-3 text-center text-xs">
                  <div>
                    <div className="font-semibold text-mute">IP address</div>
                    <div className="mt-0.5 truncate font-bold text-ink">{ip ?? "—"}</div>
                  </div>
                  <div>
                    <div className="font-semibold text-mute">{vps ? "Resources" : "Cycle"}</div>
                    <div className="mt-0.5 truncate font-bold text-ink">{vps ? `${s.product.cpuCores}C · ${gb(s.product.ramMb)}` : CYCLES[s.billingCycle]}</div>
                  </div>
                  <div>
                    <div className="font-semibold text-mute">Next due</div>
                    <div className="mt-0.5 truncate font-bold text-ink">{date(s.nextDueDate)}</div>
                  </div>
                </div>
                <div className="mt-3 flex items-center justify-between text-sm">
                  <span className="text-mute">
                    {money(s.recurringAmount, s.currency)} / {CYCLES[s.billingCycle]?.toLowerCase()}
                  </span>
                  <span className="font-bold text-primary-dark">Manage →</span>
                </div>
              </Link>
            );
          })}
        </div>
      )}
    </>
  );
}
export default function Page() {
  return (
    <Suspense>
      <Services />
    </Suspense>
  );
}
