"use client";
/* eslint-disable @next/next/no-img-element */
import {
  siAlmalinux,
  siAlpinelinux,
  siArchlinux,
  siCentos,
  siDebian,
  siFedora,
  siFreebsd,
  siGentoo,
  siKalilinux,
  siLinux,
  siOpensuse,
  siRedhat,
  siRockylinux,
  siSuse,
  siUbuntu,
  type SimpleIcon,
} from "simple-icons";
import { Icon, cx } from "./ui";

/**
 * Official distribution marks from the Simple Icons project (CC0 icon data, brand colours).
 * Windows isn't in any open icon set — it gets a neutral desktop icon unless the admin sets a logo URL.
 */
const ICONS: Record<string, SimpleIcon> = {
  ubuntu: siUbuntu,
  debian: siDebian,
  almalinux: siAlmalinux,
  alma: siAlmalinux,
  rocky: siRockylinux,
  rockylinux: siRockylinux,
  centos: siCentos,
  fedora: siFedora,
  rhel: siRedhat,
  redhat: siRedhat,
  freebsd: siFreebsd,
  arch: siArchlinux,
  archlinux: siArchlinux,
  opensuse: siOpensuse,
  suse: siSuse,
  alpine: siAlpinelinux,
  alpinelinux: siAlpinelinux,
  kali: siKalilinux,
  kalilinux: siKalilinux,
  gentoo: siGentoo,
};

export const OS_LABELS: Record<string, string> = {
  ubuntu: "Ubuntu", debian: "Debian", almalinux: "AlmaLinux", alma: "AlmaLinux", rocky: "Rocky Linux", rockylinux: "Rocky Linux", centos: "CentOS",
  fedora: "Fedora", rhel: "Red Hat Enterprise Linux", redhat: "Red Hat", freebsd: "FreeBSD", arch: "Arch Linux", archlinux: "Arch Linux",
  opensuse: "openSUSE", suse: "SUSE", alpine: "Alpine Linux", alpinelinux: "Alpine Linux", kali: "Kali Linux", kalilinux: "Kali Linux",
  gentoo: "Gentoo", cloudlinux: "CloudLinux", oracle: "Oracle Linux", windows: "Windows",
};

export type OsLike = { name: string; family?: string | null; distro?: string | null; logoUrl?: string | null };

/** Normalised distro key: "Rocky Linux 9" / "rocky" → "rocky", any Windows → "windows". */
export function osKey(o: OsLike): string {
  if (o.family === "windows" || /^win/i.test(o.distro ?? "") || /windows/i.test(o.name)) return "windows";
  const k = (o.distro || o.name.split(" ")[0] || "").toLowerCase().replace(/[^a-z]/g, "");
  if (k === "rockylinux") return "rocky";
  if (k === "alma") return "almalinux";
  if (k === "red" || k === "redhat") return "rhel";
  return k;
}

/** Very light brand colours (Tux yellow) need a dark glyph to stay visible on white. */
function readable(hex: string) {
  const n = parseInt(hex, 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 200 ? "#1f2937" : `#${hex}`;
}

export function OsLogo({ os, size = 40, className }: { os: OsLike; size?: number; className?: string }) {
  const box = { width: size, height: size };
  const tile = cx("grid shrink-0 place-items-center overflow-hidden rounded-xl bg-white ring-1 ring-[#ece4fb] shadow-sm", className);
  if (os.logoUrl) {
    return (
      <span className={tile} style={box}>
        <img src={os.logoUrl} alt="" className="h-[70%] w-[70%] object-contain" />
      </span>
    );
  }
  const key = osKey(os);
  if (key === "windows") {
    return (
      <span className={tile} style={box} title="Windows">
        <Icon name="desktop_windows" className="text-[#0078D4]" />
      </span>
    );
  }
  const icon = ICONS[key] ?? (os.family !== "windows" ? siLinux : undefined);
  if (!icon) {
    return (
      <span className={cx(tile, "font-black text-primary-dark")} style={box}>
        {os.name[0]?.toUpperCase()}
      </span>
    );
  }
  return (
    <span className={tile} style={box} title={icon.title}>
      <svg viewBox="0 0 24 24" role="img" aria-label={icon.title} style={{ width: size * 0.6, height: size * 0.6 }} fill={readable(icon.hex)}>
        <path d={icon.path} />
      </svg>
    </span>
  );
}
