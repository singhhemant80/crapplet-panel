import { SessionProvider } from "@/lib/session";
import { SiteFooter, SiteHeader } from "@/components/site-chrome";

export const metadata = { title: "Order" };
export default function OrderLayout({ children }: { children: React.ReactNode }) {
  return (
    <SessionProvider>
      <SiteHeader />
      <div className="min-h-[60vh] bg-gradient-to-b from-[#f6f0ff] via-[#fbf9ff] to-[#fbf9ff]">{children}</div>
      <SiteFooter />
    </SessionProvider>
  );
}
