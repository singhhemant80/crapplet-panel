/**
 * Turns a raw setup error (Virtualizor, Proxmox, WHM, registrar, network, our own checks) into:
 * what went wrong, why, and what to do — for staff — plus a calm line for the customer.
 * Works on stored log messages, so failures from before this existed are explained too.
 */
export type FailureCategory =
  | "connection" | "login" | "setup" | "capacity" | "os" | "ip" | "exists" | "input" | "timeout" | "stopped" | "busy" | "remote" | "unknown";

export type Explained = {
  category: FailureCategory;
  /** short headline, e.g. "Couldn't connect to the Virtualizor master" */
  title: string;
  /** why it failed, in plain words */
  cause: string;
  /** what staff should do next */
  fix: string;
  /** where to fix it */
  link?: { label: string; href: string };
  /** for the customer — never technical */
  customer: string;
  /** the original message, for support */
  raw: string;
};

type Ctx = { provisioner?: string | null; productId?: string | null; productName?: string | null; serverId?: string | null; serverName?: string | null; serviceId?: string | null; kind?: "service" | "domain" };

const CUSTOMER_DEFAULT = "We couldn't finish setting this up automatically. Our team has been alerted and will complete it for you — there's nothing you need to do.";

/** "Virtualizor addvs: {"hostname":"Invalid hostname","osid":"Invalid OS"}" → "Invalid hostname; Invalid OS" */
function remoteReasons(raw: string): string | null {
  const m = raw.match(/^(?:Virtualizor \w+|WHM \w+):\s*(.+)$/s);
  if (!m) {
    const px = raw.match(/^Proxmox \w+ \S+ failed \((\d+)\):\s*(.+)$/s);
    return px ? px[2].trim() : null;
  }
  const body = m[1].trim();
  try {
    const j = JSON.parse(body);
    const vals = Array.isArray(j) ? j : Object.values(j as object);
    const flat = vals.map((v) => (typeof v === "string" ? v : JSON.stringify(v))).filter(Boolean);
    return flat.length ? flat.join("; ") : body;
  } catch {
    return body;
  }
}

const SYSTEM: Record<string, string> = { VIRTUALIZOR: "Virtualizor master", PROXMOX: "Proxmox server", CPANEL: "cPanel/WHM server" };

export function explainProvisionError(rawIn: string | null | undefined, ctx: Ctx = {}): Explained {
  const raw = (rawIn ?? "").trim() || "Unknown error";
  const sys = SYSTEM[ctx.provisioner ?? ""] ?? (ctx.kind === "domain" ? "domain registrar" : "server");
  const server = ctx.serverName ? `“${ctx.serverName}”` : `the ${sys}`;
  const servers = { label: ctx.serverName ? `Servers → ${ctx.serverName}` : "Infrastructure → Servers", href: "/admin/servers" };
  const product = ctx.productId ? { label: `Products → ${ctx.productName ?? "this plan"}`, href: `/admin/products/${ctx.productId}` } : { label: "Products", href: "/admin/products" };
  const out = (category: FailureCategory, title: string, cause: string, fix: string, link?: Explained["link"], customer = CUSTOMER_DEFAULT): Explained => ({ category, title, cause, fix, link, customer, raw });
  const t = raw;

  // ── can't reach the server ──
  if (/Could not reach|refused the connection|doesn't resolve|DNS lookup failed|ECONNREFUSED|ETIMEDOUT|EHOSTUNREACH|ENOTFOUND|ECONNRESET|socket hang up|certificate|self[- ]signed|UND_ERR/i.test(t))
    return out("connection", `Couldn't connect to ${server}`, t.replace(/^.*?(Could not reach|refused|The hostname)/, "$1"), `Check the server's hostname/IP and port under ${servers.label}, make sure its firewall allows this panel's IP, then click Test connection and Retry.`, servers);

  // ── credentials ──
  if (/rejected the API login|refused the API token|HTTP 40[13]\b|\(40[13]\)|authentication failed|invalid (api )?(key|token|credentials|username or password)|permission denied|not authori[sz]ed|access denied/i.test(t))
    return out("login", `${server[0].toUpperCase()}${server.slice(1)} rejected our login`, remoteReasons(t) ?? t, `Update the API credentials under ${servers.label} → Edit (and allow this panel's IP if the API key is IP-restricted), click Test connection, then Retry.`, servers);

  // ── the plan / server isn't set up for this ──
  if (/No enabled .*server|has no WHM package|Choose the WHM package|has no Proxmox KVM template|has no LXC template|OS template has no Virtualizor OS id|OS has no Virtualizor id|no gateway configured|fixed Virtualizor node but none|No operating system selected|isn't a valid domain|has no server ticked/i.test(t)) {
    const os = /operating system|OS template|LXC template|KVM template/i.test(t);
    return out("setup", os ? "The operating system isn't set up for this server" : /domain/i.test(t) ? "The domain on the order isn't valid" : "The plan isn't fully set up", t, /domain/i.test(t) ? "Correct the domain under Billing & overrides on this service, then Retry." : os ? "Choose another OS under Billing & overrides, or fix the OS template under OS Templates, then Retry." : `Complete the plan's provisioning settings under ${product.label}, then Retry.`, /domain/i.test(t) ? undefined : os ? { label: "OS Templates", href: "/admin/os-templates" } : product);
  }

  // ── OS missing on the target ──
  if (/isn't available on|isn't among the OS templates|No OS templates have been synced|Invalid OS|\bosid\b/i.test(t))
    return out("os", "That operating system isn't available on the server", remoteReasons(t) ?? t, "Pick an OS this server has (Billing & overrides → Operating system), or add it in the panel and sync OS templates. Then Retry.", { label: "OS Templates", href: "/admin/os-templates" });

  // ── IPs ──
  if (/no free IPs?|IPs? (are )?(exhausted|not available)|no (more )?IP|ip ?pool|not enough IP|ips?.*(full|used up)/i.test(t))
    return out("ip", "No free IP addresses", remoteReasons(t) ?? t, `Add IPs to the pool for this location (Virtualizor IP Pools, or IP Management here), then Retry.`, { label: "IP Management", href: "/admin/ips" });

  // ── capacity ──
  if (/capacity|is full|Max services reached|under the limits|not enough (free )?(disk|space|ram|memory)|no_space|no_storage|storage|insufficient (resources|memory|disk)|out of (memory|disk)/i.test(t))
    return out("capacity", "No server has room for it", remoteReasons(t) ?? t, "Free up or add capacity (or raise the limits on the server), check Node Monitoring, then Retry.", { label: "Node Monitoring", href: "/admin/monitoring" });

  // ── already exists ──
  if (/already exists|already hosted|already taken|is taken|in use by another|duplicate|exists on/i.test(t))
    return out("exists", "Something with that name already exists", remoteReasons(t) ?? t, ctx.provisioner === "CPANEL" ? "Use another domain for this order (Billing & overrides), or remove the old account in WHM, then Retry." : "Change the hostname under Billing & overrides (or remove the old one on the server), then Retry.");

  // ── bad input refused by the server ──
  if (/invalid|not valid|must be|required|missing/i.test(t) && /^(Virtualizor|WHM|Proxmox)/.test(t))
    return out("input", `${server[0].toUpperCase()}${server.slice(1)} refused the details we sent`, remoteReasons(t) ?? t, "Correct the value it names (hostname, plan, OS, password) under Billing & overrides or on the plan, then Retry.", product);

  // ── slow / no answer ──
  if (/didn't answer|timed out|timeout|Task timed out|taking longer/i.test(t))
    return out("timeout", `${server[0].toUpperCase()}${server.slice(1)} didn't answer in time`, remoteReasons(t) ?? t, "Check the server's own panel to see whether it was created. If it was, enter its id under Billing & overrides and Retry; otherwise just Retry.", servers);

  // ── stopped ──
  if (/stopped without finishing|stopped more than a day|worker/i.test(t))
    return out("stopped", "Setup stopped before finishing", t, "Click Retry provisioning. If it keeps stopping, restart the background worker on the server (sudo -u crapplet pm2 restart all).");
  if (/Another operation is already running/i.test(t)) return out("busy", "Another action was still running", t, "Wait a minute and Retry — only one action runs per service at a time.");

  // ── the server said no, for its own reasons ──
  const remote = remoteReasons(t);
  if (remote) return out("remote", `${server[0].toUpperCase()}${server.slice(1)} refused the request`, remote, "Fix what it says (often a plan, storage or limit setting on the server), then Retry. The full message is below.", servers);

  return out("unknown", "Setup failed", t, "Check the activity log on this service for details, fix the cause, then Retry provisioning.");
}
