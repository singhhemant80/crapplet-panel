import { SessionProvider } from "@/lib/session";

/** Sign-in pages get the website header/footer ((auth)/layout); the portal has its own app shell. */
export default function ClientLayout({ children }: { children: React.ReactNode }) {
  return <SessionProvider>{children}</SessionProvider>;
}
