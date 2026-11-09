import "dotenv/config";

function req(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (v === undefined || v === "") throw new Error(`Missing required environment variable ${name}`);
  return v;
}

const isProd = process.env.NODE_ENV === "production";

export const config = {
  env: process.env.NODE_ENV ?? "development",
  isProd,
  port: parseInt(process.env.API_PORT ?? "4000", 10),
  appUrl: (process.env.APP_URL ?? "http://localhost:3000").replace(/\/$/, ""),
  databaseUrl: req("DATABASE_URL"),
  redisUrl: process.env.REDIS_URL ?? "redis://127.0.0.1:6379",
  // 32-byte keys, hex or base64. Dev fallbacks only work outside production.
  jwtSecret: req("JWT_SECRET", isProd ? undefined : "dev-jwt-secret-change-me-dev-jwt-secret"),
  encryptionKey: req("APP_ENCRYPTION_KEY", isProd ? undefined : "0000000000000000000000000000000000000000000000000000000000000000"),
  accessTokenTtlSec: 15 * 60,
  refreshTokenTtlDays: 30,
  cookieSecure: process.env.COOKIE_SECURE ? process.env.COOKIE_SECURE === "true" : isProd,
  uploadDir: process.env.UPLOAD_DIR ?? "./storage/uploads",
  smtp: {
    host: process.env.SMTP_HOST ?? "",
    port: parseInt(process.env.SMTP_PORT ?? "587", 10),
    secure: process.env.SMTP_SECURE === "true",
    user: process.env.SMTP_USER ?? "",
    pass: process.env.SMTP_PASS ?? "",
    from: process.env.SMTP_FROM ?? "Crapplet Cloud <billing@crapplet.co.in>",
  },
  // inbound email piping (POST /api/webhooks/email) shared secret
  inboundEmailSecret: process.env.INBOUND_EMAIL_SECRET ?? "",
  ipReservationMinutes: parseInt(process.env.IP_RESERVATION_MINUTES ?? "15", 10),
  // set PROVISION_DRY_RUN=true to log hypervisor calls instead of executing them
  provisionDryRun: process.env.PROVISION_DRY_RUN === "true",
};
