import { prisma } from "../../db";
import { provisioningQueue } from "../../jobs/queues";

/**
 * Step-by-step provisioning status for one service, built from its order, invoice, the provisioning
 * log and the BullMQ job. "admin" gets node/storage/error details; "client" gets friendly wording only.
 */
export type StepState = "done" | "current" | "pending" | "failed";
export interface Step {
  key: "order" | "payment" | "queue" | "server" | "create" | "ready";
  label: string;
  state: StepState;
  at?: Date | null;
  detail?: string;
}
export interface Progress {
  serviceId: string;
  status: string;
  /** still moving — the UI should poll */
  inProgress: boolean;
  /** PROVISIONING but no queue job and nothing logged for 15 min — worker stopped or job lost */
  stuck: boolean;
  percent: number;
  headline: string;
  message: string;
  steps: Step[];
  invoiceId?: string | null;
  job?: { state: string; attempt: number; maxAttempts: number; nextRetryAt: Date | null; lastError?: string | null } | null;
  error?: string | null;
  startedAt?: Date | null;
  finishedAt?: Date | null;
  now: Date;
}

const PLACED = /^(Placing VPS|Cloned template|Created container)/;
const CREATED = /^(Virtualizor VPS \S+ created|VPS \S+ running on|Created container)/;

async function jobInfo(serviceId: string) {
  try {
    const job = await provisioningQueue().getJob(`create-${serviceId}`);
    if (!job) return null;
    const state = await job.getState();
    const nextRetryAt = state === "delayed" ? new Date(job.timestamp + (job.opts.delay ?? 0)) : null;
    return { state, attempt: job.attemptsMade + (state === "active" ? 1 : 0), maxAttempts: job.opts.attempts ?? 1, nextRetryAt, lastError: job.failedReason ?? null };
  } catch {
    return null; // Redis down — the log still tells the story
  }
}

export async function provisioningProgress(serviceId: string, audience: "admin" | "client"): Promise<Progress> {
  const s = await prisma.service.findUniqueOrThrow({
    where: { id: serviceId },
    include: {
      product: { select: { provisioner: true, autoSetup: true } },
      order: { select: { id: true, createdAt: true, invoice: { select: { id: true, status: true, paidAt: true, total: true } } } },
      logs: { where: { action: "create" }, orderBy: { createdAt: "asc" }, take: 200 },
    },
  });
  const admin = audience === "admin";
  const isVps = s.product.provisioner === "PROXMOX" || s.product.provisioner === "VIRTUALIZOR";
  const logs = s.logs;
  // only look at the latest attempt: everything after the last "Provisioning started"
  const lastStart = [...logs].reverse().find((l) => l.message?.startsWith("Provisioning started"));
  const attempt = lastStart ? logs.filter((l) => l.createdAt >= lastStart.createdAt) : logs;
  const placed = attempt.find((l) => l.success && PLACED.test(l.message ?? ""));
  const created = attempt.find((l) => l.success && CREATED.test(l.message ?? ""));
  const lastFail = [...attempt].reverse().find((l) => !l.success);
  const inv = s.order?.invoice ?? null;
  const invoicePaid = !inv || inv.total === 0 || inv.status === "PAID";
  // staff can provision before payment (Provision now / Retry) — then payment no longer blocks setup
  const setupStarted = logs.length > 0 || ["PROVISIONING", "ACTIVE", "SUSPENDED", "FAILED"].includes(s.status);
  const paid = invoicePaid || setupStarted;
  const job = ["PENDING", "PROVISIONING", "FAILED"].includes(s.status) ? await jobInfo(s.id) : null;

  const steps: Step[] = [
    { key: "order", label: "Order placed", state: "done", at: s.order?.createdAt ?? s.createdAt },
    {
      key: "payment",
      label: invoicePaid ? (inv && inv.total > 0 ? "Payment received" : "No payment needed") : paid ? (admin ? "Unpaid — started by staff" : "Payment pending") : "Waiting for payment",
      state: paid ? "done" : "current",
      at: inv?.paidAt ?? null,
    },
    { key: "queue", label: "Queued for setup", state: "pending" },
    { key: "server", label: isVps ? "Server selected" : "Setting up", state: "pending" },
    { key: "create", label: isVps ? "Creating your VPS" : "Activating", state: "pending" },
    { key: "ready", label: isVps ? "Ready — login details emailed" : "Active", state: "pending" },
  ];
  const at = (k: Step["key"]) => steps.find((x) => x.key === k)!;

  const started = !!lastStart || attempt.length > 0;
  if (paid) {
    if (started || s.status === "ACTIVE") Object.assign(at("queue"), { state: "done", at: lastStart?.createdAt ?? attempt[0]?.createdAt ?? null });
    else if (s.status === "PENDING" && s.product.autoSetup === "MANUAL") Object.assign(at("queue"), { state: "current", label: "Waiting for staff to approve", detail: admin ? "This plan is set to manual setup — click Provision now" : "Our team sets this plan up by hand" });
    else Object.assign(at("queue"), { state: "current", detail: job?.state === "delayed" && job.nextRetryAt ? `Next attempt at ${job.nextRetryAt.toISOString()}` : undefined });
  }
  if (placed) Object.assign(at("server"), { state: "done", at: placed.createdAt, detail: admin ? placed.message?.replace(/^Placing VPS:\s*/, "") : undefined });
  else if (started && s.status !== "ACTIVE") at("server").state = "current";
  if (created || s.status === "ACTIVE") Object.assign(at("create"), { state: "done", at: created?.createdAt ?? null, detail: admin ? created?.message ?? undefined : undefined });
  else if (placed) at("create").state = "current";
  if (s.status === "ACTIVE" || (["SUSPENDED", "TERMINATED"].includes(s.status) && (created || s.remoteId))) {
    for (const st of steps) if (st.state !== "done") st.state = "done";
    at("ready").at = created?.createdAt ?? null;
  }
  if (!isVps && s.status === "ACTIVE") at("server").state = "done";

  const failed = s.status === "FAILED";
  const error = failed || (job?.state === "delayed" && job.lastError) || job?.state === "failed" ? lastFail?.message ?? job?.lastError ?? null : null;
  if (failed) {
    const cur = steps.find((x) => x.state === "current") ?? steps.find((x) => x.state === "pending");
    // the full error is in the header — keep the step short
    if (cur) Object.assign(cur, { state: "failed", detail: admin && error ? (error.length > 140 ? `${error.slice(0, 140)}…` : error) : undefined });
  }

  const done = steps.filter((x) => x.state === "done").length;
  const percent = Math.round((done / steps.length) * 100);
  const inProgress = !failed && paid && ["PENDING", "PROVISIONING"].includes(s.status) && !(s.status === "PENDING" && s.product.autoSetup === "MANUAL");
  const retrying = job?.state === "delayed";
  const lastActivity = Math.max(s.updatedAt.getTime(), ...attempt.map((l) => l.createdAt.getTime()));
  // a create job that failed for good while the service still says PROVISIONING is stuck right away;
  // no job at all is only stuck after 15 quiet minutes (the 5-minute safety check re-queues it)
  const stuck =
    s.status === "PROVISIONING" &&
    ((job?.state === "failed") || ((!job || job.state === "completed") && Date.now() - lastActivity > 15 * 60_000));
  if (stuck && job?.state === "failed") {
    const cur = steps.find((x) => x.state === "current") ?? steps.find((x) => x.state === "pending");
    if (cur) cur.state = "failed";
  }
  const waitingOnVirtualizor = !!attempt.length && /hasn't answered yet/.test(attempt[attempt.length - 1].message ?? "");

  let headline: string;
  let message: string;
  if (s.status === "ACTIVE") {
    headline = isVps ? "Your VPS is ready" : "Service active";
    message = isVps ? "Login details were sent by email. You can also reveal the password on this page." : "";
  } else if (failed) {
    headline = "Setup needs attention";
    message = admin ? error ?? "See the provisioning log." : "We hit a problem while setting up your server. Our team has been alerted and will finish it for you — no action is needed on your side.";
  } else if (!paid) {
    headline = "Waiting for payment";
    message = "Setup starts automatically as soon as the invoice is paid.";
  } else if (stuck) {
    headline = admin ? (job?.state === "failed" ? "Setup stopped after all attempts" : "Stuck — nothing is working on it") : "Taking longer than usual";
    message = admin
      ? job?.state === "failed"
        ? `All ${job.maxAttempts} attempts failed: ${job.lastError ?? lastFail?.message ?? "unknown error"}. Fix the cause and click Retry provisioning — it first checks Virtualizor for a VPS an earlier attempt already built.`
        : "No provisioning job is queued or running and nothing has been logged for over 15 minutes. The background worker may be stopped (check: sudo -u crapplet pm2 status). The panel re-queues it automatically within 5 minutes, or click Retry provisioning."
      : "Setting up your server is taking longer than usual. Our team can see this and will complete it — we'll email you when it's ready.";
  } else if (retrying) {
    headline = "Retrying setup";
    message = admin
      ? `Attempt ${job!.attempt} of ${job!.maxAttempts} failed: ${error ?? "unknown error"}. Retrying automatically.`
      : "The first attempt didn't finish, so we're trying again automatically. This usually resolves itself within a few minutes.";
  } else if (at("queue").state === "current" && s.status === "PENDING" && s.product.autoSetup === "MANUAL") {
    headline = "Waiting for approval";
    message = admin ? "This plan is set up manually — click Provision now." : "Our team will set this up shortly and email you when it's ready.";
  } else {
    headline = at("create").state === "current" ? "Building your VPS" : at("server").state === "current" ? "Choosing the best server" : "In the setup queue";
    message = waitingOnVirtualizor
      ? admin
        ? "Virtualizor accepted the request and is still creating the disk — large templates can take up to 15 minutes. The panel waits for it and won't build a second VPS."
        : "Your server is being built. Larger images can take up to 15 minutes — we'll email you as soon as it's ready."
      : "This usually takes 2–5 minutes. This page updates by itself, and we'll email you when it's ready.";
  }

  return {
    serviceId: s.id,
    status: s.status,
    inProgress: inProgress && !stuck,
    stuck,
    percent: failed ? Math.min(percent, 95) : percent,
    headline,
    message,
    steps: steps.map((x) => ({ ...x, detail: x.detail })),
    invoiceId: !invoicePaid ? inv?.id : null,
    job: admin ? job : null,
    error: admin ? error : null,
    startedAt: lastStart?.createdAt ?? attempt[0]?.createdAt ?? null,
    finishedAt: s.status === "ACTIVE" ? created?.createdAt ?? null : null,
    /** server time, so "running for" is right even when the viewer's clock is off */
    now: new Date(),
  };
}
