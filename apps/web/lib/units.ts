/** Bandwidth in GB as people read it on plans: 10000 → "10 TB", 500 → "500 GB", 0 → "Unmetered". */
export function bandwidth(gb?: number | null, unmetered = "Unmetered") {
  if (!gb) return unmetered;
  // placeholder "huge" values (WHMCS / Virtualizor use e.g. 999999 TB for unlimited) read as Unlimited
  if (gb >= 1_000_000) return "Unlimited";
  if (gb >= 1000) {
    const tb = gb / 1000;
    return `${Number.isInteger(tb) ? tb : +tb.toFixed(1)} TB`;
  }
  return `${gb} GB`;
}
