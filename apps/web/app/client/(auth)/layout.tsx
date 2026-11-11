import { SiteFooter, SiteHeader } from "@/components/site-chrome";

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <SiteHeader />
      <div className="min-h-[60vh]">{children}</div>
      <SiteFooter />
    </>
  );
}
