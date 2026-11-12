import { Queue, type ConnectionOptions } from "bullmq";
import IORedis from "ioredis";
import { config } from "../config";

let connection: IORedis | null = null;
export function redis(): IORedis {
  if (!connection) connection = new IORedis(config.redisUrl, { maxRetriesPerRequest: null });
  return connection;
}
export const bullConnection = (): ConnectionOptions => redis() as unknown as ConnectionOptions;

export type ProvisionAction =
  | "create"
  | "suspend"
  | "unsuspend"
  | "terminate"
  | "start"
  | "stop"
  | "shutdown"
  | "reboot"
  | "reinstall"
  | "reset_password"
  | "change_package"
  | "hard_reset"
  | "sync";

export interface ProvisionJob {
  serviceId: string;
  action: ProvisionAction;
  params?: Record<string, unknown>;
  actorId?: string;
}

export interface EmailJob {
  template: string;
  to: string;
  vars: Record<string, unknown>;
  userId?: string;
  attachments?: { filename: string; invoiceId: string }[];
}

export interface PaymentJob {
  intentId: string;
}

const queues: Record<string, Queue> = {};
function q<T>(name: string): Queue<T> {
  if (!queues[name]) {
    queues[name] = new Queue(name, {
      connection: bullConnection(),
      defaultJobOptions: { removeOnComplete: 1000, removeOnFail: 5000 },
    });
  }
  return queues[name] as Queue<T>;
}

export const provisioningQueue = () => q<ProvisionJob>("provisioning");
export const emailQueue = () => q<EmailJob>("email");
export const whatsappQueue = () => q<{ messageId: string; vars: Record<string, unknown> }>("whatsapp");
export const paymentQueue = () => q<PaymentJob>("payments");
export const migrationQueue = () => q<{ runId: string }>("migration");
export const latencyQueue = () => q<Record<string, never>>("latency");
export const backupQueue = () => q<{ runId?: string }>("backup");
export const maintenanceQueue = () => q<Record<string, unknown>>("maintenance");

export async function enqueueProvision(job: ProvisionJob) {
  // jobId de-duplicates repeated "create" requests for the same service
  const jobId = job.action === "create" ? `create-${job.serviceId}` : undefined;
  if (jobId) {
    // BullMQ ignores add() when a job with this id still exists — a finished/failed one from an earlier
    // attempt would silently swallow "Retry provisioning". Clear it; keep a waiting/running one.
    const old = await provisioningQueue().getJob(jobId);
    if (old) {
      const state = await old.getState();
      if (state === "failed" || state === "completed") await old.remove();
      else return old;
    }
  }
  return provisioningQueue().add(job.action, job, {
    jobId,
    attempts: job.action === "create" ? 3 : 2,
    backoff: { type: "exponential", delay: 30_000 },
  });
}

export async function closeQueues() {
  await Promise.all(Object.values(queues).map((x) => x.close()));
  if (connection) await connection.quit();
}
