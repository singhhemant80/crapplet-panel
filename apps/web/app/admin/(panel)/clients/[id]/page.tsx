"use client";
import Link from "next/link";
import { InvoiceFor } from "@/components/invoice-for";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";
import { api, date, invNo, money } from "@/lib/api";
import { Ago, planIcon } from "@/components/admin/list-kit";
import { Alert, Badge, Button, Card, Copy, Field, Icon, Input, Loading, PageHeader, Modal, Select, Table, Td, Textarea, Toggle, cx, toast, useApi } from "@/components/ui";

const COUNTRY: Record<string, string> = { IN: "India", US: "United States", GB: "United Kingdom", AE: "United Arab Emirates", SG: "Singapore", CA: "Canada", AU: "Australia", DE: "Germany" };
const fullName = (x: any) => [x?.firstName, x?.lastName].filter(Boolean).join(" ") || x?.email || "—";

/** Client summary — everything about one customer on one screen (WHMCS "Client Summary"). */
export default function ClientDetail() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const { data, loading, reload } = useApi(`/admin/clients/${id}`);
  const { data: sum, reload: reloadSum } = useApi(`/admin/clients/${id}/summary`);
  const [tab, setTab] = useState("services");
  const [modal, setModal] = useState<string | null>(null);
  // links like /admin/clients/x?tab=invoices open that tab
  useEffect(() => {
    const t = new URLSearchParams(window.location.search).get("tab");
    if (t && TABS.some(([k]) => k === t)) setTab(t);
  }, []);
  const refresh = () => {
    reload();
    reloadSum();
  };
  if (loading || !data) return <Loading />;
  const c = data.client;
  const p = c.profile ?? {};
  const cur = p.currency ?? "INR";
  const close = () => setModal(null);

  const run = (fn: () => Promise<any>, ok: string | ((r: any) => string)) =>
    fn()
      .then((r) => {
        toast.success(typeof ok === "string" ? ok : ok(r));
        refresh();
      })
      .catch((e) => toast.error(e.message));

  const loginAs = async () => {
    if (!confirm(`Sign in to the client area as ${c.email}? You'll leave the admin until you click "Back to admin".`)) return;
    try {
      const r = await api<{ redirect: string }>("/auth/impersonate", { body: { userId: c.id } });
      window.location.href = r.redirect;
    } catch (e: any) {
      toast.error(e.message);
    }
  };
  const goTab = (t: string) => {
    setTab(t);
    setTimeout(() => document.getElementById("client-tabs")?.scrollIntoView({ behavior: "smooth", block: "start" }), 50);
  };

  const initials = ((c.firstName?.[0] ?? "") + (c.lastName?.[0] ?? c.email?.[1] ?? "")).toUpperCase();
  const place = [p.city, p.state, COUNTRY[p.country] ?? p.country].filter(Boolean).join(", ");
  const inv = sum?.invoices;
  const due = inv ? inv.UNPAID.total + inv.COLLECTIONS.total : 0;
  const services = data.services as any[];
  const activeSvc = services.filter((s) => s.status === "ACTIVE").length;

  return (
    <>
      <PageHeader
        back="/admin/clients"
        icon={<span className="text-lg font-extrabold">{initials}</span>}
        title={fullName(c)}
        badge={<Badge status={c.status} />}
        subtitle={<>{p.companyName ? <b className="font-semibold text-white">{p.companyName} · </b> : null}Client #{c.id.slice(-6).toUpperCase()} · since {date(c.createdAt)}{sum ? ` (${sum.other.clientForDays} day${sum.other.clientForDays === 1 ? "" : "s"})` : ""}{!c.emailVerified && <span className="ml-2 rounded-full bg-amber-400/20 px-2 py-0.5 text-[11px] font-bold text-amber-200 ring-1 ring-amber-300/40">Email not verified</span>}{c.reseller && <span className="ml-2 rounded-full bg-sky-400/20 px-2 py-0.5 text-[11px] font-bold text-sky-100 ring-1 ring-sky-300/40">Reseller</span>}</>}
        meta={<>
          <span className="inline-flex items-center gap-1.5 break-all"><Icon name="mail" className="text-[16px] text-white/60" />{c.email}<span className="[&_button]:text-white/80"><Copy text={c.email} /></span></span>
          {c.phone && <span className="inline-flex items-center gap-1.5"><Icon name="call" className="text-[16px] text-white/60" />{c.phone}</span>}
          {place && <span className="inline-flex items-center gap-1.5"><Icon name="location_on" className="text-[16px] text-white/60" />{place}</span>}
          {sum?.other.lastLogin && <span className="inline-flex items-center gap-1.5"><Icon name="schedule" className="text-[16px] text-white/60" />Last login {date(sum.other.lastLogin.at, true)} · <span className="font-mono text-[12px]">{sum.other.lastLogin.ip}</span></span>}
        </>}
        actions={<>
          <Button size="sm" icon="add_shopping_cart" href={`/admin/orders/new?client=${c.id}`}>New order</Button>
          <Button size="sm" variant="outline" icon="login" disabled={c.status !== "ACTIVE"} onClick={loginAs}>Login as client</Button>
          <Button size="sm" variant="outline" icon="mail" onClick={() => setModal("email")}>Email</Button>
          <Button size="sm" variant="outline" icon="chat" disabled={!c.phone} onClick={() => setModal("whatsapp")}>WhatsApp</Button>
        </>}
      />

      {/* ── KPIs ── */}
      <div className="mb-5 grid grid-cols-2 gap-3 sm:gap-4 xl:grid-cols-5 [&>*:last-child]:col-span-2 xl:[&>*:last-child]:col-span-1">
        <Kpi icon="account_balance_wallet" tone="purple" label="Credit balance" value={sum ? money(sum.income.credit, cur) : "…"} onClick={() => setModal("credit")} hint="Manage credits" />
        <Kpi icon="pending_actions" tone={due > 0 ? "rose" : "green"} label="Due now" value={sum ? money(due, cur) : "…"} hint={inv ? `${inv.UNPAID.count + inv.COLLECTIONS.count} unpaid invoice${inv.UNPAID.count + inv.COLLECTIONS.count === 1 ? "" : "s"}` : ""} onClick={() => goTab("invoices")} />
        <Kpi icon="payments" tone="green" label="Lifetime revenue" value={sum ? money(sum.income.gross, cur) : "…"} hint={sum ? `Net ${money(sum.income.net, cur)} after fees` : ""} onClick={() => goTab("statement")} />
        <Kpi icon="dns" tone="sky" label="Active services" value={`${activeSvc}`} hint={`${services.length} total · ${sum?.products.domains ?? 0} domain${sum?.products.domains === 1 ? "" : "s"}`} onClick={() => goTab("services")} />
        <Kpi icon="support_agent" tone={sum?.products.openTickets ? "amber" : "slate"} label="Open tickets" value={`${sum?.products.openTickets ?? 0}`} hint={`${sum?.products.tickets ?? 0} total`} onClick={() => goTab("tickets")} />
      </div>

      <div className="grid items-start gap-5 xl:grid-cols-[minmax(0,1fr)_370px]">
        {/* ── main column ── */}
        <div className="min-w-0 space-y-5">
          <Records tab={tab} setTab={setTab} data={data} services={services} id={id} cur={cur} />

          <Panel icon="badge" title="Account details" action={<HeadBtn icon="edit" onClick={() => setModal("profile")}>Edit</HeadBtn>}>
            <dl className="grid gap-x-8 gap-y-3.5 sm:grid-cols-2 lg:grid-cols-3">
              <Item k="Full name" v={fullName(c)} />
              <Item k="Company" v={p.companyName} />
              <Item k="Phone" v={c.phone} />
              <Item k="Address" v={[p.address1, p.address2].filter(Boolean).join(", ")} wide />
              <Item k="City / postcode" v={[p.city, p.postcode].filter(Boolean).join(" – ")} />
              <Item k="State" v={p.state ? `${p.state}${p.stateCode ? ` (GST code ${p.stateCode})` : ""}` : ""} />
              <Item k="Country" v={COUNTRY[p.country] ?? p.country} />
              <Item k="GSTIN" v={p.gstin} mono />
              <Item k="PAN" v={p.pan} mono />
              <div>
                <dt className="text-[11.5px] font-bold uppercase tracking-wide text-mute">Billing currency</dt>
                <dd className="mt-1"><Select className="h-8 w-28 text-sm" value={cur} onChange={(e) => run(() => api(`/admin/clients/${id}`, { method: "PUT", body: { currency: e.target.value } }), `Now billed in ${e.target.value}`)}><option>INR</option><option>USD</option></Select></dd>
              </div>
              <div>
                <dt className="text-[11.5px] font-bold uppercase tracking-wide text-mute">Account status</dt>
                <dd className="mt-1"><Select className="h-8 w-32 text-sm" value={c.status} onChange={(e) => run(() => api(`/admin/clients/${id}`, { method: "PUT", body: { status: e.target.value } }), "Status updated")}><option>ACTIVE</option><option>INACTIVE</option><option>CLOSED</option></Select></dd>
              </div>
              <div>
                <dt className="text-[11.5px] font-bold uppercase tracking-wide text-mute">WhatsApp notifications</dt>
                <dd className="mt-1"><Select className="h-8 w-28 text-sm" value={p.whatsappNotifications === false ? "off" : "on"} onChange={(e) => run(() => api(`/admin/clients/${id}/whatsapp-pref`, { method: "PUT", body: { enabled: e.target.value === "on" } }), e.target.value === "on" ? "WhatsApp notifications on" : "WhatsApp notifications off")}><option value="on">On</option><option value="off">Off</option></Select></dd>
              </div>
              <Item k="Security" v={`${sum?.other.twoFactor ? "2FA on" : "2FA off"} · ${sum?.other.activeSessions ?? 0} signed-in session${sum?.other.activeSessions === 1 ? "" : "s"}`} />
            </dl>
            <div className="mt-4 flex flex-wrap gap-2 border-t border-line pt-4">
              <Button size="sm" variant="ghost" icon="password" onClick={() => setModal("setpw")}>Set new password</Button>
              <Button size="sm" variant="ghost" icon="lock_reset" onClick={() => confirm(`Email ${c.email} a password reset link?`) && run(() => api(`/admin/clients/${id}/password-reset`, { body: {} }), "Password reset email sent")}>Send password reset</Button>
              {c.totpEnabled && <Button size="sm" variant="ghost" icon="phonelink_lock" onClick={() => confirm("Turn off two-factor sign-in for this customer?") && run(() => api(`/admin/clients/${id}/reset-2fa`, { body: {} }), "2FA reset")}>Reset 2FA</Button>}
              {sum?.other.affiliate ? <span className="inline-flex items-center gap-1.5 rounded-xl bg-primary-tint px-3 text-[13px] font-semibold text-primary-dark"><Icon name="handshake" className="text-[17px]" />Affiliate <span className="font-mono">{sum.other.affiliate.code}</span></span>
                : <Button size="sm" variant="ghost" icon="handshake" onClick={() => run(() => api(`/admin/clients/${id}/affiliate`, { body: {} }), (r) => `Affiliate activated — code ${r.code}`)}>Activate as affiliate</Button>}
            </div>
          </Panel>

          <Panel icon="receipt_long" title="Invoices & billing">
            {inv ? (
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                {([["PAID", "Paid", "text-emerald-700"], ["UNPAID", "Unpaid / due", "text-rose-600"], ["DRAFT", "Draft", "text-slate-600"], ["CANCELLED", "Cancelled", "text-slate-600"], ["REFUNDED", "Refunded", "text-sky-700"], ["COLLECTIONS", "Collections", "text-amber-700"]] as const).map(([k, l, tone]) => (
                  <button key={k} type="button" onClick={() => goTab("invoices")} className="rounded-xl border border-line bg-[#fcfaff] px-4 py-3 text-left transition hover:border-[#dccafb] hover:bg-white">
                    <div className="text-[12px] font-semibold text-mute">{l}</div>
                    <div className={cx("mt-0.5 text-lg font-extrabold", inv[k].count ? tone : "text-slate-300")}>{money(inv[k].total, cur)}</div>
                    <div className="text-[11.5px] text-mute">{inv[k].count} invoice{inv[k].count === 1 ? "" : "s"}</div>
                  </button>
                ))}
              </div>
            ) : <Loading />}
            <div className="mt-4 flex flex-wrap gap-2 border-t border-line pt-4">
              <Button size="sm" variant="secondary" icon="add" onClick={() => setModal("invoice")}>Create invoice</Button>
              <Button size="sm" variant="ghost" icon="savings" onClick={() => setModal("funds")}>Add funds invoice</Button>
              <Button size="sm" variant="ghost" icon="event_repeat" onClick={() => run(() => api(`/admin/clients/${id}/generate-due`, { body: {} }), (r) => (r.created ? `${r.created} due invoice${r.created > 1 ? "s" : ""} created` : "Nothing is due yet — no invoices created"))}>Generate due invoices</Button>
              <Button size="sm" variant="ghost" icon="account_balance_wallet" onClick={() => setModal("credit")}>Manage credits</Button>
              <Button size="sm" variant="ghost" icon="summarize" onClick={() => goTab("statement")}>Account statement</Button>
            </div>
          </Panel>

          <Panel icon="inventory_2" title="Products & services" action={<HeadBtn icon="add" onClick={() => router.push(`/admin/orders/new?client=${c.id}`)}>Add order</HeadBtn>}>
            {sum ? (
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                <Count icon="dns" label="VPS / servers" a={sum.products.server.active} t={sum.products.server.total} />
                <Count icon="cloud" label="Shared hosting" a={sum.products.shared.active} t={sum.products.shared.total} />
                <Count icon="storefront" label="Reseller hosting" a={sum.products.reseller.active} t={sum.products.reseller.total} />
                <Count icon="widgets" label="Other services" a={sum.products.other.active} t={sum.products.other.total} />
                <Count icon="language" label="Domains" a={sum.products.domains} onClick={() => goTab("domains")} />
                <Count icon="shopping_bag" label="Orders" a={sum.products.orders} onClick={() => goTab("orders")} />
                <Count icon="forum" label="Tickets" a={sum.products.tickets} onClick={() => goTab("tickets")} />
                <Count icon="group_add" label="Affiliate signups" a={sum.products.affiliateSignups} />
              </div>
            ) : <Loading />}
          </Panel>

        </div>

        {/* ── sidebar ── */}
        <aside className="min-w-0 space-y-5">
          <Panel icon="bolt" title="Quick actions">
            <div className="grid grid-cols-2 gap-2">
              <Quick icon="summarize" onClick={() => goTab("statement")}>Statement</Quick>
              <Quick icon="support_agent" onClick={() => setModal("ticket")}>Open ticket</Quick>
              <Quick icon="forum" onClick={() => goTab("tickets")}>All tickets</Quick>
              <Quick icon="list_alt" onClick={() => goTab("orders")}>Orders</Quick>
              <Quick icon="call_merge" onClick={() => setModal("merge")}>Merge</Quick>
              <Quick icon="download" onClick={() => (window.location.href = `/api/admin/clients/${id}/export`)}>Export data</Quick>
            </div>
          </Panel>

          <Panel icon="contacts" title="Contacts" count={sum?.contacts?.length} action={<HeadBtn icon="add" onClick={() => setModal("contact")}>Add</HeadBtn>}>
            {sum?.contacts?.length ? (
              <ul className="-my-1 divide-y divide-line">
                {sum.contacts.map((k: any) => (
                  <li key={k.id} className="group flex items-center gap-3 py-2.5">
                    <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-slate-100 text-[12px] font-bold text-slate-600">{((k.firstName?.[0] ?? "") + (k.lastName?.[0] ?? "")).toUpperCase()}</span>
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-bold text-ink">{fullName(k)}</div>
                      <div className="truncate text-xs text-mute">{k.email}{k.emails?.length ? ` · ${k.emails.join(", ")}` : ""}</div>
                    </div>
                    <RowDel title="Remove contact" onClick={() => confirm(`Remove ${k.email}?`) && run(() => api(`/admin/clients/${id}/contacts/${k.id}`, { method: "DELETE" }), "Contact removed")} />
                  </li>
                ))}
              </ul>
            ) : <Blank icon="person_add">No additional contacts</Blank>}
          </Panel>

          <Panel icon="credit_card" title="Pay methods" count={sum?.payMethods?.length} action={<HeadBtn icon="add" onClick={() => setModal("paymethod")}>Add</HeadBtn>}>
            {sum?.payMethods?.length ? (
              <ul className="space-y-2.5">
                {sum.payMethods.map((m: any) => (
                  <li key={m.id} className={cx("rounded-xl border p-3", m.isDefault ? "border-[#dccafb] bg-primary-tint" : "border-line")}>
                    <div className="flex items-start gap-3">
                      <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-white text-primary-dark ring-1 ring-line"><Icon name={m.type === "CARD" ? "credit_card" : m.type === "UPI" ? "qr_code_2" : m.type === "BANK" ? "account_balance" : "verified_user"} className="text-[19px]" /></span>
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-1.5 text-sm font-bold text-ink"><span className="truncate">{m.label}</span>{m.isDefault && <span className="rounded bg-primary-dark px-1.5 py-px text-[10px] font-bold uppercase text-white">Default</span>}{m.status !== "ACTIVE" && <Badge status="FAILED">{m.status}</Badge>}</div>
                        <div className="text-xs capitalize text-mute">{m.gateway}{m.last4 ? ` · •••• ${m.last4}` : ""}{m.expiry ? ` · exp ${m.expiry}` : ""}</div>
                      </div>
                      <RowDel title="Remove" onClick={() => confirm(`Remove ${m.label}?`) && run(() => api(`/admin/clients/${id}/pay-methods/${m.id}`, { method: "DELETE" }), "Pay method removed")} />
                    </div>
                    <div className="mt-2 flex items-center justify-between gap-2 pl-12">
                      <Toggle checked={m.autopay} onChange={(v) => run(() => api(`/admin/clients/${id}/pay-methods/${m.id}`, { method: "PUT", body: { autopay: v } }), v ? "Autopay on" : "Autopay off")} label={<span className="text-xs">Autopay</span>} />
                      {!m.isDefault && <button className="text-xs font-bold text-primary-dark hover:underline" onClick={() => run(() => api(`/admin/clients/${id}/pay-methods/${m.id}`, { method: "PUT", body: { isDefault: true } }), "Default pay method set")}>Make default</button>}
                    </div>
                  </li>
                ))}
              </ul>
            ) : <Blank icon="add_card">No saved pay methods</Blank>}
          </Panel>

          <Panel icon="folder" title="Files" count={sum?.files?.length} action={<HeadBtn icon="upload" onClick={() => setModal("file")}>Upload</HeadBtn>}>
            {sum?.files?.length ? (
              <ul className="-my-1 divide-y divide-line">
                {sum.files.map((f: any) => (
                  <li key={f.id} className="group flex items-center gap-3 py-2.5">
                    <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-sky-50 text-sky-600"><Icon name={/\.pdf$/i.test(f.filename) ? "picture_as_pdf" : /\.(png|jpe?g|gif|webp)$/i.test(f.filename) ? "image" : "description"} className="text-[19px]" /></span>
                    <div className="min-w-0 flex-1">
                      <a className="block truncate text-sm font-bold text-ink hover:text-primary-dark" href={`/api/admin/clients/${id}/files/${f.id}`}>{f.title}</a>
                      <div className="flex items-center gap-1 text-xs text-mute">{f.adminOnly && <Icon name="lock" className="text-[13px]" />}{f.size < 1024 * 1024 ? `${Math.max(1, Math.round(f.size / 1024))} KB` : `${(f.size / 1048576).toFixed(1)} MB`} · {date(f.createdAt)}</div>
                    </div>
                    <RowDel title="Delete file" onClick={() => confirm(`Delete ${f.filename}?`) && run(() => api(`/admin/clients/${id}/files/${f.id}`, { method: "DELETE" }), "File deleted")} />
                  </li>
                ))}
              </ul>
            ) : <Blank icon="upload_file">No files uploaded</Blank>}
          </Panel>

          <Panel icon="outgoing_mail" title="Recent emails" action={<HeadBtn icon="send" onClick={() => setModal("email")}>Send</HeadBtn>}>
            {sum?.emails?.length ? (
              <ol className="relative ml-1.5 space-y-3 border-l border-line pl-4">
                {sum.emails.map((e: any) => (
                  <li key={e.id} className="relative">
                    <span className={cx("absolute -left-[21.5px] top-1.5 h-2.5 w-2.5 rounded-full ring-4 ring-white", e.status === "SENT" ? "bg-emerald-500" : e.status === "LOGGED" ? "bg-slate-300" : "bg-rose-500")} />
                    <div className="truncate text-[13px] font-semibold text-ink" title={e.subject}>{e.subject}</div>
                    <div className="text-[11.5px] text-mute">{date(e.createdAt, true)} · {e.status.toLowerCase()}</div>
                  </li>
                ))}
              </ol>
            ) : <Blank icon="mail">No emails yet</Blank>}
          </Panel>

          <Panel icon="sticky_note_2" title="Admin notes">
            <Textarea rows={4} defaultValue={p.notes ?? ""} onBlur={(e) => e.target.value !== (p.notes ?? "") && api(`/admin/clients/${id}`, { method: "PUT", body: { notes: e.target.value } }).then(() => toast.success("Notes saved"))} placeholder="Private notes — only staff see these. Saved when you click away." className="bg-amber-50/40" />
          </Panel>

          <section className="rounded-2xl border border-rose-200 bg-white shadow-card">
            <div className="flex items-center gap-2 border-b border-rose-100 px-5 py-3"><Icon name="warning" className="text-[19px] text-rose-500" /><h3 className="text-[15px] font-extrabold text-rose-700">Danger zone</h3></div>
            <div className="space-y-2 p-4">
              <Button size="sm" variant="outline" className="w-full !justify-start hover:!border-rose-300 hover:!text-rose-600" icon="block" disabled={c.status === "CLOSED"} onClick={() => setModal("close")}>Close account</Button>
              <Button size="sm" variant="outline" className="w-full !justify-start hover:!border-rose-300 hover:!text-rose-600" icon="delete_forever" onClick={async () => {
                if (!confirm(`Permanently delete ${c.email}? This can't be undone.`)) return;
                try { await api(`/admin/clients/${id}`, { method: "DELETE" }); toast.success("Customer deleted"); router.push("/admin/clients"); } catch (e: any) { toast.error(e.message); }
              }}>Delete account</Button>
              <p className="px-1 text-[11.5px] text-mute">Accounts with invoices or payments can only be closed — tax records must be kept.</p>
            </div>
          </section>
        </aside>
      </div>

      <ProfileModal open={modal === "profile"} onClose={close} c={c} onDone={refresh} />
      <ContactModal open={modal === "contact"} onClose={close} id={id} onDone={refresh} />
      <PayMethodModal open={modal === "paymethod"} onClose={close} id={id} onDone={refresh} />
      <FileModal open={modal === "file"} onClose={close} id={id} onDone={refresh} />
      <CreditModal open={modal === "credit"} onClose={close} id={id} currency={cur} onDone={refresh} />
      <InvoiceModal open={modal === "invoice"} onClose={close} id={id} currency={cur} onDone={refresh} />
      <FundsModal open={modal === "funds"} onClose={close} id={id} currency={cur} onDone={refresh} />
      <TicketModal open={modal === "ticket"} onClose={close} id={id} onDone={refresh} />
      <EmailModal open={modal === "email"} onClose={close} id={id} email={c.email} onDone={refresh} />
      <WhatsAppModal open={modal === "whatsapp"} onClose={close} client={c} />
      <SetPasswordModal open={modal === "setpw"} onClose={close} client={c} onDone={refresh} />
      <MergeModal open={modal === "merge"} onClose={close} c={c} onDone={(into: string) => router.push(`/admin/clients/${into}`)} />
      <CloseModal open={modal === "close"} onClose={close} c={c} onDone={refresh} />
    </>
  );
}

/** The customer's records in tabs: services, invoices, orders… — the part staff use most, so it comes first. */
function Records({ tab, setTab, data, services, id, cur }: { tab: string; setTab: (t: string) => void; data: any; services: any[]; id: string; cur: string }) {
  const today = new Date(new Date().toDateString());
  const rows: Record<string, any[]> = { services, invoices: data.invoices, orders: data.orders ?? [], transactions: data.transactions, tickets: data.tickets, domains: data.domains, credit: data.ledger, logins: data.logins };
  const empty = (icon: string, text: string) => (
    <div className="flex flex-col items-center gap-2 px-6 py-12 text-center text-sm text-mute"><span className="grid h-11 w-11 place-items-center rounded-xl bg-primary-soft text-primary-dark"><Icon name={icon} /></span>{text}</div>
  );
  const isEmpty = tab !== "statement" && !(rows[tab]?.length);
  const unpaid = (data.invoices as any[]).filter((i) => i.status === "UNPAID").length;
  return (
    <section id="client-tabs" className="scroll-mt-24 overflow-hidden rounded-2xl border border-line bg-white shadow-card">
      <div role="tablist" className="flex gap-1 overflow-x-auto border-b border-line bg-[#fbf9ff] p-1.5 [scrollbar-width:none] sm:flex-wrap">
        {TABS.map(([t, l, n, icon]) => {
          const count = n ? rows[n]?.length ?? 0 : 0;
          return (
            <button key={t} role="tab" aria-selected={tab === t} onClick={() => setTab(t)} className={cx("inline-flex shrink-0 items-center gap-1.5 rounded-xl px-3 py-2 text-[13px] font-bold transition", tab === t ? "bg-white text-primary-dark shadow-card ring-1 ring-line" : "text-slate-600 hover:bg-white/70 hover:text-primary-dark")}>
              <Icon name={icon} className="text-[17px]" />
              {l}
              {count > 0 && <span className={cx("rounded-md px-1.5 text-[11px] tabular-nums", tab === t ? "bg-primary-soft text-primary-dark" : "bg-slate-200/70 text-slate-500")}>{count}</span>}
              {t === "invoices" && unpaid > 0 && <span className="h-2 w-2 rounded-full bg-rose-500" title={`${unpaid} unpaid`} />}
            </button>
          );
        })}
      </div>
      {isEmpty ? empty(TABS.find(([k]) => k === tab)?.[3] ?? "inbox", `No ${TABS.find(([k]) => k === tab)?.[1].toLowerCase()} yet`) : (
        <>
          {tab === "services" && (
            <ul className="divide-y divide-line sm:hidden">
              {services.map((s: any) => (
                <li key={s.id}>
                  <Link href={`/admin/services/${s.id}`} className="flex items-center gap-3 px-4 py-3 active:bg-[#fbf9ff]">
                    <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-primary-soft text-primary-dark"><Icon name={planIcon(s.product.type, s.product.provisioner)} className="text-[19px]" /></span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[14px] font-bold text-ink">{s.product.name}</span>
                      <span className="block truncate text-[12px] text-mute">{s.hostname || "—"}{s.ips[0] ? ` · ${s.ips[0].address}` : ""}</span>
                    </span>
                    <span className="flex shrink-0 flex-col items-end gap-1"><Badge status={s.status} /><span className="text-[12px] font-semibold tabular-nums text-slate-600">{money(s.recurringAmount, s.currency)}</span></span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
          {tab === "invoices" && (
            <ul className="divide-y divide-line sm:hidden">
              {data.invoices.map((i: any) => {
                const over = i.status === "UNPAID" && i.dueDate && new Date(i.dueDate) < today;
                return (
                  <li key={i.id}>
                    <Link href={`/admin/invoices/${i.id}`} className={cx("flex items-center gap-3 px-4 py-3", over && "bg-rose-50/40")}>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate font-mono text-[13px] font-bold text-primary-dark">{invNo(i)}</span>
                        <span className="block truncate text-[12px] font-semibold text-ink">{i.for?.length ? i.for.map((f: any) => f.label).join(", ") : i.isWalletTopup ? "Add funds" : i.forSummary ?? ""}</span>
                        <span className={cx("block text-[12px]", over ? "font-bold text-rose-600" : "text-mute")}>{over ? "overdue · " : "due "}{date(i.dueDate)}</span>
                      </span>
                      <span className="flex shrink-0 flex-col items-end gap-1"><span className="font-bold tabular-nums text-ink">{money(i.total, i.currency)}</span><Badge status={i.status} /></span>
                    </Link>
                  </li>
                );
              })}
            </ul>
          )}
          {tab === "services" && (
            <div className="hidden sm:block"><Table head={["Service", "Hostname / IP", "Status", "Recurring", "Next due"]}>
              {services.map((s: any) => {
                const late = s.nextDueDate && new Date(s.nextDueDate) < today && ["ACTIVE", "SUSPENDED"].includes(s.status);
                return (
                  <tr key={s.id} className="hover:bg-[#fbf9ff]">
                    <Td><Link className="flex items-center gap-2.5 font-bold text-ink hover:text-primary-dark" href={`/admin/services/${s.id}`}><span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-primary-soft text-primary-dark"><Icon name={planIcon(s.product.type, s.product.provisioner)} className="text-[18px]" /></span>{s.product.name}</Link></Td>
                    <Td><div className="max-w-[240px] truncate font-semibold text-slate-700">{s.hostname || "—"}</div><div className="font-mono text-xs text-mute">{s.ips.map((i: any) => i.address).join(", ")}</div></Td>
                    <Td><Badge status={s.status} /></Td>
                    <Td className="whitespace-nowrap font-semibold tabular-nums">{money(s.recurringAmount, s.currency)}<div className="text-[11.5px] font-normal text-mute">{(s.billingCycle ?? "").toLowerCase().replace("annual", "yearly")}</div></Td>
                    <Td className={cx("whitespace-nowrap", late ? "font-bold text-rose-600" : "text-slate-600")}>{s.nextDueDate ? date(s.nextDueDate) : "—"}{late && <div className="text-[11px] uppercase">overdue</div>}</Td>
                  </tr>
                );
              })}
            </Table></div>
          )}
          {tab === "orders" && <Table head={["Order", "Placed", "Total", "Status"]}>{rows.orders.map((o: any) => <tr key={o.id} className="hover:bg-[#fbf9ff]"><Td><Link className="font-mono font-bold text-primary-dark hover:underline" href={`/admin/orders/${o.id}`}>{o.number}</Link></Td><Td className="text-slate-600"><Ago at={o.createdAt} /></Td><Td className="font-semibold tabular-nums">{money(o.total, o.currency)}</Td><Td><Badge status={o.status} /></Td></tr>)}</Table>}
          {tab === "invoices" && (
            <div className="hidden sm:block"><Table head={["Invoice", "For", "Issued", "Due", "Total", "Status"]}>
              {data.invoices.map((i: any) => {
                const over = i.status === "UNPAID" && i.dueDate && new Date(i.dueDate) < today;
                return (
                  <tr key={i.id} className={cx("hover:bg-[#fbf9ff]", over && "bg-rose-50/40")}>
                    <Td className="whitespace-nowrap"><Link className="font-mono font-bold text-primary-dark hover:underline" href={`/admin/invoices/${i.id}`}>{invNo(i)}</Link></Td>
                    <Td><InvoiceFor inv={i} audience="admin" compact showProduct={false} /></Td>
                    <Td className="whitespace-nowrap text-slate-600">{date(i.issueDate)}</Td>
                    <Td className={cx("whitespace-nowrap", over ? "font-bold text-rose-600" : "text-slate-600")}>{date(i.dueDate)}{over && <div className="text-[11px] uppercase">overdue</div>}</Td>
                    <Td className="whitespace-nowrap font-semibold tabular-nums">{money(i.total, i.currency)}{i.status === "UNPAID" && i.amountPaid > 0 && <div className="text-[11.5px] font-normal text-amber-700">{money(i.total - i.amountPaid, i.currency)} left</div>}</Td>
                    <Td><Badge status={i.status} /></Td>
                  </tr>
                );
              })}
            </Table></div>
          )}
          {tab === "statement" && <Statement id={id} />}
          {tab === "transactions" && <Table head={["Date", "Gateway", "Reference", "Type", "Amount"]}>{data.transactions.map((t: any) => <tr key={t.id} className="hover:bg-[#fbf9ff]"><Td className="whitespace-nowrap text-slate-600">{date(t.createdAt, true)}</Td><Td className="font-semibold uppercase">{t.gateway}</Td><Td className="max-w-[220px] truncate font-mono text-xs">{t.gatewayTxnId}</Td><Td><Badge status={t.type === "REFUND" ? "REFUNDED" : t.type === "PAYMENT" ? "PAID" : "DRAFT"}>{t.type.replace("_", " ").toLowerCase()}</Badge></Td><Td className={cx("whitespace-nowrap font-bold tabular-nums", t.type === "REFUND" ? "text-sky-700" : "text-emerald-700")}>{t.type === "REFUND" ? "−" : ""}{money(Math.abs(t.amount), t.currency)}</Td></tr>)}</Table>}
          {tab === "tickets" && <Table head={["Ticket", "Subject", "Department", "Last reply", "Status"]}>{data.tickets.map((t: any) => <tr key={t.id} className="hover:bg-[#fbf9ff]"><Td className="font-mono text-mute">#{t.number}</Td><Td><Link className="font-bold text-ink hover:text-primary-dark" href={`/admin/tickets/${t.id}`}>{t.subject}</Link></Td><Td className="text-slate-600">{t.department.name}</Td><Td className="whitespace-nowrap text-slate-600"><Ago at={t.lastReplyAt} /></Td><Td><Badge status={t.status} /></Td></tr>)}</Table>}
          {tab === "domains" && <Table head={["Domain", "Status", "Expiry", "Auto-renew"]}>{data.domains.map((d: any) => <tr key={d.id} className="hover:bg-[#fbf9ff]"><Td className="font-bold"><span className="inline-flex items-center gap-2"><Icon name="public" className="text-[18px] text-primary-dark" />{d.name}</span></Td><Td><Badge status={d.status} /></Td><Td className="whitespace-nowrap text-slate-600">{d.expiryDate ? <>{date(d.expiryDate)} <span className="text-mute">(<Ago at={d.expiryDate} />)</span></> : "—"}</Td><Td>{d.autoRenew ? <span className="font-semibold text-emerald-600">On</span> : <span className="text-mute">Off</span>}</Td></tr>)}</Table>}
          {tab === "credit" && <Table head={["Date", "Description", "Amount", "Balance"]}>{data.ledger.map((l: any) => <tr key={l.id} className="hover:bg-[#fbf9ff]"><Td className="whitespace-nowrap text-slate-600">{date(l.createdAt, true)}</Td><Td>{l.description}</Td><Td className={cx("whitespace-nowrap font-bold tabular-nums", l.amount < 0 ? "text-rose-600" : "text-emerald-600")}>{l.amount > 0 ? "+" : ""}{money(l.amount, cur)}</Td><Td className="whitespace-nowrap tabular-nums">{money(l.balanceAfter, cur)}</Td></tr>)}</Table>}
          {tab === "logins" && <Table head={["Time", "IP", "Result"]}>{data.logins.map((l: any) => <tr key={l.id} className="hover:bg-[#fbf9ff]"><Td className="whitespace-nowrap text-slate-600">{date(l.createdAt, true)} <span className="text-mute">· <Ago at={l.createdAt} /></span></Td><Td className="font-mono text-xs">{l.ip}</Td><Td>{l.success ? <Badge status="ACTIVE">signed in</Badge> : <Badge status="FAILED">{l.reason ?? "failed"}</Badge>}</Td></tr>)}</Table>}
        </>
      )}
    </section>
  );
}

const TABS: [string, string, string | undefined, string][] = [["services", "Services", "services", "dns"], ["invoices", "Invoices", "invoices", "receipt_long"], ["statement", "Statement", undefined, "summarize"], ["orders", "Orders", "orders", "shopping_bag"], ["transactions", "Payments", "transactions", "payments"], ["tickets", "Tickets", "tickets", "support_agent"], ["domains", "Domains", "domains", "public"], ["credit", "Credit log", "credit", "account_balance_wallet"], ["logins", "Logins", "logins", "login"]];

// ───── building blocks ─────
function Panel({ icon, title, count, action, children }: { icon: string; title: string; count?: number; action?: ReactNode; children: ReactNode }) {
  return (
    <section className="rounded-2xl border border-line bg-white shadow-card">
      <div className="flex items-center justify-between gap-2 border-b border-line px-5 py-3.5">
        <h3 className="flex items-center gap-2 text-[15px] font-extrabold text-ink">
          <span className="grid h-7 w-7 place-items-center rounded-lg bg-primary-soft text-primary-dark"><Icon name={icon} className="text-[17px]" /></span>
          {title}
          {count ? <span className="rounded-full bg-slate-100 px-2 text-[11.5px] font-bold text-slate-500">{count}</span> : null}
        </h3>
        {action}
      </div>
      <div className="p-5">{children}</div>
    </section>
  );
}
function HeadBtn({ icon, children, onClick }: { icon: string; children: ReactNode; onClick: () => void }) {
  return <button type="button" onClick={onClick} className="inline-flex items-center gap-1 rounded-lg px-2.5 py-1.5 text-[12.5px] font-bold text-primary-dark transition hover:bg-primary-tint"><Icon name={icon} className="text-[16px]" />{children}</button>;
}
function Item({ k, v, mono, wide }: { k: string; v?: ReactNode; mono?: boolean; wide?: boolean }) {
  return (
    <div className={cx("min-w-0", wide && "sm:col-span-2")}>
      <dt className="text-[11.5px] font-bold uppercase tracking-wide text-mute">{k}</dt>
      <dd className={cx("mt-1 break-words text-[14px] font-semibold text-ink", mono && !!v && "font-mono text-[13px]", !v && "font-normal text-slate-300")}>{v || "Not set"}</dd>
    </div>
  );
}
function Kpi({ icon, label, value, hint, tone, onClick }: { icon: string; label: string; value: ReactNode; hint?: string; tone: "purple" | "green" | "amber" | "rose" | "sky" | "slate"; onClick?: () => void }) {
  const tones = { purple: "bg-primary-soft text-primary-dark", green: "bg-emerald-50 text-emerald-600", amber: "bg-amber-50 text-amber-600", rose: "bg-rose-50 text-rose-600", sky: "bg-sky-50 text-sky-600", slate: "bg-slate-100 text-slate-500" };
  return (
    <button type="button" onClick={onClick} className="flex flex-col items-start gap-2.5 rounded-2xl border border-line bg-white p-3.5 text-left shadow-card sm:flex-row sm:items-center sm:gap-3.5 sm:p-4 transition hover:-translate-y-px hover:border-[#dccafb]">
      <span className={cx("grid h-11 w-11 shrink-0 place-items-center rounded-xl", tones[tone])}><Icon name={icon} className="text-[22px]" /></span>
      <div className="min-w-0">
        <div className="truncate text-[12.5px] font-semibold text-mute">{label}</div>
        <div className={cx("truncate text-xl font-extrabold tracking-tight", tone === "rose" ? "text-rose-600" : "text-ink")}>{value}</div>
        {hint && <div className="truncate text-[11.5px] text-mute">{hint}</div>}
      </div>
    </button>
  );
}
function Count({ icon, label, a, t, onClick }: { icon: string; label: string; a: number; t?: number; onClick?: () => void }) {
  const Tag = onClick ? "button" : "div";
  return (
    <Tag type={onClick ? "button" : undefined} onClick={onClick} className={cx("flex items-center gap-3 rounded-xl border border-line px-3.5 py-3 text-left", onClick && "transition hover:border-[#dccafb] hover:bg-primary-tint")}>
      <Icon name={icon} className={cx("text-[22px]", a ? "text-primary-dark" : "text-slate-300")} />
      <div className="min-w-0">
        <div className={cx("text-lg font-extrabold leading-tight", a ? "text-ink" : "text-slate-300")}>{a}{t !== undefined && t !== a ? <span className="text-[12px] font-semibold text-mute"> / {t}</span> : null}</div>
        <div className="truncate text-[11.5px] font-semibold text-mute">{label}</div>
      </div>
    </Tag>
  );
}
function Quick({ icon, children, onClick }: { icon: string; children: ReactNode; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} className="flex items-center gap-2 rounded-xl border border-line px-3 py-2.5 text-left text-[13px] font-bold text-slate-700 transition hover:border-[#dccafb] hover:bg-primary-tint hover:text-primary-dark">
      <Icon name={icon} className="text-[18px] text-primary-dark" />
      <span className="truncate">{children}</span>
    </button>
  );
}
function RowDel({ title, onClick }: { title: string; onClick: () => void }) {
  return <button type="button" title={title} onClick={onClick} className="grid h-8 w-8 shrink-0 place-items-center rounded-lg text-slate-300 transition hover:bg-rose-50 hover:text-rose-600"><Icon name="delete" className="text-[17px]" /></button>;
}
function Blank({ icon, children }: { icon: string; children: ReactNode }) {
  return <div className="flex flex-col items-center gap-1 rounded-xl border border-dashed border-line py-5 text-center text-[13px] text-mute"><Icon name={icon} className="text-[22px] text-slate-300" />{children}</div>;
}

function EmailModal({ open, onClose, id, email, onDone }: { open: boolean; onClose: () => void; id: string; email: string; onDone: () => void }) {
  const [subject, setSubject] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (open) { setSubject(""); setMessage(""); } }, [open]);
  return (
    <Modal open={open} onClose={onClose} title={`Email ${email}`} wide>
      <div className="space-y-3">
        <Field label="Subject"><Input value={subject} onChange={(e) => setSubject(e.target.value)} autoFocus /></Field>
        <Field label="Message" hint="Sent with your branding through Email Delivery; it appears under Recent emails."><Textarea rows={8} value={message} onChange={(e) => setMessage(e.target.value)} /></Field>
        <Button icon="send" loading={busy} disabled={subject.trim().length < 2 || message.trim().length < 2} onClick={async () => {
          setBusy(true);
          try { await api(`/admin/clients/${id}/email`, { body: { subject, message } }); toast.success("Email queued"); onClose(); onDone(); } catch (e: any) { toast.error(e.message); }
          setBusy(false);
        }}>Send email</Button>
      </div>
    </Modal>
  );
}

const WA_QUICK: [string, string][] = [
  ["Payment reminder", "Hi {name}, a friendly reminder that you have an unpaid invoice. You can pay online from your client area: {app}/client/invoices"],
  ["Service ready", "Hi {name}, your service is ready. Login details are in your email and client area: {app}/client"],
  ["Maintenance", "Hi {name}, we're doing scheduled maintenance today. Your service may be briefly unavailable. Thank you for your patience."],
  ["Ticket update", "Hi {name}, we've replied to your support ticket: {app}/client/tickets"],
];

function WhatsAppModal({ open, onClose, client: c }: { open: boolean; onClose: () => void; client: any }) {
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);
  const hist = useApi(open ? `/admin/whatsapp/messages?userId=${c.id}` : null, [open]);
  useEffect(() => { if (open) setMsg(`Hi ${c.firstName ?? ""}, `); }, [open, c.firstName]);
  const digits = String(c.phone ?? "").replace(/\D/g, "");
  const phone = digits.length === 10 ? `91${digits}` : digits.replace(/^0+/, "");
  const app = typeof window !== "undefined" ? window.location.origin : "";
  async function send() {
    setBusy(true);
    try {
      await api(`/admin/clients/${c.id}/whatsapp`, { body: { text: msg } });
      toast.success("WhatsApp message queued");
      hist.reload();
      setMsg(`Hi ${c.firstName ?? ""}, `);
    } catch (e: any) {
      toast.error(e.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal open={open} onClose={onClose} title="Send WhatsApp message" wide>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2 text-sm">
        <span className="text-mute">To <b className="text-ink">+{phone}</b>{c.profile?.whatsappNotifications === false && <span className="ml-2 rounded-full bg-amber-50 px-2 py-0.5 text-[11px] font-bold text-amber-700 ring-1 ring-amber-200">notifications off</span>}</span>
        <div className="flex flex-wrap gap-1.5">{WA_QUICK.map(([l, t]) => <button key={l} type="button" onClick={() => setMsg(t.replace("{name}", c.firstName ?? "").replaceAll("{app}", app))} className="rounded-full bg-[#f4effd] px-2.5 py-1 text-[11.5px] font-bold text-primary-dark hover:bg-primary-soft">{l}</button>)}</div>
      </div>
      <Textarea rows={5} value={msg} onChange={(e) => setMsg(e.target.value)} autoFocus maxLength={1000} />
      <div className="mt-1 text-right text-[11px] text-mute">{msg.length}/1000</div>
      <div className="mt-3 flex flex-wrap gap-2">
        <Button className="!bg-emerald-600 !bg-none hover:!bg-emerald-700" icon="send" loading={busy} disabled={!msg.trim() || phone.length < 10} onClick={send}>Send via WhatsApp</Button>
        <Button variant="outline" icon="open_in_new" disabled={!msg.trim() || phone.length < 10} onClick={() => window.open(`https://wa.me/${phone}?text=${encodeURIComponent(msg)}`, "_blank", "noopener")}>Open in WhatsApp app</Button>
      </div>
      <p className="mt-2 text-xs text-mute">“Send” uses the WhatsApp provider set up in Admin → WhatsApp. With Meta&apos;s official API, free text only reaches clients who messaged you in the last 24 hours — use “Open in WhatsApp app” otherwise.</p>
      {hist.data?.items?.length > 0 && (
        <div className="mt-5 border-t border-line pt-4">
          <div className="mb-2 text-[11px] font-bold uppercase tracking-wider text-mute">Recent WhatsApp messages</div>
          <ul className="max-h-56 space-y-2 overflow-y-auto">
            {hist.data.items.slice(0, 10).map((m: any) => (
              <li key={m.id} className="rounded-xl bg-[#f0fdf4] p-3 text-[13px] ring-1 ring-emerald-100">
                <div className="mb-1 flex items-center justify-between gap-2 text-[11px] font-semibold text-mute"><span>{m.event === "manual" ? "Message" : m.event} · {date(m.createdAt, true)}</span><Badge status={m.status === "SENT" ? "ACTIVE" : m.status === "FAILED" ? "FAILED" : "PENDING"}>{m.status.toLowerCase()}</Badge></div>
                <div className="whitespace-pre-wrap break-words text-slate-700">{m.body}</div>
                {m.error && <div className="mt-1 text-xs text-rose-600">{m.error}</div>}
              </li>
            ))}
          </ul>
        </div>
      )}
    </Modal>
  );
}

function SetPasswordModal({ open, onClose, client: c, onDone }: { open: boolean; onClose: () => void; client: any; onDone: () => void }) {
  const [mode, setMode] = useState<"generate" | "own">("generate");
  const [pw, setPw] = useState("");
  const [sendEmail, setSendEmail] = useState(true);
  const [sendWa, setSendWa] = useState(false);
  const [signOut, setSignOut] = useState(true);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ password: string; sent: string[] } | null>(null);
  useEffect(() => { if (open) { setMode("generate"); setPw(""); setResult(null); setSendEmail(true); setSendWa(false); setSignOut(true); } }, [open]);
  async function save() {
    setBusy(true);
    try {
      const r = await api(`/admin/clients/${c.id}/set-password`, { body: { ...(mode === "own" ? { password: pw } : {}), sendEmail, sendWhatsapp: sendWa, signOut } });
      setResult(r);
      onDone();
    } catch (e: any) {
      toast.error(e.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal open={open} onClose={onClose} title={`Set a new password for ${c.firstName ?? c.email}`}>
      {result ? (
        <div className="space-y-4">
          <Alert tone="success">Password changed{result.sent.length ? ` · sent by ${result.sent.join(", ")}` : ""}.</Alert>
          <div>
            <div className="mb-1 text-[11px] font-bold uppercase tracking-wider text-mute">New password — shown once</div>
            <div className="flex items-center gap-2 rounded-xl border border-line bg-[#faf7ff] px-4 py-3 font-mono text-[15px] font-bold text-ink"><span className="min-w-0 flex-1 break-all">{result.password}</span><Copy text={result.password} /></div>
            <p className="mt-2 text-xs text-mute">Share it with {c.email} securely. They can change it under Account → Security.</p>
          </div>
          <div className="flex justify-end"><Button onClick={onClose}>Done</Button></div>
        </div>
      ) : (
        <div className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2">
            {([["generate", "casino", "Generate a strong one"], ["own", "edit", "Type a password"]] as const).map(([k, i, t]) => (
              <button key={k} type="button" onClick={() => setMode(k)} className={cx("flex items-center gap-2 rounded-xl border p-3 text-left text-sm font-extrabold", mode === k ? "border-primary bg-primary-tint text-ink ring-2 ring-primary/20" : "border-line text-slate-600 hover:border-primary/40")}>
                <span className={cx("grid h-8 w-8 place-items-center rounded-lg", mode === k ? "bg-primary-dark text-white" : "bg-primary-soft text-primary-dark")}><Icon name={i} className="text-[18px]" /></span>{t}
              </button>
            ))}
          </div>
          {mode === "own" && <Field label="New password" hint="At least 8 characters"><Input type="text" value={pw} onChange={(e) => setPw(e.target.value)} autoFocus /></Field>}
          <div className="space-y-2.5 rounded-xl bg-[#fbf9ff] p-4">
            <Toggle checked={sendEmail} onChange={setSendEmail} label={`Email the new password to ${c.email}`} />
            <Toggle checked={sendWa} onChange={setSendWa} label={c.phone ? `Send it on WhatsApp to ${c.phone}` : "Send it on WhatsApp (no mobile number)"} />
            <Toggle checked={signOut} onChange={setSignOut} label="Sign the client out everywhere" />
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={onClose}>Cancel</Button>
            <Button icon="password" loading={busy} disabled={(mode === "own" && pw.length < 8) || (sendWa && !c.phone)} onClick={save}>Set password</Button>
          </div>
        </div>
      )}
    </Modal>
  );
}

function Statement({ id }: { id: string }) {
  const { data, loading } = useApi(`/admin/clients/${id}/statement`);
  if (loading || !data) return <div className="p-6"><Loading /></div>;
  const cur = data.currency;
  return (
    <>
      <Table head={["Date", "Type", "Reference", "Description", "Debit", "Credit", "Balance"]}>
        {data.rows.map((r: any) => (
          <tr key={r.kind + r.id} className={r.kind === "info" ? "text-mute" : undefined}>
            <Td className="whitespace-nowrap text-xs">{date(r.date, true)}</Td>
            <Td className="whitespace-nowrap text-xs font-semibold">{KIND[r.kind] ?? r.kind}</Td>
            <Td className="font-mono text-xs"><span className="block max-w-[150px] truncate" title={r.ref}>{r.kind === "invoice" ? <Link className="text-primary-dark" href={`/admin/invoices/${r.id}`}>{r.ref}</Link> : r.ref}</span></Td>
            <Td className={cx("min-w-[220px]", r.kind === "info" && "text-xs italic")}>{r.description}</Td>
            <Td className="whitespace-nowrap">{r.debit ? money(r.debit, cur) : ""}</Td>
            <Td className="whitespace-nowrap text-emerald-700">{r.credit ? money(r.credit, cur) : ""}</Td>
            <Td className={cx("whitespace-nowrap font-bold", r.balance > 0 && "text-rose-600", r.balance < 0 && "text-emerald-700")}>{r.kind === "info" ? "" : r.balance < 0 ? `${money(-r.balance, cur)} CR` : money(r.balance, cur)}</Td>
          </tr>
        ))}
      </Table>
      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-line px-5 py-3 text-sm">
        <span className="text-xs text-mute">Oldest first. Payments from account credit are listed for reference only — the money was counted when it was received.</span>
        {data.balance > 0 ? <span>Balance owed:&nbsp;<b className="text-rose-600">{money(data.balance, cur)}</b></span> : data.balance < 0 ? <span>In credit:&nbsp;<b className="text-emerald-700">{money(-data.balance, cur)}</b></span> : <span>Settled:&nbsp;<b className="text-emerald-700">{money(0, cur)}</b></span>}
      </div>
    </>
  );
}
const KIND: Record<string, string> = { invoice: "Invoice", payment: "Payment", refund: "Refund", creditnote: "Credit note", adjustment: "Credit adjustment", info: "Paid from credit" };

// ───── modals ─────
function ProfileModal({ open, onClose, c, onDone }: any) {
  const [f, setF] = useState<any>({});
  useEffect(() => {
    if (open) {
      const p = c.profile ?? {};
      setF({ firstName: c.firstName, lastName: c.lastName ?? "", email: c.email, phone: c.phone ?? "", companyName: p.companyName ?? "", gstin: p.gstin ?? "", pan: p.pan ?? "", address1: p.address1 ?? "", address2: p.address2 ?? "", city: p.city ?? "", state: p.state ?? "", postcode: p.postcode ?? "", country: p.country ?? "IN" });
    }
  }, [open, c]);
  const set = (k: string) => (e: any) => setF({ ...f, [k]: e.target.value });
  const fields: [string, string][] = [["firstName", "First name"], ["lastName", "Last name"], ["email", "Email"], ["phone", "Phone"], ["companyName", "Company"], ["gstin", "GSTIN"], ["pan", "PAN"], ["address1", "Address 1"], ["address2", "Address 2"], ["city", "City"], ["state", "State"], ["postcode", "Postcode"]];
  return (
    <Modal open={open} onClose={onClose} title="Edit client information" wide>
      <div className="grid gap-3 sm:grid-cols-2">
        {fields.map(([k, l]) => <Field key={k} label={l}><Input value={f[k] ?? ""} onChange={set(k)} /></Field>)}
        <Field label="Country"><Select value={f.country ?? "IN"} onChange={set("country")}>{Object.entries(COUNTRY).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</Select></Field>
      </div>
      <Button className="mt-4" onClick={() => {
        // required fields left empty are not sent (keeps the current value); optional ones can be cleared
        const required = ["firstName", "email", "phone", "address1", "city", "state", "postcode"];
        const body = Object.fromEntries(Object.entries(f).filter(([k, v]) => !(required.includes(k) && String(v ?? "").trim() === "")));
        api(`/admin/clients/${c.id}`, { method: "PUT", body }).then(() => { toast.success("Client updated"); onClose(); onDone(); }).catch((e) => toast.error(e.message));
      }}>Save changes</Button>
    </Modal>
  );
}

function ContactModal({ open, onClose, id, onDone }: any) {
  const blank = { firstName: "", lastName: "", email: "", phone: "", companyName: "", emails: ["invoice", "support"] as string[] };
  const [f, setF] = useState(blank);
  useEffect(() => { if (open) setF(blank); }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
  const kinds = [["general", "General"], ["invoice", "Invoices"], ["support", "Support"], ["product", "Product / service"], ["domain", "Domain"]];
  return (
    <Modal open={open} onClose={onClose} title="Add contact">
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="First name"><Input value={f.firstName} onChange={(e) => setF({ ...f, firstName: e.target.value })} /></Field>
        <Field label="Last name"><Input value={f.lastName} onChange={(e) => setF({ ...f, lastName: e.target.value })} /></Field>
        <Field label="Email"><Input type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} /></Field>
        <Field label="Phone"><Input value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} /></Field>
        <Field label="Company (optional)" className="sm:col-span-2"><Input value={f.companyName} onChange={(e) => setF({ ...f, companyName: e.target.value })} /></Field>
      </div>
      <div className="mt-3 text-[13px] font-bold text-slate-700">Emails they receive</div>
      <div className="mt-1.5 flex flex-wrap gap-3">
        {kinds.map(([k, l]) => <label key={k} className="flex items-center gap-1.5 text-sm"><input type="checkbox" checked={f.emails.includes(k)} onChange={(e) => setF({ ...f, emails: e.target.checked ? [...f.emails, k] : f.emails.filter((x) => x !== k) })} />{l}</label>)}
      </div>
      <Button className="mt-4" onClick={() => api(`/admin/clients/${id}/contacts`, { body: { ...f, phone: f.phone || null, companyName: f.companyName || null } }).then(() => { toast.success("Contact added"); onClose(); onDone(); }).catch((e) => toast.error(e.message))}>Add contact</Button>
    </Modal>
  );
}

function PayMethodModal({ open, onClose, id, onDone }: any) {
  const blank = { type: "UPI", gateway: "razorpay", label: "", brand: "", last4: "", expiry: "", reference: "", isDefault: false, autopay: false };
  const [f, setF] = useState(blank);
  useEffect(() => { if (open) setF(blank); }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <Modal open={open} onClose={onClose} title="Add pay method">
      <Alert tone="info" className="mb-4">Record a card, UPI AutoPay or e-mandate the customer set up with the gateway. Only a label, the last 4 digits and the gateway's token / mandate id are kept — never full card or account numbers.</Alert>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Type"><Select value={f.type} onChange={(e) => setF({ ...f, type: e.target.value })}><option value="UPI">UPI AutoPay</option><option value="CARD">Card</option><option value="MANDATE">e-Mandate (NACH)</option><option value="BANK">Bank account</option><option value="OTHER">Other</option></Select></Field>
        <Field label="Gateway"><Select value={f.gateway} onChange={(e) => setF({ ...f, gateway: e.target.value })}>{["razorpay", "cashfree", "stripe", "payu", "paypal", "manual"].map((g) => <option key={g}>{g}</option>)}</Select></Field>
        <Field label="Label" className="sm:col-span-2" hint={f.type === "CARD" ? "e.g. HDFC Visa" : f.type === "UPI" ? "e.g. UPI AutoPay — name@okhdfcbank" : "e.g. SBI e-mandate"}><Input value={f.label} onChange={(e) => setF({ ...f, label: e.target.value })} /></Field>
        {f.type === "CARD" && <>
          <Field label="Last 4 digits"><Input maxLength={4} value={f.last4} onChange={(e) => setF({ ...f, last4: e.target.value.replace(/\D/g, "") })} /></Field>
          <Field label="Expiry (MM/YY)"><Input maxLength={5} value={f.expiry} onChange={(e) => setF({ ...f, expiry: e.target.value })} placeholder="08/29" /></Field>
        </>}
        <Field label="Gateway token / mandate id (optional)" className="sm:col-span-2" hint="Stored encrypted; used to charge renewals automatically."><Input value={f.reference} onChange={(e) => setF({ ...f, reference: e.target.value })} placeholder="token_… / mandate_… / cus_…" /></Field>
      </div>
      <div className="mt-3 flex flex-wrap gap-5">
        <Toggle checked={f.isDefault} onChange={(v) => setF({ ...f, isDefault: v })} label="Default" />
        <Toggle checked={f.autopay} onChange={(v) => setF({ ...f, autopay: v })} label="Autopay renewals" />
      </div>
      <Button className="mt-4" onClick={() => api(`/admin/clients/${id}/pay-methods`, { body: { ...f, brand: f.brand || null, last4: f.last4 || null, expiry: f.expiry || null, reference: f.reference || null } }).then(() => { toast.success("Pay method added"); onClose(); onDone(); }).catch((e) => toast.error(e.message))}>Add pay method</Button>
    </Modal>
  );
}

function FileModal({ open, onClose, id, onDone }: any) {
  const [file, setFile] = useState<File | null>(null);
  const [title, setTitle] = useState("");
  const [adminOnly, setAdminOnly] = useState(true);
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (open) { setFile(null); setTitle(""); setAdminOnly(true); } }, [open]);
  return (
    <Modal open={open} onClose={onClose} title="Add file">
      <div className="space-y-3">
        <Field label="File" hint="PDF, image, Office document, CSV, TXT or ZIP — up to 20 MB"><input type="file" onChange={(e) => setFile(e.target.files?.[0] ?? null)} className="block w-full text-sm" /></Field>
        <Field label="Title (optional)"><Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Signed agreement, KYC" /></Field>
        <Toggle checked={adminOnly} onChange={setAdminOnly} label="Only staff can see it" />
        <Button loading={busy} disabled={!file} onClick={async () => {
          const form = new FormData();
          form.append("file", file!);
          form.append("title", title);
          form.append("adminOnly", String(adminOnly));
          setBusy(true);
          try { await api(`/admin/clients/${id}/files`, { form }); toast.success("File uploaded"); onClose(); onDone(); } catch (e: any) { toast.error(e.message); }
          setBusy(false);
        }}>Upload</Button>
      </div>
    </Modal>
  );
}

function FundsModal({ open, onClose, id, currency = "INR", onDone }: any) {
  const [amount, setAmount] = useState("");
  return (
    <Modal open={open} onClose={onClose} title="Create add funds invoice">
      <p className="mb-3 text-sm text-mute">The customer gets an invoice; when it's paid the amount is added to their credit balance.</p>
      <Field label={`Amount (${currency})`}><Input type="number" min={1} step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} /></Field>
      <Button className="mt-4" disabled={!(Number(amount) >= 1)} onClick={() => api(`/admin/clients/${id}/add-funds-invoice`, { body: { amount: Math.round(Number(amount) * 100) } }).then(() => { toast.success("Add funds invoice created and emailed"); onClose(); onDone(); }).catch((e) => toast.error(e.message))}>Create &amp; email</Button>
    </Modal>
  );
}

function TicketModal({ open, onClose, id, onDone }: any) {
  const { data } = useApi<{ items: any[] }>(open ? "/admin/ticket-departments" : null);
  const [f, setF] = useState({ departmentId: "", subject: "", message: "", priority: "MEDIUM" });
  useEffect(() => { if (open) setF({ departmentId: "", subject: "", message: "", priority: "MEDIUM" }); }, [open]);
  const depts = data?.items ?? [];
  const router = useRouter();
  return (
    <Modal open={open} onClose={onClose} title="Open new support ticket" wide>
      <div className="grid gap-3 sm:grid-cols-[1fr_160px]">
        <Field label="Department"><Select value={f.departmentId || depts[0]?.id || ""} onChange={(e) => setF({ ...f, departmentId: e.target.value })}>{depts.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}</Select></Field>
        <Field label="Priority"><Select value={f.priority} onChange={(e) => setF({ ...f, priority: e.target.value })}><option>LOW</option><option>MEDIUM</option><option>HIGH</option><option>URGENT</option></Select></Field>
        <Field label="Subject" className="sm:col-span-2"><Input value={f.subject} onChange={(e) => setF({ ...f, subject: e.target.value })} /></Field>
        <Field label="Message" className="sm:col-span-2"><Textarea rows={6} value={f.message} onChange={(e) => setF({ ...f, message: e.target.value })} /></Field>
      </div>
      <Button className="mt-4" icon="send" onClick={() => api<{ id: string }>("/admin/tickets", { body: { userId: id, departmentId: f.departmentId || depts[0]?.id, subject: f.subject, message: f.message, priority: f.priority } }).then((r) => { toast.success("Ticket opened — the customer has been emailed"); onClose(); onDone(); router.push(`/admin/tickets/${r.id}`); }).catch((e) => toast.error(e.message))}>Open ticket</Button>
    </Modal>
  );
}

function MergeModal({ open, onClose, c, onDone }: any) {
  const [q, setQ] = useState("");
  const [found, setFound] = useState<any[]>([]);
  const [target, setTarget] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (open) { setQ(""); setFound([]); setTarget(null); } }, [open]);
  useEffect(() => {
    if (q.trim().length < 2) return setFound([]);
    const t = setTimeout(() => api(`/admin/clients?q=${encodeURIComponent(q.trim())}&pageSize=8`).then((r) => setFound((r.clients ?? []).filter((x: any) => x.id !== c.id))).catch(() => {}), 250);
    return () => clearTimeout(t);
  }, [q, c.id]);
  return (
    <Modal open={open} onClose={onClose} title="Merge clients accounts">
      <p className="mb-3 text-sm text-mute">Everything on <b>{c.email}</b> — services, orders, invoices, payments, tickets, domains, contacts, files, pay methods and credit — moves to the account you choose. {c.email} is then closed.</p>
      {target ? (
        <div className="flex items-center justify-between rounded-xl bg-primary-tint px-4 py-3 ring-1 ring-[#e9d5ff]"><div><b>{fullName(target)}</b><div className="text-xs text-mute">{target.email}</div></div><Button size="sm" variant="ghost" onClick={() => setTarget(null)}>Change</Button></div>
      ) : (
        <>
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search the account to merge into…" autoFocus />
          {found.length > 0 && <div className="mt-2 divide-y divide-line overflow-hidden rounded-xl border border-line">{found.map((x) => <button key={x.id} type="button" onClick={() => setTarget(x)} className="flex w-full justify-between px-4 py-2.5 text-left text-sm hover:bg-[#fbf9ff]"><span><b>{fullName(x)}</b> <span className="text-mute">{x.email}</span></span><Icon name="chevron_right" className="text-mute" /></button>)}</div>}
        </>
      )}
      <Button className="mt-4" variant="danger" loading={busy} disabled={!target} onClick={async () => {
        if (!confirm(`Merge ${c.email} into ${target.email}? This can't be undone.`)) return;
        setBusy(true);
        try { const r = await api(`/admin/clients/${c.id}/merge`, { body: { intoUserId: target.id } }); toast.success(`Merged — ${r.moved.services} services, ${r.moved.invoices} invoices moved`); onClose(); onDone(target.id); } catch (e: any) { toast.error(e.message); }
        setBusy(false);
      }}>Merge into this account</Button>
    </Modal>
  );
}

function CloseModal({ open, onClose, c, onDone }: any) {
  const [cancelInvoices, setCancel] = useState(true);
  return (
    <Modal open={open} onClose={onClose} title="Close client account">
      <p className="text-sm text-mute"><b>{c.email}</b> will be signed out and can't sign in again until you set the status back to Active. Billing records are kept.</p>
      <div className="mt-3"><Toggle checked={cancelInvoices} onChange={setCancel} label="Cancel unpaid invoices" /></div>
      <p className="mt-2 text-xs text-mute">Active services aren't touched — suspend or terminate them from each service page if needed.</p>
      <Button className="mt-4" variant="danger" onClick={() => api(`/admin/clients/${c.id}/close`, { body: { cancelInvoices } }).then((r) => { toast.success(`Account closed${r.cancelledInvoices ? `, ${r.cancelledInvoices} invoice(s) cancelled` : ""}${r.liveServices ? ` — ${r.liveServices} service(s) still live` : ""}`); onClose(); onDone(); }).catch((e) => toast.error(e.message))}>Close account</Button>
    </Modal>
  );
}

function CreditModal({ open, onClose, id, currency = "INR", onDone }: any) {
  const [amount, setAmount] = useState("");
  const [description, setDescription] = useState("");
  return (
    <Modal open={open} onClose={onClose} title="Manage credits">
      <div className="space-y-4">
        <Field label={`Amount (${currency})`} hint="Use a negative number to deduct."><Input type="number" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} /></Field>
        <Field label="Reason"><Input value={description} onChange={(e) => setDescription(e.target.value)} /></Field>
        <Button onClick={() => api(`/admin/clients/${id}/credit`, { body: { amount: Math.round(Number(amount) * 100), description } }).then(() => { toast.success("Credit updated"); onClose(); onDone(); }).catch((e) => toast.error(e.message))}>Save</Button>
      </div>
    </Modal>
  );
}

function InvoiceModal({ open, onClose, id, currency = "INR", onDone }: any) {
  const [items, setItems] = useState([{ description: "", price: "", taxable: true }]);
  const [due, setDue] = useState("");
  return (
    <Modal open={open} onClose={onClose} title="Create invoice" wide>
      <div className="space-y-3">
        {items.map((it, i) => (
          <div key={i} className="grid gap-2 sm:grid-cols-[1fr_140px_auto]">
            <Input placeholder="Description" value={it.description} onChange={(e) => setItems(items.map((x, j) => (j === i ? { ...x, description: e.target.value } : x)))} />
            <Input placeholder={`${currency} amount`} type="number" value={it.price} onChange={(e) => setItems(items.map((x, j) => (j === i ? { ...x, price: e.target.value } : x)))} />
            <label className="flex items-center gap-1 text-xs font-semibold"><input type="checkbox" checked={it.taxable} onChange={(e) => setItems(items.map((x, j) => (j === i ? { ...x, taxable: e.target.checked } : x)))} /> GST</label>
          </div>
        ))}
        <Button size="sm" variant="ghost" icon="add" onClick={() => setItems([...items, { description: "", price: "", taxable: true }])}>Add line</Button>
        <Field label="Due date"><Input type="date" value={due} onChange={(e) => setDue(e.target.value)} /></Field>
        <Button onClick={() => api("/admin/invoices", { body: { userId: id, dueDate: due || undefined, items: items.filter((x) => x.description).map((x) => ({ description: x.description, unitPrice: Math.round(Number(x.price) * 100), taxable: x.taxable })) } }).then(() => { toast.success("Invoice created and emailed"); onClose(); onDone(); }).catch((e) => toast.error(e.message))}>Create &amp; email</Button>
      </div>
    </Modal>
  );
}
