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
  // clients can sign in with their password or a one-time code emailed to them
  const [method, setMethod] = useState<"password" | "otp">("password");
  const [otpSent, setOtpSent] = useState(false);
  const [otp, setOtp] = useState("");
  const [resendIn, setResendIn] = useState(0);
  useEffect(() => {
    if (resendIn <= 0) return;
    const t = setTimeout(() => setResendIn((n) => n - 1), 1000);
    return () => clearTimeout(t);
  }, [resendIn]);
  const useOtp = portal === "client" && method === "otp";

  async function sendCode() {
    setBusy(true);
    setError(null);
    try {
      await api("/auth/login/otp/request", { body: { email } });
      setOtpSent(true);
      setOtp("");
      setResendIn(60);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    if (me && ((portal === "admin" && me.type === "STAFF") || (portal === "client" && me.type === "CLIENT"))) router.replace(next);
  }, [me, portal, next, router]);

  async function submit(e?: React.FormEvent) {
    e?.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (challenge) await api("/auth/login/2fa", { body: { challenge, code } });
      else if (useOtp) {
        if (!otpSent) {
          setBusy(false);
          return sendCode();
        }
        const r = await api("/auth/login/otp/verify", { body: { email, code: otp } });
        if (r.twoFactorRequired) {
          setChallenge(r.challenge);
          setBusy(false);
          return;
        }
      } else {
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
            ? "You were signed in, but the browser refused the login cookie because this page is on http://. Open the site with https:// (or set COOKIE_SECURE=auto in apps/api/.env and restart)."
            : "You were signed in, but the browser didn't keep the login cookie. Allow cookies for this site and try again.",
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
  useEffect(() => {
    if (useOtp && otpSent && !challenge && otp.length === 6 && !busy) submit();
  }, [otp]); // eslint-disable-line react-hooks/exhaustive-deps
  const switchMethod = (m: "password" | "otp") => { setMethod(m); setError(null); setOtpSent(false); setOtp(""); };

  return (
    <form onSubmit={submit} className="space-y-5">
      {sp.get("reset") && <Alert tone="success">Password updated — please sign in.</Alert>}
      {sp.get("next")?.startsWith("/order") && !challenge && <Alert>Sign in to continue with your order — your cart and IP hold are saved.</Alert>}
      {error && <Alert tone="error">{error}</Alert>}
      {!challenge && portal === "client" && (
        <div className="grid grid-cols-2 gap-1 rounded-xl bg-[#f6f2fd] p-1" role="tablist">
          {([["password", "password", "Password"], ["otp", "forward_to_inbox", "Email code"]] as const).map(([k, i, t]) => (
            <button key={k} type="button" role="tab" aria-selected={method === k} onClick={() => switchMethod(k)} className={"flex h-10 items-center justify-center gap-1.5 rounded-lg text-sm font-extrabold transition " + (method === k ? "bg-white text-primary-dark shadow-sm" : "text-mute hover:text-ink")}>
              <Icon name={i} className="text-[18px]" />{t}
            </button>
          ))}
        </div>
      )}
      {!challenge && useOtp ? (
        !otpSent ? (
          <>
            <Field label="Email address" hint="We'll email you a 6-digit code — no password needed.">
              <IconInput icon="mail" type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@company.com" />
            </Field>
          </>
        ) : (
          <div className="space-y-4">
            <div className="flex items-center gap-3 rounded-2xl bg-primary-tint p-4 ring-1 ring-[#e9d5ff]">
              <span className="grid h-11 w-11 place-items-center rounded-xl bg-white text-primary-dark shadow-sm"><Icon name="mark_email_read" /></span>
              <div className="min-w-0 text-sm"><div className="font-extrabold text-ink">Check your email</div><div className="break-words text-mute">If <b className="text-ink">{email}</b> has an account, we&apos;ve sent a 6-digit code. It expires in 10 minutes.</div></div>
            </div>
            <CodeBoxes value={otp} onChange={setOtp} />
            <div className="flex flex-wrap items-center justify-between gap-2 text-sm font-bold">
              <button type="button" className="text-primary-dark hover:underline" onClick={() => { setOtpSent(false); setOtp(""); setError(null); }}>← Change email</button>
              <button type="button" className="text-primary-dark hover:underline disabled:text-slate-400 disabled:no-underline" disabled={resendIn > 0 || busy} onClick={sendCode}>{resendIn > 0 ? `Resend code in ${resendIn}s` : "Resend code"}</button>
            </div>
          </div>
        )
      ) : !challenge ? (
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
      <Button type="submit" size="lg" className="h-[52px] w-full text-[15px]" loading={busy} icon={challenge ? "verified_user" : useOtp && !otpSent ? "send" : "login"} disabled={!challenge && useOtp && otpSent && otp.length < 6}>
        {challenge ? "Verify & sign in" : useOtp ? (otpSent ? "Verify & sign in" : "Email me a code") : "Sign in securely"}
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
