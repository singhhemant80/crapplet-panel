import { createApp } from "./app";
import { config } from "./config";
import { prisma } from "./db";
import { closeQueues } from "./jobs/queues";
import { attachConsoleProxy } from "./modules/console";

const app = createApp();
const server = app.listen(config.port, "127.0.0.1", () => {
  console.log(`[api] listening on http://127.0.0.1:${config.port} (${config.env})`);
});
attachConsoleProxy(server);

// older email-log rows: encrypt any passwords / links they stored in clear
setTimeout(() => {
  import("./modules/email/mailer")
    .then((m) => m.sealOldEmailLogs())
    .then((n) => n && console.log(`[mail] encrypted secrets in ${n} older email-log rows`))
    .catch((e) => console.error("[mail] sealing old email logs failed", e));
}, 5_000).unref();

// one-time: customers can only upgrade (downgrades go through support) — switches off an older saved "allow downgrades"
setTimeout(async () => {
  try {
    const { getSettings, updateSettings } = await import("./lib/settings");
    const a = (await getSettings()).automation as Record<string, unknown>;
    if (!a.upgradesOnlySet) await updateSettings("automation", { clientDowngrades: false, upgradesOnlySet: true } as never);
  } catch (e) {
    console.error("[settings] upgrades-only switch failed", e);
  }
}, 6_000).unref();

async function shutdown() {
  server.close();
  await closeQueues().catch(() => undefined);
  await prisma.$disconnect();
  process.exit(0);
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
