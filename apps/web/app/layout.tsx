import "./globals.css";
import type { Metadata, Viewport } from "next";
import { Toaster } from "@/components/ui";

export const metadata: Metadata = {
  title: { default: "Crapplet Cloud", template: "%s | Crapplet Cloud" },
  description: "Crapplet Cloud client area — manage VPS, hosting, domains, invoices and support.",
  icons: { icon: "/Crapplet_Icon.png" },
};
export const viewport: Viewport = { width: "device-width", initialScale: 1, themeColor: "#7c3aed" };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en-IN">
      <head>
        {/* eslint-disable-next-line @next/next/no-page-custom-font */}
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
        <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800;900&display=swap" rel="stylesheet" />
        <link href="https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined:wght,FILL@100..700,0..1&display=swap" rel="stylesheet" />
      </head>
      <body className="min-h-screen">
        {children}
        <Toaster />
      </body>
    </html>
  );
}
