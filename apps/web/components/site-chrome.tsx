"use client";
import { useEffect } from "react";
import Script from "next/script";
import { SITE_FOOTER_HTML, SITE_HEADER_HTML } from "./site-markup";

/** The exact crapplet.co.in header (markup + header.css + header.js) so the client area feels like the website. */
export function SiteHeader() {
  useEffect(() => {
    // header.js binds on load; when navigating client-side it is already bound
  }, []);
  return (
    <>
      {/* eslint-disable-next-line @next/next/no-css-tags */}
      <link rel="stylesheet" href="/header.css" />
      <div dangerouslySetInnerHTML={{ __html: SITE_HEADER_HTML }} />
      <Script src="/header.js" strategy="afterInteractive" />
    </>
  );
}

export function SiteFooter() {
  return <div className="bg-white" dangerouslySetInnerHTML={{ __html: SITE_FOOTER_HTML }} />;
}
