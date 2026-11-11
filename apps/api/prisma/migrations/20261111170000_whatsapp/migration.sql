ALTER TABLE "ClientProfile" ADD COLUMN "whatsappNotifications" BOOLEAN NOT NULL DEFAULT true;

CREATE TABLE "WhatsappMessage" (
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "to" TEXT NOT NULL,
    "event" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'QUEUED',
    "providerId" TEXT,
    "error" TEXT,
    "sentById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "WhatsappMessage_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "WhatsappMessage_createdAt_idx" ON "WhatsappMessage"("createdAt");
CREATE INDEX "WhatsappMessage_userId_createdAt_idx" ON "WhatsappMessage"("userId", "createdAt");
