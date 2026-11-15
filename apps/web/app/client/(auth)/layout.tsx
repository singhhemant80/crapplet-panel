import { SiteFooter, SiteHeader } from "@/components/site-chrome";

/**
 * Sign-in / register / password pages. Desktop keeps the full website header and footer; phones and
 * tablets get a slim bar and a one-line footer so the form is the first thing you see.
 */
export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <div className="hidden lg:block">
        <SiteHeader />
      </div>
      <header className="sticky top-0 z-30 border-b border-[#efe7ff] bg-white/90 backdrop-blur-md lg:hidden">
        <div className="mx-auto flex h-14 max-w-2xl items-center justify-between px-4">
          <a href="/index.html" aria-label="Crapplet Cloud home" className="flex items-center">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/Crapplet_logo.png" alt="Crapplet Cloud" className="h-8 w-auto max-[360px]:h-7" />
          </a>
          <nav className="flex shrink-0 items-center gap-0.5 text-[13px] font-bold">
            <a href="/order" className="rounded-lg px-2.5 py-2 max-[400px]:hidden text-slate-600 hover:bg-primary-tint hover:text-primary-dark">Plans</a>
            <a href="/contact.html" className="rounded-lg px-2.5 py-2 text-slate-600 hover:bg-primary-tint hover:text-primary-dark">Support</a>
            <a href="/" className="inline-flex items-center gap-1 rounded-lg px-2.5 py-2 text-primary-dark hover:bg-primary-tint">
              Website
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" aria-hidden="true"><path d="M7 17 17 7M9 7h8v8" /></svg>
            </a>
          </nav>
        </div>
      </header>
      <div className="min-h-[60vh]">{children}</div>
      <div className="hidden lg:block">
        <SiteFooter />
      </div>
      <footer className="border-t border-[#f1ebff] bg-white px-4 py-5 text-center text-xs text-mute lg:hidden">
        <div className="flex flex-wrap items-center justify-center gap-x-4 gap-y-1 font-semibold">
          <a href="/terms-and-conditions.html" className="hover:text-primary-dark">Terms</a>
          <a href="/privacy-and-policy.html" className="hover:text-primary-dark">Privacy</a>
          <a href="/refund-policy.html" className="hover:text-primary-dark">Refunds</a>
          <a href="/contact.html" className="hover:text-primary-dark">Contact</a>
        </div>
        <div className="mt-2">© {new Date().getFullYear()} Crapplet Infotech Pvt. Ltd.</div>
      </footer>
    </>
  );
}
