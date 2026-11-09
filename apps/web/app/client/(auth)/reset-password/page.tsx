"use client";
import { Suspense } from "react";
import { AuthShell } from "@/components/auth-shell";
import { ResetForm } from "@/components/reset-form";

export default function ResetPage() {
  return (
    <AuthShell title="Choose a new password">
      <Suspense>
        <ResetForm loginPath="/client/login" />
      </Suspense>
    </AuthShell>
  );
}
