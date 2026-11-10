"use client";
import Link from "next/link";
import { forwardRef, useCallback, useEffect, useRef, useState, type ReactNode, type ButtonHTMLAttributes, type InputHTMLAttributes, type SelectHTMLAttributes, type TextareaHTMLAttributes } from "react";
import { createPortal } from "react-dom";
import { api } from "@/lib/api";

export const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(" ");

export function Icon({ name, className = "", fill = false }: { name: string; className?: string; fill?: boolean }) {
  return (
    <span className={cx("material-symbols-outlined leading-none select-none", className)} style={fill ? { fontVariationSettings: "'FILL' 1" } : undefined} aria-hidden>
      {name}
    </span>
  );
}

type BtnProps = ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "primary" | "secondary" | "ghost" | "danger" | "outline"; size?: "sm" | "md" | "lg"; loading?: boolean; icon?: string; href?: string };
export function Button({ variant = "primary", size = "md", loading, icon, href, className, children, disabled, ...rest }: BtnProps) {
  const cls = cx(
    "inline-flex items-center justify-center gap-2 rounded-xl font-bold transition-all disabled:opacity-50 disabled:cursor-not-allowed whitespace-nowrap",
    size === "sm" && "h-9 px-3.5 text-[13px]",
    size === "md" && "h-11 px-5 text-sm",
    size === "lg" && "h-12 px-6 text-[15px]",
    variant === "primary" && "bg-gradient-to-br from-primary to-primary-dark text-white shadow-glow hover:-translate-y-px hover:shadow-[0_12px_28px_rgba(124,58,237,.4)]",
    variant === "secondary" && "bg-primary-soft text-primary-dark hover:bg-[#ead9ff]",
    variant === "outline" && "border border-[#e6dcf8] bg-white text-slate-700 hover:border-primary hover:text-primary-dark",
    variant === "ghost" && "text-slate-600 hover:bg-primary-tint hover:text-primary-dark",
    variant === "danger" && "bg-rose-600 text-white hover:bg-rose-700",
    className,
  );
  const inner = (
    <>
      {loading ? <Spinner className="h-4 w-4" /> : icon ? <Icon name={icon} className="text-[19px]" /> : null}
      {children}
    </>
  );
  if (href) return <Link href={href} className={cls}>{inner}</Link>;
  return (
    <button className={cls} disabled={disabled || loading} {...rest}>
      {inner}
    </button>
  );
}

export function Spinner({ className = "h-5 w-5" }: { className?: string }) {
  return <span className={cx("inline-block animate-spin rounded-full border-2 border-current border-t-transparent", className)} />;
}

export function Card({ children, className, title, action, pad = true }: { children: ReactNode; className?: string; title?: ReactNode; action?: ReactNode; pad?: boolean }) {
  return (
    <section className={cx("rounded-2xl border border-line bg-white shadow-card", className)}>
      {title && (
        <header className="flex items-center justify-between gap-3 border-b border-line px-5 py-4">
          <h3 className="text-[15px] font-extrabold text-ink">{title}</h3>
          {action}
        </header>
      )}
      <div className={pad ? "p-5" : ""}>{children}</div>
    </section>
  );
}

export function Stat({ label, value, icon, tone = "purple", href, hint }: { label: string; value: ReactNode; icon: string; tone?: "purple" | "green" | "amber" | "rose" | "sky" | "slate"; href?: string; hint?: string }) {
  const tones = { purple: "bg-primary-soft text-primary-dark", green: "bg-emerald-50 text-emerald-600", amber: "bg-amber-50 text-amber-600", rose: "bg-rose-50 text-rose-600", sky: "bg-sky-50 text-sky-600", slate: "bg-slate-100 text-slate-600" };
  const body = (
    <div className="flex items-center gap-4 rounded-2xl border border-line bg-white p-5 shadow-card transition hover:border-[#dccafb]">
      <span className={cx("grid h-12 w-12 shrink-0 place-items-center rounded-xl", tones[tone])}>
        <Icon name={icon} className="text-[24px]" />
      </span>
      <div className="min-w-0">
        <div className="truncate text-[13px] font-semibold text-mute">{label}</div>
        <div className="mt-0.5 text-2xl font-extrabold tracking-tight text-ink">{value}</div>
        {hint && <div className="text-xs text-mute">{hint}</div>}
      </div>
    </div>
  );
  return href ? <Link href={href}>{body}</Link> : body;
}

const STATUS: Record<string, string> = {
  ACTIVE: "bg-emerald-50 text-emerald-700 ring-emerald-200",
  PAID: "bg-emerald-50 text-emerald-700 ring-emerald-200",
  APPROVED: "bg-emerald-50 text-emerald-700 ring-emerald-200",
  AVAILABLE: "bg-emerald-50 text-emerald-700 ring-emerald-200",
  ANSWERED: "bg-sky-50 text-sky-700 ring-sky-200",
  running: "bg-emerald-50 text-emerald-700 ring-emerald-200",
  PENDING: "bg-amber-50 text-amber-700 ring-amber-200",
  PROVISIONING: "bg-violet-50 text-violet-700 ring-violet-200",
  UNPAID: "bg-amber-50 text-amber-700 ring-amber-200",
  OPEN: "bg-amber-50 text-amber-700 ring-amber-200",
  CUSTOMER_REPLY: "bg-orange-50 text-orange-700 ring-orange-200",
  IN_PROGRESS: "bg-violet-50 text-violet-700 ring-violet-200",
  RESERVED: "bg-violet-50 text-violet-700 ring-violet-200",
  PENDING_REVIEW: "bg-violet-50 text-violet-700 ring-violet-200",
  PENDING_TRANSFER: "bg-amber-50 text-amber-700 ring-amber-200",
  ALLOCATED: "bg-sky-50 text-sky-700 ring-sky-200",
  SUSPENDED: "bg-rose-50 text-rose-700 ring-rose-200",
  FAILED: "bg-rose-50 text-rose-700 ring-rose-200",
  SENT: "bg-emerald-50 text-emerald-700 ring-emerald-200",
  BOUNCED: "bg-rose-50 text-rose-700 ring-rose-200",
  SUPPRESSED: "bg-amber-50 text-amber-700 ring-amber-200",
  LOGGED: "bg-slate-100 text-slate-600 ring-slate-200",
  FRAUD: "bg-rose-50 text-rose-700 ring-rose-200",
  BLOCKED: "bg-rose-50 text-rose-700 ring-rose-200",
  REJECTED: "bg-rose-50 text-rose-700 ring-rose-200",
  EXPIRED: "bg-rose-50 text-rose-700 ring-rose-200",
  URGENT: "bg-rose-50 text-rose-700 ring-rose-200",
  HIGH: "bg-orange-50 text-orange-700 ring-orange-200",
  stopped: "bg-slate-100 text-slate-600 ring-slate-200",
};
export function Badge({ status, children }: { status?: string; children?: ReactNode }) {
  const s = status ?? String(children ?? "");
  return (
    <span className={cx("inline-flex items-center rounded-full px-2.5 py-0.5 text-[11.5px] font-bold uppercase tracking-wide ring-1 ring-inset", STATUS[s] ?? "bg-slate-100 text-slate-600 ring-slate-200")}>
      {children ?? s.replace(/_/g, " ").toLowerCase()}
    </span>
  );
}

export function Field({ label, hint, error, children, className }: { label?: ReactNode; hint?: ReactNode; error?: string; children: ReactNode; className?: string }) {
  return (
    <label className={cx("block", className)}>
      {label && <span className="mb-1.5 block text-[13px] font-bold text-slate-700">{label}</span>}
      {children}
      {hint && !error && <span className="mt-1 block text-xs text-mute">{hint}</span>}
      {error && <span className="mt-1 block text-xs font-semibold text-rose-600">{error}</span>}
    </label>
  );
}
const inputCls = "w-full rounded-xl border border-[#e6dcf8] bg-white px-3.5 text-[14.5px] text-ink placeholder:text-slate-400 outline-none transition focus:border-primary focus:ring-4 focus:ring-primary/15 disabled:bg-slate-50";
export const Input = (p: InputHTMLAttributes<HTMLInputElement>) => <input {...p} className={cx(inputCls, "h-11", p.className)} />;
export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(function Textarea(p, ref) {
  return <textarea ref={ref} {...p} className={cx(inputCls, "py-2.5", p.className)} />;
});
export const Select = ({ children, ...p }: SelectHTMLAttributes<HTMLSelectElement>) => (
  <select {...p} className={cx(inputCls, "h-11 pr-8", p.className)}>
    {children}
  </select>
);
export function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label?: ReactNode }) {
  return (
    <button type="button" onClick={() => onChange(!checked)} className="inline-flex items-center gap-2.5 text-sm font-semibold text-slate-700">
      <span className={cx("relative h-6 w-11 rounded-full transition", checked ? "bg-primary-dark" : "bg-slate-300")}>
        <span className={cx("absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition", checked ? "left-[22px]" : "left-0.5")} />
      </span>
      {label}
    </button>
  );
}

export function Alert({ tone = "info", children, className }: { tone?: "info" | "success" | "warn" | "error"; children: ReactNode; className?: string }) {
  const t = { info: "bg-primary-tint border-[#e9d5ff] text-primary-deep", success: "bg-emerald-50 border-emerald-200 text-emerald-800", warn: "bg-amber-50 border-amber-200 text-amber-800", error: "bg-rose-50 border-rose-200 text-rose-800" };
  const i = { info: "info", success: "check_circle", warn: "warning", error: "error" };
  return (
    <div className={cx("flex items-start gap-3 rounded-xl border px-4 py-3 text-sm", t[tone], className)}>
      <Icon name={i[tone]} className="mt-px text-[20px]" />
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}

export function Empty({ icon = "inbox", title, children }: { icon?: string; title: string; children?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center px-6 py-14 text-center">
      <span className="mb-4 grid h-14 w-14 place-items-center rounded-2xl bg-primary-soft text-primary-dark">
        <Icon name={icon} className="text-[28px]" />
      </span>
      <div className="text-base font-extrabold text-ink">{title}</div>
      {children && <div className="mt-1.5 max-w-md text-sm text-mute">{children}</div>}
    </div>
  );
}

export function PageHeader({ title, subtitle, actions, back }: { title: ReactNode; subtitle?: ReactNode; actions?: ReactNode; back?: string }) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
      <div className="min-w-0">
        {back && (
          <Link href={back} className="mb-2 inline-flex items-center gap-1 text-[13px] font-bold text-primary-dark hover:underline">
            <Icon name="arrow_back" className="text-[17px]" /> Back
          </Link>
        )}
        <h1 className="text-2xl font-extrabold tracking-tight text-ink sm:text-[28px]">{title}</h1>
        {subtitle && <p className="mt-1 text-sm text-mute">{subtitle}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

export function Table({ head, children, empty }: { head: ReactNode[]; children: ReactNode; empty?: ReactNode }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[640px] text-left text-sm">
        <thead>
          <tr className="border-b border-line bg-[#fbf9ff] text-[11.5px] font-bold uppercase tracking-wider text-mute">
            {head.map((h, i) => (
              <th key={i} className="whitespace-nowrap px-4 py-3">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-[#f3effb]">{children}</tbody>
      </table>
      {empty}
    </div>
  );
}
export const Td = ({ children, className }: { children?: ReactNode; className?: string }) => <td className={cx("px-4 py-3 align-middle", className)}>{children}</td>;

export function Modal({ open, onClose, title, children, wide }: { open: boolean; onClose: () => void; title: ReactNode; children: ReactNode; wide?: boolean }) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    if (open) document.addEventListener("keydown", k);
    return () => document.removeEventListener("keydown", k);
  }, [open, onClose]);
  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = prev; };
  }, [open]);
  if (!open || typeof document === "undefined") return null;
  // portal to <body> so the overlay is never trapped inside an animated/transformed or overflow-hidden parent
  return createPortal(
    <div className="fixed inset-0 z-[100] flex items-start justify-center overflow-y-auto bg-slate-900/40 p-4 pt-[8vh] backdrop-blur-sm" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={cx("w-full rounded-2xl bg-white shadow-2xl", wide ? "max-w-3xl" : "max-w-lg")}>
        <div className="flex items-center justify-between border-b border-line px-5 py-4">
          <h3 className="text-base font-extrabold text-ink">{title}</h3>
          <button onClick={onClose} className="grid h-8 w-8 place-items-center rounded-lg text-slate-500 hover:bg-slate-100" aria-label="Close">
            <Icon name="close" className="text-[20px]" />
          </button>
        </div>
        <div className="p-5">{children}</div>
      </div>
    </div>,
    document.body,
  );
}

// ── tiny toast system ──
type ToastT = { id: number; tone: "success" | "error" | "info"; text: string };
let pushToast: (t: Omit<ToastT, "id">) => void = () => {};
export const toast = {
  success: (text: string) => pushToast({ tone: "success", text }),
  error: (text: string) => pushToast({ tone: "error", text }),
  info: (text: string) => pushToast({ tone: "info", text }),
};
export function Toaster() {
  const [items, setItems] = useState<ToastT[]>([]);
  useEffect(() => {
    pushToast = (t) => {
      const id = Date.now() + Math.random();
      setItems((x) => [...x, { ...t, id }]);
      setTimeout(() => setItems((x) => x.filter((i) => i.id !== id)), 5000);
    };
  }, []);
  return (
    <div className="pointer-events-none fixed bottom-4 right-4 z-[80] flex w-[min(380px,calc(100vw-32px))] flex-col gap-2">
      {items.map((t) => (
        <div key={t.id} className={cx("pointer-events-auto flex items-start gap-2.5 rounded-xl px-4 py-3 text-sm font-semibold shadow-xl", t.tone === "success" ? "bg-emerald-600 text-white" : t.tone === "error" ? "bg-rose-600 text-white" : "bg-ink text-white")}>
          <Icon name={t.tone === "success" ? "check_circle" : t.tone === "error" ? "error" : "info"} className="text-[19px]" />
          <span>{t.text}</span>
        </div>
      ))}
    </div>
  );
}

/** Data fetching hook with reload. */
export function useApi<T = any>(path: string | null, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(!!path);
  const alive = useRef(true);
  const load = useCallback(async () => {
    if (!path) return;
    setLoading(true);
    try {
      const d = await api<T>(path);
      if (alive.current) {
        setData(d);
        setError(null);
      }
    } catch (e: any) {
      if (alive.current) setError(e.message);
    } finally {
      if (alive.current) setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, ...deps]);
  useEffect(() => {
    alive.current = true;
    load();
    return () => {
      alive.current = false;
    };
  }, [load]);
  return { data, error, loading, reload: load, setData };
}

export function Loading({ label = "Loading…" }: { label?: string }) {
  return (
    <div className="flex items-center justify-center gap-3 py-16 text-sm font-semibold text-mute">
      <Spinner className="h-5 w-5 text-primary-dark" /> {label}
    </div>
  );
}

export function Pager({ page, pageSize, total, onPage }: { page: number; pageSize: number; total: number; onPage: (p: number) => void }) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  if (pages <= 1) return null;
  return (
    <div className="flex items-center justify-between border-t border-line px-4 py-3 text-sm text-mute">
      <span>
        {(page - 1) * pageSize + 1}–{Math.min(page * pageSize, total)} of {total}
      </span>
      <div className="flex gap-2">
        <Button size="sm" variant="outline" disabled={page <= 1} onClick={() => onPage(page - 1)}>
          Previous
        </Button>
        <Button size="sm" variant="outline" disabled={page >= pages} onClick={() => onPage(page + 1)}>
          Next
        </Button>
      </div>
    </div>
  );
}

export function Copy({ text }: { text: string }) {
  const [ok, setOk] = useState(false);
  return (
    <button
      type="button"
      onClick={() => {
        navigator.clipboard?.writeText(text);
        setOk(true);
        setTimeout(() => setOk(false), 1500);
      }}
      className="inline-grid h-7 w-7 place-items-center rounded-lg text-slate-500 hover:bg-primary-soft hover:text-primary-dark"
      title="Copy"
    >
      <Icon name={ok ? "check" : "content_copy"} className="text-[16px]" />
    </button>
  );
}
