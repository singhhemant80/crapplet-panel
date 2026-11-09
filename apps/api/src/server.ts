import { createApp } from "./app";
import { config } from "./config";
import { prisma } from "./db";
import { closeQueues } from "./jobs/queues";

const app = createApp();
const server = app.listen(config.port, "127.0.0.1", () => {
  console.log(`[api] listening on http://127.0.0.1:${config.port} (${config.env})`);
});

async function shutdown() {
  server.close();
  await closeQueues().catch(() => undefined);
  await prisma.$disconnect();
  process.exit(0);
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
