"use client";
import { useState, type InputHTMLAttributes, type ReactNode } from "react";
import { Icon, cx } from "./ui";

const PERKS = [
  { icon: "public", title: "Pick your own IPv4", text: "Choose the exact address before you pay." },
  { icon: "bolt", title: "Live in under a minute", text: "VPS deploys automatically after payment." },
  { icon: "receipt_long", title: "GST-ready invoices", text: "Add your GSTIN and claim input tax credit." },
  { icon: "qr_code_2", title: "Pay with UPI", text: "UPI, cards, netbanking and wallet credit." },
];

/** Split-screen auth layout: branded panel on the left, form card on the right. */
export function AuthShell({ title, subtitle, children, wide, eyebrow = "Client area" }: { title: string; subtitle?: ReactNode; children: ReactNode; wide?: boolean; eyebrow?: string }) {
  return (
    <div className="relative overflow-hidden bg-[radial-gradient(circle_at_0%_0%,#efe3ff_0,transparent_45%),radial-gradient(circle_at_100%_100%,#fde7f3_0,transparent_40%)] bg-[#fbf9ff] px-4 py-10 sm:py-14">
      <div className={cx("relative mx-auto grid overflow-hidden rounded-[28px] border border-line bg-white shadow-[0_40px_90px_rgba(46,16,101,.16)] fade-up lg:grid-cols-[0.9fr_1.1fr]", wide ? "max-w-6xl" : "max-w-5xl")}>
        {/* brand panel */}
        <aside className="relative hidden overflow-hidden bg-[linear-gradient(150deg,#8b5cf6_0%,#6d28d9_50%,#3b0f7a_100%)] p-10 text-white lg:flex lg:flex-col">
          <div className="pointer-events-none absolute -right-24 -top-24 h-72 w-72 rounded-full bg-white/10 blur-2xl" />
          <div className="pointer-events-none absolute -bottom-32 -left-20 h-80 w-80 rounded-full bg-fuchsia-400/20 blur-3xl" />
          <div className="pointer-events-none absolute inset-0 opacity-[.07] [background-image:linear-gradient(#fff_1px,transparent_1px),linear-gradient(90deg,#fff_1px,transparent_1px)] [background-size:28px_28px]" />

          <div className="relative">
            <span className="inline-flex items-center gap-2 rounded-full bg-white/15 px-3 py-1 text-[11px] font-extrabold uppercase tracking-[.18em] ring-1 ring-white/20">
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-300 shadow-[0_0_0_3px_rgba(110,231,183,.3)]" /> 99.99% uptime SLA
            </span>
            <h2 className="mt-6 text-[30px] font-extrabold leading-tight tracking-tight">
              Cloud servers from
              <br />
              <span className="bg-gradient-to-r from-white to-violet-200 bg-clip-text text-transparent">Noida to the world.</span>
            </h2>
            <p className="mt-3 max-w-sm text-[15px] leading-relaxed text-violet-100/85">One account for your VPS, hosting, domains, invoices and 24/7 support.</p>
          </div>

          {/* mini server card illustration */}
          <div className="relative mt-8 rounded-2xl border border-white/15 bg-white/10 p-4 backdrop-blur-md">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <span className="grid h-10 w-10 place-items-center rounded-xl bg-white text-primary-dark shadow-lg">
                  <Icon name="terminal" />
                </span>
                <div>
                  <div className="text-sm font-extrabold">Linux VPS G2</div>
                  <div className="font-mono text-xs text-violet-100/80">web1.yourbrand.in</div>
                </div>
              </div>
              <span className="rounded-full bg-emerald-400/20 px-2.5 py-0.5 text-[11px] font-extrabold text-emerald-200 ring-1 ring-emerald-300/40">● RUNNING</span>
            </div>
            <div className="mt-4 grid grid-cols-3 gap-2 text-center">
              {[["IPv4", "103.x.x.10"], ["CPU", "2 vCPU"], ["RAM", "4 GB"]].map(([k, v]) => (
                <div key={k} className="rounded-xl bg-white/10 px-2 py-2">
                  <div className="text-[10px] font-bold uppercase tracking-wider text-violet-200/80">{k}</div>
                  <div className="mt-0.5 font-mono text-[12.5px] font-bold">{v}</div>
                </div>
              ))}
            </div>
          </div>

          <ul className="relative mt-8 space-y-4">
            {PERKS.map((p) => (
              <li key={p.title} className="flex gap-3">
                <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-white/15 ring-1 ring-white/20">
                  <Icon name={p.icon} className="text-[19px]" />
                </span>
                <div>
                  <div className="text-sm font-extrabold">{p.title}</div>
                  <div className="text-[13px] text-violet-100/75">{p.text}</div>
                </div>
              </li>
            ))}
          </ul>

          {wide && (
            <div className="relative mt-10 grid grid-cols-3 gap-3">
              {[["< 60s", "VPS deployment"], ["24/7", "Expert support"], ["Tier III", "Data centre"]].map(([v, l]) => (
                <div key={l} className="rounded-2xl bg-white/10 px-3 py-4 text-center ring-1 ring-white/15">
                  <div className="text-xl font-extrabold">{v}</div>
                  <div className="mt-0.5 text-[11px] font-semibold text-violet-100/75">{l}</div>
                </div>
              ))}
            </div>
          )}

          <div className="relative mt-auto flex items-center gap-3 pt-10 text-xs font-semibold text-violet-100/80">
            <Icon name="verified_user" className="text-[18px]" /> Tier III data centre · DDoS protected · GSTIN 23AAHCC8426G1ZR
          </div>
        </aside>

        {/* form */}
        <section className="min-w-0 p-6 sm:p-10">
          <div className="-mx-6 -mt-6 mb-7 flex gap-2 overflow-x-auto bg-[linear-gradient(120deg,#8b5cf6,#6d28d9)] px-6 py-3 sm:-mx-10 sm:-mt-10 sm:px-10 lg:hidden">
            {PERKS.map((p) => (
              <span key={p.title} className="inline-flex shrink-0 items-center gap-1.5 rounded-full bg-white/15 px-3 py-1.5 text-xs font-bold text-white ring-1 ring-white/20">
                <Icon name={p.icon} className="text-[16px]" /> {p.title}
              </span>
            ))}
          </div>
          <div className="mb-7">
            <span className="text-[11px] font-extrabold uppercase tracking-[.2em] text-primary-dark">{eyebrow}</span>
            <h1 className="mt-1.5 text-[26px] font-extrabold tracking-tight text-ink sm:text-[30px]">{title}</h1>
            {subtitle && <p className="mt-1.5 text-[14.5px] text-mute">{subtitle}</p>}
          </div>
          {children}
          <p className="mt-8 flex items-center justify-center gap-2 text-xs font-semibold text-mute">
            <Icon name="lock" className="text-[16px]" /> Secured with 256-bit TLS · Crapplet Infotech Pvt. Ltd.
          </p>
        </section>
      </div>
    </div>
  );
}

/** Input with a leading icon (and optional trailing slot). */
export function IconInput({ icon, trailing, className, ...p }: InputHTMLAttributes<HTMLInputElement> & { icon: string; trailing?: ReactNode }) {
  return (
    <div className="group relative">
      <Icon name={icon} className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-[20px] text-slate-400 transition group-focus-within:text-primary-dark" />
      <input
        {...p}
        className={cx(
          "h-12 w-full rounded-xl border border-[#e6dcf8] bg-[#fcfaff] pl-11 text-[15px] text-ink outline-none transition placeholder:text-slate-400 hover:border-[#d8c6fb] focus:border-primary focus:bg-white focus:ring-4 focus:ring-primary/15",
          trailing ? "pr-12" : "pr-3.5",
          className,
        )}
      />
      {trailing && <div className="absolute right-2 top-1/2 -translate-y-1/2">{trailing}</div>}
    </div>
  );
}

export function PasswordInput(p: Omit<InputHTMLAttributes<HTMLInputElement>, "type">) {
  const [show, setShow] = useState(false);
  return (
    <IconInput
      {...p}
      icon="lock"
      type={show ? "text" : "password"}
      trailing={
        <button type="button" onClick={() => setShow(!show)} className="grid h-9 w-9 place-items-center rounded-lg text-slate-400 hover:bg-primary-soft hover:text-primary-dark" aria-label={show ? "Hide password" : "Show password"}>
          <Icon name={show ? "visibility_off" : "visibility"} className="text-[20px]" />
        </button>
      }
    />
  );
}

export function passwordScore(pw: string) {
  let s = 0;
  if (pw.length >= 8) s++;
  if (pw.length >= 12) s++;
  if (/[A-Z]/.test(pw) && /[a-z]/.test(pw)) s++;
  if (/\d/.test(pw)) s++;
  if (/[^A-Za-z0-9]/.test(pw)) s++;
  return Math.min(4, s);
}

export function StrengthMeter({ password }: { password: string }) {
  if (!password) return null;
  const s = passwordScore(password);
  const label = ["Too weak", "Weak", "Fair", "Good", "Strong"][s];
  const color = ["bg-rose-500", "bg-rose-500", "bg-amber-400", "bg-emerald-400", "bg-emerald-500"][s];
  return (
    <div className="mt-2 flex items-center gap-3">
      <div className="flex flex-1 gap-1">
        {[0, 1, 2, 3].map((i) => (
          <span key={i} className={cx("h-1.5 flex-1 rounded-full transition", i < s ? color : "bg-slate-200")} />
        ))}
      </div>
      <span className={cx("text-xs font-bold", s >= 3 ? "text-emerald-600" : s === 2 ? "text-amber-600" : "text-rose-600")}>{label}</span>
    </div>
  );
}

export function SectionTitle({ n, title, hint }: { n: number; title: string; hint?: string }) {
  return (
    <div className="mb-4 flex items-center gap-3">
      <span className="grid h-7 w-7 place-items-center rounded-full bg-gradient-to-br from-primary to-primary-dark text-xs font-extrabold text-white shadow-glow">{n}</span>
      <div>
        <div className="text-[15px] font-extrabold text-ink">{title}</div>
        {hint && <div className="text-xs text-mute">{hint}</div>}
      </div>
      <span className="ml-2 h-px flex-1 bg-line" />
    </div>
  );
}
