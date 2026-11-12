import Link from "next/link";
import { Icon, cx } from "./ui";

/** Order progress. Hosting plans get WHMCS's extra "Domain" step between the plan and its options. */
export function OrderSteps({ step, hosting = false }: { step: 1 | 2 | 3 | 4; hosting?: boolean }) {
  const steps: readonly (readonly [string, string | null])[] = hosting
    ? [["Choose plan", "/order"], ["Domain", null], ["Configure", null], ["Review & pay", "/order/cart"]]
    : [["Choose plan", "/order"], ["Configure", null], ["Review & pay", "/order/cart"]];
  return (
    <ol className="mb-8 flex items-center gap-1.5 text-[13px] font-bold sm:gap-4">
      {steps.map(([l, href], i) => {
        const n = i + 1;
        const inner = (
          <span className={cx("flex items-center gap-2", n === step ? "text-primary-dark" : n < step ? "text-slate-700" : "text-slate-400")}>
            <span className={cx("grid h-7 w-7 place-items-center rounded-full text-xs", n === step ? "bg-primary-dark text-white shadow-glow" : n < step ? "bg-primary-soft text-primary-dark" : "bg-slate-200 text-slate-500")}>
              {n < step ? <Icon name="check" className="text-[16px]" /> : n}
            </span>
            <span className={n === step ? "inline" : "hidden sm:inline"}>{l}</span>
          </span>
        );
        return (
          <li key={l} className="flex items-center gap-1.5 sm:gap-4">
            {href && n < step ? <Link href={href}>{inner}</Link> : inner}
            {i < steps.length - 1 && <span className="h-px w-5 bg-slate-300 sm:w-12" />}
          </li>
        );
      })}
    </ol>
  );
}
