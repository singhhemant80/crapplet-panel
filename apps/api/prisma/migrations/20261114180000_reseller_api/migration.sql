ALTER TABLE "Reseller" ADD COLUMN IF NOT EXISTS "webhookUrl" TEXT;
ALTER TABLE "Reseller" ADD COLUMN IF NOT EXISTS "webhookSecretEnc" TEXT;
ALTER TABLE "Reseller" ADD COLUMN IF NOT EXISTS "webhookLastAt" TIMESTAMP(3);
ALTER TABLE "Reseller" ADD COLUMN IF NOT EXISTS "webhookLastStatus" TEXT;
ALTER TABLE "Service" ADD COLUMN IF NOT EXISTS "resellerRef" TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS "Service_resellerId_resellerRef_key" ON "Service"("resellerId", "resellerRef");
