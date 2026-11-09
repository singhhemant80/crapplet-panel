"use client";
import { useState } from "react";
import { api, date } from "@/lib/api";
import { useSession } from "@/lib/session";
import { Alert, Badge, Button, Card, Field, Input, Table, Td, toast, useApi } from "@/components/ui";

export function SecurityPanel() {
  const { me, reload } = useSession();
  const sessions = useApi("/auth/sessions");
  const history = useApi("/auth/login-history");
  const [pw, setPw] = useState({ currentPassword: "", newPassword: "" });
  const [setup, setSetup] = useState<{ qr: string; secret: string } | null>(null);
  const [code, setCode] = useState("");
  const [disable, setDisable] = useState({ password: "", code: "" });
  return (
    <div className="space-y-6">
      <div className="grid gap-6 lg:grid-cols-2">
        <Card title="Change password">
          <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); api("/auth/change-password", { body: pw }).then(() => { toast.success("Password changed — other sessions were signed out"); setPw({ currentPassword: "", newPassword: "" }); }).catch((e) => toast.error(e.message)); }}>
            <Field label="Current password"><Input type="password" required value={pw.currentPassword} onChange={(e) => setPw({ ...pw, currentPassword: e.target.value })} /></Field>
            <Field label="New password" hint="At least 8 characters."><Input type="password" minLength={8} required value={pw.newPassword} onChange={(e) => setPw({ ...pw, newPassword: e.target.value })} /></Field>
            <Button type="submit" icon="key">Update password</Button>
          </form>
        </Card>
        <Card title={<span className="flex items-center gap-2">Two-factor authentication {me?.totpEnabled ? <Badge status="ACTIVE">on</Badge> : <Badge>off</Badge>}</span>}>
          {me?.totpEnabled ? (
            <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); api("/auth/2fa/disable", { body: disable }).then(() => { toast.success("2FA disabled"); reload(); }).catch((e) => toast.error(e.message)); }}>
              <Alert tone="success">Your account is protected with an authenticator app.</Alert>
              <Field label="Password"><Input type="password" value={disable.password} onChange={(e) => setDisable({ ...disable, password: e.target.value })} /></Field>
              <Field label="Current code"><Input inputMode="numeric" maxLength={6} value={disable.code} onChange={(e) => setDisable({ ...disable, code: e.target.value })} /></Field>
              <Button type="submit" variant="danger">Disable 2FA</Button>
            </form>
          ) : setup ? (
            <div className="space-y-3">
              <p className="text-sm text-mute">Scan with Google Authenticator, Authy or 1Password, then enter the 6-digit code.</p>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={setup.qr} alt="2FA QR code" className="h-44 w-44 rounded-xl border border-line" />
              <p className="break-all font-mono text-xs text-mute">{setup.secret}</p>
              <Field label="Code"><Input inputMode="numeric" maxLength={6} value={code} onChange={(e) => setCode(e.target.value)} /></Field>
              <Button onClick={() => api("/auth/2fa/enable", { body: { code } }).then(() => { toast.success("Two-factor authentication enabled"); setSetup(null); reload(); }).catch((e) => toast.error(e.message))}>Verify &amp; enable</Button>
            </div>
          ) : (
            <div className="space-y-3">
              <p className="text-sm text-mute">Add a second step at sign-in using a time-based code from your phone.</p>
              <Button icon="qr_code_2" onClick={() => api("/auth/2fa/setup", { body: {} }).then(setSetup).catch((e) => toast.error(e.message))}>Set up 2FA</Button>
            </div>
          )}
        </Card>
      </div>
      <Card title="Active sessions" action={<Button size="sm" variant="outline" onClick={() => api("/auth/sessions/revoke-others", { body: {} }).then(() => { toast.success("Other sessions signed out"); sessions.reload(); })}>Sign out other sessions</Button>} pad={false}>
        <Table head={["Device", "IP", "Signed in", "Last active", ""]}>
          {sessions.data?.sessions.map((s: any) => (
            <tr key={s.id}>
              <Td className="max-w-[320px] truncate text-xs">{s.userAgent}</Td>
              <Td className="font-mono text-xs">{s.ip}</Td>
              <Td className="text-mute">{date(s.createdAt, true)}</Td>
              <Td className="text-mute">{date(s.lastUsedAt, true)}</Td>
              <Td className="text-right">{s.current ? <Badge status="ACTIVE">this device</Badge> : <button className="text-xs font-bold text-rose-600" onClick={() => api(`/auth/sessions/${s.id}`, { method: "DELETE" }).then(sessions.reload)}>Revoke</button>}</Td>
            </tr>
          ))}
        </Table>
      </Card>
      <Card title="Login history" pad={false}>
        <Table head={["Time", "IP", "Result", "Device"]}>
          {history.data?.history.map((h: any) => (
            <tr key={h.id}>
              <Td className="text-mute">{date(h.createdAt, true)}</Td>
              <Td className="font-mono text-xs">{h.ip}</Td>
              <Td>{h.success ? <Badge status="ACTIVE">success</Badge> : <Badge status="FAILED">{h.reason ?? "failed"}</Badge>}</Td>
              <Td className="max-w-[320px] truncate text-xs text-mute">{h.userAgent}</Td>
            </tr>
          ))}
        </Table>
      </Card>
    </div>
  );
}

