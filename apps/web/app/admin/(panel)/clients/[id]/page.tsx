"use client";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";
import { api, date, invNo, money } from "@/lib/api";
import { Alert, Badge, Button, Card, Copy, Field, Icon, Input, Loading, Modal, PageHeader, Select, Table, Td, Textarea, Toggle, cx, toast, useApi } from "@/components/ui";

const COUNTRY: Record<string, string> = { IN: "India", US: "United States", GB: "United Kingdom", AE: "United Arab Emirates", SG: "Singapore", CA: "Canada", AU: "Australia", DE: "Germany" };
const fullName = (x: any) => [x?.firstName, x?.lastName].filter(Boolean).join(" ") || x?.email || "—";

/** WHMCS-style client summary. */
export default function ClientDetail() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const { data, loading, reload } = useApi(`/admin/clients/${id}`);
  const { data: sum, reload: reloadSum } = useApi(`/admin/clients/${id}/summary`);
  const [tab, setTab] = useState("services");
  const [modal, setModal] = useState<string | null>(null);
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

  return (
    <>
      <PageHeader
        back="/admin/clients"
        title={<span className="flex items-center gap-3">{fullName(c)} <Badge status={c.status} /></span>}
        subtitle={`#${c.id.slice(-6).toUpperCase()} · ${c.email}${c.phone ? ` · ${c.phone}` : ""} · customer since ${date(c.createdAt)}`}
        actions={<>
          <Button size="sm" icon="add_shopping_cart" href={`/admin/orders/new?client=${c.id}`}>New order</Button>
          <Button variant="outline" size="sm" icon="login" disabled={c.status !== "ACTIVE"} title={c.status !== "ACTIVE" ? "Only active accounts" : "Open the client area as this customer"} onClick={loginAs}>Login as client</Button>
        </>}
      />

      <div className="mb-6 grid items-start gap-5 md:grid-cols-2 2xl:grid-cols-4">
        {/* ── column 1 ── */}
        <div className="space-y-5">
          <Panel title="Client information" action={<SmallBtn icon="edit" onClick={() => setModal("profile")}>Edit</SmallBtn>}>
            <Rows rows={[
              ["First name", c.firstName],
              ["Last name", c.lastName || "—"],
              ["Company", p.companyName || "—"],
              ["Email", <span key="e" className="inline-flex items-center gap-1 break-all">{c.email}<Copy text={c.email} /></span>],
              ["Address 1", p.address1 || "—"],
              ["Address 2", p.address2 || "—"],
              ["City", p.city || "—"],
              ["State", `${p.state || "—"}${p.stateCode ? ` (${p.stateCode})` : ""}`],
              ["Postcode", p.postcode || "—"],
              ["Country", `${p.country ?? "—"}${COUNTRY[p.country] ? ` – ${COUNTRY[p.country]}` : ""}`],
              ["Phone", c.phone || "—"],
              ["GSTIN", <span key="g" className="font-mono">{p.gstin || "—"}</span>],
              ["PAN", <span key="p" className="font-mono">{p.pan || "—"}</span>],
              ["Currency", cur],
            ]} />
            <Links>
              <ActionLink icon="login" onClick={loginAs} disabled={c.status !== "ACTIVE"}>Login as client</ActionLink>
              <ActionLink icon="lock_reset" onClick={() => confirm(`Email ${c.email} a password reset link?`) && run(() => api(`/admin/clients/${id}/password-reset`, { body: {} }), "Password reset email sent")}>Send password reset email</ActionLink>
              {c.totpEnabled && <ActionLink icon="phonelink_lock" onClick={() => confirm("Turn off two-factor sign-in for this customer?") && run(() => api(`/admin/clients/${id}/reset-2fa`, { body: {} }), "2FA reset")}>Reset two-factor sign-in</ActionLink>}
            </Links>
          </Panel>

          <Panel title="Contacts">
            {sum?.contacts?.length ? (
              <ul className="divide-y divide-line text-sm">
                {sum.contacts.map((k: any) => (
                  <li key={k.id} className="flex items-start justify-between gap-2 py-2">
                    <div className="min-w-0">
                      <div className="font-bold text-ink">{fullName(k)}{k.companyName ? <span className="font-normal text-mute"> · {k.companyName}</span> : null}</div>
                      <div className="break-all text-xs text-mute">{k.email}{k.phone ? ` · ${k.phone}` : ""}</div>
                      {k.emails?.length > 0 && <div className="mt-0.5 text-[11px] text-mute">Gets: {k.emails.join(", ")} emails</div>}
                    </div>
                    <IconBtn icon="delete" title="Remove contact" onClick={() => confirm(`Remove ${k.email}?`) && run(() => api(`/admin/clients/${id}/contacts/${k.id}`, { method: "DELETE" }), "Contact removed")} />
                  </li>
                ))}
              </ul>
            ) : <Empty>No additional contacts</Empty>}
            <Links><ActionLink icon="person_add" onClick={() => setModal("contact")}>Add contact</ActionLink></Links>
          </Panel>

          <Panel title="Pay methods">
            {sum?.payMethods?.length ? (
              <ul className="divide-y divide-line text-sm">
                {sum.payMethods.map((m: any) => (
                  <li key={m.id} className="py-2">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-1.5 font-bold text-ink">
                          <Icon name={m.type === "CARD" ? "credit_card" : m.type === "UPI" ? "qr_code_2" : m.type === "BANK" ? "account_balance" : "verified_user"} className="text-[18px] text-mute" />
                          {m.label}
                          {m.isDefault && <span className="rounded bg-primary-soft px-1.5 py-0.5 text-[10px] font-bold uppercase text-primary-dark">Default</span>}
                          {m.status !== "ACTIVE" && <Badge status="FAILED">{m.status}</Badge>}
                        </div>
                        <div className="text-xs text-mute">{m.gateway}{m.last4 ? ` · •••• ${m.last4}` : ""}{m.expiry ? ` · exp ${m.expiry}` : ""}</div>
                      </div>
                      <IconBtn icon="delete" title="Remove" onClick={() => confirm(`Remove ${m.label}?`) && run(() => api(`/admin/clients/${id}/pay-methods/${m.id}`, { method: "DELETE" }), "Pay method removed")} />
                    </div>
                    <div className="mt-1.5 flex flex-wrap items-center gap-3">
                      <Toggle checked={m.autopay} onChange={(v) => run(() => api(`/admin/clients/${id}/pay-methods/${m.id}`, { method: "PUT", body: { autopay: v } }), v ? "Autopay on" : "Autopay off")} label={<span className="text-xs">Autopay renewals</span>} />
                      {!m.isDefault && <button className="text-xs font-bold text-primary-dark" onClick={() => run(() => api(`/admin/clients/${id}/pay-methods/${m.id}`, { method: "PUT", body: { isDefault: true } }), "Default pay method set")}>Make default</button>}
                    </div>
                  </li>
                ))}
              </ul>
            ) : <Empty>No pay methods</Empty>}
            <Links><ActionLink icon="add_card" onClick={() => setModal("paymethod")}>Add pay method</ActionLink></Links>
          </Panel>
        </div>

        {/* ── column 2 ── */}
        <div className="space-y-5">
          <Panel title="Invoices / billing">
            {sum ? (
              <Rows rows={[
                ...(["PAID", "DRAFT", "UNPAID", "CANCELLED", "REFUNDED", "COLLECTIONS"] as const).map((k) => [
                  k === "UNPAID" ? "Unpaid / due" : k[0] + k.slice(1).toLowerCase(),
                  <span key={k} className={cx(k === "UNPAID" && sum.invoices[k].count > 0 && "font-bold text-rose-600")}>{sum.invoices[k].count} ({money(sum.invoices[k].total, cur)})</span>,
                ] as [string, ReactNode]),
                ["Gross revenue", money(sum.income.gross, cur)],
                ["Gateway fees", money(sum.income.fees, cur)],
                ["Net income", <b key="n">{money(sum.income.net, cur)}</b>],
                ["Credit balance", <b key="c" className={sum.income.credit > 0 ? "text-emerald-700" : ""}>{money(sum.income.credit, cur)}</b>],
              ]} />
            ) : <Loading />}
            <Links>
              <ActionLink icon="receipt_long" onClick={() => setModal("invoice")}>Create invoice</ActionLink>
              <ActionLink icon="savings" onClick={() => setModal("funds")}>Create add funds invoice</ActionLink>
              <ActionLink icon="event_repeat" onClick={() => run(() => api(`/admin/clients/${id}/generate-due`, { body: {} }), (r) => (r.created ? `${r.created} due invoice${r.created > 1 ? "s" : ""} created` : "Nothing is due yet — no invoices created"))}>Generate due invoices</ActionLink>
              <ActionLink icon="account_balance_wallet" onClick={() => setModal("credit")}>Manage credits</ActionLink>
              <ActionLink icon="summarize" onClick={() => goTab("statement")}>View account statement</ActionLink>
            </Links>
          </Panel>

          <Panel title="Other information">
            {sum ? (
              <Rows rows={[
                ["Status", <Select key="s" className="h-8 w-32 text-sm" value={c.status} onChange={(e) => run(() => api(`/admin/clients/${id}`, { method: "PUT", body: { status: e.target.value } }), "Status updated")}><option>ACTIVE</option><option>INACTIVE</option><option>CLOSED</option></Select>],
                ["Billing currency", <Select key="cur" className="h-8 w-24 text-sm" value={cur} onChange={(e) => run(() => api(`/admin/clients/${id}`, { method: "PUT", body: { currency: e.target.value } }), `Now billed in ${e.target.value}`)}><option>INR</option><option>USD</option></Select>],
                ["Signup date", date(sum.other.signupDate)],
                ["Client for", `${sum.other.clientForDays} day${sum.other.clientForDays === 1 ? "" : "s"}`],
                ["Last login", sum.other.lastLogin ? <span key="l">{date(sum.other.lastLogin.at, true)}<br /><span className="break-all font-mono text-[11px] text-mute">{sum.other.lastLogin.ip}</span></span> : "Never"],
                ["Signed-in sessions", String(sum.other.activeSessions)],
                ["Email verified", sum.other.emailVerified ? "Yes" : <b key="v" className="text-amber-700">No</b>],
                ["Two-factor sign-in", sum.other.twoFactor ? "On" : "Off"],
                ["Reseller", c.reseller ? `${c.reseller.brandName} (${c.reseller.status})` : "—"],
                ["Affiliate", sum.other.affiliate ? <span key="a" className="font-mono">{sum.other.affiliate.code}</span> : "—"],
              ]} />
            ) : <Loading />}
          </Panel>
        </div>

        {/* ── column 3 ── */}
        <div className="space-y-5">
          <Panel title="Products / services">
            {sum ? (
              <Rows rows={[
                ["Shared hosting", `${sum.products.shared.active} (${sum.products.shared.total} total)`],
                ["Reseller hosting", `${sum.products.reseller.active} (${sum.products.reseller.total} total)`],
                ["VPS / server", `${sum.products.server.active} (${sum.products.server.total} total)`],
                ["Other services", `${sum.products.other.active} (${sum.products.other.total} total)`],
                ["Domains", String(sum.products.domains)],
                ["Orders", String(sum.products.orders)],
                ["Support tickets", `${sum.products.openTickets} open (${sum.products.tickets} total)`],
                ["Affiliate signups", String(sum.products.affiliateSignups)],
              ]} />
            ) : <Loading />}
            <Links>
              <ActionLink icon="list_alt" onClick={() => goTab("orders")}>View orders</ActionLink>
              <ActionLink icon="add_shopping_cart" onClick={() => router.push(`/admin/orders/new?client=${c.id}`)}>Add new order</ActionLink>
            </Links>
          </Panel>

          <Panel title="Files">
            {sum?.files?.length ? (
              <ul className="divide-y divide-line text-sm">
                {sum.files.map((f: any) => (
                  <li key={f.id} className="flex items-center justify-between gap-2 py-2">
                    <a className="min-w-0 truncate font-semibold text-primary-dark" href={`/api/admin/clients/${id}/files/${f.id}`}>{f.title}</a>
                    <span className="flex shrink-0 items-center gap-1 text-[11px] text-mute">
                      {f.adminOnly && <span title="Only staff can see this file"><Icon name="lock" className="text-[14px]" /></span>}
                      {(f.size / 1024).toFixed(0)} KB · {date(f.createdAt)}
                      <IconBtn icon="delete" title="Delete file" onClick={() => confirm(`Delete ${f.filename}?`) && run(() => api(`/admin/clients/${id}/files/${f.id}`, { method: "DELETE" }), "File deleted")} />
                    </span>
                  </li>
                ))}
              </ul>
            ) : <Empty>No files uploaded</Empty>}
            <Links><ActionLink icon="upload_file" onClick={() => setModal("file")}>Add file</ActionLink></Links>
          </Panel>

          <Panel title="Recent emails">
            {sum?.emails?.length ? (
              <ul className="divide-y divide-line text-sm">
                {sum.emails.map((e: any) => (
                  <li key={e.id} className="flex items-start justify-between gap-2 py-2">
                    <div className="min-w-0"><div className="truncate font-semibold text-ink" title={e.subject}>{e.subject}</div><div className="text-[11px] text-mute">{date(e.createdAt, true)}</div></div>
                    <Badge status={e.status === "SENT" ? "ACTIVE" : e.status === "LOGGED" ? "PENDING" : "FAILED"}>{e.status.toLowerCase()}</Badge>
                  </li>
                ))}
              </ul>
            ) : <Empty>No emails yet</Empty>}
            <Links><ActionLink icon="mail" onClick={() => router.push(`/admin/email?q=${encodeURIComponent(c.email)}`)}>Email delivery log</ActionLink></Links>
          </Panel>
        </div>

        {/* ── column 4 ── */}
        <div className="space-y-5">
          <Panel title="Other actions">
            <Links first>
              <ActionLink icon="summarize" onClick={() => goTab("statement")}>View account statement</ActionLink>
              <ActionLink icon="support_agent" onClick={() => setModal("ticket")}>Open new support ticket</ActionLink>
              <ActionLink icon="forum" onClick={() => goTab("tickets")}>View all support tickets</ActionLink>
              <ActionLink icon="handshake" disabled={!!sum?.other?.affiliate} onClick={() => run(() => api(`/admin/clients/${id}/affiliate`, { body: {} }), (r) => `Affiliate activated — code ${r.code}`)}>{sum?.other?.affiliate ? "Already an affiliate" : "Activate as affiliate"}</ActionLink>
              <ActionLink icon="call_merge" onClick={() => setModal("merge")}>Merge clients accounts</ActionLink>
              <ActionLink icon="download" onClick={() => (window.location.href = `/api/admin/clients/${id}/export`)}>Export client data</ActionLink>
              <ActionLink icon="block" tone="danger" disabled={c.status === "CLOSED"} onClick={() => setModal("close")}>Close client account</ActionLink>
              <ActionLink icon="delete_forever" tone="danger" onClick={async () => {
                if (!confirm(`Permanently delete ${c.email}? This can't be undone.`)) return;
                try { await api(`/admin/clients/${id}`, { method: "DELETE" }); toast.success("Customer deleted"); router.push("/admin/clients"); } catch (e: any) { toast.error(e.message); }
              }}>Delete client account</ActionLink>
            </Links>
          </Panel>

          <WhatsAppCard client={c} />
          <SendEmailCard id={id} email={c.email} onSent={reloadSum} />

          <Panel title="Admin notes">
            <Textarea rows={5} defaultValue={p.notes ?? ""} onBlur={(e) => e.target.value !== (p.notes ?? "") && api(`/admin/clients/${id}`, { method: "PUT", body: { notes: e.target.value } }).then(() => toast.success("Notes saved"))} placeholder="Private notes — only staff see these (saved when you click away)" />
          </Panel>
        </div>
      </div>

      <div id="client-tabs" className="mb-4 flex scroll-mt-24 gap-2 overflow-x-auto">
        {["services", "orders", "invoices", "statement", "transactions", "tickets", "domains", "credit", "logins"].map((t) => <button key={t} onClick={() => setTab(t)} className={cx("rounded-full px-4 py-2 text-sm font-bold capitalize", tab === t ? "bg-primary-dark text-white" : "bg-white text-slate-600 ring-1 ring-line")}>{t}</button>)}
      </div>
      <Card pad={false}>
        {tab === "services" && <Table head={["Service", "Hostname / IP", "Status", "Recurring", "Next due"]}>{data.services.map((s: any) => <tr key={s.id}><Td><Link className="font-bold text-primary-dark" href={`/admin/services/${s.id}`}>{s.product.name}</Link></Td><Td>{s.hostname}<div className="font-mono text-xs text-mute">{s.ips.map((i: any) => i.address).join(", ")}</div></Td><Td><Badge status={s.status} /></Td><Td>{money(s.recurringAmount, s.currency)}</Td><Td>{date(s.nextDueDate)}</Td></tr>)}</Table>}
        {tab === "orders" && <Table head={["Order", "Date", "Total", "Status"]}>{(data.orders ?? []).map((o: any) => <tr key={o.id}><Td><Link className="font-bold text-primary-dark" href={`/admin/orders/${o.id}`}>{o.number}</Link></Td><Td>{date(o.createdAt, true)}</Td><Td>{money(o.total, o.currency)}</Td><Td><Badge status={o.status} /></Td></tr>)}</Table>}
        {tab === "invoices" && <Table head={["Invoice", "Date", "Total", "Status"]}>{data.invoices.map((i: any) => <tr key={i.id}><Td><Link className="font-bold text-primary-dark" href={`/admin/invoices/${i.id}`}>{invNo(i)}</Link></Td><Td>{date(i.issueDate)}</Td><Td>{money(i.total, i.currency)}</Td><Td><Badge status={i.status} /></Td></tr>)}</Table>}
        {tab === "statement" && <Statement id={id} />}
        {tab === "transactions" && <Table head={["Date", "Gateway", "Reference", "Type", "Amount"]}>{data.transactions.map((t: any) => <tr key={t.id}><Td>{date(t.createdAt, true)}</Td><Td>{t.gateway}</Td><Td className="font-mono text-xs">{t.gatewayTxnId}</Td><Td>{t.type}</Td><Td>{money(t.amount, t.currency)}</Td></tr>)}</Table>}
        {tab === "tickets" && <Table head={["Ticket", "Subject", "Department", "Status"]}>{data.tickets.map((t: any) => <tr key={t.id}><Td>#{t.number}</Td><Td><Link className="font-bold text-primary-dark" href={`/admin/tickets/${t.id}`}>{t.subject}</Link></Td><Td>{t.department.name}</Td><Td><Badge status={t.status} /></Td></tr>)}</Table>}
        {tab === "domains" && <Table head={["Domain", "Status", "Expiry"]}>{data.domains.map((d: any) => <tr key={d.id}><Td className="font-bold">{d.name}</Td><Td><Badge status={d.status} /></Td><Td>{date(d.expiryDate)}</Td></tr>)}</Table>}
        {tab === "credit" && <Table head={["Date", "Description", "Amount", "Balance"]}>{data.ledger.map((l: any) => <tr key={l.id}><Td>{date(l.createdAt, true)}</Td><Td>{l.description}</Td><Td className={l.amount < 0 ? "text-rose-600" : "text-emerald-600"}>{money(l.amount, cur)}</Td><Td>{money(l.balanceAfter, cur)}</Td></tr>)}</Table>}
        {tab === "logins" && <Table head={["Time", "IP", "Result"]}>{data.logins.map((l: any) => <tr key={l.id}><Td>{date(l.createdAt, true)}</Td><Td className="font-mono text-xs">{l.ip}</Td><Td>{l.success ? <Badge status="ACTIVE">ok</Badge> : <Badge status="FAILED">{l.reason}</Badge>}</Td></tr>)}</Table>}
      </Card>

      <ProfileModal open={modal === "profile"} onClose={close} c={c} onDone={refresh} />
      <ContactModal open={modal === "contact"} onClose={close} id={id} onDone={refresh} />
      <PayMethodModal open={modal === "paymethod"} onClose={close} id={id} onDone={refresh} />
      <FileModal open={modal === "file"} onClose={close} id={id} onDone={refresh} />
      <CreditModal open={modal === "credit"} onClose={close} id={id} currency={cur} onDone={refresh} />
      <InvoiceModal open={modal === "invoice"} onClose={close} id={id} currency={cur} onDone={refresh} />
      <FundsModal open={modal === "funds"} onClose={close} id={id} currency={cur} onDone={refresh} />
      <TicketModal open={modal === "ticket"} onClose={close} id={id} onDone={refresh} />
      <MergeModal open={modal === "merge"} onClose={close} c={c} onDone={(into: string) => router.push(`/admin/clients/${into}`)} />
      <CloseModal open={modal === "close"} onClose={close} c={c} onDone={refresh} />
    </>
  );
}

// ───── small building blocks ─────
function Panel({ title, action, children }: { title: string; action?: ReactNode; children: ReactNode }) {
  return (
    <section className="rounded-2xl border border-line bg-white shadow-card">
      <div className="flex items-center justify-between gap-2 border-b border-line px-5 py-3">
        <h3 className="text-[15px] font-extrabold text-ink">{title}</h3>
        {action}
      </div>
      <div className="px-5 py-3">{children}</div>
    </section>
  );
}
function Rows({ rows }: { rows: [string, ReactNode][] }) {
  return (
    <dl className="divide-y divide-line text-[13.5px]">
      {rows.map(([k, v]) => (
        <div key={k} className="grid grid-cols-[minmax(0,42%)_1fr] items-center gap-3 py-1.5">
          <dt className="text-mute">{k}</dt>
          <dd className="min-w-0 break-words font-semibold text-ink">{v}</dd>
        </div>
      ))}
    </dl>
  );
}
function Links({ children, first }: { children: ReactNode; first?: boolean }) {
  return <div className={cx("space-y-0.5", !first && "mt-3 border-t border-line pt-2")}>{children}</div>;
}
function ActionLink({ icon, children, onClick, disabled, tone }: { icon: string; children: ReactNode; onClick: () => void; disabled?: boolean; tone?: "danger" }) {
  return (
    <button type="button" disabled={disabled} onClick={onClick} className={cx("flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left text-[13.5px] font-semibold transition disabled:cursor-not-allowed disabled:opacity-45", tone === "danger" ? "text-rose-600 hover:bg-rose-50" : "text-primary-dark hover:bg-primary-tint")}>
      <Icon name={icon} className="text-[18px]" />
      {children}
    </button>
  );
}
function SmallBtn({ icon, children, onClick }: { icon: string; children: ReactNode; onClick: () => void }) {
  return <button type="button" onClick={onClick} className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-xs font-bold text-primary-dark hover:bg-primary-tint"><Icon name={icon} className="text-[15px]" />{children}</button>;
}
function IconBtn({ icon, title, onClick }: { icon: string; title: string; onClick: () => void }) {
  return <button type="button" title={title} onClick={onClick} className="grid h-7 w-7 shrink-0 place-items-center rounded-lg text-slate-400 hover:bg-rose-50 hover:text-rose-600"><Icon name={icon} className="text-[16px]" /></button>;
}
function Empty({ children }: { children: ReactNode }) {
  return <p className="rounded-xl bg-[#fbf9ff] py-3 text-center text-sm text-mute">{children}</p>;
}

// ───── cards ─────
function WhatsAppCard({ client: c }: { client: any }) {
  const [msg, setMsg] = useState("");
  const digits = String(c.phone ?? "").replace(/\D/g, "");
  const phone = digits.length === 10 ? `91${digits}` : digits;
  const fill = (t: string) => t.replace(/\{firstname\}/gi, c.firstName ?? "").replace(/\{lastname\}/gi, c.lastName ?? "").replace(/\{email\}/gi, c.email ?? "").replace(/\{userid\}/gi, c.id);
  return (
    <Panel title="Send WhatsApp message">
      {phone.length < 10 ? <Empty>No mobile number on the account</Empty> : (
        <>
          <Textarea rows={3} value={msg} onChange={(e) => setMsg(e.target.value)} placeholder={`Hi {firstname}, …`} />
          <p className="mt-1 text-[11px] text-mute">You can use {"{firstname}"}, {"{lastname}"}, {"{email}"}, {"{userid}"}</p>
          <Button className="mt-2 w-full !bg-emerald-600 hover:!bg-emerald-700" size="sm" icon="chat" disabled={!msg.trim()} onClick={() => window.open(`https://wa.me/${phone}?text=${encodeURIComponent(fill(msg))}`, "_blank", "noopener")}>Open in WhatsApp (+{phone})</Button>
        </>
      )}
    </Panel>
  );
}

function SendEmailCard({ id, email, onSent }: { id: string; email: string; onSent: () => void }) {
  const [subject, setSubject] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <Panel title="Send email">
      <div className="space-y-2">
        <Input value={subject} onChange={(e) => setSubject(e.target.value)} placeholder="Subject" />
        <Textarea rows={4} value={message} onChange={(e) => setMessage(e.target.value)} placeholder={`Message to ${email}`} />
        <Button size="sm" className="w-full" icon="send" loading={busy} disabled={subject.trim().length < 2 || message.trim().length < 2} onClick={async () => {
          setBusy(true);
          try { await api(`/admin/clients/${id}/email`, { body: { subject, message } }); toast.success("Email queued"); setSubject(""); setMessage(""); onSent(); } catch (e: any) { toast.error(e.message); }
          setBusy(false);
        }}>Send</Button>
        <p className="text-[11px] text-mute">Goes out with your branding through Email Delivery and appears under Recent emails.</p>
      </div>
    </Panel>
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
          <tr key={r.kind + r.id}>
            <Td>{date(r.date, true)}</Td>
            <Td className="capitalize">{r.kind}</Td>
            <Td className="font-mono text-xs">{r.kind === "invoice" ? <Link className="text-primary-dark" href={`/admin/invoices/${r.id}`}>{r.ref}</Link> : r.ref}</Td>
            <Td>{r.description}</Td>
            <Td>{r.debit ? money(r.debit, cur) : ""}</Td>
            <Td className="text-emerald-700">{r.credit ? money(r.credit, cur) : ""}</Td>
            <Td className={cx("font-bold", r.balance > 0 && "text-rose-600")}>{money(r.balance, cur)}</Td>
          </tr>
        ))}
      </Table>
      <div className="flex justify-end border-t border-line px-5 py-3 text-sm">Balance owed:&nbsp;<b className={data.balance > 0 ? "text-rose-600" : "text-emerald-700"}>{money(data.balance, cur)}</b></div>
    </>
  );
}

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
