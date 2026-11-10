ALTER TABLE "EmailLog" ADD COLUMN "messageId" TEXT;
ALTER TABLE "EmailLog" ADD COLUMN "response" TEXT;
ALTER TABLE "EmailLog" ADD COLUMN "job" JSONB;
CREATE INDEX "EmailLog_to_idx" ON "EmailLog"("to");
CREATE INDEX "EmailLog_createdAt_idx" ON "EmailLog"("createdAt");
