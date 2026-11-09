"use client";
import Link from "next/link";
import { Suspense, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { api } from "@/lib/api";
import { AuthShell } from "@/components/auth-shell";
import { Alert, Loading } from "@/components/ui";

function Verify() {
  const sp = useSearchParams();
  const [state, setState] = useState<"busy" | "ok" | string>("busy");
  useEffect(() => {
    api("/auth/verify-email", { body: { token: sp.get("token") } })
      .then(() => setState("ok"))
      .catch((e) => setState(e.message));
  }, [sp]);
  if (state === "busy") return <Loading label="Verifying…" />;
  return (
    <div className="space-y-4">
      {state === "ok" ? <Alert tone="success">Your email address is verified. Thank you!</Alert> : <Alert tone="error">{state}</Alert>}
      <Link href="/client" className="block text-center text-sm font-bold text-primary-dark hover:underline">
        Go to your dashboard
      </Link>
    </div>
  );
}
export default function VerifyPage() {
  return (
    <AuthShell title="Email verification">
      <Suspense>
        <Verify />
      </Suspense>
    </AuthShell>
  );
}
