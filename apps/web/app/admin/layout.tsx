import { SessionProvider } from "@/lib/session";

export const metadata = { title: { default: "Admin", template: "%s · Crapplet Admin" }, robots: { index: false } };
export default function AdminRoot({ children }: { children: React.ReactNode }) {
  return <SessionProvider>{children}</SessionProvider>;
}
