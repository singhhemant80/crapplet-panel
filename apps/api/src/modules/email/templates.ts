/** Built-in email templates. Admins can override any of these from Admin → Email Templates. */
export const DEFAULT_TEMPLATES: Record<string, { name: string; subject: string; body: string }> = {
  "auth.verify_email": {
    name: "Email verification",
    subject: "Verify your {{company.brand}} email address",
    body: `<p>Hi {{name}},</p><p>Please confirm your email address to finish setting up your account.</p>
<p><a href="{{link}}" style="display:inline-block;background:#7c3aed;color:#fff;padding:12px 22px;border-radius:10px;text-decoration:none;font-weight:700">Verify email</a></p>
<p style="color:#64748b">This link expires in 24 hours.</p>`,
  },
  "auth.password_reset": {
    name: "Password reset",
    subject: "Reset your {{company.brand}} password",
    body: `<p>Hi {{name}},</p><p>We received a request to reset your password. If this was you, use the button below.</p>
<p><a href="{{link}}" style="display:inline-block;background:#7c3aed;color:#fff;padding:12px 22px;border-radius:10px;text-decoration:none;font-weight:700">Reset password</a></p>
<p style="color:#64748b">This link expires in 60 minutes. If you didn't ask for this, you can ignore this email.</p>`,
  },
  "auth.welcome": {
    name: "Welcome",
    subject: "Welcome to {{company.brand}}",
    body: `<p>Hi {{name}},</p><p>Your account is ready. Sign in any time at <a href="{{appUrl}}/client">{{appUrl}}/client</a>.</p>`,
  },
  "order.confirmation": {
    name: "Order confirmation",
    subject: "Order {{orderNumber}} received",
    body: `<p>Hi {{name}},</p><p>Thanks for your order <b>{{orderNumber}}</b>. Invoice <b>{{invoiceNumber}}</b> for <b>{{total}}</b> has been generated.</p>
<p><a href="{{appUrl}}/client/invoices/{{invoiceId}}">View &amp; pay invoice</a></p>`,
  },
  "invoice.created": {
    name: "Invoice created",
    subject: "Invoice {{invoiceNumber}} — {{total}} due {{dueDate}}",
    body: `<p>Hi {{name}},</p><p>A new invoice has been generated.</p><p>Invoice: <b>{{invoiceNumber}}</b><br>Amount: <b>{{total}}</b><br>Due date: <b>{{dueDate}}</b></p>
<p><a href="{{appUrl}}/client/invoices/{{invoiceId}}">Pay now</a></p>`,
  },
  "invoice.paid": {
    name: "Payment confirmation",
    subject: "Payment received — Invoice {{invoiceNumber}}",
    body: `<p>Hi {{name}},</p><p>We received your payment of <b>{{amount}}</b> for invoice <b>{{invoiceNumber}}</b>. Thank you! Your tax invoice is attached.</p>`,
  },
  "invoice.reminder": {
    name: "Payment reminder",
    subject: "Reminder: Invoice {{invoiceNumber}} due {{dueDate}}",
    body: `<p>Hi {{name}},</p><p>This is a reminder that invoice <b>{{invoiceNumber}}</b> for <b>{{total}}</b> is due on <b>{{dueDate}}</b>.</p>
<p><a href="{{appUrl}}/client/invoices/{{invoiceId}}">Pay now</a> to avoid service interruption.</p>`,
  },
  "invoice.overdue": {
    name: "Overdue notice",
    subject: "Overdue: Invoice {{invoiceNumber}}",
    body: `<p>Hi {{name}},</p><p>Invoice <b>{{invoiceNumber}}</b> for <b>{{total}}</b> was due on <b>{{dueDate}}</b> and is now overdue. Services linked to this invoice may be suspended.</p>
<p><a href="{{appUrl}}/client/invoices/{{invoiceId}}">Pay now</a></p>`,
  },
  "service.renewal_reminder": {
    name: "Renewal reminder",
    subject: "{{productName}} renews on {{dueDate}}",
    body: `<p>Hi {{name}},</p><p>Your service <b>{{productName}}</b> ({{hostname}}) is due for renewal on <b>{{dueDate}}</b>.</p>`,
  },
  "service.vps_ready": {
    name: "VPS activated",
    subject: "Your VPS {{hostname}} is ready",
    body: `<p>Hi {{name}},</p><p>Your <b>{{productName}}</b> server is online.</p>
<table cellpadding="6" style="background:#faf7ff;border-radius:10px;border:1px solid #ece4fb">
<tr><td>Hostname</td><td><b>{{hostname}}</b></td></tr>
<tr><td>IP address</td><td><b>{{ip}}</b></td></tr>
<tr><td>Username</td><td><b>{{username}}</b></td></tr>
<tr><td>Password</td><td><b>{{password}}</b></td></tr>
<tr><td>Operating system</td><td>{{os}}</td></tr></table>
<p>Manage your server at <a href="{{appUrl}}/client/services/{{serviceId}}">your client area</a>. Please change the password after your first login.</p>`,
  },
  "service.hosting_ready": {
    name: "Hosting account ready (cPanel)",
    subject: "Your hosting for {{domain}} is ready",
    body: `<p>Hi {{name}},</p><p>Your <b>{{productName}}</b> account for <b>{{domain}}</b> is ready.</p>
<table style="border-collapse:collapse;margin:12px 0">
<tr><td style="padding:4px 14px 4px 0;color:#64748b">cPanel</td><td><a href="{{cpanelUrl}}">{{cpanelUrl}}</a></td></tr>
<tr><td style="padding:4px 14px 4px 0;color:#64748b">Username</td><td><b>{{username}}</b></td></tr>
<tr><td style="padding:4px 14px 4px 0;color:#64748b">Password</td><td><b>{{password}}</b></td></tr>
<tr><td style="padding:4px 14px 4px 0;color:#64748b">Webmail</td><td><a href="{{webmailUrl}}">{{webmailUrl}}</a></td></tr>
<tr><td style="padding:4px 14px 4px 0;color:#64748b">Server IP</td><td>{{ip}}</td></tr>
<tr><td style="padding:4px 14px 4px 0;color:#64748b">Nameservers</td><td>{{nameservers}}</td></tr>
</table>
<p>Point your domain's nameservers to the ones above (or an A record to the server IP). DNS changes can take a few hours to spread.</p>
<p>You can also open cPanel with one click from your client area: <a href="{{appUrl}}/client/services/{{serviceId}}">{{appUrl}}/client/services/{{serviceId}}</a></p>
<p style="color:#64748b">Reseller accounts can manage their customers in WHM: {{whmUrl}}</p>`,
  },
  "service.activated": {
    name: "Service activated",
    subject: "Your {{productName}} service is active",
    body: `<p>Hi {{name}},</p><p>Your service <b>{{productName}}</b> is now active. Details are available in your client area.</p>`,
  },
  "service.suspended": {
    name: "Service suspended",
    subject: "Service suspended: {{productName}}",
    body: `<p>Hi {{name}},</p><p>Your service <b>{{productName}}</b> ({{hostname}}) has been suspended. Reason: {{reason}}.</p><p>Pay any outstanding invoices to restore it automatically.</p>`,
  },
  "service.unsuspended": {
    name: "Service reactivated",
    subject: "Service reactivated: {{productName}}",
    body: `<p>Hi {{name}},</p><p>Your service <b>{{productName}}</b> ({{hostname}}) has been reactivated.</p>`,
  },
  "service.terminated": {
    name: "Service terminated",
    subject: "Service terminated: {{productName}}",
    body: `<p>Hi {{name}},</p><p>Your service <b>{{productName}}</b> ({{hostname}}) has been terminated.</p>`,
  },
  "ticket.opened": {
    name: "Ticket opened",
    subject: "[{{ticketNumber}}] {{subject}}",
    body: `<p>Hi {{name}},</p><p>We've received your ticket <b>{{ticketNumber}}</b> in {{department}}. Our team will reply shortly.</p>`,
  },
  "ticket.reply": {
    name: "Ticket reply",
    subject: "[{{ticketNumber}}] {{subject}}",
    body: `<p>Hi {{name}},</p><div style="border-left:3px solid #a365fe;padding-left:12px;white-space:pre-wrap">{{message}}</div>
<p><a href="{{appUrl}}/client/tickets/{{ticketId}}">View ticket</a></p>`,
  },
  "domain.expiry": {
    name: "Domain expiry",
    subject: "{{domain}} expires on {{expiryDate}}",
    body: `<p>Hi {{name}},</p><p>Your domain <b>{{domain}}</b> expires on <b>{{expiryDate}}</b>. Renew it to keep your website and email working.</p>`,
  },
  "reseller.approved": {
    name: "Reseller approved",
    subject: "Your reseller account is approved",
    body: `<p>Hi {{name}},</p><p>Your reseller account <b>{{brand}}</b> has been approved. You can now order wholesale VPS and create API keys from your reseller dashboard.</p>`,
  },
  "admin.provisioning_failed": {
    name: "Admin: provisioning failed",
    subject: "[Action needed] Provisioning failed for service {{serviceId}}",
    body: `<p>Provisioning of <b>{{productName}}</b> for {{clientEmail}} failed.</p><pre style="white-space:pre-wrap">{{error}}</pre>`,
  },
  "staff.message": {
    name: "Message from staff (Send Email on the client page)",
    subject: "{{subject}}",
    body: `<p>Hi {{name}},</p>{{{messageHtml}}}`,
  },
};
