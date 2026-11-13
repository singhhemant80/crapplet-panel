"use client";
import { Suspense } from "react";
import { LoginForm } from "@/components/login-form";
import { AdminAuthCard } from "@/components/admin/auth-card";

export default function AdminLogin() {
  return (
    <AdminAuthCard title="Welcome back" subtitle="Sign in to manage customers, servers and billing.">
      <Suspense><LoginForm portal="admin" /></Suspense>
    </AdminAuthCard>
  );
}
