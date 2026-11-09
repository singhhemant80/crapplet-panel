"use client";
import { useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { api } from "@/lib/api";
import { Alert, Button, Field, Input } from "./ui";

export function ResetForm({ loginPath }: { loginPath: string }) {
  const sp = useSearchParams();
  const router = useRouter();
  const [pw, setPw] = useState("");
  const [pw2, setPw2] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <form
      className="space-y-4"
      onSubmit={async (e) => {
        e.preventDefault();
        if (pw !== pw2) return setError("Passwords do not match");
        setBusy(true);
        try {
          await api("/auth/reset-password", { body: { token: sp.get("token"), password: pw } });
          router.replace(`${loginPath}?reset=1`);
        } catch (e: any) {
          setError(e.message);
        } finally {
          setBusy(false);
        }
      }}
    >
      {error && <Alert tone="error">{error}</Alert>}
      <Field label="New password" hint="At least 8 characters.">
        <Input type="password" minLength={8} required value={pw} onChange={(e) => setPw(e.target.value)} autoComplete="new-password" />
      </Field>
      <Field label="Confirm new password">
        <Input type="password" required value={pw2} onChange={(e) => setPw2(e.target.value)} autoComplete="new-password" />
      </Field>
      <Button type="submit" size="lg" className="w-full" loading={busy} icon="key">
        Update password
      </Button>
    </form>
  );
}
