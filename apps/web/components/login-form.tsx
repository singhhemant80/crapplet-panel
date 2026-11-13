"use client";
import { safeNext } from "@/lib/safe-next";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { api } from "@/lib/api";
import { useSession } from "@/lib/session";
import { Alert, Button, Field, Icon } from "@/components/ui";
import { IconInput, PasswordInput } from "./auth-shell";

function CodeBoxes({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const refs = useRef<(HTMLInputElement | null)[]>([]);
  return (
    <div className="flex justify-between gap-2" onPaste={(e) => { const d = e.clipboardData.getData("text").replace(/\D/g, "").slice(0, 6); if (d) { e.preventDefault(); onChange(d); refs.current[Math.min(5, d.length)]?.focus(); } }}>
      {Array.from({ length: 6 }, (_, i) => (
        <input
          key={i}
          ref={(el) => { refs.current[i] = el; }}
          inputMode="numeric"
          maxLength={1}
          autoFocus={i === 0}
          value={value[i] ?? ""}
          onChange={(e) => {
            const d = e.target.value.replace(/\D/g, "").slice(-1);
            const next = (value.slice(0, i) + d + value.slice(i + 1)).slice(0, 6);
            onChange(next);
            if (d && i < 5) refs.current[i + 1]?.focus();
          }}
          onKeyDown={(e) => { if (e.key === "Backspace" && !value[i] && i > 0) refs.current[i - 1]?.focus(); }}
          className="h-14 w-full min-w-0 rounded-xl border border-[#e6dcf8] bg-[#fcfaff] text-center text-2xl font-extrabold text-ink outline-none focus:border-primary focus:bg-white focus:ring-4 focus:ring-primary/15"
          aria-label={`Digit ${i + 1}`}
        />
      ))}
    </div>
  );
}

export function LoginForm({ portal = "client" }: { portal?: "client" | "admin" }) {
  const router = useRouter();
  const sp = useSearchParams();
  const { me, reload } = useSession();
  const next = safeNext(sp.get("next"), portal === "admin" ? "/admin" : "/client");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [challenge, setChallenge] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (me && ((portal === "admin" && me.type === "STAFF") || (portal === "client" && me.type === "CLIENT"))) router.replace(next);
  }, [me, portal, next, router]);

  async function submit(e?: React.FormEvent) {
    e?.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (challenge) await api("/auth/login/2fa", { body: { challenge, code } });
      else {
        const r = await api("/auth/login", { body: { email, password, portal } });
        if (r.twoFactorRequired) {
          setChallenge(r.challenge);
          setBusy(false);
          return;
        }
      }
      // make sure the browser actually kept the session cookie before navigating
      const ok = await api("/auth/me").then(() => true, () => false);
      if (!ok) {
        setError(
          window.location.protocol === "http:"
            ? "Your password was accepted, but the browser refused the login cookie because this page is on http://. Open the site with https:// (or set COOKIE_SECURE=auto in apps/api/.env and restart)."
            : "Your password was accepted, but the browser didn't keep the login cookie. Allow cookies for this site and try again.",
        );
        return;
      }
      await reload();
      router.replace(next);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    if (challenge && code.length === 6 && !busy) submit();
  }, [code]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <form onSubmit={submit} className="space-y-5">
      {sp.get("reset") && <Alert tone="success">Password updated — please sign in.</Alert>}
      {sp.get("next")?.startsWith("/order") && !challenge && <Alert>Sign in to continue with your order — your cart and IP hold are saved.</Alert>}
      {error && <Alert tone="error">{error}</Alert>}
      {!challenge ? (
        <>
          <Field label="Email address">
            <IconInput icon="mail" type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@company.com" />
          </Field>
          <Field
            label={
              <span className="flex justify-between">
                Password
                <Link href={portal === "admin" ? "/admin/forgot-password" : "/client/forgot-password"} className="font-bold text-primary-dark hover:underline">
                  Forgot password?
                </Link>
              </span>
            }
          >
            <PasswordInput autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} placeholder="••••••••" />
          </Field>
        </>
      ) : (
        <div className="space-y-4">
          <div className="flex items-center gap-3 rounded-2xl bg-primary-tint p-4 ring-1 ring-[#e9d5ff]">
            <span className="grid h-11 w-11 place-items-center rounded-xl bg-white text-primary-dark shadow-sm"><Icon name="phonelink_lock" /></span>
            <div className="text-sm"><div className="font-extrabold text-ink">Two-factor authentication</div><div className="text-mute">Enter the 6-digit code from your authenticator app.</div></div>
          </div>
          <CodeBoxes value={code} onChange={setCode} />
          <button type="button" className="text-sm font-bold text-primary-dark hover:underline" onClick={() => { setChallenge(null); setCode(""); }}>← Use a different account</button>
        </div>
      )}
      <Button type="submit" size="lg" className="h-[52px] w-full text-[15px]" loading={busy} icon={challenge ? "verified_user" : "login"}>
        {challenge ? "Verify & sign in" : "Sign in securely"}
      </Button>
      {portal === "client" && !challenge && (
        <>
          <div className="flex items-center gap-3 text-xs font-bold uppercase tracking-wider text-slate-400">
            <span className="h-px flex-1 bg-line" /> New to Crapplet? <span className="h-px flex-1 bg-line" />
          </div>
          <Link
            href={`/client/register${sp.get("next") ? `?next=${encodeURIComponent(sp.get("next")!)}` : ""}`}
            className="flex h-[52px] items-center justify-center gap-2 rounded-xl border-2 border-[#e6dcf8] text-[15px] font-extrabold text-primary-dark transition hover:border-primary hover:bg-primary-tint"
          >
            <Icon name="person_add" className="text-[20px]" /> Create a free account
          </Link>
        </>
      )}
    </form>
  );
}
