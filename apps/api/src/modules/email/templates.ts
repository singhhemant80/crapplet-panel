/** Built-in email templates. Admins can override any of these from Admin → Email Templates. */

// ───────── email building blocks (tables + inline styles: they work in Gmail, Outlook and Apple Mail) ─────────
const TONE: Record<string, [bg: string, fg: string, border: string]> = {
  purple: ["#f5f0ff", "#6d28d9", "#e4d6ff"],
  green: ["#ecfdf5", "#047857", "#bbf0d6"],
  amber: ["#fffbeb", "#b45309", "#fde3a7"],
  red: ["#fef2f2", "#b91c1c", "#fbcaca"],
  blue: ["#eff6ff", "#1d4ed8", "#cfe0fd"],
  slate: ["#f1f5f9", "#475569", "#e2e8f0"],
};
const BTN: Record<string, string> = { purple: "#7c3aed", red: "#dc2626", amber: "#d97706", green: "#059669" };

/** Status label, big headline and an intro line. */
function hero(tone: string, label: string, title: string, intro: string) {
  const [bg, fg, bd] = TONE[tone] ?? TONE.purple;
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td style="padding:0 0 6px">
<span style="display:inline-block;background:${bg};color:${fg};border:1px solid ${bd};font-size:11px;font-weight:800;letter-spacing:.08em;text-transform:uppercase;padding:5px 12px;border-radius:999px">${label}</span>
<h1 style="margin:16px 0 8px;font-size:25px;line-height:1.25;font-weight:800;color:#0f172a;letter-spacing:-.01em">${title}</h1>
<p style="margin:0 0 6px;font-size:15.5px;line-height:1.65;color:#475569">${intro}</p></td></tr></table>`;
}

/** Bulletproof call-to-action button. */
function btn(label: string, href: string, tone = "purple") {
  const c = BTN[tone] ?? BTN.purple;
  const bg = tone === "purple" ? `background:${c};background:linear-gradient(135deg,#a365fe,#7c3aed)` : `background:${c}`;
  return `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:26px 0 10px"><tr><td bgcolor="${c}" style="border-radius:12px;${bg};box-shadow:0 8px 20px -8px ${c}">
<a href="${href}" target="_blank" style="display:inline-block;padding:14px 30px;font-size:15px;font-weight:700;line-height:1;color:#ffffff;text-decoration:none;border-radius:12px">${label}&nbsp;&nbsp;&rarr;</a></td></tr></table>`;
}

/** A rounded card of label → value rows. */
function details(rows: [string, string][]) {
  const tr = rows
    .map(([k, v], i) => `<tr><td style="padding:12px 18px;${i ? "border-top:1px solid #eee7fb;" : ""}color:#64748b;font-size:13.5px;white-space:nowrap;vertical-align:top;width:38%">${k}</td><td style="padding:12px 18px;${i ? "border-top:1px solid #eee7fb;" : ""}color:#0f172a;font-size:14.5px;word-break:break-word">${v}</td></tr>`)
    .join("");
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:20px 0 4px;background:#fbf9ff;border:1px solid #eee7fb;border-radius:14px;border-collapse:separate">${tr}</table>`;
}

/** Big amount with a caption (invoices). */
function amountBox(label: string, amount: string, caption: string, tone = "purple") {
  const [bg, fg, bd] = TONE[tone] ?? TONE.purple;
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:20px 0 4px;background:${bg};border:1px solid ${bd};border-radius:14px"><tr><td style="padding:20px 22px">
<div style="font-size:12px;font-weight:800;letter-spacing:.08em;text-transform:uppercase;color:${fg}">${label}</div>
<div style="margin-top:6px;font-size:32px;line-height:1.1;font-weight:800;color:#0f172a;letter-spacing:-.02em">${amount}</div>
<div style="margin-top:6px;font-size:14px;color:#475569">${caption}</div></td></tr></table>`;
}

function callout(tone: string, text: string) {
  const [bg, fg, bd] = TONE[tone] ?? TONE.blue;
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:18px 0 4px"><tr><td style="background:${bg};border:1px solid ${bd};border-left:4px solid ${fg};border-radius:12px;padding:14px 16px;font-size:14px;line-height:1.6;color:#334155">${text}</td></tr></table>`;
}

function note(text: string) {
  return `<p style="margin:16px 0 0;font-size:13.5px;line-height:1.6;color:#64748b">${text}</p>`;
}

function quote(text: string) {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:16px 0 4px"><tr><td style="background:#fbf9ff;border-left:4px solid #a365fe;border-radius:0 12px 12px 0;padding:16px 18px;font-size:15px;line-height:1.65;color:#0f172a;white-space:pre-wrap">${text}</td></tr></table>`;
}

const ICONS: Record<string, string> = { rocket: "&#128640;", wallet: "&#128179;", chat: "&#128172;", key: "&#128273;" };
/** Numbered "what's next" list with small icons. */
function steps(items: [icon: string, title: string, text: string][]) {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:18px 0 0">${items
    .map(([ic, t, d]) => `<tr><td style="padding:8px 14px 8px 0;vertical-align:top;width:44px"><div style="width:40px;height:40px;line-height:40px;text-align:center;border-radius:12px;background:#f5f0ff;font-size:19px">${ICONS[ic] ?? "&#10022;"}</div></td><td style="padding:8px 0;vertical-align:top"><div style="font-size:15px;font-weight:700;color:#0f172a">${t}</div><div style="font-size:14px;line-height:1.55;color:#64748b">${d}</div></td></tr>`)
    .join("")}</table>`;
}

const mono = (v: string) => `<span style="font-family:SFMono-Regular,Menlo,Consolas,monospace;font-size:14px;font-weight:700;background:#ffffff;border:1px solid #e9e1fb;border-radius:6px;padding:2px 7px">${v}</span>`;
const link = (v: string) => `<a href="${v}" style="color:#7c3aed;font-weight:600;text-decoration:none">${v}</a>`;
const badge = (tone: string, v: string) => {
  const [bg, fg, bd] = TONE[tone] ?? TONE.purple;
  return `<span style="display:inline-block;background:${bg};color:${fg};border:1px solid ${bd};font-size:12px;font-weight:700;padding:2px 10px;border-radius:999px">${v}</span>`;
};
export const DEFAULT_TEMPLATES: Record<string, { name: string; subject: string; body: string }> = {
  "auth.verify_email": {
    name: "Email verification",
    subject: "Verify your {{company.brand}} email address",
    body: hero("purple", "Verify email", "Confirm your email address", "Hi {{name}}, one click and your {{company.brand}} account is ready to use.") +
      btn("Verify my email", "{{link}}") +
      note("This link expires in 24 hours. If you didn't create an account, you can safely ignore this email."),
  },
  "auth.password_reset": {
    name: "Password reset",
    subject: "Reset your {{company.brand}} password",
    body: hero("purple", "Security", "Reset your password", "Hi {{name}}, we received a request to reset the password for your account.") +
      btn("Choose a new password", "{{link}}") +
      note("This link expires in 60 minutes. If you didn't ask for this, ignore this email — your password won't change."),
  },
  "auth.password_set": {
    name: "Password set by staff",
    subject: "Your {{company.brand}} password was reset",
    body: hero("purple", "Security", "Your new password", "Hi {{name}}, as requested, our team has set a new password for your account.") +
      details([["Email", "<b>{{email}}</b>"], ["New password", mono("{{password}}")]]) +
      btn("Sign in", "{{appUrl}}/client/login") +
      callout("amber", "Please change this password after signing in (Account → Security). If you didn't ask for this, contact us right away."),
  },
  "auth.welcome": {
    name: "Welcome",
    subject: "Welcome to {{company.brand}}",
    body: hero("purple", "Welcome", "Welcome aboard, {{name}}!", "Your {{company.brand}} account is ready. Here's what you can do next:") +
      steps([
        ["rocket", "Launch a server", "Linux & Windows VPS, hosting and dedicated servers — ready in minutes."],
        ["wallet", "Add funds or pay invoices", "UPI, cards, net banking and account credit."],
        ["chat", "Talk to us any time", "Open a ticket or WhatsApp us — we usually reply in minutes."],
      ]) +
      btn("Go to your client area", "{{appUrl}}/client"),
  },
  "order.confirmation": {
    name: "Order confirmation",
    subject: "Order {{orderNumber}} received",
    body: hero("green", "Order received", "Thanks for your order!", "Hi {{name}}, we've received order <b>{{orderNumber}}</b>. Pay the invoice below and we'll set everything up right away.") +
      amountBox("Amount due", "{{total}}", "Invoice {{invoiceNumber}}") +
      btn("View &amp; pay invoice", "{{appUrl}}/client/invoices/{{invoiceId}}"),
  },
  "invoice.created": {
    name: "Invoice created",
    subject: "Invoice {{invoiceNumber}} — {{total}} due {{dueDate}}",
    body: hero("purple", "New invoice", "Invoice {{invoiceNumber}}", "Hi {{name}}, a new invoice has been generated for your account.") +
      amountBox("Amount due", "{{total}}", "Due on {{dueDate}}") +
      btn("Pay now", "{{appUrl}}/client/invoices/{{invoiceId}}") +
      note("Pay with UPI, card, net banking or your account credit. Already paid? You can ignore this email."),
  },
  "invoice.paid": {
    name: "Payment confirmation",
    subject: "Payment received — Invoice {{invoiceNumber}}",
    body: hero("green", "Payment received", "Thank you — we've got your payment", "Hi {{name}}, your payment was received and applied to your account.") +
      details([["Invoice", "<b>{{invoiceNumber}}</b>"], ["Amount paid", "<b>{{amount}}</b>"], ["Status", badge("green", "Paid")]]) +
      note("Your tax invoice is attached to this email as a PDF."),
  },
  "invoice.reminder": {
    name: "Payment reminder",
    subject: "Reminder: Invoice {{invoiceNumber}} due {{dueDate}}",
    body: hero("amber", "Payment reminder", "Invoice {{invoiceNumber}} is due soon", "Hi {{name}}, a friendly reminder that this invoice is due on <b>{{dueDate}}</b>.") +
      amountBox("Amount due", "{{total}}", "Due on {{dueDate}}", "amber") +
      btn("Pay now", "{{appUrl}}/client/invoices/{{invoiceId}}") +
      note("Paying on time keeps your services running without interruption. Already paid? Thank you — please ignore this email."),
  },
  "invoice.overdue": {
    name: "Overdue notice",
    subject: "Overdue: Invoice {{invoiceNumber}}",
    body: hero("red", "Overdue", "Invoice {{invoiceNumber}} is overdue", "Hi {{name}}, this invoice was due on <b>{{dueDate}}</b> and hasn't been paid yet.") +
      amountBox("Amount overdue", "{{total}}", "Was due on {{dueDate}}", "red") +
      callout("red", "Services linked to this invoice may be suspended if it stays unpaid. Pay now to avoid any interruption.") +
      btn("Pay now", "{{appUrl}}/client/invoices/{{invoiceId}}", "red"),
  },
  "service.renewal_reminder": {
    name: "Renewal reminder",
    subject: "{{productName}} renews on {{dueDate}}",
    body: hero("blue", "Renewal", "{{productName}} renews on {{dueDate}}", "Hi {{name}}, your service is coming up for renewal.") +
      details([["Service", "<b>{{productName}}</b>"], ["Hostname", "{{hostname}}"], ["Renewal date", "<b>{{dueDate}}</b>"]]) +
      btn("Manage my services", "{{appUrl}}/client/services"),
  },
  "service.vps_ready": {
    name: "VPS activated",
    subject: "Your VPS {{hostname}} is ready",
    body: hero("green", "Server ready", "Your server is online", "Hi {{name}}, your <b>{{productName}}</b> has been set up and is ready to use.") +
      details([["Hostname", "<b>{{hostname}}</b>"], ["IP address", mono("{{ip}}")], ["Username", mono("{{username}}")], ["Password", mono("{{password}}")], ["Operating system", "{{os}}"]]) +
      btn("Manage my server", "{{appUrl}}/client/services/{{serviceId}}") +
      callout("amber", "For your security, please change the password after your first login. Keep these details private."),
  },
  "service.hosting_ready": {
    name: "Hosting account ready (cPanel)",
    subject: "Your hosting for {{domain}} is ready",
    body: hero("green", "Hosting ready", "Your hosting for {{domain}} is live", "Hi {{name}}, your <b>{{productName}}</b> account is ready.") +
      details([["cPanel", link("{{cpanelUrl}}")], ["Username", mono("{{username}}")], ["Password", mono("{{password}}")], ["Webmail", link("{{webmailUrl}}")], ["Server IP", mono("{{ip}}")], ["Nameservers", "{{nameservers}}"]]) +
      btn("Open in client area", "{{appUrl}}/client/services/{{serviceId}}") +
      callout("blue", "Point your domain's nameservers to the ones above (or an A record to the server IP). DNS changes can take a few hours to spread.") +
      note("Reseller accounts can manage their customers in WHM: {{whmUrl}}"),
  },
  "service.activated": {
    name: "Service activated",
    subject: "Your {{productName}} service is active",
    body: hero("green", "Active", "{{productName}} is active", "Hi {{name}}, your service is now active. All the details are in your client area.") +
      details([["Service", "<b>{{productName}}</b>"], ["Hostname", "{{hostname}}"], ["Status", badge("green", "Active")]]) +
      btn("View service", "{{appUrl}}/client/services/{{serviceId}}"),
  },
  "service.suspended": {
    name: "Service suspended",
    subject: "Service suspended: {{productName}}",
    body: hero("red", "Suspended", "{{productName}} has been suspended", "Hi {{name}}, your service <b>{{productName}}</b> ({{hostname}}) is suspended.") +
      details([["Service", "<b>{{productName}}</b>"], ["Hostname", "{{hostname}}"], ["Reason", "{{reason}}"], ["Status", badge("red", "Suspended")]]) +
      callout("blue", "Pay any outstanding invoices and it's restored automatically — usually within a minute.") +
      btn("View my invoices", "{{appUrl}}/client/invoices"),
  },
  "service.suspended_reminder": {
    name: "Suspended service — payment reminder",
    subject: "Reminder: {{productName}} is suspended — pay {{amountDue}} to restore it",
    body: hero("amber", "Reminder", "{{productName}} is still suspended", "Hi {{name}}, your service <b>{{productName}}</b> ({{hostname}}) is suspended because an invoice is unpaid.") +
      amountBox("Amount to pay", "{{amountDue}}", "Invoice {{invoiceNumber}}", "amber") +
      callout("blue", "As soon as it's paid, your service is restored automatically — usually within a minute. Services that stay unpaid may be removed later, together with their data.") +
      btn("Pay & restore", "{{appUrl}}/client/invoices/{{invoiceId}}") +
      note("Already paid? Thank you — please ignore this email, or reply and we'll check it for you."),
  },
  "service.unsuspended": {
    name: "Service reactivated",
    subject: "Service reactivated: {{productName}}",
    body: hero("green", "Reactivated", "{{productName}} is back online", "Hi {{name}}, your service <b>{{productName}}</b> ({{hostname}}) has been reactivated. Thanks!") +
      btn("View my services", "{{appUrl}}/client/services"),
  },
  "service.terminated": {
    name: "Service terminated",
    subject: "Service terminated: {{productName}}",
    body: hero("slate", "Terminated", "{{productName}} has been terminated", "Hi {{name}}, your service <b>{{productName}}</b> ({{hostname}}) has been terminated and its data removed.") +
      note("Need it again? You can order a new service any time from your client area.") +
      btn("Order a new service", "{{appUrl}}/order"),
  },
  "ticket.opened": {
    name: "Ticket opened",
    subject: "[{{ticketNumber}}] {{subject}}",
    body: hero("blue", "Support", "We've got your request", "Hi {{name}}, thanks for reaching out — our team will reply shortly.") +
      details([["Ticket", "<b>#{{ticketNumber}}</b>"], ["Subject", "{{subject}}"], ["Department", "{{department}}"]]) +
      btn("View ticket", "{{appUrl}}/client/tickets/{{ticketId}}") +
      note("Reply to this ticket from your client area to add more details."),
  },
  "ticket.reply": {
    name: "Ticket reply",
    subject: "[{{ticketNumber}}] {{subject}}",
    body: hero("blue", "Support · #{{ticketNumber}}", "New reply on your ticket", "Hi {{name}}, our team replied to <b>{{subject}}</b>:") +
      quote("{{message}}") +
      btn("View &amp; reply", "{{appUrl}}/client/tickets/{{ticketId}}"),
  },
  "domain.expiry": {
    name: "Domain expiry",
    subject: "{{domain}} expires on {{expiryDate}}",
    body: hero("amber", "Domain renewal", "{{domain}} expires on {{expiryDate}}", "Hi {{name}}, renew your domain to keep your website and email working.") +
      details([["Domain", "<b>{{domain}}</b>"], ["Expires on", "<b>{{expiryDate}}</b>"]]) +
      btn("Renew now", "{{appUrl}}/client/domains", "amber"),
  },
  "reseller.approved": {
    name: "Reseller approved",
    subject: "Your reseller account is approved",
    body: hero("green", "Approved", "Welcome to the reseller program!", "Hi {{name}}, your reseller account <b>{{brand}}</b> has been approved.") +
      steps([
        ["rocket", "Order wholesale servers", "VPS and hosting at reseller prices."],
        ["key", "Create API keys", "Sell from your own website with our Reseller API."],
      ]) +
      btn("Open reseller dashboard", "{{appUrl}}/client"),
  },
  "admin.provisioning_failed": {
    name: "Admin: provisioning failed",
    subject: "[Action needed] Provisioning failed for service {{serviceId}}",
    body: `<p>Provisioning of <b>{{productName}}</b> for {{clientEmail}} failed.</p><pre style="white-space:pre-wrap">{{error}}</pre><p><a href="{{adminUrl}}">Open in admin</a></p>`,
  },
  "admin.manual_setup": {
    name: "Admin: paid order needs manual setup",
    subject: "[Action needed] Set up {{productName}} for {{clientEmail}}",
    body: `<p><b>{{clientEmail}}</b> has paid for <b>{{productName}}</b> {{hostname}}. This plan is set up by hand, so the service is waiting for you.</p><p><a href="{{adminUrl}}">Open the service</a> — set it up, then click <b>Activate</b> on its order.</p>`,
  },
  "staff.message": {
    name: "Message from staff (Send Email on the client page)",
    subject: "{{subject}}",
    body: `<p>Hi {{name}},</p>{{{messageHtml}}}`,
  },
  "alert.order_placed": {
    name: "Staff alert: new order",
    subject: "🛒 New order {{orderNumber}} · {{total}} · {{clientName}}",
    body: `<p style="font-size:15px">{{headline}}</p>{{{details}}}<p><a href="{{adminUrl}}" style="display:inline-block;background:#6d28d9;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none;font-weight:700">{{linkLabel}}</a></p><p style="color:#94a3b8;font-size:12px">Staff alert · {{alertName}} · {{sentAt}}. Change who gets these, or turn them off, in Admin → Email Delivery → Staff alerts.</p>`,
  },
  "alert.upgrade_requested": {
    name: "Staff alert: plan change ordered",
    subject: "⬆️ {{clientName}} ordered a {{direction}}: {{from}} → {{to}}",
    body: `<p style="font-size:15px">{{headline}}</p>{{{details}}}<p><a href="{{adminUrl}}" style="display:inline-block;background:#6d28d9;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none;font-weight:700">{{linkLabel}}</a></p><p style="color:#94a3b8;font-size:12px">Staff alert · {{alertName}} · {{sentAt}}. Change who gets these, or turn them off, in Admin → Email Delivery → Staff alerts.</p>`,
  },
  "alert.payment_received": {
    name: "Staff alert: payment received",
    subject: "💰 Payment received: {{amount}} from {{clientName}} ({{gateway}})",
    body: `<p style="font-size:15px">{{headline}}</p>{{{details}}}<p><a href="{{adminUrl}}" style="display:inline-block;background:#6d28d9;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none;font-weight:700">{{linkLabel}}</a></p><p style="color:#94a3b8;font-size:12px">Staff alert · {{alertName}} · {{sentAt}}. Change who gets these, or turn them off, in Admin → Email Delivery → Staff alerts.</p>`,
  },
  "alert.payment_review": {
    name: "Staff alert: payment to verify",
    subject: "[Action needed] Verify {{amount}} {{gateway}} payment from {{clientName}} — ref {{reference}}",
    body: `<p style="font-size:15px">{{headline}}</p>{{{details}}}<p><a href="{{adminUrl}}" style="display:inline-block;background:#6d28d9;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none;font-weight:700">{{linkLabel}}</a></p><p style="color:#94a3b8;font-size:12px">Staff alert · {{alertName}} · {{sentAt}}. Change who gets these, or turn them off, in Admin → Email Delivery → Staff alerts.</p>`,
  },
  "alert.payment_failed": {
    name: "Staff alert: AutoPay payment failed",
    subject: "⚠️ AutoPay failed: {{amount}} for invoice {{invoiceNumber}} ({{clientName}})",
    body: `<p style="font-size:15px">{{headline}}</p>{{{details}}}<p><a href="{{adminUrl}}" style="display:inline-block;background:#6d28d9;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none;font-weight:700">{{linkLabel}}</a></p><p style="color:#94a3b8;font-size:12px">Staff alert · {{alertName}} · {{sentAt}}. Change who gets these, or turn them off, in Admin → Email Delivery → Staff alerts.</p>`,
  },
  "alert.payment_problem": {
    name: "Staff alert: payment couldn't be applied",
    subject: "[Action needed] {{gateway}} payment {{gatewayTxnId}} couldn't be applied",
    body: `<p style="font-size:15px">{{headline}}</p>{{{details}}}<p><a href="{{adminUrl}}" style="display:inline-block;background:#6d28d9;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none;font-weight:700">{{linkLabel}}</a></p><p style="color:#94a3b8;font-size:12px">Staff alert · {{alertName}} · {{sentAt}}. Change who gets these, or turn them off, in Admin → Email Delivery → Staff alerts.</p>`,
  },
  "alert.credit_applied": {
    name: "Staff alert: invoice paid from credit",
    subject: "Invoice {{invoiceNumber}} paid from credit ({{amount}}) · {{clientName}}",
    body: `<p style="font-size:15px">{{headline}}</p>{{{details}}}<p><a href="{{adminUrl}}" style="display:inline-block;background:#6d28d9;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none;font-weight:700">{{linkLabel}}</a></p><p style="color:#94a3b8;font-size:12px">Staff alert · {{alertName}} · {{sentAt}}. Change who gets these, or turn them off, in Admin → Email Delivery → Staff alerts.</p>`,
  },
  "alert.refund_issued": {
    name: "Staff alert: refund issued",
    subject: "↩️ Refund issued: {{amount}} to {{clientName}}",
    body: `<p style="font-size:15px">{{headline}}</p>{{{details}}}<p><a href="{{adminUrl}}" style="display:inline-block;background:#6d28d9;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none;font-weight:700">{{linkLabel}}</a></p><p style="color:#94a3b8;font-size:12px">Staff alert · {{alertName}} · {{sentAt}}. Change who gets these, or turn them off, in Admin → Email Delivery → Staff alerts.</p>`,
  },
  "alert.service_suspended": {
    name: "Staff alert: service suspended",
    subject: "Suspended: {{productName}} {{hostname}} · {{clientName}}",
    body: `<p style="font-size:15px">{{headline}}</p>{{{details}}}<p><a href="{{adminUrl}}" style="display:inline-block;background:#6d28d9;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none;font-weight:700">{{linkLabel}}</a></p><p style="color:#94a3b8;font-size:12px">Staff alert · {{alertName}} · {{sentAt}}. Change who gets these, or turn them off, in Admin → Email Delivery → Staff alerts.</p>`,
  },
  "alert.service_terminated": {
    name: "Staff alert: service terminated",
    subject: "Terminated: {{productName}} {{hostname}} · {{clientName}}",
    body: `<p style="font-size:15px">{{headline}}</p>{{{details}}}<p><a href="{{adminUrl}}" style="display:inline-block;background:#6d28d9;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none;font-weight:700">{{linkLabel}}</a></p><p style="color:#94a3b8;font-size:12px">Staff alert · {{alertName}} · {{sentAt}}. Change who gets these, or turn them off, in Admin → Email Delivery → Staff alerts.</p>`,
  },
  "alert.ticket_opened": {
    name: "Staff alert: new ticket",
    subject: "🎫 New ticket #{{ticketNumber}}: {{subject}} · {{clientName}}",
    body: `<p style="font-size:15px">{{headline}}</p>{{{details}}}<p><a href="{{adminUrl}}" style="display:inline-block;background:#6d28d9;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none;font-weight:700">{{linkLabel}}</a></p><p style="color:#94a3b8;font-size:12px">Staff alert · {{alertName}} · {{sentAt}}. Change who gets these, or turn them off, in Admin → Email Delivery → Staff alerts.</p>`,
  },
  "alert.cancellation": {
    name: "Staff alert: cancellation request",
    subject: "[Action needed] Cancellation request from {{clientName}} (#{{ticketNumber}})",
    body: `<p style="font-size:15px">{{headline}}</p>{{{details}}}<p><a href="{{adminUrl}}" style="display:inline-block;background:#6d28d9;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none;font-weight:700">{{linkLabel}}</a></p><p style="color:#94a3b8;font-size:12px">Staff alert · {{alertName}} · {{sentAt}}. Change who gets these, or turn them off, in Admin → Email Delivery → Staff alerts.</p>`,
  },
  "alert.ticket_reply": {
    name: "Staff alert: customer replied",
    subject: "💬 {{clientName}} replied on #{{ticketNumber}}: {{subject}}",
    body: `<p style="font-size:15px">{{headline}}</p>{{{details}}}<p><a href="{{adminUrl}}" style="display:inline-block;background:#6d28d9;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none;font-weight:700">{{linkLabel}}</a></p><p style="color:#94a3b8;font-size:12px">Staff alert · {{alertName}} · {{sentAt}}. Change who gets these, or turn them off, in Admin → Email Delivery → Staff alerts.</p>`,
  },
  "alert.client_registered": {
    name: "Staff alert: new client",
    subject: "👤 New client: {{clientName}} ({{clientEmail}})",
    body: `<p style="font-size:15px">{{headline}}</p>{{{details}}}<p><a href="{{adminUrl}}" style="display:inline-block;background:#6d28d9;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none;font-weight:700">{{linkLabel}}</a></p><p style="color:#94a3b8;font-size:12px">Staff alert · {{alertName}} · {{sentAt}}. Change who gets these, or turn them off, in Admin → Email Delivery → Staff alerts.</p>`,
  },
};
