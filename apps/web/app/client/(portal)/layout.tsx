"use client";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { useSession } from "@/lib/session";
import { api } from "@/lib/api";
import { Alert, Button, Icon, Loading, cx, toast } from "@/components/ui";

const NAV: { href: string; label: string; icon: string; exact?: boolean }[] = [
  { href: "/client", label: "Dashboard", icon: "space_dashboard", exact: true },
  { href: "/client/services", label: "My Services", icon: "dns" },
  { href: "/order", label: "Order New Services", icon: "add_shopping_cart" },
  { href: "/client/domains", label: "Domains", icon: "language" },
  { href: "/client/invoices", label: "Invoices", icon: "receipt_long" },
  { href: "/client/payments", label: "Payments", icon: "payments" },
  { href: "/client/wallet", label: "Wallet & Transactions", icon: "account_balance_wallet" },
  { href: "/client/tickets", label: "Support Tickets", icon: "support_agent" },
  { href: "/client/knowledgebase", label: "Knowledgebase", icon: "menu_book" },
  { href: "/client/downloads", label: "Downloads", icon: "download" },
  { href: "/client/affiliates", label: "Affiliates & Referrals", icon: "handshake" },
  { href: "/client/reseller", label: "VPS Reseller", icon: "storefront" },
  { href: "/client/profile", label: "Profile", icon: "person" },
  { href: "/client/security", label: "Security Settings", icon: "shield_lock" },
];

export default function PortalLayout({ children }: { children: React.ReactNode }) {
  const { me, loading, logout } = useSession();
  const router = useRouter();
  const path = usePathname();
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!loading && (!me || me.type !== "CLIENT")) router.replace(`/client/login?next=${encodeURIComponent(path)}`);
  }, [loading, me, path, router]);
  useEffect(() => setOpen(false), [path]);

  if (loading || !me || me.type !== "CLIENT") return <Loading />;

  const active = (n: (typeof NAV)[number]) => (n.exact ? path === n.href : path === n.href || path.startsWith(n.href + "/"));
  return (
    <div className="mx-auto max-w-[1280px] px-4 py-6 sm:px-6 lg:py-10">
      <div className="lg:grid lg:grid-cols-[264px_1fr] lg:gap-8">
        <aside className="mb-6 lg:mb-0">
          <div className="rounded-2xl border border-line bg-white p-4 shadow-card lg:sticky lg:top-[150px]">
            <div className="flex items-center gap-3 border-b border-line pb-4">
              <span className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-gradient-to-br from-primary to-primary-dark text-base font-extrabold text-white">
                {me.firstName[0]}
                {me.lastName?.[0] ?? ""}
              </span>
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-extrabold text-ink">
                  {me.firstName} {me.lastName}
                </div>
                <div className="truncate text-xs text-mute">{me.profile?.companyName || me.email}</div>
              </div>
              <button className="grid h-9 w-9 place-items-center rounded-lg border border-line lg:hidden" onClick={() => setOpen(!open)} aria-label="Menu">
                <Icon name={open ? "close" : "menu"} />
              </button>
            </div>
            <nav className={cx("mt-3 flex-col gap-0.5", open ? "flex" : "hidden lg:flex")}>
              {NAV.map((n) => (
                <Link
                  key={n.href}
                  href={n.href}
                  className={cx(
                    "flex items-center gap-3 rounded-xl px-3 py-2.5 text-[14px] font-semibold transition",
                    active(n) ? "bg-primary-soft text-primary-dark" : "text-slate-600 hover:bg-primary-tint hover:text-primary-dark",
                  )}
                >
                  <Icon name={n.icon} className="text-[20px]" fill={active(n)} />
                  {n.label}
                </Link>
              ))}
              <button
                onClick={async () => {
                  await logout();
                  router.replace("/client/login");
                }}
                className="mt-1 flex items-center gap-3 rounded-xl px-3 py-2.5 text-left text-[14px] font-semibold text-rose-600 hover:bg-rose-50"
              >
                <Icon name="logout" className="text-[20px]" /> Logout
              </button>
            </nav>
          </div>
        </aside>
        <main className="min-w-0 fade-up">
          {!me.emailVerified && (
            <Alert tone="warn" className="mb-5">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span>Please verify your email address — we sent a link to {me.email}.</span>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() =>
                    api("/auth/resend-verification", { body: {} })
                      .then(() => toast.success("Verification email sent"))
                      .catch((e) => toast.error(e.message))
                  }
                >
                  Resend
                </Button>
              </div>
            </Alert>
          )}
          {children}
        </main>
      </div>
    </div>
  );
}
