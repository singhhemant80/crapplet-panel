"use client";
import { useEffect, useState } from "react";
import { Alert, Button, Field, Icon, Input, Modal, cx } from "./ui";
import { OsChooser } from "./os-chooser";
import { PasswordField, passwordProblem } from "./password-field";

/**
 * Pick a new OS (logos + versions), choose the new password (generated or your own) and type REINSTALL
 * to confirm. Shared by the client area and admin. `onSubmit(os, confirm, password?)` — no password = generate.
 */
export function ReinstallModal({ open, onClose, svc, onSubmit, busy, staff }: { open: boolean; onClose: () => void; svc: any; onSubmit: (os: string, c: string, password?: string) => void; busy?: boolean; staff?: boolean }) {
  const options = svc.product.osTemplates
    .map((o: any) => o.osTemplate)
    // only images available on the server this VPS lives on
    .filter((o: any) => o.enabled !== false && (!o.virtualizorServerId || !svc.serverId || o.virtualizorServerId === svc.serverId));
  const [os, setOs] = useState(svc.osTemplate?.id ?? "");
  const [c, setC] = useState("");
  const [mode, setMode] = useState<"generate" | "own">("generate");
  const [pw, setPw] = useState("");
  useEffect(() => {
    if (open) {
      setC("");
      setMode("generate");
      setPw("");
    }
  }, [open]);
  const chosen = options.find((o: any) => o.id === os) ?? svc.osTemplate;
  const windows = /windows/i.test(`${chosen?.family ?? ""} ${chosen?.name ?? ""}`);
  const user = windows ? "Administrator" : "root";
  const pwBad = mode === "own" && (!pw || !!passwordProblem(pw));
  const who = staff ? "the customer" : "you";
  const opts = [
    { k: "generate" as const, icon: "casino", t: "Generate for me", d: `A strong random password, emailed to ${who} and shown under Login.` },
    { k: "own" as const, icon: "edit", t: staff ? "Set a password" : "Choose my own", d: "10+ characters with upper case, lower case and a number." },
  ];
  return (
    <Modal open={open} onClose={onClose} title="Reinstall operating system" wide>
      <Alert tone="error" className="mb-4">
        {staff ? "All data on this server will be permanently erased. The IP address stays the same; the login details are emailed to the customer." : "All data on this server will be permanently erased. Your IP address stays the same; the login details are emailed to you."}
      </Alert>
      <div className="space-y-4">
        <Field label="Operating system">
          <OsChooser value={os} onChange={setOs} options={options} />
        </Field>
        <div>
          <div className="mb-1.5 text-sm font-bold text-ink">New {user} password</div>
          <div className="grid gap-3 sm:grid-cols-2">
            {opts.map((o) => (
              <button key={o.k} type="button" onClick={() => setMode(o.k)} className={cx("rounded-xl border p-3.5 text-left transition", mode === o.k ? "border-primary bg-primary-tint ring-2 ring-primary/20" : "border-line bg-white hover:border-primary/40")}>
                <span className="flex items-center gap-2">
                  <span className={cx("grid h-8 w-8 place-items-center rounded-lg", mode === o.k ? "bg-primary-dark text-white" : "bg-primary-soft text-primary-dark")}><Icon name={o.icon} className="text-[18px]" /></span>
                  <span className="text-sm font-extrabold text-ink">{o.t}</span>
                  {mode === o.k && <Icon name="check_circle" className="ml-auto text-[20px] text-primary-dark" />}
                </span>
                <span className="mt-1.5 block text-xs leading-relaxed text-mute">{o.d}</span>
              </button>
            ))}
          </div>
          {mode === "own" && (
            <div className="mt-3">
              <PasswordField value={pw} onChange={setPw} optionalHint="Or click Generate to fill in a strong one" />
            </div>
          )}
        </div>
        <Field label='Type "REINSTALL" to confirm'>
          <Input value={c} onChange={(e) => setC(e.target.value)} autoComplete="off" />
        </Field>
        <Button variant="danger" className="w-full" disabled={c !== "REINSTALL" || pwBad} loading={busy} onClick={() => onSubmit(os, c, mode === "own" ? pw : undefined)}>
          Erase and reinstall
        </Button>
      </div>
    </Modal>
  );
}
