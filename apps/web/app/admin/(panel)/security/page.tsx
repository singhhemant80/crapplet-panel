"use client";
import { PageHeader } from "@/components/ui";
import { SecurityPanel } from "@/components/security-panel";

export default function AdminSecurity() {
  return (
    <>
      <PageHeader title="My security" subtitle="Staff accounts should always have two-factor authentication enabled." />
      <SecurityPanel />
    </>
  );
}
