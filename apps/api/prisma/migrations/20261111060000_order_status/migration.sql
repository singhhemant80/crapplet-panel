-- Orders follow their services: add Suspended / Terminated and a manual lock
ALTER TYPE "OrderStatus" ADD VALUE 'SUSPENDED';
ALTER TYPE "OrderStatus" ADD VALUE 'TERMINATED';
ALTER TABLE "Order" ADD COLUMN "statusLocked" BOOLEAN NOT NULL DEFAULT false;
