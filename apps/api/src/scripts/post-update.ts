/**
 * Runs after every panel update (deploy/install.sh, not on first install):
 * the same as pressing "Sync all" for Virtualizor — services (IPs, node, hostname), IP pools and OS templates.
 *   node dist/scripts/post-update.js        (or: npx tsx src/scripts/post-update.ts)
 * Never fails the update: problems are printed and recorded in the Activity Log.
 */
import { prisma } from "../db";
import { audit } from "../lib/audit";
import { runSyncAll, type SyncAllState } from "../modules/provisioning/virtualizor-sync-all";
import { syncVirtualizorIps } from "../modules/provisioning/virtualizor-ips";
import { syncVirtualizorOs } from "../modules/provisioning/virtualizor-os";

const line = (s: string) => console.log(`    ${s}`);
const msg = (e: unknown) => String((e as Error)?.message ?? e).slice(0, 200);

export async function postUpdateSync() {
  const masters = await prisma.server.findMany({ where: { type: "VIRTUALIZOR", enabled: true } });
  if (!masters.length) {
    line("No Virtualizor servers — nothing to sync");
    return null;
  }
  const report: Record<string, unknown> = {};

  // 1. services ← Virtualizor (shows up under VPS & Services → "Sync all" as the last run)
  const s: SyncAllState = { status: "running", startedAt: new Date().toISOString(), startedBy: "panel update", phase: "Reading VPS lists from Virtualizor", servers: [], checked: 0, total: 0, updated: 0, unchanged: 0, missing: [], duplicates: [], changes: [] };
  try {
    await runSyncAll(s);
    line(`Services: ${s.checked}/${s.total} checked · ${s.updated} updated · ${s.unchanged} unchanged · ${s.missing.length} not found${s.duplicates?.length ? ` · ${s.duplicates.length} duplicates` : ""}`);
    for (const sv of s.servers) if (sv.error) line(`  ${sv.name}: ${sv.error}`);
    report.services = { total: s.total, updated: s.updated, unchanged: s.unchanged, missing: s.missing.length, serverErrors: s.servers.filter((x) => x.error) };
  } catch (e) {
    line(`Services: failed — ${msg(e)}`);
    report.services = { error: msg(e) };
  }

  // 2. IP pools and 3. OS templates, per master
  for (const [label, fn] of [["IP pools", syncVirtualizorIps], ["OS templates", syncVirtualizorOs]] as const) {
    const out: unknown[] = [];
    for (const m of masters) {
      try {
        const r = await (fn as (srv: typeof m) => Promise<unknown>)(m);
        out.push({ server: m.name, ok: true, ...(r as object) });
        line(`${label} · ${m.name}: ok`);
      } catch (e) {
        out.push({ server: m.name, ok: false, error: msg(e) });
        line(`${label} · ${m.name}: failed — ${msg(e)}`);
      }
    }
    report[label === "IP pools" ? "ips" : "os"] = out;
  }

  await audit({ action: "virtualizor.post_update_sync", entity: "server", entityId: "*", details: report });
  return report;
}

if (/post-update\.(js|ts)$/.test(process.argv[1] ?? "")) {
  const stop = setTimeout(() => {
    console.log("    Virtualizor sync is taking too long — stopped; run it from VPS & Services → Sync all");
    process.exit(0);
  }, 10 * 60_000);
  postUpdateSync()
    .catch((e) => console.log(`    Virtualizor sync failed: ${msg(e)}`))
    .finally(async () => {
      clearTimeout(stop);
      await prisma.$disconnect().catch(() => undefined);
      process.exit(0);
    });
}
