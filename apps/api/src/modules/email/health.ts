/**
 * Why aren't emails arriving? One check for Admin → Email Delivery: the sending queue and its worker,
 * the SMTP settings, the last day's results and blocked addresses — each problem with the fix.
 */
import { prisma } from "../../db";
import { emailQueue } from "../../jobs/queues";
import { getMailConfig, mailPassUnreadable } from "./mail-config";

export type Problem = { level: "error" | "warn"; title: string; fix: string };

let workers: { at: number; n: number | null } | null = null;
/** connected email workers (null = Redis can't tell, e.g. CLIENT LIST disabled); cached 20 s */
export async function emailWorkers(): Promise<number | null> {
  if (workers && Date.now() - workers.at < 20_000) return workers.n;
  let n: number | null = null;
  try {
    n = await emailQueue().getWorkersCount();
  } catch {
    n = null;
  }
  workers = { at: Date.now(), n };
  return n;
}

export async function emailHealth() {
  const c = await getMailConfig();
  const problems: Problem[] = [];
  let queue: { waiting: number; active: number; delayed: number; failed: number; oldestWaitingMin: number | null; workers: number | null; reachable: boolean } = { waiting: 0, active: 0, delayed: 0, failed: 0, oldestWaitingMin: null, workers: null, reachable: false };
  try {
    const q = emailQueue();
    const counts = await q.getJobCounts("waiting", "active", "delayed", "failed", "prioritized", "paused");
    const oldest = (await q.getJobs(["waiting", "prioritized", "paused"], 0, 0, true))[0];
    queue = {
      waiting: (counts.waiting ?? 0) + (counts.prioritized ?? 0) + (counts.paused ?? 0),
      active: counts.active ?? 0,
      delayed: counts.delayed ?? 0,
      failed: counts.failed ?? 0,
      oldestWaitingMin: oldest ? Math.round((Date.now() - oldest.timestamp) / 60_000) : null,
      workers: await emailWorkers(),
      reachable: true,
    };
  } catch {
    problems.push({ level: "warn", title: "The email queue (Redis) can't be reached", fix: "Emails are sent straight away instead of being queued, so they still go out — but check Redis: sudo systemctl status redis-server" });
  }

  if (!c.enabled) problems.push({ level: "error", title: "Sending is switched off", fix: "Emails are only written to the log. Turn on \"Send emails\" in the Setup tab and save." });
  if (!c.host) problems.push({ level: "error", title: "No SMTP server is set up", fix: "Fill in the Setup tab (host, port, username, password) and press Test connection." });
  if (mailPassUnreadable) problems.push({ level: "error", title: "The saved SMTP password can't be read", fix: "The server's ENCRYPTION_KEY changed since it was saved, so the panel logs in with no password and the mail server refuses. Type the SMTP password again in the Setup tab and save." });
  if (c.host && c.user && !c.pass && !mailPassUnreadable) problems.push({ level: "error", title: "SMTP username is set but the password is empty", fix: "Enter the SMTP password in the Setup tab and save." });
  if (c.host && !c.fromEmail) problems.push({ level: "error", title: "No From address", fix: "Set the From email in the Setup tab — most providers refuse mail without it." });

  if (queue.reachable && queue.workers === 0 && (queue.waiting > 0 || queue.delayed > 0)) {
    problems.push({ level: "error", title: `The email worker isn't running — ${queue.waiting + queue.delayed} email${queue.waiting + queue.delayed === 1 ? " is" : "s are"} waiting`, fix: "Start it on the server: sudo -u crapplet pm2 restart crapplet-worker (check with: sudo -u crapplet pm2 status). Or press \"Send waiting emails now\" on this card. New emails are sent straight away while no worker is connected." });
  } else if (queue.reachable && queue.workers === 0) {
    problems.push({ level: "warn", title: "The email worker isn't running", fix: "New emails are sent straight away meanwhile, but automation, backups and VPS setup also need it: sudo -u crapplet pm2 restart crapplet-worker" });
  } else if (queue.oldestWaitingMin !== null && queue.oldestWaitingMin > 10) {
    problems.push({ level: "warn", title: `Emails have been waiting ${queue.oldestWaitingMin} min to be sent`, fix: "The worker is connected but slow or stuck — restart it: sudo -u crapplet pm2 restart crapplet-worker" });
  }

  const since = new Date(Date.now() - 86400_000);
  const grouped = await prisma.emailLog.groupBy({ by: ["status"], where: { createdAt: { gt: since }, template: { not: "test" } }, _count: { _all: true } });
  const last24h = Object.fromEntries(grouped.map((g) => [g.status, g._count._all])) as Record<string, number>;
  const lastFail = await prisma.emailLog.findFirst({ where: { status: { in: ["FAILED", "BOUNCED"] }, createdAt: { gt: since } }, orderBy: { createdAt: "desc" }, select: { to: true, error: true, createdAt: true, template: true } });
  const sent = last24h.SENT ?? 0;
  const bad = (last24h.FAILED ?? 0) + (last24h.BOUNCED ?? 0);
  if (bad && bad >= sent) problems.push({ level: "error", title: `Most emails failed in the last 24 hours (${bad} failed, ${sent} sent)`, fix: `The mail server said: ${lastFail?.error ?? "see the Log tab"}. Fix the setting it points to, press Test connection, then "Retry failed emails".` });
  else if (bad) problems.push({ level: "warn", title: `${bad} email${bad === 1 ? "" : "s"} failed in the last 24 hours`, fix: `Last error: ${lastFail?.error ?? "see the Log tab"}` });
  if ((last24h.LOGGED ?? 0) > 0 && c.enabled && c.host) problems.push({ level: "warn", title: `${last24h.LOGGED} email${last24h.LOGGED === 1 ? " was" : "s were"} only logged, not sent, in the last 24 hours`, fix: "That happens while sending is off or no SMTP server is set — re-send them from the Log tab if needed." });
  const suppressed = last24h.SUPPRESSED ?? 0;
  if (suppressed) problems.push({ level: "warn", title: `${suppressed} email${suppressed === 1 ? " was" : "s were"} held back because the address bounced before`, fix: "Open the Log tab, filter by Suppressed, correct the customer's address or press Resend." });
  if (sent && !bad && !problems.some((p) => p.level === "error")) {
    // everything leaves fine — the usual reason for "not received" is spam filtering
    problems.push({ level: "warn", title: "Emails leave the panel fine — if customers don't see them, they're likely in spam", fix: "Run the Deliverability check (SPF, DKIM, DMARC) and fix anything red. Ask the customer to check Spam / Promotions." });
  }

  return {
    ok: !problems.some((p) => p.level === "error"),
    problems,
    queue,
    last24h,
    lastFailure: lastFail,
    config: { enabled: c.enabled, host: c.host, port: c.port, fromEmail: c.fromEmail, user: c.user, passwordSaved: !!c.pass, passwordUnreadable: mailPassUnreadable },
  };
}

/** Send what's waiting in the queue right here (when the worker is down). */
export async function sendWaitingNow(limit = 300) {
  const { sendTemplatedEmail } = await import("./mailer");
  const q = emailQueue();
  const jobs = await q.getJobs(["waiting", "prioritized", "paused", "delayed"], 0, limit - 1, true);
  let sent = 0;
  let failed = 0;
  for (const j of jobs) {
    if (!j?.data) continue;
    try {
      await j.remove(); // taken off first so a worker coming back can't send it twice
    } catch {
      continue; // a worker picked it up meanwhile
    }
    try {
      await sendTemplatedEmail(j.data);
      sent++;
    } catch {
      failed++; // logged as FAILED in the email log with the server's reason
    }
  }
  return { sent, failed, left: Math.max(0, (await q.getJobCounts("waiting")).waiting ?? 0) };
}

export async function retryFailed() {
  const jobs = await emailQueue().getJobs(["failed"], 0, 999, true);
  let n = 0;
  for (const j of jobs) {
    try {
      await j.retry();
      n++;
    } catch {
      /* already retried */
    }
  }
  return { retried: n };
}
