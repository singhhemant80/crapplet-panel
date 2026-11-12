/** Starting points for a new email campaign. {{firstName}} etc. are filled in per customer when sending. */
export const CTA = (text: string, href: string) =>
  `<p style="margin:22px 0"><a href="${href}" style="display:inline-block;background:#7c3aed;color:#ffffff;padding:12px 24px;border-radius:10px;font-weight:700;text-decoration:none">${text}</a></p>`;

export const VARIABLES: [string, string][] = [
  ["{{firstName}}", "First name"],
  ["{{name}}", "Full name"],
  ["{{companyName}}", "Customer's company"],
  ["{{email}}", "Email address"],
  ["{{company.brand}}", "Your brand name"],
  ["{{appUrl}}", "Your panel address"],
];

export type Starter = { key: string; label: string; icon: string; blurb: string; kind: "OFFER" | "INFO"; name: string; subject: string; preheader: string; body: string };

export const STARTERS: Starter[] = [
  {
    key: "offer",
    label: "Offer / discount",
    icon: "sell",
    blurb: "A promo code or sale — only to customers who accept offers.",
    kind: "OFFER",
    name: "Festive offer",
    subject: "{{firstName}}, 25% off your next server",
    preheader: "Use code FESTIVE25 at checkout — this week only.",
    body: `<h2 style="margin:0 0 12px;font-size:22px;color:#1e0b4b">25% off this week</h2>
<p>Hi {{firstName}},</p>
<p>Thank you for hosting with {{company.brand}}. For a limited time, get <b>25% off</b> the first invoice of any new VPS, dedicated server or hosting plan.</p>
<p style="margin:18px 0;padding:14px 18px;border:2px dashed #c4b5fd;border-radius:12px;background:#faf7ff;font-size:18px;font-weight:800;letter-spacing:2px;text-align:center;color:#5b21b6">FESTIVE25</p>
${CTA("Claim your discount", "{{appUrl}}/order")}
<p style="color:#64748b;font-size:13px">Valid until Sunday. Can't be combined with other offers.</p>`,
  },
  {
    key: "news",
    label: "News / new product",
    icon: "campaign",
    blurb: "Launches, new locations and features worth knowing about.",
    kind: "OFFER",
    name: "Product news",
    subject: "New at {{company.brand}}: Mumbai data centre coming soon",
    preheader: "Lower latency for customers across West India.",
    body: `<h2 style="margin:0 0 12px;font-size:22px;color:#1e0b4b">We're expanding to Mumbai</h2>
<p>Hi {{firstName}},</p>
<p>Alongside our Tier III data centre in Noida, we're opening a new location in <b>Mumbai</b>. You'll be able to choose it for new servers as soon as it's live.</p>
<ul>
  <li>Lower latency for West and South India</li>
  <li>Same panel, same support, same pricing</li>
  <li>Easy migration for existing servers</li>
</ul>
${CTA("See our plans", "{{appUrl}}/order")}
<p>— Team {{company.brand}}</p>`,
  },
  {
    key: "maintenance",
    label: "Maintenance notice",
    icon: "construction",
    blurb: "Planned work or service information — goes to everyone you choose.",
    kind: "INFO",
    name: "Scheduled maintenance",
    subject: "Scheduled maintenance on Saturday, 2:00–4:00 AM IST",
    preheader: "A short network upgrade — most services won't notice.",
    body: `<h2 style="margin:0 0 12px;font-size:22px;color:#1e0b4b">Scheduled maintenance</h2>
<p>Hi {{firstName}},</p>
<p>We'll be upgrading network equipment in our Noida data centre:</p>
<p style="margin:16px 0;padding:14px 18px;border-radius:12px;background:#f1f5f9"><b>When:</b> Saturday, 2:00 AM – 4:00 AM IST<br><b>Expected impact:</b> up to 5 minutes of network interruption</p>
<p>No action is needed from you. If you have questions, just reply to this email or open a ticket.</p>
${CTA("Open your client area", "{{appUrl}}/client")}
<p>— Team {{company.brand}}</p>`,
  },
  {
    key: "blank",
    label: "Start from scratch",
    icon: "edit_note",
    blurb: "An empty email.",
    kind: "OFFER",
    name: "New campaign",
    subject: "",
    preheader: "",
    body: `<p>Hi {{firstName}},</p>
<p></p>`,
  },
];
