"use client";
import Link from "next/link";
import { useState } from "react";
import { api } from "@/lib/api";
import { AuthShell } from "@/components/auth-shell";
import { Alert, Button, Field, Input } from "@/components/ui";

export default function ForgotPage() {
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <AuthShell title="Reset your password" subtitle="We'll email you a secure link to choose a new password.">
      {sent ? (
        <Alert tone="success">If an account exists for {email}, a reset link is on its way. It expires in 60 minutes.</Alert>
      ) : (
        <form
          className="space-y-4"
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            try {
              await api("/auth/forgot-password", { body: { email } });
              setSent(true);
            } catch (e: any) {
              setError(e.message);
            } finally {
              setBusy(false);
            }
          }}
        >
          {error && <Alert tone="error">{error}</Alert>}
          <Field label="Email address">
            <Input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
          </Field>
          <Button type="submit" size="lg" className="w-full" loading={busy} icon="mail">
            Send reset link
          </Button>
        </form>
      )}
      <p className="mt-5 text-center text-sm">
        <Link href="/client/login" className="font-bold text-primary-dark hover:underline">
          Back to sign in
        </Link>
      </p>
    </AuthShell>
  );
}
