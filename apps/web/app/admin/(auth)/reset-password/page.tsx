"use client";
import { Suspense } from "react";
import { ResetForm } from "@/components/reset-form";
import { AdminAuthCard } from "@/components/admin/auth-card";

export default function AdminReset() {
  return <AdminAuthCard title="Choose a new password"><Suspense><ResetForm loginPath="/admin/login" /></Suspense></AdminAuthCard>;
}
