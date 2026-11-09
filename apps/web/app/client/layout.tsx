import { SessionProvider } from "@/lib/session";
import { SiteFooter, SiteHeader } from "@/components/site-chrome";

export default function ClientLayout({ children }: { children: React.ReactNode }) {
  return (
    <SessionProvider>
      <SiteHeader />
      <div className="min-h-[60vh]">{children}</div>
      <SiteFooter />
    </SessionProvider>
  );
}
