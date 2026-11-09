-- Node monitoring: Virtualizor slave id + live metadata
ALTER TABLE "ServerNode" ADD COLUMN "externalId" TEXT;
ALTER TABLE "ServerNode" ADD COLUMN "meta" JSONB;
