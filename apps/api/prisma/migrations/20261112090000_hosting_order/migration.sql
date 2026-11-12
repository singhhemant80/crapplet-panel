-- WHMCS-style hosting orders: free domain with a plan, and old WHMCS group links
ALTER TABLE "Product" ADD COLUMN "freeDomain" TEXT NOT NULL DEFAULT 'none';
ALTER TABLE "Product" ADD COLUMN "freeDomainCycles" "BillingCycle"[] DEFAULT ARRAY[]::"BillingCycle"[];
ALTER TABLE "Product" ADD COLUMN "freeDomainTlds" TEXT[] DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "ProductGroup" ADD COLUMN "legacyGid" INTEGER;
CREATE UNIQUE INDEX "ProductGroup_legacyGid_key" ON "ProductGroup"("legacyGid");
