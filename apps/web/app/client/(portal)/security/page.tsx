"use client";
import { PageHeader } from "@/components/ui";
import { SecurityPanel } from "@/components/security-panel";

export default function Security() {
  return (
    <>
      <PageHeader title="Security Settings" subtitle="Password, two-factor authentication, sessions and sign-in history." />
      <SecurityPanel />
    </>
  );
}
