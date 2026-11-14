import { prisma, type InvoiceItemType } from "../../db";
import { badRequest, conflict } from "../../lib/http";
import { nextSequence } from "../../lib/sequence";
import { addCycle, addMonths, formatMoney, CYCLE_MONTHS } from "../../lib/money";
import { encrypt } from "../../lib/crypto";
import { createInvoice, invoiceLabel, type NewInvoiceItem, applyCreditToInvoice } from "../billing/invoices";
import { attachReservationToOrder } from "../ipam/service";
import { queueEmail } from "../email/mailer";
import { enqueueProvision } from "../../jobs/queues";
import { priceCart, type Cart } from "./pricing";
import { DOMAIN_RE, HOSTING_TYPES, coloSpecs, isColoProduct, isHostingProduct, isVpsProduct } from "../../lib/product-kind";

export async function checkout(args: { userId: string; cart: Cart; ip?: string; notes?: string; useCredit?: boolean; resellerId?: string | null; wholesaleDiscountPct?: number | null; extraConfig?: Record<string, unknown>; staff?: boolean }) {
  const ownerId = args.userId;
  if (!args.cart.items.length && !args.cart.domains.length) throw badRequest("Your cart is empty");

  const result = await prisma.$transaction(
    async (tx) => {
      const priced = await priceCart(args.cart, { userId: ownerId, db: tx, wholesale: args.resellerId ? { discountPct: args.wholesaleDiscountPct ?? 0 } : null });
      const orderNo = await nextSequence("order", tx);
      const order = await tx.order.create({
        data: {
          number: `ORD-${String(orderNo).padStart(6, "0")}`,
          userId: ownerId,
          currency: priced.currency,
          total: priced.tax.total,
          promoCode: priced.promo?.code,
          ip: args.ip,
          notes: args.notes,
          resellerId: args.resellerId ?? null,
        },
      });
      if (priced.promo) await tx.promoCode.update({ where: { code: priced.promo.code }, data: { uses: { increment: 1 } } });

      const invItems: NewInvoiceItem[] = [];
      const serviceIds: string[] = [];
      for (const [idx, item] of args.cart.items.entries()) {
        const p = priced.products[idx];
        const productLine = priced.lines.find((l) => l.kind === "product" && l.itemIndex === idx)!;
        // staff can still place an order for a plan marked out of stock (e.g. a reserved server)
        if (p.outOfStock && !args.staff) throw conflict(`${p.name} is out of stock right now`);
        if (p.stockControl) {
          const r = await tx.product.updateMany({ where: { id: p.id, stockQty: { gte: item.quantity } }, data: { stockQty: { decrement: item.quantity } } });
          if (!r.count) throw conflict(`${p.name} is out of stock`);
        }
        const isVps = isVpsProduct(p);
        if (isVps && !item.osTemplateId && p.osTemplates.length) throw badRequest(`Please choose an operating system for ${p.name}`);
        if (isColoProduct(p) && item.equipment) {
          const max = coloSpecs(p.moduleConfig).rackUnits;
          if (max && item.equipment.units > max) throw badRequest(`${p.name} includes ${max}U of rack space — your equipment is ${item.equipment.units}U. Choose a bigger plan or contact sales.`);
        }
        if (item.ipId && (!p.allowIpSelection || p.provisioner === "VIRTUALIZOR")) throw badRequest(`${p.name} does not support choosing an IP address — IPs are assigned by Virtualizor`);
        if (item.ipId && item.quantity > 1) throw badRequest("A selected IP can only be used for a single server");
        if (isHostingProduct(p)) {
          // hosting is ordered for a domain (WHMCS: "Choose a domain")
          const d = (item.hostname ?? "").trim().toLowerCase();
          if (!DOMAIN_RE.test(d)) throw badRequest(`Choose the domain for ${p.name} (e.g. example.com)`);
          if (item.quantity > 1) throw badRequest(`Order ${p.name} once per domain`);
          if (args.cart.items.some((x, i) => i !== idx && (x.hostname ?? "").toLowerCase() === d && priced.products[i] && isHostingProduct(priced.products[i]))) throw badRequest(`${d} is in your cart twice — one hosting plan per domain`);
          const taken = await tx.service.findFirst({ where: { hostname: d, OR: [{ product: { provisioner: "CPANEL" } }, { product: { type: { in: [...HOSTING_TYPES] } } }], status: { in: ["PENDING", "PROVISIONING", "ACTIVE", "SUSPENDED"] } }, select: { id: true } });
          if (taken) throw conflict(`${d} already has a hosting account with us`);
        }

        for (let q = 0; q < item.quantity; q++) {
          let serverId = item.serverId ?? null;
          if (item.ipId && q === 0) {
            const ip = await attachReservationToOrder(tx, { ipId: item.ipId, userId: args.userId, orderId: order.id });
            if (!p.servers.some((s) => s.serverId === ip.serverId)) throw badRequest("The selected IP does not belong to a location that offers this plan");
            serverId = ip.serverId;
          }
          if (serverId && !p.servers.some((s) => s.serverId === serverId)) throw badRequest("Invalid location for this plan");
          const per = Math.round(productLine.amount / item.quantity);
          const perRecurring = Math.round(productLine.recurring / item.quantity);
          const svc = await tx.service.create({
            data: {
              userId: ownerId,
              orderId: order.id,
              productId: p.id,
              serverId,
              billingCycle: item.cycle,
              currency: priced.currency,
              firstAmount: per,
              recurringAmount: perRecurring,
              hostname: item.hostname ?? null,
              osTemplateId: item.osTemplateId ?? null,
              // root password chosen at order time (encrypted); empty = generated at setup
              passwordEnc: isVps && item.rootPassword ? encrypt(item.rootPassword) : null,
              virtType: p.virtType,
              config: { ...item.config, ...(args.extraConfig ?? {}), requestedIpId: q === 0 ? item.ipId ?? null : null, ...(isColoProduct(p) && item.equipment ? { equipment: item.equipment } : {}) },
              resellerId: args.resellerId ?? null,
            },
          });
          serviceIds.push(svc.id);
          const start = new Date();
          invItems.push({
            type: "SERVICE",
            relId: svc.id,
            description: productLine.description.replace(/\n/g, " · "),
            hsnSac: p.hsnSac,
            unitPrice: per,
            taxable: p.taxable,
            periodStart: null,
            periodEnd: item.cycle === "ONETIME" ? null : addCycle(start, item.cycle),
          });
          for (const l of priced.lines.filter((x) => x.itemIndex === idx && (x.kind === "setup" || x.kind === "addon"))) {
            if (l.kind === "addon" && l.addonId) {
              const sa = await tx.serviceAddon.create({ data: { serviceId: svc.id, addonId: l.addonId, recurringAmount: Math.round(l.recurring / item.quantity), status: "PENDING" } });
              invItems.push({ type: "ADDON", relId: sa.id, description: l.description, unitPrice: Math.round(l.amount / item.quantity), taxable: l.taxable });
            } else invItems.push({ type: "SETUP", relId: svc.id, description: l.description, hsnSac: l.hsnSac, unitPrice: Math.round(l.amount / item.quantity), taxable: l.taxable });
          }
        }
      }

      for (const [idx, d] of args.cart.domains.entries()) {
        const line = priced.lines.find((l) => l.kind === "domain" && l.domainIndex === idx)!;
        const taken = await tx.domain.findUnique({ where: { name: d.name } });
        if (taken && taken.status !== "CANCELLED" && taken.status !== "TRANSFERRED_AWAY") throw conflict(`${d.name} is already registered with us`);
        if (taken) await tx.domain.delete({ where: { id: taken.id } });
        const dom = await tx.domain.create({
          data: {
            userId: ownerId,
            orderId: order.id,
            name: d.name,
            action: d.action,
            years: d.years,
            status: d.action === "transfer" ? "PENDING_TRANSFER" : "PENDING",
            recurringAmount: line.recurring,
            currency: priced.currency,
            nameservers: ["ns1.crapplet.co.in", "ns2.crapplet.co.in"],
            eppCodeEnc: d.eppCode ? encrypt(d.eppCode) : null,
          },
        });
        invItems.push({ type: "DOMAIN", relId: dom.id, description: line.description, hsnSac: line.hsnSac, unitPrice: line.amount, periodEnd: addMonths(new Date(), d.years * 12) });
      }

      const promo = priced.lines.find((l) => l.kind === "promo");
      if (promo) invItems.push({ type: "PROMO" as InvoiceItemType, description: promo.description, unitPrice: promo.amount, taxable: true });

      const invoice = await createInvoice(tx, { userId: ownerId, items: invItems, currency: priced.currency });
      await tx.order.update({ where: { id: order.id }, data: { invoiceId: invoice.id, total: invoice.total } });
      return { order, invoice, serviceIds };
    },
    { timeout: 20_000 },
  );

  const user = await prisma.user.findUniqueOrThrow({ where: { id: ownerId } });
  await queueEmail(
    "order.confirmation",
    user.email,
    { name: user.firstName, orderNumber: result.order.number, invoiceNumber: invoiceLabel(result.invoice), invoiceId: result.invoice.id, total: formatMoney(result.invoice.total, result.invoice.currency) },
    user.id,
  );

  // ON_ORDER products (e.g. free trials) are provisioned immediately; everything else waits for verified payment
  const svcs = await prisma.service.findMany({ where: { id: { in: result.serviceIds } }, include: { product: true } });
  for (const s of svcs) if (s.product.autoSetup === "ON_ORDER") await enqueueProvision({ serviceId: s.id, action: "create" });

  let paid = result.invoice.status === "PAID";
  if (result.invoice.status === "PAID") {
    const { onInvoicePaid } = await import("../billing/hooks");
    await onInvoicePaid(result.invoice.id);
  } else if (args.useCredit) {
    const prof = await prisma.clientProfile.findUnique({ where: { userId: ownerId } });
    if (prof && prof.creditBalance > 0) paid = (await applyCreditToInvoice(ownerId, result.invoice.id)).paid;
  }
  return { orderId: result.order.id, orderNumber: result.order.number, invoiceId: result.invoice.id, total: result.invoice.total, paid };
}

export { CYCLE_MONTHS };
