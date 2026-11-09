"use client";
import { cx } from "./ui";

type Os = { id: string; name: string; family: string; distro?: string | null };

const BRAND: Record<string, { label: string; color: string; mark: string }> = {
  ubuntu: { label: "Ubuntu", color: "#E95420", mark: "U" },
  debian: { label: "Debian", color: "#A81D33", mark: "D" },
  almalinux: { label: "AlmaLinux", color: "#0F4266", mark: "A" },
  alma: { label: "AlmaLinux", color: "#0F4266", mark: "A" },
  rocky: { label: "Rocky Linux", color: "#10B981", mark: "R" },
  rockylinux: { label: "Rocky Linux", color: "#10B981", mark: "R" },
  centos: { label: "CentOS", color: "#932279", mark: "C" },
  fedora: { label: "Fedora", color: "#51A2DA", mark: "F" },
  cloudlinux: { label: "CloudLinux", color: "#0097F3", mark: "CL" },
  oracle: { label: "Oracle Linux", color: "#C74634", mark: "O" },
  windows: { label: "Windows", color: "#0078D4", mark: "⊞" },
  freebsd: { label: "FreeBSD", color: "#AB2B28", mark: "B" },
  arch: { label: "Arch Linux", color: "#1793D1", mark: "A" },
  opensuse: { label: "openSUSE", color: "#73BA25", mark: "S" },
  alpine: { label: "Alpine", color: "#0D597F", mark: "A" },
  kali: { label: "Kali Linux", color: "#367BF0", mark: "K" },
};

const keyOf = (o: Os) => {
  if (o.family === "windows") return "windows";
  const k = (o.distro || o.name.split(" ")[0]).toLowerCase().replace(/[^a-z]/g, "");
  return k === "rocky" || k === "rockylinux" ? "rocky" : k === "alma" ? "almalinux" : k;
};
const brandOf = (k: string, sample: Os) => BRAND[k] ?? { label: sample.name.split(" ")[0], color: "#7c3aed", mark: sample.name[0]?.toUpperCase() ?? "?" };
/** "Ubuntu 24.04" under the Ubuntu card → "24.04" */
const versionLabel = (o: Os, brand: string) => o.name.replace(new RegExp(`^${brand}\\s*`, "i"), "").replace(/^Windows\s*/i, "") || o.name;

/** Distro cards with a version dropdown each (like the big clouds' OS pickers). */
export function OsChooser({ options, value, onChange }: { options: Os[]; value: string; onChange: (id: string) => void }) {
  const groups = new Map<string, Os[]>();
  for (const o of options) {
    const k = keyOf(o);
    groups.set(k, [...(groups.get(k) ?? []), o]);
  }
  // newest version first inside each distro
  for (const list of groups.values()) list.sort((a, b) => b.name.localeCompare(a.name, undefined, { numeric: true }));
  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {[...groups.entries()].map(([k, list]) => {
        const brand = brandOf(k, list[0]);
        const chosen = list.find((o) => o.id === value);
        const active = !!chosen;
        return (
          <div
            key={k}
            role="button"
            tabIndex={0}
            onClick={() => !active && onChange(list[0].id)}
            onKeyDown={(e) => e.key === "Enter" && !active && onChange(list[0].id)}
            className={cx(
              "group relative cursor-pointer rounded-2xl border bg-white p-3.5 transition",
              active ? "border-primary ring-2 ring-primary/25 shadow-[0_8px_24px_rgba(124,58,237,.12)]" : "border-line hover:-translate-y-0.5 hover:border-primary/40 hover:shadow-md",
            )}
          >
            <div className="flex items-center gap-3">
              <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl text-sm font-black text-white shadow-sm" style={{ background: brand.color }}>
                {brand.mark}
              </span>
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-extrabold text-ink">{brand.label}</div>
                <div className="text-xs text-mute">{list.length} version{list.length === 1 ? "" : "s"}</div>
              </div>
              <span className={cx("grid h-5 w-5 place-items-center rounded-full border-2", active ? "border-primary bg-primary" : "border-slate-300")}>
                {active && <span className="h-2 w-2 rounded-full bg-white" />}
              </span>
            </div>
            <select
              aria-label={`${brand.label} version`}
              className={cx("mt-3 h-9 w-full rounded-lg border px-2 text-sm font-semibold outline-none", active ? "border-primary/40 bg-primary-tint text-primary-dark" : "border-line bg-slate-50 text-slate-600")}
              value={chosen?.id ?? list[0].id}
              onClick={(e) => e.stopPropagation()}
              onChange={(e) => onChange(e.target.value)}
            >
              {list.map((o) => (
                <option key={o.id} value={o.id}>
                  {versionLabel(o, brand.label)}
                </option>
              ))}
            </select>
          </div>
        );
      })}
    </div>
  );
}
