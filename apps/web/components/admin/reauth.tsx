"use client";
/**
 * Staff password re-confirmation ("sudo mode"), the UI half — the server enforces it.
 *  - Products, Servers and Setup pages open behind a lock screen.
 *  - Critical actions anywhere (close/delete a customer, refunds, terminate …) pop up a password prompt,
 *    and the action carries on by itself once the password is right.
 *  - After confirming, nothing asks again for a few minutes; "Lock" in the header ends that early.
 */
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useRouter } from "next/navigation";
import { ApiError, api, setReauthHandler } from "@/lib/api";
import { useSession } from "@/lib/session";
import { Button, Icon, cx } from "@/components/ui";

type Status = { until: number | null; minutes: number };
type Ctx = Status & { active: boolean; lockCount: number; lock: () => Promise<void>; confirmed: (until: string, minutes: number) => void };
const ReauthCtx = createContext<Ctx>({ until: null, minutes: 15, active: false, lockCount: 0, lock: async () => {}, confirmed: () => {} });
export const useReauth = () => useContext(ReauthCtx);

/** Admin pages that open behind the lock screen. */
const AREAS: { label: string; icon: string; prefixes: string[] }[] = [
  { label: "Products & catalogue", icon: "inventory_2", prefixes: ["products", "product-groups", "addons", "promo-codes", "os-templates", "currencies"] },
  { label: "Servers & infrastructure", icon: "dns", prefixes: ["servers", "proxmox", "monitoring", "virtualizor", "ips", "locations"] },
  { label: "Setup", icon: "settings", prefixes: ["staff", "roles", "email", "email-templates", "whatsapp", "settings", "automation", "backups", "broker-latency", "migration", "gateways"] },
];
export function lockedArea(path: string) {
  const seg = path.split("/")[2] ?? "";
  return AREAS.find((a) => a.prefixes.includes(seg)) ?? null;
}

function useNow(ms: number) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

/** The password box used by both the lock screen and the pop-up. */
function ConfirmForm({ onDone, onCancel, autoFocus = true, compact }: { onDone: (until: string, minutes: number) => void; onCancel?: () => void; autoFocus?: boolean; compact?: boolean }) {
  const { me } = useSession();
  const router = useRouter();
  const [pw, setPw] = useState("");
  const [show, setShow] = useState(false);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!pw || busy) return;
    setBusy(true);
    setErr("");
    try {
      const r = await api<{ until: string; minutes: number }>("/auth/reauth", { body: { password: pw } });
      setPw("");
      onDone(r.until, r.minutes);
    } catch (x) {
      const e2 = x as ApiError;
      if (e2.status === 401) {
        router.replace("/admin/login?reason=reauth");
        return;
      }
      setErr(e2.message);
      setPw("");
    } finally {
      setBusy(false);
    }
  };
  return (
    <form onSubmit={submit} className="space-y-3">
      <div className="flex items-center gap-2 rounded-xl bg-[#f6f2fd] px-3 py-2 text-[13px] text-mute">
        <Icon name="account_circle" className="text-[18px] text-primary-dark" />
        <span className="truncate">Signed in as <b className="text-ink">{me?.email}</b></span>
      </div>
      <label className="block">
        <span className="mb-1.5 block text-[13px] font-bold text-ink">Your password</span>
        <div className="relative">
          <input
            type={show ? "text" : "password"}
            autoComplete="current-password"
            autoFocus={autoFocus}
            value={pw}
            onChange={(e) => setPw(e.target.value)}
            className={cx("h-11 w-full rounded-xl border bg-white px-3.5 pr-11 text-[14.5px] text-ink outline-none transition focus:border-primary focus:ring-4 focus:ring-primary/15", err ? "border-rose-300" : "border-[#e6dcf8]")}
            placeholder="Enter your admin password"
          />
          <button type="button" onClick={() => setShow((v) => !v)} className="absolute inset-y-0 right-0 grid w-11 place-items-center text-slate-400 hover:text-ink" aria-label={show ? "Hide password" : "Show password"}>
            <Icon name={show ? "visibility_off" : "visibility"} className="text-[19px]" />
          </button>
        </div>
        {err && <span className="mt-1.5 flex items-center gap-1 text-[12.5px] font-semibold text-rose-600"><Icon name="error" className="text-[15px]" />{err}</span>}
      </label>
      <div className={cx("flex gap-2", compact ? "justify-end" : "")}>
        {onCancel && <Button type="button" variant="ghost" onClick={onCancel}>Cancel</Button>}
        <Button type="submit" loading={busy} disabled={!pw} icon="lock_open" className={compact ? "" : "w-full justify-center"}>Confirm</Button>
      </div>
    </form>
  );
}

export function ReauthProvider({ children }: { children: ReactNode }) {
  const [st, setSt] = useState<Status>({ until: null, minutes: 15 });
  const [prompt, setPrompt] = useState<{ label?: string } | null>(null);
  const waiting = useRef<((ok: boolean) => void)[]>([]);
  const [lockCount, setLockCount] = useState(0);
  const now = useNow(10_000);
  const active = !!st.until && st.until > now;

  useEffect(() => {
    api<{ until: string | null; minutes: number }>("/auth/reauth")
      .then((r) => setSt({ until: r.until ? new Date(r.until).getTime() : null, minutes: r.minutes }))
      .catch(() => undefined);
  }, []);

  const confirmed = useCallback((until: string, minutes: number) => setSt({ until: new Date(until).getTime(), minutes }), []);
  const finish = useCallback((ok: boolean) => {
    const w = waiting.current;
    waiting.current = [];
    setPrompt(null);
    w.forEach((r) => r(ok));
  }, []);

  // the API client calls this when the server answers "confirm your password"
  useEffect(() => {
    setReauthHandler(
      (label) =>
        new Promise<boolean>((resolve) => {
          waiting.current.push(resolve);
          setSt((s) => ({ ...s, until: null })); // whatever we thought, the server says it has run out
          setPrompt((p) => p ?? { label });
        }),
    );
    return () => setReauthHandler(null);
  }, []);

  const lock = useCallback(async () => {
    await api("/auth/reauth", { method: "DELETE" }).catch(() => undefined);
    setSt((s) => ({ ...s, until: null }));
    setLockCount((n) => n + 1);
  }, []);

  return (
    <ReauthCtx.Provider value={{ ...st, active, lockCount, lock, confirmed }}>
      {children}
      {prompt &&
        typeof document !== "undefined" &&
        createPortal(
          <div className="fixed inset-0 z-[200] flex items-start justify-center overflow-y-auto bg-slate-900/50 p-4 pt-[12vh] backdrop-blur-sm" role="dialog" aria-modal="true" onKeyDown={(e) => e.key === "Escape" && finish(false)}>
            <div className="w-full max-w-md overflow-hidden rounded-2xl bg-white shadow-2xl fade-up">
              <div className="flex items-start gap-3 border-b border-line bg-[linear-gradient(135deg,#faf7ff,#f3ecff)] px-5 py-4">
                <div className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-primary/10 text-primary-dark"><Icon name="shield_lock" className="text-[24px]" fill /></div>
                <div className="min-w-0">
                  <h3 className="text-base font-extrabold text-ink">Confirm it&apos;s you</h3>
                  <p className="mt-0.5 text-[13px] leading-snug text-mute">
                    {prompt.label ? <><b className="text-ink">{prompt.label}</b> is a protected action. </> : "This is a protected action. "}
                    Enter your password to continue — you won&apos;t be asked again for {st.minutes} minutes.
                  </p>
                </div>
              </div>
              <div className="p-5">
                <ConfirmForm compact onDone={(u, m) => { confirmed(u, m); finish(true); }} onCancel={() => finish(false)} />
              </div>
            </div>
          </div>,
          document.body,
        )}
    </ReauthCtx.Provider>
  );
}

/** Shows the lock screen in place of a protected page until the password is confirmed. */
export function AreaGate({ path, children }: { path: string; children: ReactNode }) {
  const { active, confirmed, minutes, lockCount } = useReauth();
  const area = lockedArea(path);
  const key = area?.label ?? "";
  // once through, the page stays open for this visit (an expired window only re-asks when something is saved)
  const [passed, setPassed] = useState<string | null>(null);
  useEffect(() => {
    if (active && area) setPassed(key);
  }, [active, area, key]);
  useEffect(() => {
    if (!active && passed && passed !== key) setPassed(null);
  }, [active, key, passed]);
  // "Lock now" closes the area again
  const seenLock = useRef(lockCount);
  useEffect(() => {
    if (seenLock.current !== lockCount) setPassed(null);
    seenLock.current = lockCount;
  }, [lockCount]);

  if (!area || active || passed === key) return <>{children}</>;
  return (
    <div className="grid min-h-[70vh] place-items-center">
      <div className="w-full max-w-[420px] overflow-hidden rounded-3xl border border-line bg-white shadow-[0_24px_60px_-24px_rgba(76,29,149,.35)]">
        <div className="relative overflow-hidden bg-[linear-gradient(135deg,#1f0f4a,#3b1a87)] px-7 pb-7 pt-8 text-white">
          <div className="pointer-events-none absolute -right-10 -top-10 h-40 w-40 rounded-full bg-white/10 blur-2xl" />
          <div className="grid h-14 w-14 place-items-center rounded-2xl bg-white/15 ring-1 ring-white/20"><Icon name="lock" className="text-[30px]" fill /></div>
          <h2 className="mt-4 text-xl font-extrabold">Confirm your password</h2>
          <p className="mt-1 text-[13.5px] leading-relaxed text-violet-100/85">
            <span className="inline-flex items-center gap-1 rounded-md bg-white/10 px-1.5 py-0.5 font-bold text-white"><Icon name={area.icon} className="text-[15px]" />{area.label}</span>{" "}
            is a protected area. You won&apos;t be asked again for {minutes} minutes.
          </p>
        </div>
        <div className="p-7">
          <ConfirmForm onDone={(u, m) => { confirmed(u, m); setPassed(key); }} />
        </div>
      </div>
    </div>
  );
}

/** Header pill: "Unlocked · 12 min" with a lock button. */
export function ReauthPill() {
  const { active, until, lock } = useReauth();
  const now = useNow(10_000);
  if (!active || !until) return null;
  const mins = Math.max(1, Math.ceil((until - now) / 60_000));
  return (
    <button onClick={lock} title="Lock protected areas now" className="group hidden items-center gap-1.5 rounded-full border border-emerald-200 bg-emerald-50 px-3 py-1.5 text-[12px] font-bold text-emerald-700 transition hover:border-rose-200 hover:bg-rose-50 hover:text-rose-700 sm:inline-flex">
      <span className="group-hover:hidden"><Icon name="lock_open" className="text-[16px]" /></span>
      <span className="hidden group-hover:inline"><Icon name="lock" className="text-[16px]" /></span>
      <span className="group-hover:hidden">Unlocked · {mins} min</span>
      <span className="hidden group-hover:inline">Lock now</span>
    </button>
  );
}
