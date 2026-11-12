-- One-click "Out of stock" for plans (independent of stock-quantity tracking)
ALTER TABLE "Product" ADD COLUMN "outOfStock" BOOLEAN NOT NULL DEFAULT false;
