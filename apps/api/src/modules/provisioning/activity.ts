/**
 * What's happening to a service right now (and what just finished): reinstall, change IP, power actions,
 * password reset, suspend … Built from the provisioning queue and the provisioning log, so the service
 * page can show a progress card that updates by itself. Customers get friendly wording — never the
 * internal error text.
 */
import { prisma } from "../../db";
import { provisioningQueue } from "../../jobs/queues";

export type ActivityState = "queued" | "running" | "retrying" | "installing" | "done" | "failed";
export interface ActivityItem {
  id: string;
  action: string;
  label: string;
  state: ActivityState;
  percent: number;
  steps: { label: string; state: "done" | "current" | "pending" | "failed" }[];
  message: string;
  queuedAt: Date | null;
  startedAt: Date | null;
  finishedAt: Date | null;
}

const LABELS: Record<string, { doing: string; done: string }> = {
  reinstall: { doing: "Reinstalling the operating system", done: "Operating system reinstalled" },
  change_ip: { doing: "Changing IP address", done: "IP address changed" },
  reset_password: { doing: "Resetting the password", done: "Password reset" },
  start: { doing: "Starting the VPS", done: "VPS started" },
  stop: { doing: "Powering off", done: "Powered off" },
  shutdown: { doing: "Shutting down", done: "Shut down" },
  reboot: { doing: "Rebooting", done: "Rebooted" },
  hard_reset: { doing: "Hard reset", done: "Hard reset done" },
  suspend: { doing: "Suspending", done: "Suspended" },
  unsuspend: { doing: "Unsuspending", done: "Unsuspended" },
  terminate: { doing: "Terminating", done: "Terminated" },
  change_package: { doing: "Changing the plan", done: "Plan changed" },
  change_plan: { doing: "Changing the plan", done: "Plan changed" },
};
/** what customers are shown (staff see everything) */
const CLIENT_ACTIONS = new Set(["reinstall", "change_ip", "reset_password", "start", "stop", "shutdown", "reboot", "hard_reset", "change_package", "change_plan"]);
const FINISHED_FOR = 10 * 60_000;
const INSTALL_WINDOW = 20 * 60_000;

const stateCache = new Map<string, { at: number; running: boolean | null }>();
/** is the VPS back up after a reinstall? (asked at most every 10 s) */
async function backUp(serviceId: string): Promise<boolean | null> {
  const hit = stateCache.get(serviceId);
  if (hit && hit.at > Date.now() - 10_000) return hit.running;
  const { liveStatus } = await import("./provisioner");
  const st = await liveStatus(serviceId).catch(() => null);
  const running = st ? st.state === "running" : null;
  stateCache.set(serviceId, { at: Date.now(), running });
  return running;
}

function stepsFor(action: string, state: ActivityState) {
  const names = action === "reinstall" ? ["Queued", "Sent to the server", "Installing the OS", "Done"] : ["Queued", "Working on it", "Done"];
  const at = { queued: 0, retrying: 1, running: 1, installing: 2, done: names.length, failed: -1 }[state];
  return names.map((label, i) => ({
    label,
    state: (state === "failed" ? (i === 0 ? "done" : i === 1 ? "failed" : "pending") : i < at ? "done" : i === at ? "current" : "pending") as "done" | "current" | "pending" | "failed",
  }));
}
const PERCENT: Record<ActivityState, number> = { queued: 10, running: 45, retrying: 45, installing: 75, done: 100, failed: 100 };

export async function serviceActivity(serviceId: string, audience: "admin" | "client"): Promise<{ items: ActivityItem[]; active: boolean }> {
  const admin = audience === "admin";
  const show = (a: string) => a !== "create" && a !== "sync" && !!LABELS[a] && (admin || CLIENT_ACTIONS.has(a));
  const svc = await prisma.service.findUnique({ where: { id: serviceId }, select: { product: { select: { provisioner: true } } } });
  const logs = await prisma.provisioningLog.findMany({ where: { serviceId, createdAt: { gt: new Date(Date.now() - INSTALL_WINDOW) } }, orderBy: { createdAt: "desc" }, take: 100 });
  const items: ActivityItem[] = [];

  // waiting / running jobs
  let jobs: { id: string; action: string; state: string; queuedAt: Date; processedOn: Date | null; attempts: number; error: string | null }[] = [];
  try {
    const list = await provisioningQueue().getJobs(["waiting", "active", "delayed", "prioritized", "paused"], 0, 500, true);
    for (const j of list) {
      if (!j?.data || j.data.serviceId !== serviceId || !show(j.data.action)) continue;
      jobs.push({ id: String(j.id), action: j.data.action, state: await j.getState(), queuedAt: new Date(j.timestamp), processedOn: j.processedOn ? new Date(j.processedOn) : null, attempts: j.attemptsMade, error: j.failedReason ?? null });
    }
  } catch {
    jobs = []; // Redis down — the log still tells what finished
  }
  for (const j of jobs) {
    const state: ActivityState = j.state === "active" ? "running" : j.state === "delayed" ? "retrying" : "queued";
    const started = logs.find((l) => l.action === `${j.action}_started` && l.createdAt >= j.queuedAt);
    items.push({
      id: `job-${j.id}`,
      action: j.action,
      label: LABELS[j.action].doing,
      state,
      percent: PERCENT[state],
      steps: stepsFor(j.action, state),
      message:
        state === "retrying"
          ? admin
            ? `The first try failed (${j.error ?? "unknown error"}) — trying again automatically`
            : "The first try didn't finish — trying again automatically"
          : state === "queued"
            ? "Waiting for its turn — this usually starts within seconds"
            : j.action === "change_ip"
              ? "Asking Virtualizor for free addresses and moving the VPS onto them"
              : "Working on it — this page updates by itself",
      queuedAt: j.queuedAt,
      startedAt: started?.createdAt ?? j.processedOn,
      finishedAt: null,
    });
  }

  // just finished (latest result per action, unless the same action is queued again)
  const seen = new Set(jobs.map((j) => j.action));
  for (const l of logs) {
    if (l.action.endsWith("_started") || l.action.endsWith("_requested") || seen.has(l.action) || !show(l.action)) continue;
    seen.add(l.action);
    if (Date.now() - l.createdAt.getTime() > (l.action === "reinstall" ? INSTALL_WINDOW : FINISHED_FOR)) continue;
    const started = logs.find((x) => x.action === `${l.action}_started` && x.createdAt <= l.createdAt);
    let state: ActivityState = l.success ? "done" : "failed";
    // Virtualizor accepts a reinstall straight away and rebuilds the disk afterwards — wait until the VPS is back up
    if (state === "done" && l.action === "reinstall" && svc?.product.provisioner === "VIRTUALIZOR") {
      const up = await backUp(serviceId);
      if (up === false) state = "installing";
    }
    if (state === "done" && Date.now() - l.createdAt.getTime() > FINISHED_FOR) continue;
    items.push({
      id: `log-${l.id}`,
      action: l.action,
      label: state === "installing" || state === "done" ? LABELS[l.action][state === "done" ? "done" : "doing"] : LABELS[l.action].doing,
      state,
      percent: PERCENT[state],
      steps: stepsFor(l.action, state),
      message:
        state === "installing"
          ? "The server is installing the new system — it restarts by itself when it's ready (usually 2–10 minutes)"
          : state === "failed"
            ? admin
              ? l.message ?? "Failed"
              : "This didn't go through. Our team has been alerted and will sort it out — you can also open a support ticket."
            : admin
              ? l.message ?? LABELS[l.action].done
              : l.action === "change_ip"
                ? "Your VPS has new IP addresses — they're shown on this page"
                : l.action === "reinstall"
                  ? "Your VPS is ready with the new operating system. The login details were emailed to you."
                  : LABELS[l.action].done,
      queuedAt: null,
      startedAt: started?.createdAt ?? null,
      finishedAt: l.createdAt,
    });
  }
  items.sort((a, b) => +(b.finishedAt === null) - +(a.finishedAt === null) || (b.finishedAt?.getTime() ?? 0) - (a.finishedAt?.getTime() ?? 0));
  return { items, active: items.some((i) => ["queued", "running", "retrying", "installing"].includes(i.state)) };
}
