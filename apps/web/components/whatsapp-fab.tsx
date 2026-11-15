"use client";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";

/** Our support WhatsApp (country code + number, digits only). The website uses the same number in public-site/whatsapp.js. */
export const SUPPORT_WHATSAPP = "919039573607";

/** What the chat starts with, depending on where the customer is. */
function messageFor(path: string) {
  if (path.startsWith("/order")) return "Hi Crapplet Cloud! I need help with placing an order.";
  if (/^\/client\/invoices/.test(path)) return "Hi Crapplet Cloud! I have a question about an invoice.";
  if (/^\/client\/services/.test(path)) return "Hi Crapplet Cloud! I need help with one of my services.";
  if (/^\/client\/(login|register|forgot|reset)/.test(path)) return "Hi Crapplet Cloud! I need help signing in to my account.";
  if (path.startsWith("/client")) return "Hi Crapplet Cloud! I'm a customer and need some help.";
  return "Hi Crapplet Cloud! I have a question.";
}

/** Floating "Chat on WhatsApp" button, bottom-right. */
export function WhatsAppFab() {
  const path = usePathname() ?? "";
  const [hello, setHello] = useState(false);
  useEffect(() => {
    try {
      if (window.matchMedia("(min-width: 900px)").matches && !sessionStorage.getItem("cwa-hello")) {
        sessionStorage.setItem("cwa-hello", "1");
        const a = setTimeout(() => setHello(true), 2500);
        const b = setTimeout(() => setHello(false), 7000);
        return () => (clearTimeout(a), clearTimeout(b));
      }
    } catch {
      /* storage blocked */
    }
  }, []);
  const href = `https://wa.me/${SUPPORT_WHATSAPP}?text=${encodeURIComponent(messageFor(path))}`;
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      aria-label="Chat with Crapplet Cloud on WhatsApp"
      className="group fixed bottom-3.5 right-3.5 z-[45] flex items-center gap-2.5 [-webkit-tap-highlight-color:transparent] focus:outline-none sm:bottom-5 sm:right-5 print:hidden"
    >
      <span
        className={`order-first max-w-0 overflow-hidden whitespace-nowrap rounded-full bg-white px-0 py-0 text-sm font-bold leading-none text-ink opacity-0 shadow-[0_8px_24px_-8px_rgba(15,23,42,.3),0_0_0_1px_rgba(15,23,42,.06)] transition-all duration-300 group-hover:max-w-[220px] group-hover:px-4 group-hover:py-[11px] group-hover:opacity-100 group-focus-visible:max-w-[220px] group-focus-visible:px-4 group-focus-visible:py-[11px] group-focus-visible:opacity-100 ${hello ? "!max-w-[220px] !px-4 !py-[11px] !opacity-100" : ""}`}
      >
        Chat with us
        <small className="mt-1 block text-[11.5px] font-semibold text-green-600">Usually replies in minutes</small>
      </span>
      <span className="relative grid h-[54px] w-[54px] place-items-center rounded-full bg-[linear-gradient(145deg,#2fe474,#1ebe5b_55%,#128c4b)] shadow-[0_10px_28px_-6px_rgba(18,140,75,.55),0_2px_6px_rgba(0,0,0,.12),inset_0_1px_0_rgba(255,255,255,.35)] transition-transform duration-200 group-hover:-translate-y-0.5 group-hover:scale-[1.04] group-focus-visible:outline group-focus-visible:outline-[3px] group-focus-visible:outline-offset-[3px] group-focus-visible:outline-emerald-200 sm:h-[58px] sm:w-[58px]">
        <span className="absolute inset-0 -z-10 rounded-full bg-[#25d366] opacity-40 motion-safe:animate-ping [animation-duration:2.4s]" aria-hidden />
        <svg viewBox="0 0 32 32" aria-hidden className="h-[29px] w-[29px] fill-white drop-shadow-[0_1px_1px_rgba(0,0,0,.15)] sm:h-[31px] sm:w-[31px]">
          <path d="M16.04 3C8.86 3 3.02 8.83 3.02 16c0 2.3.6 4.53 1.74 6.5L3 29l6.68-1.74A13 13 0 0 0 16.04 29C23.2 29 29 23.17 29 16S23.2 3 16.04 3Zm0 23.8c-2 0-3.95-.54-5.65-1.55l-.4-.24-3.97 1.04 1.06-3.86-.26-.4A10.76 10.76 0 0 1 5.2 16c0-5.97 4.86-10.82 10.84-10.82 5.96 0 10.8 4.85 10.8 10.82 0 5.96-4.84 10.8-10.8 10.8Zm5.93-8.1c-.33-.16-1.93-.95-2.23-1.06-.3-.1-.52-.16-.73.17-.22.32-.84 1.05-1.03 1.27-.19.22-.38.24-.7.08-.33-.16-1.38-.5-2.62-1.6-.97-.86-1.62-1.93-1.81-2.25-.19-.33-.02-.5.14-.66.15-.15.33-.38.49-.57.16-.19.22-.33.33-.54.1-.22.05-.41-.03-.57-.08-.16-.73-1.76-1-2.41-.27-.63-.54-.55-.73-.56h-.62c-.22 0-.57.08-.87.41-.3.32-1.14 1.11-1.14 2.71s1.17 3.15 1.33 3.36c.16.22 2.3 3.5 5.56 4.91.78.34 1.39.54 1.86.69.78.25 1.5.21 2.06.13.63-.1 1.93-.79 2.2-1.55.27-.76.27-1.41.19-1.55-.08-.13-.3-.21-.62-.37Z" />
        </svg>
      </span>
    </a>
  );
}
