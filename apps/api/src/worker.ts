/**
 * Background worker — run as a separate PM2 process: `node dist/worker.js`
 * Queues: provisioning, email, maintenance (IP reservation expiry, server health, daily billing).
 */
import { Worker, type Job } from "bullmq";
import { bullConnection, maintenanceQueue, closeQueues, type EmailJob, type ProvisionJob } from "./jobs/queues";
import { runProvisionAction, markCreateFailed } from "./modules/provisioning/provisioner";
import { sendTemplatedEmail } from "./modules/email/mailer";
import { expireReservations } from "./modules/ipam/service";
import { maybeRunScheduled } from "./jobs/billing";
import { deliverWhatsapp } from "./modules/whatsapp/service";
import { checkAllServers } from "./jobs/health";
import { refreshExchangeRates } from "./lib/currency";
import { syncVirtualizorOs } from "./modules/provisioning/virtualizor-os";
import { syncVirtualizorIps } from "./modules/provisioning/virtualizor-ips";
import { getSettings } from "./lib/settings";
import { prisma } from "./db";
import { executeMigrationRun } from "./modules/migration/service";
import { clearStaleServiceLocks, reconcileProvisioning } from "./modules/provisioning/reconcile";
import { reconcileOrderStatuses } from "./modules/orders/status";

const connection = bullConnection();

const provisioning = new Worker<ProvisionJob>(
  "provisioning",
  async (job: Job<ProvisionJob>) => runProvisionAction(job.data.serviceId, job.data.action, job.data.params ?? {}),
  // short lock, renewed automatically while a job runs: a run killed by a restart is picked up again
  // within about a minute instead of looking "active" for half an hour
  { connection, concurrency: 4, lockDuration: 60_000, stalledInterval: 30_000, maxStalledCount: 3, autorun: false },
);
provisioning.on("failed", async (job, err) => {
  if (!job) return;
  console.error(`[provisioning] ${job.name} ${job.data.serviceId} failed (attempt ${job.attemptsMade}/${job.opts.attempts}):`, err.message);
  if (job.data.action === "create" && job.attemptsMade >= (job.opts.attempts ?? 1)) {
    const svc = await prisma.service.findUnique({ where: { id: job.data.serviceId } });
    if (svc && svc.status !== "ACTIVE" && svc.status !== "FAILED") await markCreateFailed(svc.id, err.message);
  }
});
provisioning.on("completed", (job) => console.log(`[provisioning] ${job.name} ${job.data.serviceId} done`));

const email = new Worker<EmailJob>("email", async (job) => sendTemplatedEmail(job.data), { connection, concurrency: 5 });
const whatsapp = new Worker<{ messageId: string; vars: Record<string, unknown> }>("whatsapp", async (job) => deliverWhatsapp(job.data.messageId, job.data.vars), { connection, concurrency: 3 });
whatsapp.on("failed", (job, err) => console.error(`[whatsapp] ${job?.name} failed:`, err.message));
email.on("failed", (job, err) => console.error(`[email] ${job?.data.template} → ${job?.data.to} failed:`, err.message));

const maintenance = new Worker(
  "maintenance",
  async (job) => {
    switch (job.name) {
      case "expire-ip-reservations":
        return { released: await expireReservations() };
      case "reconcile-provisioning":
        return reconcileProvisioning();
      case "reconcile-orders":
        return reconcileOrderStatuses();
      case "server-health":
        return checkAllServers();
      case "daily-billing": // schedule from older versions — replaced by automation-tick
        return maybeRunScheduled();
      case "automation-tick":
        return maybeRunScheduled();
      case "sync-os": {
        // keep OS templates in step with every Virtualizor master
        const masters = await prisma.server.findMany({ where: { type: "VIRTUALIZOR", enabled: true } });
        return Promise.all(
          masters.map(async (m) => ({
            server: m.name,
            os: await syncVirtualizorOs(m).catch((e) => ({ error: String(e.message ?? e) })),
            ips: await syncVirtualizorIps(m).catch((e) => ({ error: String(e.message ?? e) })),
          })),
        );
      }
      case "sync-ips": {
        // IP Management mirrors Virtualizor — refresh every 10 minutes
        const masters = await prisma.server.findMany({ where: { type: "VIRTUALIZOR", enabled: true } });
        return Promise.all(masters.map(async (m) => ({ server: m.name, ips: await syncVirtualizorIps(m).catch((e) => ({ error: String(e.message ?? e) })) })));
      }
      case "fx-rates": {
        if (!(await getSettings()).currency.autoUpdateRates) return { skipped: "auto-update off" };
        return refreshExchangeRates();
      }
    }
  },
  { connection, concurrency: 1 },
);
maintenance.on("failed", (job, err) => console.error(`[maintenance] ${job?.name} failed:`, err.message));

// one import at a time; a large WHMCS can take a while
const migration = new Worker<{ runId: string }>("migration", async (job) => executeMigrationRun(job.data.runId), { connection, concurrency: 1, lockDuration: 2 * 60 * 60_000 });
migration.on("failed", (job, err) => console.error(`[migration] ${job?.data.runId} failed:`, err.message));

async function schedule() {
  const q = maintenanceQueue();
  await q.upsertJobScheduler("expire-ip-reservations", { every: 60_000 }, { name: "expire-ip-reservations" });
  await q.upsertJobScheduler("server-health", { every: 5 * 60_000 }, { name: "server-health" });
  await q.upsertJobScheduler("reconcile-provisioning", { every: 5 * 60_000 }, { name: "reconcile-provisioning" });
  await q.upsertJobScheduler("reconcile-orders", { every: 5 * 60_000 }, { name: "reconcile-orders" });

  // daily automation: checked every 5 minutes, runs once a day after Settings → Automation → run time
  await q.removeJobScheduler("daily-billing").catch(() => undefined);
  await q.upsertJobScheduler("automation-tick", { every: 5 * 60_000 }, { name: "automation-tick" });
  // before billing runs, so renewal invoices use today's rate
  await q.upsertJobScheduler("sync-os", { pattern: "0 3 * * *", tz: "Asia/Kolkata" }, { name: "sync-os" });
  await q.upsertJobScheduler("sync-ips", { every: 10 * 60_000 }, { name: "sync-ips" });
  await q.upsertJobScheduler("fx-rates", { pattern: "30 8 * * *", tz: "Asia/Kolkata" }, { name: "fx-rates" });
  console.log("[worker] schedules registered: IP expiry (1m), server health (5m), automation (daily, checked every 5m)");
}

// bring every order's status in line with its services once at start-up (fixes old orders too)
reconcileOrderStatuses()
  .then((r) => r.fixed && console.log(`[worker] corrected the status of ${r.fixed} order(s)`))
  .catch((e) => console.error("[worker] order status check failed", e));

// clear locks left by a killed run BEFORE taking provisioning jobs, so a fresh lock is never deleted
clearStaleServiceLocks()
  .catch(() => 0)
  .then((cleared) => {
    if (cleared) console.log(`[worker] cleared ${cleared} provisioning lock(s) left by a previous run`);
    provisioning.run().catch((e) => console.error("[worker] provisioning worker stopped", e));
  });

schedule().catch((e) => {
  console.error("[worker] failed to register schedules", e);
  process.exit(1);
});

async function shutdown() {
  console.log("[worker] shutting down");
  await Promise.all([provisioning.close(), email.close(), whatsapp.close(), maintenance.close(), migration.close()]);
  await closeQueues();
  await prisma.$disconnect();
  process.exit(0);
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
console.log("[worker] started");
