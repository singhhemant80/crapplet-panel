"use client";
import Link from "next/link";
import { Suspense, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { api, money } from "@/lib/api";
import { Badge, Button, Empty, Field, Icon, Input, Loading, Modal, PageHeader, Pager, cx, toast, useApi } from "@/components/ui";
import { emptyProfile, ProfileFields } from "@/components/profile-fields";
import { Ago, Avatar, ListShell, SearchBox, StatusTabs, initialsOf, type Tab } from "@/components/admin/list-kit";

const TABS: Tab[] = [
  { key: "", label: "All customers" },
  { key: "active", label: "With active services", tone: "green" },
  { key: "unpaid", label: "Unpaid invoices", tone: "amber" },
  { key: "overdue", label: "Overdue", tone: "rose" },
  { key: "new", label: "New · 30 days", tone: "purple" },
  { key: "noservices", label: "No services", tone: "slate" },
  { key: "inactive", label: "Inactive / closed", tone: "slate" },
];
const inr = (paise: number) => money(paise, "INR").replace(/\.00$/, "");
const flag = (cc?: string | null) => (cc && /^[A-Z]{2}$/.test(cc) ? String.fromCodePoint(...[...cc].map((c) => 0x1f1a5 + c.charCodeAt(0))) : "");

function Clients() {
  const sp = useSearchParams();
  const router = useRouter();
  const [q, setQ] = useState(sp.get("q") ?? "");
  const [segment, setSegment] = useState(sp.get("segment") ?? "");
  const [page, setPage] = useState(1);
  const [adding, setAdding] = useState(false);
  const qs = new URLSearchParams({ page: String(page), ...(q && { q }), ...(segment && { segment }) });
  const { data, loading, reload } = useApi(`/admin/clients?${qs}`, [page, q, segment]);
  const c = data?.counts;

  return (
    <>
      <PageHeader
        title="Customers"
        subtitle="Everyone with an account — open a customer to see their services, invoices, tickets and notes."
        actions={<Button icon="person_add" onClick={() => setAdding(true)}>Add customer</Button>}
        stats={
          c
            ? [
                ["Customers", c.all.toLocaleString("en-IN"), `${c.new} joined in 30 days`],
                ["With active services", c.active.toLocaleString("en-IN"), c.all ? `${Math.round((c.active / c.all) * 100)}% of all` : undefined],
                ["Owe money", c.unpaid.toLocaleString("en-IN"), "unpaid invoices"],
                ["Overdue", <span key="o" className={c.overdue ? "text-rose-600" : ""}>{c.overdue.toLocaleString("en-IN")}</span>, "past the due date"],
              ]
            : undefined
        }
      />

      <ListShell
        toolbar={
          <>
            <StatusTabs tabs={TABS} value={segment} onChange={(k) => { setSegment(k); setPage(1); }} counts={c} />
            <SearchBox value={q} onSearch={(v) => { setQ(v); setPage(1); }} placeholder="Search name, email, phone, company, GSTIN, IP…" />
          </>
        }
        footer={data && <Pager page={data.page} pageSize={data.pageSize} total={data.total} onPage={setPage} />}
      >
        {loading && !data ? <Loading /> : !data?.clients.length ? (
          <Empty icon="group" title={q || segment ? "No customers match" : "No customers yet"}>
            <p className="text-sm text-mute">{q || segment ? "Try another tab or search." : "Add one, or they'll appear when they sign up."}</p>
          </Empty>
        ) : (
          <div className={cx("transition-opacity", loading && "opacity-60")}>
            <div className="hidden xl:block">
              <table className="w-full table-fixed text-left text-sm">
                <colgroup><col style={{ width: "22%" }} /><col style={{ width: "19%" }} /><col style={{ width: "14%" }} /><col style={{ width: "8%" }} /><col style={{ width: "15%" }} /><col style={{ width: "10%" }} /><col style={{ width: "12%" }} /></colgroup>
                <thead>
                  <tr className="border-b border-line bg-[#fbf9ff] text-[11.5px] font-bold uppercase tracking-wider text-mute">
                    <th className="py-3 pl-5 pr-3">Customer</th>
                    <th className="px-3 py-3">Contact</th>
                    <th className="px-3 py-3">Company / GSTIN</th>
                    <th className="px-3 py-3 text-center">Services</th>
                    <th className="px-3 py-3 text-right">Balance</th>
                    <th className="px-3 py-3">Status</th>
                    <th className="py-3 pl-3 pr-5">Activity</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {data.clients.map((u: any) => (
                    <tr key={u.id} className="group cursor-pointer transition hover:bg-[#fbf9ff]" onClick={(e) => { if (!(e.target as HTMLElement).closest("a,button")) router.push(`/admin/clients/${u.id}`); }}>
                      <td className="py-3 pl-5 pr-3"><Who u={u} /></td>
                      <td className="px-3 py-3">
                        <a href={`mailto:${u.email}`} className="block truncate text-[13px] text-slate-700 hover:text-primary-dark">{u.email}</a>
                        {u.phone ? <a href={`tel:${u.phone}`} className="block text-[12px] text-mute hover:text-primary-dark">{u.phone}</a> : <span className="text-[12px] text-slate-300">no phone</span>}
                      </td>
                      <td className="px-3 py-3">
                        <div className="truncate text-[13px] font-semibold text-ink">{u.profile?.companyName || <span className="font-normal text-slate-300">—</span>}</div>
                        {u.profile?.gstin && <div className="font-mono text-[11.5px] text-mute">{u.profile.gstin}</div>}
                      </td>
                      <td className="px-3 py-3 text-center"><Services u={u} /></td>
                      <td className="whitespace-nowrap px-3 py-3 text-right"><Balance u={u} /></td>
                      <td className="px-3 py-3"><StatusCell u={u} /></td>
                      <td className="whitespace-nowrap py-3 pl-3 pr-5 text-[12px] text-mute">
                        <div>Joined <Ago at={u.createdAt} /></div>
                        <div>{u.stats.lastLoginAt ? <>Seen <Ago at={u.stats.lastLoginAt} /></> : "Never signed in"}</div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <ul className="divide-y divide-line xl:hidden">
              {data.clients.map((u: any) => (
                <li key={u.id}>
                  <Link href={`/admin/clients/${u.id}`} className="block space-y-3 p-4 active:bg-[#fbf9ff]">
                    <div className="flex items-start justify-between gap-3">
                      <Who u={u} plain />
                      <StatusCell u={u} />
                    </div>
                    <div className="grid grid-cols-3 gap-2 rounded-xl bg-[#fbf9ff] p-2.5 text-center">
                      <div><div className="text-[11px] font-bold uppercase tracking-wide text-mute">Services</div><div className="mt-0.5"><Services u={u} /></div></div>
                      <div><div className="text-[11px] font-bold uppercase tracking-wide text-mute">Owes</div><div className={cx("mt-0.5 font-extrabold tabular-nums", u.stats.dueInr ? (u.stats.overdue ? "text-rose-600" : "text-amber-600") : "text-slate-400")}>{u.stats.dueInr ? inr(u.stats.dueInr) : "—"}</div></div>
                      <div><div className="text-[11px] font-bold uppercase tracking-wide text-mute">Paid</div><div className="mt-0.5 font-extrabold tabular-nums text-ink">{inr(u.stats.paidInr)}</div></div>
                    </div>
                    <div className="flex items-center justify-between text-[12px] text-mute">
                      <span className="truncate">{u.phone || u.email}</span>
                      <span className="shrink-0">Joined <Ago at={u.createdAt} /></span>
                    </div>
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        )}
      </ListShell>
      <AddClient open={adding} onClose={() => setAdding(false)} onDone={reload} />
    </>
  );
}

function Who({ u, plain }: { u: any; plain?: boolean }) {
  const name = `${u.firstName ?? ""} ${u.lastName ?? ""}`.trim() || u.email;
  const place = [u.profile?.city, u.profile?.state].filter(Boolean).join(", ");
  const Tag: any = plain ? "span" : Link;
  return (
    <Tag {...(plain ? {} : { href: `/admin/clients/${u.id}` })} className="group/c flex min-w-0 items-center gap-3">
      <Avatar name={initialsOf(u.firstName, u.lastName, u.email)} seed={u.id} size={40} />
      <span className="min-w-0">
        <span className="flex items-center gap-1.5">
          <span className="truncate font-bold text-ink group-hover/c:text-primary-dark">{name}</span>
          {u.emailVerifiedAt && <span title="Email verified" className="shrink-0"><Icon name="verified" className="text-[15px] text-sky-500" fill /></span>}
        </span>
        <span className="block truncate text-[12px] text-mute">{flag(u.profile?.country)} {place || u.profile?.country || "—"}</span>
      </span>
    </Tag>
  );
}

function Services({ u }: { u: any }) {
  const live = u.stats.liveServices;
  const all = u._count.services;
  return (
    <span className={cx("inline-flex items-baseline gap-0.5 font-extrabold tabular-nums", live ? "text-emerald-600" : "text-slate-400")} title={`${live} active or suspended of ${all}`}>
      {live}<span className="text-[11.5px] font-semibold text-mute">/{all}</span>
    </span>
  );
}

function Balance({ u }: { u: any }) {
  const credit = u.profile?.creditBalance ?? 0;
  return (
    <div className="space-y-0.5">
      {u.stats.dueInr > 0 ? (
        <div className={cx("font-extrabold tabular-nums", u.stats.overdue ? "text-rose-600" : "text-amber-600")}>{inr(u.stats.dueInr)} <span className="text-[11px] font-bold uppercase">{u.stats.overdue ? "overdue" : "due"}</span></div>
      ) : (
        <div className="text-[12.5px] font-semibold text-emerald-600">Nothing due</div>
      )}
      {u.stats.paidInr > 0 && <div className="truncate text-[11.5px] text-mute">paid {inr(u.stats.paidInr)}</div>}
      {credit > 0 && <div className="truncate text-[11.5px] font-semibold text-sky-700">credit {money(credit, u.profile?.currency ?? "INR").replace(/\.00$/, "")}</div>}
    </div>
  );
}

function StatusCell({ u }: { u: any }) {
  return (
    <div className="flex flex-col items-start gap-1">
      <Badge status={u.status} />
      {u.ownerResellerId && <span className="rounded-md bg-sky-50 px-1.5 py-0.5 text-[10.5px] font-bold text-sky-700 ring-1 ring-sky-200">reseller's customer</span>}
      {u._count.tickets > 0 && <span className="inline-flex items-center gap-0.5 text-[11.5px] font-bold text-violet-700"><Icon name="support_agent" className="text-[14px]" />{u._count.tickets} open ticket{u._count.tickets > 1 ? "s" : ""}</span>}
    </div>
  );
}

function AddClient({ open, onClose, onDone }: { open: boolean; onClose: () => void; onDone: () => void }) {
  const [v, setV] = useState(emptyProfile);
  const [email, setEmail] = useState("");
  return (
    <Modal open={open} onClose={onClose} title="Add customer" wide>
      <Field label="Email" className="mb-4"><Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} /></Field>
      <ProfileFields v={v} set={(p) => setV({ ...v, ...p })} />
      <Button className="mt-5" onClick={() => api("/admin/clients", { body: { ...v, email } }).then((r) => { toast.success(r.password ? `Created — temporary password: ${r.password}` : "Customer created"); onClose(); onDone(); }).catch((e) => toast.error(e.message))}>Create customer</Button>
    </Modal>
  );
}

export default function Page() {
  return <Suspense fallback={<Loading />}><Clients /></Suspense>;
}
