"use client";
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { api } from "./api";

export interface Me {
  id: string;
  type: "CLIENT" | "STAFF";
  email: string;
  firstName: string;
  lastName: string;
  phone: string | null;
  emailVerified: boolean;
  totpEnabled: boolean;
  /** offers & news emails (campaigns) */
  marketingEmails?: boolean;
  role: { name: string; permissions: string[] } | null;
  profile: any;
  reseller: { id: string; status: string; brandName: string } | null;
  affiliate: { code: string } | null;
  /** set when a staff member opened this client session with "Login as client" */
  impersonatedBy?: { name: string } | null;
}

const Ctx = createContext<{ me: Me | null; loading: boolean; reload: () => Promise<void>; logout: () => Promise<void> }>({ me: null, loading: true, reload: async () => {}, logout: async () => {} });

export function SessionProvider({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<Me | null>(null);
  const [loading, setLoading] = useState(true);
  const reload = useCallback(async () => {
    try {
      const r = await api<{ user: Me }>("/auth/me");
      setMe(r.user);
    } catch {
      setMe(null);
    } finally {
      setLoading(false);
    }
  }, []);
  const logout = useCallback(async () => {
    await api("/auth/logout", { method: "POST", body: {} }).catch(() => {});
    setMe(null);
  }, []);
  useEffect(() => {
    reload();
  }, [reload]);
  return <Ctx.Provider value={{ me, loading, reload, logout }}>{children}</Ctx.Provider>;
}
export const useSession = () => useContext(Ctx);

export function can(me: Me | null, perm: string) {
  if (!me || me.type !== "STAFF") return false;
  const p = me.role?.permissions ?? [];
  return p.includes("*") || p.includes(perm) || (perm.endsWith(".view") && p.includes(perm.replace(".view", ".manage")));
}
