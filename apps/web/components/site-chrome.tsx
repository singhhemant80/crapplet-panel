"use client";
import { useEffect } from "react";
import Script from "next/script";
import { SITE_FOOTER_HTML, SITE_HEADER_HTML } from "./site-markup";

/** The exact crapplet.co.in header (markup + header.css + header.js) so the client area feels like the website. */
export function SiteHeader() {
  useEffect(() => {
    // header.js is loaded once; each client-side navigation renders a fresh <header>, so bind it again
    (window as unknown as { crappletHeaderInit?: () => void }).crappletHeaderInit?.();
  });
  return (
    <>
      {/* eslint-disable-next-line @next/next/no-css-tags */}
      <link rel="stylesheet" href="/header.css" />
      <div dangerouslySetInnerHTML={{ __html: SITE_HEADER_HTML }} />
      <Script src="/header.js?v=3" strategy="afterInteractive" onLoad={() => (window as unknown as { crappletHeaderInit?: () => void }).crappletHeaderInit?.()} />
    </>
  );
}

export function SiteFooter() {
  return <div className="bg-white" dangerouslySetInnerHTML={{ __html: SITE_FOOTER_HTML }} />;
}
