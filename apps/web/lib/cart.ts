"use client";
export interface CartItem {
  key: string;
  productId: string;
  productName: string;
  cycle: string;
  osTemplateId?: string | null;
  osName?: string;
  hostname?: string | null;
  serverId?: string | null;
  location?: string;
  ipId?: string | null;
  ipAddress?: string;
  ipExpiresAt?: string;
  config: Record<string, string | number | boolean>;
  addonIds: string[];
  quantity: number;
}
export interface CartDomain {
  name: string;
  action: "register" | "transfer";
  years: number;
  eppCode?: string;
}
export interface Cart {
  items: CartItem[];
  domains: CartDomain[];
  promoCode?: string;
}
const KEY = "cc_cart";
export function readCart(): Cart {
  try {
    return { items: [], domains: [], ...JSON.parse(localStorage.getItem(KEY) ?? "{}") };
  } catch {
    return { items: [], domains: [] };
  }
}
export function writeCart(c: Cart) {
  try {
    localStorage.setItem(KEY, JSON.stringify(c));
    window.dispatchEvent(new Event("cc-cart"));
  } catch {
    /* storage unavailable */
  }
}
export function cartCount() {
  const c = readCart();
  return c.items.length + c.domains.length;
}
export function toApiCart(c: Cart) {
  return {
    items: c.items.map(({ productId, cycle, osTemplateId, hostname, serverId, ipId, config, addonIds, quantity }) => ({ productId, cycle, osTemplateId: osTemplateId || null, hostname: hostname || null, serverId: serverId || null, ipId: ipId || null, config, addonIds, quantity })),
    domains: c.domains,
    promoCode: c.promoCode || null,
    currency: "INR",
  };
}
