-- OS templates synced from Virtualizor masters
ALTER TABLE "OsTemplate" ADD COLUMN "virtualizorServerId" TEXT;
ALTER TABLE "OsTemplate" ADD COLUMN "virtualizorVirt" TEXT;
ALTER TABLE "OsTemplate" ADD COLUMN "distro" TEXT;
ALTER TABLE "OsTemplate" ADD COLUMN "remoteName" TEXT;
ALTER TABLE "OsTemplate" ADD COLUMN "source" TEXT NOT NULL DEFAULT 'manual';
ALTER TABLE "OsTemplate" ADD COLUMN "syncedAt" TIMESTAMP(3);
CREATE UNIQUE INDEX "OsTemplate_virtualizorServerId_virtualizorOsId_key" ON "OsTemplate"("virtualizorServerId", "virtualizorOsId");
