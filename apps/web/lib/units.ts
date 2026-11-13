/** Bandwidth in GB as people read it on plans: 10000 → "10 TB", 500 → "500 GB", 0 → "Unmetered". */
export function bandwidth(gb?: number | null, unmetered = "Unmetered") {
  if (!gb) return unmetered;
  if (gb >= 1000) {
    const tb = gb / 1000;
    return `${Number.isInteger(tb) ? tb : +tb.toFixed(1)} TB`;
  }
  return `${gb} GB`;
}
