-- refunds point at the payment they reverse (prevents refunding more than was paid across wallet + gateway)
ALTER TABLE "Transaction" ADD COLUMN "refundOfId" TEXT;
CREATE INDEX "Transaction_refundOfId_idx" ON "Transaction"("refundOfId");
