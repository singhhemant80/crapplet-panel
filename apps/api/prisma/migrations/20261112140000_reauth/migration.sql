-- Staff password re-confirmation ("sudo mode")
ALTER TABLE "Session" ADD COLUMN IF NOT EXISTS "sudoUntil" TIMESTAMP(3);
ALTER TABLE "Session" ADD COLUMN IF NOT EXISTS "sudoFailures" INTEGER NOT NULL DEFAULT 0;
