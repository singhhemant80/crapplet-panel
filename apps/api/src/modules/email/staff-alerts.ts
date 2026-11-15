/**
 * Emails to the business (not the customer) when something happens that staff should know about:
 * new orders, every payment, payments to verify, refunds, failed setups, new tickets, sign-ups …
 * Who gets them and which ones are sent is set in Admin → Email Delivery → Staff alerts.
 * Never throws — an alert must never break the order / payment it reports.
 */
import { prisma } from "../../db";
import { config } from "../../config";
import { formatMoney } from "../../lib/money";
import { getSettings, updateSettings } from "../../lib/settings";
import { esc, queueEmail } from "./mailer";

export type AlertGroup = "Orders" | "Payments" | "Services" | "Support" | "Clients";

/** Every staff alert. `template` is the email template used (editable under Email Templates). */
export const STAFF_ALERTS = {
  "order.placed": { name: "New order placed", group: "Orders", on: true, template: "alert.order_placed", hint: "As soon as a customer checks out, paid or not." },
  "upgrade.requested": { name: "Upgrade / downgrade ordered", group: "Orders", on: true, template: "alert.upgrade_requested", hint: "A customer changed plan from the client area." },
  "payment.received": { name: "Payment received", group: "Payments", on: true, template: "alert.payment_received", hint: "Every payment — gateway, UPI, bank transfer approved, or recorded by staff." },
  "payment.review": { name: "Payment waiting for verification", group: "Payments", on: true, template: "alert.payment_review", hint: "A customer submitted a bank / UPI reference that needs checking." },
  "payment.failed": { name: "AutoPay payment failed", group: "Payments", on: true, template: "alert.payment_failed", hint: "A UPI AutoPay renewal charge didn't go through." },
  "payment.problem": { name: "Payment couldn't be applied", group: "Payments", on: true, template: "alert.payment_problem", hint: "Money was taken but didn't match the invoice (wrong currency)." },
  "credit.applied": { name: "Invoice paid from account credit", group: "Payments", on: false, template: "alert.credit_applied", hint: "A renewal or order was settled from the customer's wallet." },
  "refund.issued": { name: "Refund issued", group: "Payments", on: true, template: "alert.refund_issued", hint: "Any refund — to the card / UPI, the wallet, or paid back by hand." },
  "service.manual_setup": { name: "Paid order needs manual setup", group: "Services", on: true, template: "admin.manual_setup", hint: "Colocation, dedicated and other hand-delivered plans." },
  "service.provisioning_failed": { name: "Automatic setup failed", group: "Services", on: true, template: "admin.provisioning_failed", hint: "VPS / hosting / domain setup failed — with the reason and the fix." },
  "service.suspended": { name: "Service suspended", group: "Services", on: false, template: "alert.service_suspended", hint: "Including automatic suspensions for unpaid invoices." },
  "service.terminated": { name: "Service terminated", group: "Services", on: false, template: "alert.service_terminated", hint: "Including automatic terminations." },
  "ticket.opened": { name: "New support ticket", group: "Support", on: true, template: "alert.ticket_opened", hint: "A customer opened a ticket." },
  "ticket.cancellation": { name: "Cancellation request", group: "Support", on: true, template: "alert.cancellation", hint: "A customer asked to cancel a service." },
  "ticket.client_reply": { name: "Customer replied to a ticket", group: "Support", on: true, template: "alert.ticket_reply", hint: "A customer answered on an existing ticket." },
  "client.registered": { name: "New client signed up", group: "Clients", on: true, template: "alert.client_registered", hint: "Someone created an account." },
} as const satisfies Record<string, { name: string; group: AlertGroup; on: boolean; template: string; hint: string }>;

export type StaffAlert = keyof typeof STAFF_ALERTS;

export type StaffAlertConfig = {
  enabled: boolean;
  /** comma / newline separated; empty → the billing email under Settings → Company */
  recipients: string;
  events: Partial<Record<StaffAlert, boolean>>;
};

const EMAIL = /^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/;

export function parseRecipients(raw: string | null | undefined): string[] {
  const out: string[] = [];
  for (const p of String(raw ?? "").split(/[\s,;]+/)) {
    const e = p.trim().toLowerCase();
    if (e && EMAIL.test(e) && !out.includes(e)) out.push(e);
  }
  return out.slice(0, 10);
}

export async function getStaffAlertConfig(): Promise<StaffAlertConfig & { to: string[] }> {
  const s = await getSettings();
  const c = s.staffAlerts as StaffAlertConfig;
  const events = Object.fromEntries(Object.entries(STAFF_ALERTS).map(([k, v]) => [k, c.events?.[k as StaffAlert] ?? v.on])) as Record<StaffAlert, boolean>;
  const list = parseRecipients(c.recipients);
  return { enabled: c.enabled !== false, recipients: c.recipients ?? "", events, to: list.length ? list : parseRecipients(s.company.billingEmail) };
}

export async function saveStaffAlertConfig(patch: Partial<StaffAlertConfig>) {
  const cur = await getStaffAlertConfig();
  const events = { ...cur.events };
  for (const [k, v] of Object.entries(patch.events ?? {})) if (k in STAFF_ALERTS && typeof v === "boolean") events[k as StaffAlert] = v;
  await updateSettings("staffAlerts", { enabled: patch.enabled ?? cur.enabled, recipients: patch.recipients ?? cur.recipients, events });
  return getStaffAlertConfig();
}

// ───────── building the email ─────────

type Row = [label: string, value: unknown, href?: string];

/** A two-column details table (values escaped). */
export function detailsTable(rows: Row[]) {
  const tr = rows
    .filter(([, v]) => v !== undefined && v !== null && v !== "")
    .map(([k, v, href]) => {
      const val = href ? `<a href="${esc(href)}" style="color:#6d28d9">${esc(v)}</a>` : esc(v).replace(/\n/g, "<br>");
      return `<tr><td style="padding:7px 12px 7px 0;color:#64748b;white-space:nowrap;vertical-align:top">${esc(k)}</td><td style="padding:7px 0;color:#0f172a;font-weight:600">${val}</td></tr>`;
    })
    .join("");
  return `<table cellpadding="0" cellspacing="0" style="width:100%;border-collapse:collapse;font-size:14px;border-top:1px solid #e2e8f0;border-bottom:1px solid #e2e8f0;margin:12px 0">${tr}</table>`;
}

export const adminLink = (path: string) => `${config.appUrl}${path}`;

const GATEWAY_NAMES: Record<string, string> = { razorpay: "Razorpay", cashfree: "Cashfree", payu: "PayU", stripe: "Stripe", paypal: "PayPal", bank: "Bank transfer", upi: "UPI", wire: "Wire transfer", manual: "Recorded by staff", custom: "Custom gateway", credit: "Account credit", razorpay_autopay: "Razorpay UPI AutoPay", cashfree_autopay: "Cashfree UPI AutoPay" };
export async function gatewayName(code: string) {
  const row = await prisma.paymentGateway.findUnique({ where: { code }, select: { name: true } }).catch(() => null);
  return row?.name || GATEWAY_NAMES[code] || code;
}

/** Who the alert is about. */
export async function clientInfo(userId: string | null | undefined) {
  if (!userId) return { clientName: "", clientEmail: "", rows: [] as Row[] };
  const u = await prisma.user.findUnique({ where: { id: userId }, select: { firstName: true, lastName: true, email: true, phone: true, ownerResellerId: true, profile: { select: { companyName: true } } } });
  if (!u) return { clientName: "", clientEmail: "", rows: [] as Row[] };
  const name = `${u.firstName ?? ""} ${u.lastName ?? ""}`.trim() || u.email;
  const label = [name, u.profile?.companyName].filter(Boolean).join(" · ");
  const rows: Row[] = [
    ["Client", `${label} (#${userId.slice(-6).toUpperCase()})`, adminLink(`/admin/clients/${userId}`)],
    ["Email", u.email],
    ["Phone", u.phone],
  ];
  if (u.ownerResellerId) rows.push(["Note", "End customer of a reseller"]);
  return { clientName: name, clientEmail: u.email, rows };
}

/**
 * Send one staff alert. `data.headline` is the first line, `data.rows` the details,
 * `data.link` / `data.linkLabel` the button; any other keys are template variables.
 */
export async function alertStaff(event: StaffAlert, data: { subjectVars?: Record<string, unknown>; headline?: string; rows?: Row[]; link?: string; linkLabel?: string; vars?: Record<string, unknown> } = {}) {
  try {
    const def = STAFF_ALERTS[event];
    if (!def) return { sent: 0 };
    const cfg = await getStaffAlertConfig();
    if (!cfg.enabled || !cfg.events[event] || !cfg.to.length) return { sent: 0 };
    const vars = {
      ...data.subjectVars,
      ...data.vars,
      headline: data.headline ?? "",
      details: detailsTable(data.rows ?? []),
      adminUrl: data.link ?? adminLink("/admin"),
      linkLabel: data.linkLabel ?? "Open in admin",
      alertName: def.name,
      sentAt: new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata", day: "2-digit", month: "short", year: "numeric", hour: "numeric", minute: "2-digit", hour12: true }) + " IST",
    };
    for (const to of cfg.to) await queueEmail(def.template, to, vars);
    return { sent: cfg.to.length };
  } catch (e) {
    console.error(`[staff-alert] ${event} failed`, e);
    return { sent: 0 };
  }
}

/** Fire-and-forget wrapper for hot paths (checkout, payments): the caller never waits on it. */
export function alertStaffLater(fn: () => Promise<unknown>) {
  void fn().catch((e) => console.error("[staff-alert]", e));
}

// ───────── one helper per event (each loads what it needs) ─────────

const money = formatMoney;

export async function alertOrderPlaced(orderId: string, opts: { byStaff?: boolean } = {}) {
  const o = await prisma.order.findUnique({ where: { id: orderId }, include: { invoice: { include: { items: true } } } });
  if (!o) return;
  const c = await clientInfo(o.userId);
  const inv = o.invoice;
  const items = (inv?.items ?? []).filter((i) => i.type !== "PROMO").map((i) => `• ${i.description.split("\n")[0]}`).join("\n");
  const paid = inv?.status === "PAID";
  return alertStaff("order.placed", {
    subjectVars: { orderNumber: o.number, total: money(o.total, o.currency), clientName: c.clientName },
    headline: `${c.clientName || "A customer"} placed order ${o.number} for ${money(o.total, o.currency)}${opts.byStaff ? " (entered by staff)" : ""}.`,
    rows: [
      ["Order", o.number, adminLink(`/admin/orders/${o.id}`)],
      ...c.rows,
      ["Items", items],
      ["Total", money(o.total, o.currency)],
      ["Invoice", inv ? (inv.number ?? inv.proformaNumber) : "", inv ? adminLink(`/admin/invoices/${inv.id}`) : undefined],
      ["Payment", paid ? "Paid" : "Awaiting payment"],
      ["Promo code", o.promoCode],
      ["IP address", o.ip],
      ["Notes", o.notes],
    ],
    link: adminLink(`/admin/orders/${o.id}`),
    linkLabel: "Open the order",
  });
}

/** What an invoice is for, in one line ("Order ORD-000123 · Starter Hosting (acme.in)", "Wallet top-up", "Renewal: …"). */
async function invoiceFor(inv: { id: string; isWalletTopup: boolean; items: { description: string; type: string; periodStart: Date | null }[] }) {
  if (inv.isWalletTopup) return "Wallet top-up (adds account credit)";
  const order = await prisma.order.findFirst({ where: { invoiceId: inv.id }, select: { number: true } });
  const lines = inv.items.filter((i) => i.type !== "PROMO" && i.type !== "LATE_FEE").map((i) => i.description.split("\n")[0]);
  const what = lines.slice(0, 4).join("\n") + (lines.length > 4 ? `\n+ ${lines.length - 4} more` : "");
  const renewal = !order && inv.items.some((i) => i.periodStart);
  return [order ? `New order ${order.number}` : renewal ? "Renewal" : "", what].filter(Boolean).join("\n");
}

export async function alertPaymentReceived(p: { invoiceId: string; amount: number; gateway: string; gatewayTxnId: string; fee?: number; becamePaid: boolean }) {
  const inv = await prisma.invoice.findUnique({ where: { id: p.invoiceId }, include: { items: true } });
  if (!inv) return;
  const c = await clientInfo(inv.userId);
  const via = await gatewayName(p.gateway);
  const label = inv.number ?? inv.proformaNumber;
  const balance = Math.max(0, inv.total - inv.amountPaid);
  const status = inv.status === "PAID" ? (p.becamePaid ? "Paid in full" : "Already paid — the extra went to account credit") : `Part paid — ${money(balance, inv.currency)} still due`;
  return alertStaff("payment.received", {
    subjectVars: { amount: money(p.amount, inv.currency), clientName: c.clientName, gateway: via, invoiceNumber: label },
    headline: `${money(p.amount, inv.currency)} received from ${c.clientName || "a customer"} via ${via} for invoice ${label}.`,
    rows: [
      ["Amount", money(p.amount, inv.currency)],
      ["Method", via],
      ["Transaction ID", p.gatewayTxnId],
      ["Gateway fee", p.fee ? money(p.fee, inv.currency) : ""],
      ...c.rows,
      ["Invoice", `${label} · ${money(inv.total, inv.currency)}`, adminLink(`/admin/invoices/${inv.id}`)],
      ["For", await invoiceFor(inv)],
      ["Invoice status", status],
    ],
    link: adminLink(`/admin/invoices/${inv.id}`),
    linkLabel: "Open the invoice",
  });
}

export async function alertCreditApplied(invoiceId: string, amount: number) {
  const inv = await prisma.invoice.findUnique({ where: { id: invoiceId }, include: { items: true } });
  if (!inv) return;
  const c = await clientInfo(inv.userId);
  const label = inv.number ?? inv.proformaNumber;
  return alertStaff("credit.applied", {
    subjectVars: { invoiceNumber: label, amount: money(amount, inv.currency), clientName: c.clientName },
    headline: `Invoice ${label} was paid with ${money(amount, inv.currency)} of ${c.clientName || "the customer"}'s account credit.`,
    rows: [["Invoice", `${label} · ${money(inv.total, inv.currency)}`, adminLink(`/admin/invoices/${inv.id}`)], ...c.rows, ["For", await invoiceFor(inv)], ["Credit used", money(amount, inv.currency)]],
    link: adminLink(`/admin/invoices/${inv.id}`),
    linkLabel: "Open the invoice",
  });
}

export async function alertPaymentReview(intentId: string) {
  const it = await prisma.paymentIntent.findUnique({ where: { id: intentId }, include: { invoice: { include: { items: true } } } });
  if (!it) return;
  const c = await clientInfo(it.userId);
  const via = await gatewayName(it.gateway);
  const label = it.invoice.number ?? it.invoice.proformaNumber;
  return alertStaff("payment.review", {
    subjectVars: { amount: money(it.amount, it.currency), gateway: via, reference: it.reference ?? "", clientName: c.clientName },
    headline: `${c.clientName || "A customer"} says they paid ${money(it.amount, it.currency)} by ${via}. Check it against your bank statement, then approve or reject it.`,
    rows: [["Amount", money(it.amount, it.currency)], ["Method", via], ["Reference / UTR", it.reference], ...c.rows, ["Invoice", label, adminLink(`/admin/invoices/${it.invoiceId}`)], ["For", await invoiceFor(it.invoice)]],
    link: adminLink("/admin/payment-reviews"),
    linkLabel: "Review payments",
  });
}

export async function alertPaymentFailed(intentId: string, reason: string) {
  const it = await prisma.paymentIntent.findUnique({ where: { id: intentId }, include: { invoice: true } });
  if (!it) return;
  const c = await clientInfo(it.userId);
  const label = it.invoice.number ?? it.invoice.proformaNumber;
  return alertStaff("payment.failed", {
    subjectVars: { amount: money(it.amount, it.currency), clientName: c.clientName, invoiceNumber: label },
    headline: `The UPI AutoPay charge of ${money(it.amount, it.currency)} for invoice ${label} didn't go through. The customer has been told and it will be retried.`,
    rows: [["Amount", money(it.amount, it.currency)], ["Method", await gatewayName(it.gateway)], ["Reason", reason], ...c.rows, ["Invoice", label, adminLink(`/admin/invoices/${it.invoiceId}`)], ["Due date", it.invoice.dueDate.toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata", day: "2-digit", month: "short", year: "numeric" })]],
    link: adminLink(`/admin/invoices/${it.invoiceId}`),
    linkLabel: "Open the invoice",
  });
}

export async function alertPaymentProblem(args: { gateway: string; gatewayTxnId: string; amount: number; currency?: string; intentId: string; problem: string }) {
  const it = await prisma.paymentIntent.findUnique({ where: { id: args.intentId }, include: { invoice: true } });
  const c = await clientInfo(it?.userId);
  const via = await gatewayName(args.gateway);
  return alertStaff("payment.problem", {
    subjectVars: { gateway: via, gatewayTxnId: args.gatewayTxnId, clientName: c.clientName },
    headline: `${via} took a payment that couldn't be applied: ${args.problem}. Check it in the ${via} dashboard and refund it or record it by hand.`,
    rows: [["Problem", args.problem], ["Charged", `${(args.amount / 100).toFixed(2)} ${args.currency ?? ""}`.trim()], ["Transaction ID", args.gatewayTxnId], ...c.rows, ["Invoice", it ? (it.invoice.number ?? it.invoice.proformaNumber) : "", it ? adminLink(`/admin/invoices/${it.invoiceId}`) : undefined]],
    link: it ? adminLink(`/admin/invoices/${it.invoiceId}`) : adminLink("/admin/transactions"),
    linkLabel: "Open in admin",
  });
}

export async function alertRefund(args: { paymentId: string; amount: number; method: string; reason: string; actorId: string; refundId: string }) {
  const p = await prisma.transaction.findUnique({ where: { id: args.paymentId } });
  if (!p) return;
  const c = await clientInfo(p.userId);
  const by = await prisma.user.findUnique({ where: { id: args.actorId }, select: { firstName: true, lastName: true, email: true } });
  const inv = p.invoiceId ? await prisma.invoice.findUnique({ where: { id: p.invoiceId }, select: { id: true, number: true, proformaNumber: true } }) : null;
  const how = args.method === "wallet" ? "to the customer's wallet" : args.method === "manual" ? "paid back by hand" : `through ${await gatewayName(p.gateway)}`;
  return alertStaff("refund.issued", {
    subjectVars: { amount: money(args.amount, p.currency), clientName: c.clientName },
    headline: `${money(args.amount, p.currency)} was refunded ${how}.`,
    rows: [
      ["Amount", money(args.amount, p.currency)],
      ["How", how],
      ["Reason", args.reason],
      ["Original payment", `${money(p.amount, p.currency)} · ${await gatewayName(p.gateway)} · ${p.gatewayTxnId}`],
      ["Refund reference", args.refundId],
      ...c.rows,
      ["Invoice", inv ? (inv.number ?? inv.proformaNumber) : "", inv ? adminLink(`/admin/invoices/${inv.id}`) : undefined],
      ["Done by", by ? `${by.firstName ?? ""} ${by.lastName ?? ""}`.trim() || by.email : ""],
    ],
    link: inv ? adminLink(`/admin/invoices/${inv.id}`) : adminLink(`/admin/clients/${p.userId}`),
    linkLabel: inv ? "Open the invoice" : "Open the client",
  });
}

export async function alertTicket(ticketId: string, kind: "opened" | "reply", message: string) {
  const t = await prisma.ticket.findUnique({ where: { id: ticketId }, include: { department: { select: { name: true } }, service: { select: { hostname: true, product: { select: { name: true } } } } } });
  if (!t) return;
  const c = await clientInfo(t.userId);
  const cancel = kind === "opened" && /^cancellation request/i.test(t.subject);
  const event: StaffAlert = cancel ? "ticket.cancellation" : kind === "opened" ? "ticket.opened" : "ticket.client_reply";
  const text = message.length > 1500 ? `${message.slice(0, 1500)}…` : message;
  return alertStaff(event, {
    subjectVars: { ticketNumber: t.number, subject: t.subject, clientName: c.clientName, priority: t.priority },
    headline: cancel
      ? `${c.clientName || "A customer"} asked to cancel ${t.service ? `${t.service.product.name}${t.service.hostname ? ` (${t.service.hostname})` : ""}` : "a service"}.`
      : kind === "opened"
        ? `${c.clientName || "A customer"} opened ticket #${t.number}: “${t.subject}”.`
        : `${c.clientName || "The customer"} replied on ticket #${t.number}: “${t.subject}”.`,
    rows: [
      ["Ticket", `#${t.number} · ${t.subject}`, adminLink(`/admin/tickets/${t.id}`)],
      ["Department", t.department?.name],
      ["Priority", t.priority.charAt(0) + t.priority.slice(1).toLowerCase()],
      ["Service", t.service ? `${t.service.product.name}${t.service.hostname ? ` · ${t.service.hostname}` : ""}` : "", t.serviceId ? adminLink(`/admin/services/${t.serviceId}`) : undefined],
      ...c.rows,
      ["Message", text],
    ],
    link: adminLink(`/admin/tickets/${t.id}`),
    linkLabel: "Reply to the ticket",
  });
}

export async function alertClientRegistered(userId: string, ip?: string | null) {
  const c = await clientInfo(userId);
  const p = await prisma.clientProfile.findUnique({ where: { userId }, select: { city: true, state: true, country: true, gstin: true } });
  return alertStaff("client.registered", {
    subjectVars: { clientName: c.clientName, clientEmail: c.clientEmail },
    headline: `${c.clientName || c.clientEmail} just created an account.`,
    rows: [...c.rows, ["Location", [p?.city, p?.state, p?.country].filter(Boolean).join(", ")], ["GSTIN", p?.gstin], ["IP address", ip]],
    link: adminLink(`/admin/clients/${userId}`),
    linkLabel: "Open the client",
  });
}

export async function alertUpgrade(upgradeId: string) {
  const up = await prisma.serviceUpgrade.findUnique({ where: { id: upgradeId }, include: { service: { select: { hostname: true, product: { select: { name: true } } } } } });
  if (!up) return;
  const [from, to] = await Promise.all([prisma.product.findUnique({ where: { id: up.fromProductId }, select: { name: true } }), prisma.product.findUnique({ where: { id: up.toProductId }, select: { name: true } })]);
  const c = await clientInfo(up.userId);
  const cyc = (x: string) => x.charAt(0) + x.slice(1).toLowerCase();
  const dir = up.newRecurring >= up.oldRecurring ? "upgrade" : "downgrade";
  return alertStaff("upgrade.requested", {
    subjectVars: { clientName: c.clientName, from: from?.name ?? "", to: to?.name ?? "", direction: dir },
    headline: `${c.clientName || "A customer"} ordered a ${dir}: ${from?.name} → ${to?.name}${up.service.hostname ? ` on ${up.service.hostname}` : ""}.`,
    rows: [
      ["Service", `${up.service.product.name}${up.service.hostname ? ` · ${up.service.hostname}` : ""}`, adminLink(`/admin/services/${up.serviceId}`)],
      ["From", `${from?.name} · ${cyc(up.fromCycle)} · ${money(up.oldRecurring, up.currency)}`],
      ["To", `${to?.name} · ${cyc(up.toCycle)} · ${money(up.newRecurring, up.currency)}`],
      ["To pay now", up.amountDue > 0 ? money(up.amountDue, up.currency) : up.amountDue < 0 ? `${money(-up.amountDue, up.currency)} back to the customer` : "Nothing"],
      ...c.rows,
    ],
    link: adminLink(`/admin/services/${up.serviceId}`),
    linkLabel: "Open the service",
  });
}

export async function alertServiceState(serviceId: string, state: "suspended" | "terminated", reason?: string) {
  const s = await prisma.service.findUnique({ where: { id: serviceId }, select: { userId: true, hostname: true, product: { select: { name: true } } } });
  if (!s) return;
  const c = await clientInfo(s.userId);
  return alertStaff(state === "suspended" ? "service.suspended" : "service.terminated", {
    subjectVars: { productName: s.product.name, hostname: s.hostname ?? "", clientName: c.clientName },
    headline: `${s.product.name}${s.hostname ? ` (${s.hostname})` : ""} for ${c.clientName || "a customer"} was ${state}.`,
    rows: [["Service", `${s.product.name}${s.hostname ? ` · ${s.hostname}` : ""}`, adminLink(`/admin/services/${serviceId}`)], ["Reason", reason], ...c.rows],
    link: adminLink(`/admin/services/${serviceId}`),
    linkLabel: "Open the service",
  });
}

/** "Send test" on the settings page: one sample alert to every recipient, regardless of the event switches. */
export async function sendTestAlert() {
  const cfg = await getStaffAlertConfig();
  if (!cfg.to.length) throw new Error("Add at least one email address first");
  for (const to of cfg.to)
    await queueEmail("alert.payment_received", to, {
      amount: "₹1,180.00", clientName: "Test Customer", gateway: "UPI", invoiceNumber: "TEST-0001",
      headline: "This is a test staff alert — if you can read this, payment and order alerts will reach this inbox.",
      details: detailsTable([["Amount", "₹1,180.00"], ["Method", "UPI"], ["Transaction ID", "TEST123456"], ["Client", "Test Customer"], ["For", "Sample order"]]),
      adminUrl: adminLink("/admin/email"), linkLabel: "Open Email Delivery", alertName: "Test",
      sentAt: new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata", day: "2-digit", month: "short", year: "numeric", hour: "numeric", minute: "2-digit", hour12: true }) + " IST",
    });
  return { to: cfg.to };
}
