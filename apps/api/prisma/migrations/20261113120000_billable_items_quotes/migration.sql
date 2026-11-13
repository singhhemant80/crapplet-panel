-- Billable items and quotes
CREATE TABLE IF NOT EXISTS "BillableItem" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "description" TEXT NOT NULL,
  "amount" INTEGER NOT NULL,
  "quantity" INTEGER NOT NULL DEFAULT 1,
  "currency" TEXT NOT NULL DEFAULT 'INR',
  "taxable" BOOLEAN NOT NULL DEFAULT true,
  "invoiceAction" TEXT NOT NULL DEFAULT 'NEXT_INVOICE',
  "dueDate" TIMESTAMP(3),
  "recurEveryMonths" INTEGER,
  "recurTimes" INTEGER,
  "recurDone" INTEGER NOT NULL DEFAULT 0,
  "invoiced" BOOLEAN NOT NULL DEFAULT false,
  "invoiceId" TEXT,
  "lastInvoicedAt" TIMESTAMP(3),
  "serviceId" TEXT,
  "notes" TEXT,
  "createdById" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "BillableItem_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "BillableItem_userId_invoiced_idx" ON "BillableItem"("userId", "invoiced");
CREATE INDEX IF NOT EXISTS "BillableItem_invoiced_invoiceAction_dueDate_idx" ON "BillableItem"("invoiced", "invoiceAction", "dueDate");
DO $$ BEGIN
  ALTER TABLE "BillableItem" ADD CONSTRAINT "BillableItem_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS "Quote" (
  "id" TEXT NOT NULL,
  "number" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "subject" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'DRAFT',
  "currency" TEXT NOT NULL DEFAULT 'INR',
  "validUntil" TIMESTAMP(3) NOT NULL,
  "items" JSONB NOT NULL,
  "subtotal" INTEGER NOT NULL DEFAULT 0,
  "taxTotal" INTEGER NOT NULL DEFAULT 0,
  "total" INTEGER NOT NULL DEFAULT 0,
  "customerNotes" TEXT,
  "adminNotes" TEXT,
  "invoiceId" TEXT,
  "sentAt" TIMESTAMP(3),
  "acceptedAt" TIMESTAMP(3),
  "declinedAt" TIMESTAMP(3),
  "createdById" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Quote_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "Quote_number_key" ON "Quote"("number");
CREATE INDEX IF NOT EXISTS "Quote_userId_idx" ON "Quote"("userId");
CREATE INDEX IF NOT EXISTS "Quote_status_idx" ON "Quote"("status");
DO $$ BEGIN
  ALTER TABLE "Quote" ADD CONSTRAINT "Quote_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
