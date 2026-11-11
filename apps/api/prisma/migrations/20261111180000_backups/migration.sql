CREATE TABLE "BackupRun" (
    "id" TEXT NOT NULL,
    "trigger" TEXT NOT NULL,
    "triggeredBy" TEXT,
    "status" TEXT NOT NULL DEFAULT 'RUNNING',
    "fileName" TEXT,
    "sizeBytes" BIGINT,
    "includesUploads" BOOLEAN NOT NULL DEFAULT false,
    "destinations" JSONB NOT NULL DEFAULT '[]',
    "error" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "deletedAt" TIMESTAMP(3),
    CONSTRAINT "BackupRun_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "BackupRun_startedAt_idx" ON "BackupRun"("startedAt");
