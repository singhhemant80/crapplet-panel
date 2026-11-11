/**
 * Turns low-level connection errors (undici / Node) into a message that says what to check.
 * Used by the Proxmox and Virtualizor clients so "Test connection" explains the problem.
 */
export function explainNetError(e: unknown, host: string, port: number, panel: "Virtualizor" | "Proxmox" | "WHM"): Error {
  const err = e as { code?: string; cause?: { code?: string; message?: string }; message?: string };
  const code = err?.code ?? err?.cause?.code ?? "";
  const raw = err?.message ?? String(e);
  const target = `${host}:${port}`;
  const fw =
    panel === "Virtualizor"
      ? `Check that port ${port} is open on the ${panel} server's firewall for this panel's IP (e.g. on the master: csf -a <panel IP>, or iptables/ufw allow), and that the hostname is not behind the Cloudflare proxy (orange cloud) — Cloudflare doesn't pass port ${port}; use the server's real IP instead.`
      : `Check that port ${port} is open on the ${panel} host's firewall for this panel's IP, and that the hostname is not behind the Cloudflare proxy — use the server's real IP instead.`;
  let msg: string;
  switch (code) {
    case "UND_ERR_CONNECT_TIMEOUT":
    case "ETIMEDOUT":
    case "EHOSTUNREACH":
    case "ENETUNREACH":
      msg = `Could not reach ${target} (connection timed out). ${fw}`;
      break;
    case "ECONNREFUSED":
      msg = `${target} refused the connection — nothing is listening on port ${port}. Check the port number and that the ${panel} service is running.`;
      break;
    case "ENOTFOUND":
    case "EAI_AGAIN":
      msg = `The hostname ${host} doesn't resolve (DNS lookup failed). Check the spelling or use the server's IP address.`;
      break;
    case "ECONNRESET":
    case "UND_ERR_SOCKET":
      msg = `${target} closed the connection. A firewall may be dropping it, or the port isn't serving HTTPS.`;
      break;
    case "DEPTH_ZERO_SELF_SIGNED_CERT":
    case "SELF_SIGNED_CERT_IN_CHAIN":
    case "UNABLE_TO_VERIFY_LEAF_SIGNATURE":
    case "CERT_HAS_EXPIRED":
    case "ERR_TLS_CERT_ALTNAME_INVALID":
      msg = `${target} uses an SSL certificate that can't be verified (${code}). Turn off "Verify TLS certificate" for this server, or install a valid certificate on it.`;
      break;
    default:
      return e instanceof Error ? e : new Error(raw);
  }
  const out = new Error(msg);
  (out as any).code = code;
  return out;
}
