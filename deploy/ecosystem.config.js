// PM2 process file — `pm2 start deploy/ecosystem.config.js` from the repository root
const path = require("path");
const root = path.resolve(__dirname, "..");
module.exports = {
  apps: [
    { name: "crapplet-api", cwd: path.join(root, "apps/api"), script: "dist/server.js", instances: 2, exec_mode: "cluster", env: { NODE_ENV: "production" }, max_memory_restart: "600M", time: true },
    { name: "crapplet-worker", cwd: path.join(root, "apps/api"), script: "dist/worker.js", instances: 1, env: { NODE_ENV: "production" }, max_memory_restart: "600M", kill_timeout: 30000, time: true },
    { name: "crapplet-web", cwd: path.join(root, "apps/web"), script: "node_modules/next/dist/bin/next", args: "start -p 3000 -H 127.0.0.1", env: { NODE_ENV: "production", PORT: 3000 }, max_memory_restart: "700M", time: true },
  ],
};
