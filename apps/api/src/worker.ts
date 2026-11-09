/**
 * Background worker — run as a separate PM2 process: `node dist/worker.js`
 * Queues: provisioning, email, maintenance (IP reservation expiry, server health, daily billing).
 */
import { Worker, type Job } from "bullmq";
import { bullConnection, maintenanceQueue, closeQueues, type EmailJob, type ProvisionJob } from "./jobs/queues";
import { runProvisionAction, markCreateFailed } from "./modules/provisioning/provisioner";
import { sendTemplatedEmail } from "./modules/email/mailer";
import { expireReservations } from "./modules/ipam/service";
import { runBillingCycle } from "./jobs/billing";
import { checkAllServers } from "./jobs/health";
import { refreshExchangeRates } from "./lib/currency";
import { getSettings } from "./lib/settings";
import { prisma } from "./db";
import { executeMigrationRun } from "./modules/migration/service";

const connection = bullConnection();

const provisioning = new Worker<ProvisionJob>(
  "provisioning",
  async (job: Job<ProvisionJob>) => runProvisionAction(job.data.serviceId, job.data.action, job.data.params ?? {}),
  { connection, concurrency: 4, lockDuration: 30 * 60_000 },
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
email.on("failed", (job, err) => console.error(`[email] ${job?.data.template} → ${job?.data.to} failed:`, err.message));

const maintenance = new Worker(
  "maintenance",
  async (job) => {
    switch (job.name) {
      case "expire-ip-reservations":
        return { released: await expireReservations() };
      case "server-health":
        return checkAllServers();
      case "daily-billing":
        return runBillingCycle();
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
  await q.upsertJobScheduler("daily-billing", { pattern: "0 9 * * *", tz: "Asia/Kolkata" }, { name: "daily-billing" });
  // before billing runs, so renewal invoices use today's rate
  await q.upsertJobScheduler("fx-rates", { pattern: "30 8 * * *", tz: "Asia/Kolkata" }, { name: "fx-rates" });
  console.log("[worker] schedules registered: IP expiry (1m), server health (5m), billing (09:00 IST)");
}

schedule().catch((e) => {
  console.error("[worker] failed to register schedules", e);
  process.exit(1);
});

async function shutdown() {
  console.log("[worker] shutting down");
  await Promise.all([provisioning.close(), email.close(), maintenance.close(), migration.close()]);
  await closeQueues();
  await prisma.$disconnect();
  process.exit(0);
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
console.log("[worker] started");
