"use client";
import { useEffect, useState } from "react";
import { Alert, Button, Icon, Modal, cx } from "./ui";
import { PasswordField, passwordProblem } from "./password-field";

/**
 * Reset a VPS root / Administrator password: let the panel generate a strong one, or type your own.
 * `onSubmit(password?)` — undefined means "generate".
 */
export function ResetPasswordModal({ open, onClose, onSubmit, busy, windows }: { open: boolean; onClose: () => void; onSubmit: (password?: string) => void; busy?: boolean; windows?: boolean }) {
  const [mode, setMode] = useState<"generate" | "own">("generate");
  const [pw, setPw] = useState("");
  useEffect(() => {
    if (open) { setMode("generate"); setPw(""); }
  }, [open]);
  const user = windows ? "Administrator" : "root";
  const bad = mode === "own" && (!pw || !!passwordProblem(pw));
  const opts = [
    { k: "generate" as const, icon: "casino", t: "Generate for me", d: "A strong random password. You'll see it under Login once it's applied." },
    { k: "own" as const, icon: "edit", t: "Choose my own", d: "Type a password you'll remember — 10+ characters with upper case, lower case and a number." },
  ];
  return (
    <Modal open={open} onClose={onClose} title={`Reset ${user} password`}>
      <div className="grid gap-3 sm:grid-cols-2">
        {opts.map((o) => (
          <button key={o.k} type="button" onClick={() => setMode(o.k)} className={cx("rounded-xl border p-4 text-left transition", mode === o.k ? "border-primary bg-primary-tint ring-2 ring-primary/20" : "border-line bg-white hover:border-primary/40")}>
            <span className="flex items-center gap-2">
              <span className={cx("grid h-8 w-8 place-items-center rounded-lg", mode === o.k ? "bg-primary-dark text-white" : "bg-primary-soft text-primary-dark")}><Icon name={o.icon} className="text-[18px]" /></span>
              <span className="text-sm font-extrabold text-ink">{o.t}</span>
              {mode === o.k && <Icon name="check_circle" className="ml-auto text-[20px] text-primary-dark" />}
            </span>
            <span className="mt-2 block text-xs leading-relaxed text-mute">{o.d}</span>
          </button>
        ))}
      </div>
      {mode === "own" && (
        <div className="mt-4">
          <div className="mb-1.5 text-sm font-bold text-ink">New {user} password</div>
          <PasswordField value={pw} onChange={setPw} optionalHint="Or click Generate to fill in a strong one" />
        </div>
      )}
      <Alert tone="warn" className="mt-4">The server restarts to apply the new password — save your work first. It's back in about a minute.</Alert>
      <div className="mt-4 flex justify-end gap-2">
        <Button variant="ghost" onClick={onClose}>Cancel</Button>
        <Button icon="key" loading={busy} disabled={bad} onClick={() => onSubmit(mode === "own" ? pw : undefined)}>Reset password</Button>
      </div>
    </Modal>
  );
}
