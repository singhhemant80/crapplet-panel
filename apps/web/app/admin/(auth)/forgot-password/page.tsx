"use client";
import Link from "next/link";
import { useState } from "react";
import { api } from "@/lib/api";
import { AdminAuthCard } from "@/components/admin/auth-card";
import { Alert, Button, Field, Input } from "@/components/ui";

export default function AdminForgot() {
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  return (
    <AdminAuthCard title="Reset password">
      {sent ? <Alert tone="success">If that staff account exists, a reset link has been emailed.</Alert> : (
        <form className="space-y-4" onSubmit={async (e) => { e.preventDefault(); await api("/auth/forgot-password", { body: { email } }).catch(() => {}); setSent(true); }}>
          <Field label="Email"><Input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} /></Field>
          <Button type="submit" className="w-full">Send reset link</Button>
        </form>
      )}
      <Link href="/admin/login" className="mt-4 block text-center text-sm font-bold text-primary-dark">Back to sign in</Link>
    </AdminAuthCard>
  );
}
