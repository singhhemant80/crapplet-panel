import { redirect } from "next/navigation";
// The public marketing site is served as static HTML by Nginx at "/"; when running Next alone, go to the client area.
export default function Home() {
  redirect("/client");
}
