-- AlterEnum
ALTER TYPE "BillingCycle" ADD VALUE 'TRIENNIAL';

-- CreateEnum
CREATE TYPE "MigrationStatus" AS ENUM ('QUEUED', 'RUNNING', 'COMPLETED', 'FAILED');

-- CreateTable
CREATE TABLE "LegacyMap" (
    "id" TEXT NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'whmcs',
    "entity" TEXT NOT NULL,
    "legacyId" TEXT NOT NULL,
    "localId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LegacyMap_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MigrationRun" (
    "id" TEXT NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'whmcs',
    "status" "MigrationStatus" NOT NULL DEFAULT 'QUEUED',
    "dryRun" BOOLEAN NOT NULL DEFAULT true,
    "optionsEnc" TEXT,
    "entities" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "progress" JSONB NOT NULL DEFAULT '{}',
    "summary" JSONB NOT NULL DEFAULT '{}',
    "warnings" JSONB NOT NULL DEFAULT '[]',
    "error" TEXT,
    "createdById" TEXT,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MigrationRun_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "LegacyMap_localId_idx" ON "LegacyMap"("localId");

-- CreateIndex
CREATE UNIQUE INDEX "LegacyMap_source_entity_legacyId_key" ON "LegacyMap"("source", "entity", "legacyId");
