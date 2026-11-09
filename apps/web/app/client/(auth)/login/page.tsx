"use client";
import { Suspense } from "react";
import { AuthShell } from "@/components/auth-shell";
import { LoginForm } from "@/components/login-form";

export default function LoginPage() {
  return (
    <AuthShell eyebrow="Welcome back" title="Sign in to Crapplet Cloud" subtitle="Manage your servers, pay invoices and talk to our 24/7 team.">
      <Suspense>
        <LoginForm />
      </Suspense>
    </AuthShell>
  );
}
