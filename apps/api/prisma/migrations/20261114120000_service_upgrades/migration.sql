-- Plan / billing-cycle changes (upgrade & downgrade)
ALTER TYPE "InvoiceItemType" ADD VALUE IF NOT EXISTS 'UPGRADE';

CREATE TABLE IF NOT EXISTS "ServiceUpgrade" (
    "id" TEXT NOT NULL,
    "serviceId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "fromProductId" TEXT NOT NULL,
    "toProductId" TEXT NOT NULL,
    "fromCycle" "BillingCycle" NOT NULL,
    "toCycle" "BillingCycle" NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'INR',
    "oldRecurring" INTEGER NOT NULL,
    "newRecurring" INTEGER NOT NULL,
    "credit" INTEGER NOT NULL DEFAULT 0,
    "charge" INTEGER NOT NULL DEFAULT 0,
    "amountDue" INTEGER NOT NULL DEFAULT 0,
    "newNextDueDate" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "creditRefund" BOOLEAN NOT NULL DEFAULT true,
    "applyOnServer" BOOLEAN NOT NULL DEFAULT true,
    "invoiceId" TEXT,
    "message" TEXT,
    "byClient" BOOLEAN NOT NULL DEFAULT false,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "appliedAt" TIMESTAMP(3),
    CONSTRAINT "ServiceUpgrade_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "ServiceUpgrade_serviceId_status_idx" ON "ServiceUpgrade"("serviceId", "status");
CREATE INDEX IF NOT EXISTS "ServiceUpgrade_invoiceId_idx" ON "ServiceUpgrade"("invoiceId");
DO $$ BEGIN
  ALTER TABLE "ServiceUpgrade" ADD CONSTRAINT "ServiceUpgrade_serviceId_fkey" FOREIGN KEY ("serviceId") REFERENCES "Service"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
