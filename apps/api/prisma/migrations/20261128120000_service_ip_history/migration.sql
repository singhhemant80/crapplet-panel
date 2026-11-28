CREATE TABLE IF NOT EXISTS "ServiceIpChange" (
    "id" TEXT NOT NULL,
    "serviceId" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "primary" BOOLEAN NOT NULL DEFAULT false,
    "source" TEXT NOT NULL,
    "actorId" TEXT,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ServiceIpChange_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "ServiceIpChange_serviceId_createdAt_idx" ON "ServiceIpChange"("serviceId", "createdAt");
CREATE INDEX IF NOT EXISTS "ServiceIpChange_address_idx" ON "ServiceIpChange"("address");
DO $$ BEGIN
  ALTER TABLE "ServiceIpChange" ADD CONSTRAINT "ServiceIpChange_serviceId_fkey" FOREIGN KEY ("serviceId") REFERENCES "Service"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
