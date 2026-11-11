CREATE TABLE "AutomationRun" (
    "id" TEXT NOT NULL,
    "trigger" TEXT NOT NULL,
    "triggeredById" TEXT,
    "status" TEXT NOT NULL DEFAULT 'RUNNING',
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "durationMs" INTEGER,
    "summary" JSONB NOT NULL DEFAULT '{}',
    "error" TEXT,
    CONSTRAINT "AutomationRun_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "AutomationRun_startedAt_idx" ON "AutomationRun"("startedAt");

CREATE TABLE "AutomationEvent" (
    "id" TEXT NOT NULL,
    "runId" TEXT,
    "action" TEXT NOT NULL,
    "entity" TEXT,
    "entityId" TEXT,
    "userId" TEXT,
    "label" TEXT,
    "success" BOOLEAN NOT NULL DEFAULT true,
    "message" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AutomationEvent_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "AutomationEvent_createdAt_idx" ON "AutomationEvent"("createdAt");
CREATE INDEX "AutomationEvent_action_createdAt_idx" ON "AutomationEvent"("action", "createdAt");
CREATE INDEX "AutomationEvent_runId_idx" ON "AutomationEvent"("runId");
ALTER TABLE "AutomationEvent" ADD CONSTRAINT "AutomationEvent_runId_fkey" FOREIGN KEY ("runId") REFERENCES "AutomationRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;
