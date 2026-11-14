/**
 * What each invoice is for: the services (and domains) its lines bill, so invoice lists can show
 * "notresquired · Colocation Single U" next to the number instead of making staff open every invoice.
 */
import { prisma } from "../../db";

export type InvoiceFor = { kind: "service" | "domain"; id: string; label: string; product?: string; status?: string };
export type InvoiceLinks = { for: InvoiceFor[]; summary: string | null };

export async function invoiceLinks(invoiceIds: string[], opts: { includeStatus?: boolean } = {}): Promise<Map<string, InvoiceLinks>> {
  const out = new Map<string, InvoiceLinks>();
  if (!invoiceIds.length) return out;
  const items = await prisma.invoiceItem.findMany({
    where: { invoiceId: { in: invoiceIds } },
    select: { invoiceId: true, type: true, relId: true, description: true },
    orderBy: { id: "asc" },
  });
  const ids = (types: string[]) => [...new Set(items.filter((i) => types.includes(i.type) && i.relId).map((i) => i.relId!))];
  const [addons, upgrades, domains] = await Promise.all([
    ids(["ADDON"]).length ? prisma.serviceAddon.findMany({ where: { id: { in: ids(["ADDON"]) } }, select: { id: true, serviceId: true } }) : [],
    ids(["UPGRADE"]).length ? prisma.serviceUpgrade.findMany({ where: { id: { in: ids(["UPGRADE"]) } }, select: { id: true, serviceId: true } }) : [],
    ids(["DOMAIN"]).length ? prisma.domain.findMany({ where: { id: { in: ids(["DOMAIN"]) } }, select: { id: true, name: true, status: true } }) : [],
  ]);
  const serviceOf = new Map<string, string>([...addons.map((a) => [a.id, a.serviceId] as const), ...upgrades.map((u) => [u.id, u.serviceId] as const)]);
  const serviceIds = [...new Set([...ids(["SERVICE", "SETUP"]), ...serviceOf.values()])];
  const services = serviceIds.length
    ? await prisma.service.findMany({ where: { id: { in: serviceIds } }, select: { id: true, hostname: true, status: true, product: { select: { name: true } } } })
    : [];
  const svc = new Map(services.map((s) => [s.id, s]));
  const dom = new Map(domains.map((d) => [d.id, d]));

  for (const id of invoiceIds) {
    const mine = items.filter((i) => i.invoiceId === id);
    const list: InvoiceFor[] = [];
    const seen = new Set<string>();
    for (const it of mine) {
      if (!it.relId) continue;
      if (it.type === "DOMAIN") {
        const d = dom.get(it.relId);
        if (d && !seen.has(`d${d.id}`)) {
          seen.add(`d${d.id}`);
          list.push({ kind: "domain", id: d.id, label: d.name, ...(opts.includeStatus ? { status: d.status } : {}) });
        }
        continue;
      }
      const sid = it.type === "SERVICE" || it.type === "SETUP" ? it.relId : it.type === "ADDON" || it.type === "UPGRADE" ? serviceOf.get(it.relId) : undefined;
      const s = sid ? svc.get(sid) : undefined;
      if (s && !seen.has(`s${s.id}`)) {
        seen.add(`s${s.id}`);
        list.push({ kind: "service", id: s.id, label: s.hostname || s.product.name, product: s.product.name, ...(opts.includeStatus ? { status: s.status } : {}) });
      }
    }
    // nothing linked (wallet top-up, a custom charge, an old import): describe it by its first line
    const first = mine.find((i) => i.type !== "PROMO" && i.type !== "LATE_FEE") ?? mine[0];
    out.set(id, { for: list, summary: list.length ? null : first ? (first.type === "WALLET" ? "Add funds" : first.description.split("\n")[0].slice(0, 80)) : null });
  }
  return out;
}

/** Adds `for` / `forSummary` to each invoice row. */
export async function withInvoiceLinks<T extends { id: string }>(rows: T[], opts: { includeStatus?: boolean } = {}) {
  const links = await invoiceLinks(rows.map((r) => r.id), opts);
  return rows.map((r) => ({ ...r, for: links.get(r.id)?.for ?? [], forSummary: links.get(r.id)?.summary ?? null }));
}
