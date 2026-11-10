"use client";
import { useState } from "react";
import { Button, Copy, Icon, Input, cx } from "./ui";

const LOWER = "abcdefghijkmnopqrstuvwxyz";
const UPPER = "ABCDEFGHJKLMNPQRSTUVWXYZ";
const DIGIT = "23456789";
const SYMBOL = "!@#%^*-_=+";

/** 16-character random password with every character class, from the browser's secure RNG. */
export function generatePassword(len = 16) {
  const all = LOWER + UPPER + DIGIT + SYMBOL;
  const rnd = (n: number) => {
    const a = new Uint32Array(1);
    crypto.getRandomValues(a);
    return a[0] % n;
  };
  const pick = (set: string) => set[rnd(set.length)];
  const chars = [pick(LOWER), pick(UPPER), pick(DIGIT), pick(SYMBOL), ...Array.from({ length: len - 4 }, () => pick(all))];
  for (let i = chars.length - 1; i > 0; i--) {
    const j = rnd(i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join("");
}

/** Same rules as the API: 10–64 chars, upper + lower + digit, no spaces / quotes / backslashes. */
export function passwordProblem(v: string): string | null {
  if (!v) return null;
  if (v.length < 10) return "At least 10 characters";
  if (v.length > 64) return "At most 64 characters";
  if (/[^\x21-\x7e]/.test(v)) return "No spaces or special letters";
  if (/['"`\\]/.test(v)) return "No quotes or backslashes";
  if (!/[a-z]/.test(v) || !/[A-Z]/.test(v) || !/\d/.test(v)) return "Add upper case, lower case and a number";
  return null;
}

function strength(v: string) {
  let s = 0;
  if (v.length >= 12) s++;
  if (v.length >= 16) s++;
  if (/[a-z]/.test(v) && /[A-Z]/.test(v)) s++;
  if (/\d/.test(v)) s++;
  if (/[^a-zA-Z0-9]/.test(v)) s++;
  return Math.min(4, s);
}

/** Root password input with Generate, show/hide and copy. Empty = the panel generates one. */
export function PasswordField({ value, onChange, optionalHint = "Leave empty and we'll generate one and email it", className }: { value: string; onChange: (v: string) => void; optionalHint?: string; className?: string }) {
  const [show, setShow] = useState(false);
  const problem = passwordProblem(value);
  const st = strength(value);
  return (
    <div className={className}>
      <div className="flex gap-2">
        <div className="relative min-w-0 flex-1">
          <Input
            type={show ? "text" : "password"}
            value={value}
            autoComplete="new-password"
            spellCheck={false}
            placeholder="Root password"
            onChange={(e) => onChange(e.target.value)}
            className={cx("pr-16 font-mono", problem && "border-rose-300")}
          />
          <span className="absolute inset-y-0 right-1.5 flex items-center gap-0.5">
            <button type="button" aria-label={show ? "Hide password" : "Show password"} className="grid h-7 w-7 place-items-center rounded-md text-slate-500 hover:bg-slate-100" onClick={() => setShow(!show)}>
              <Icon name={show ? "visibility_off" : "visibility"} className="text-[18px]" />
            </button>
            {value && <Copy text={value} />}
          </span>
        </div>
        <Button type="button" variant="outline" icon="casino" onClick={() => { onChange(generatePassword()); setShow(true); }}>Generate</Button>
      </div>
      {value ? (
        <div className="mt-1.5 flex items-center gap-2">
          <div className="flex h-1.5 w-28 gap-1">{[0, 1, 2, 3].map((i) => <span key={i} className={cx("flex-1 rounded-full", i < st ? (st >= 3 ? "bg-emerald-500" : st === 2 ? "bg-amber-400" : "bg-rose-400") : "bg-slate-200")} />)}</div>
          <span className={cx("text-xs", problem ? "font-semibold text-rose-600" : "text-mute")}>{problem ?? (st >= 3 ? "Strong" : "OK — longer is better")}</span>
        </div>
      ) : (
        <p className="mt-1.5 text-xs text-mute">{optionalHint}</p>
      )}
    </div>
  );
}
