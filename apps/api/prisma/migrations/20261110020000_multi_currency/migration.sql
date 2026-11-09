-- Multi-currency: per-currency prices for add-ons, options, domains, promos; FX rate on invoices
ALTER TABLE "Currency" ADD COLUMN "enabled" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "Addon" ADD COLUMN "prices" JSONB NOT NULL DEFAULT '{}';
ALTER TABLE "ConfigOption" ADD COLUMN "unitPrices" JSONB NOT NULL DEFAULT '{}';
ALTER TABLE "PromoCode" ADD COLUMN "fixedAmounts" JSONB NOT NULL DEFAULT '{}';
ALTER TABLE "DomainPricing" ADD COLUMN "prices" JSONB NOT NULL DEFAULT '{}';
ALTER TABLE "Invoice" ADD COLUMN "exchangeRate" DOUBLE PRECISION NOT NULL DEFAULT 1;
ALTER TABLE "Domain" ADD COLUMN "currency" TEXT NOT NULL DEFAULT 'INR';

-- make sure the two billing currencies exist
INSERT INTO "Currency" ("code", "prefix", "suffix", "rate", "isDefault", "enabled") VALUES ('INR', '₹', '', 1, true, true) ON CONFLICT ("code") DO NOTHING;
INSERT INTO "Currency" ("code", "prefix", "suffix", "rate", "isDefault", "enabled") VALUES ('USD', '$', '', 0.012, false, true) ON CONFLICT ("code") DO NOTHING;
