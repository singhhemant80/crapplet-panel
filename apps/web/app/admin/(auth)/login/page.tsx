"use client";
import { Suspense } from "react";
import { LoginForm } from "@/components/login-form";
import { AdminAuthCard } from "@/components/admin/auth-card";

export default function AdminLogin() {
  return (
    <AdminAuthCard title="Staff sign in">
      <Suspense><LoginForm portal="admin" /></Suspense>
    </AdminAuthCard>
  );
}
