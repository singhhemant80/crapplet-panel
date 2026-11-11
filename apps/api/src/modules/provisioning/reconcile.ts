import { prisma } from "../../db";
import { enqueueProvision, provisioningQueue, redis } from "../../jobs/queues";
import { markCreateFailed } from "./provisioner";

/**
 * Locks for one-operation-per-service live in Redis. Only the worker takes them, so when the worker
 * (re)starts nothing can be holding one — any left over came from a run killed mid-way (pm2 restart,
 * crash) and would otherwise block that service for 30 minutes.
 */
export async function clearStaleServiceLocks() {
  const r = redis();
  let cursor = "0";
  let cleared = 0;
  do {
    const [next, keys] = await r.scan(cursor, "MATCH", "crapplet:lock:service:*", "COUNT", 200);
    cursor = next;
    if (keys.length) cleared += await r.del(...keys);
  } while (cursor !== "0");
  return cleared;
}

/**
 * Safety net, every 5 minutes: a service can't sit in PROVISIONING with nothing working on it.
 * - its create job failed for good → mark FAILED (staff are emailed, the tracker shows the reason)
 * - no job at all (lost on restart) → queue it again; the create step first looks for a VPS an earlier
 *   attempt already built in Virtualizor, so this never builds a second one
 */
export async function reconcileProvisioning() {
  const quiet = new Date(Date.now() - 10 * 60_000);
  const stuck = await prisma.service.findMany({
    where: { status: "PROVISIONING", updatedAt: { lt: quiet }, product: { provisioner: { in: ["PROXMOX", "VIRTUALIZOR", "CPANEL"] } } },
    select: { id: true, updatedAt: true, logs: { orderBy: { createdAt: "desc" }, take: 1, select: { createdAt: true } } },
    take: 50,
  });
  const out = { checked: stuck.length, failed: 0, requeued: 0 };
  for (const s of stuck) {
    if (s.logs[0] && s.logs[0].createdAt > quiet) continue; // still logging — busy
    const job = await provisioningQueue().getJob(`create-${s.id}`);
    const state = job ? await job.getState() : "missing";
    if (state === "active" || state === "waiting" || state === "delayed" || state === "prioritized" || state === "waiting-children") continue;
    const lastSeen = s.logs[0]?.createdAt ?? s.updatedAt;
    if (state === "failed") {
      await markCreateFailed(s.id, job?.failedReason || "Provisioning stopped without finishing");
      out.failed++;
    } else if (Date.now() - lastSeen.getTime() > 24 * 3600_000) {
      // stuck for over a day — don't suddenly build it; let staff decide
      await markCreateFailed(s.id, "Setup stopped more than a day ago without finishing — click Retry provisioning if it's still wanted");
      out.failed++;
    } else {
      await prisma.provisioningLog.create({ data: { serviceId: s.id, action: "create", success: true, message: "Setup had stopped without finishing (worker restart?) — queued again automatically" } });
      await enqueueProvision({ serviceId: s.id, action: "create" });
      out.requeued++;
    }
  }
  return out;
}
