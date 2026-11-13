-- UPI AutoPay mandates (Razorpay tokens)
ALTER TABLE "PayMethod" ADD COLUMN IF NOT EXISTS "externalId" TEXT;
ALTER TABLE "PayMethod" ADD COLUMN IF NOT EXISTS "maxAmount" INTEGER;
CREATE UNIQUE INDEX IF NOT EXISTS "PayMethod_externalId_key" ON "PayMethod"("externalId");
