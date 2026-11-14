ALTER TABLE "Service" ADD COLUMN IF NOT EXISTS "terminationReason" TEXT;
-- services terminated before the date was always recorded: take it from their terminate log
UPDATE "Service" s SET "terminationDate" = l."createdAt"
FROM (SELECT "serviceId", MAX("createdAt") AS "createdAt" FROM "ProvisioningLog" WHERE action = 'terminate' AND success = true GROUP BY "serviceId") l
WHERE s.id = l."serviceId" AND s.status IN ('TERMINATED', 'CANCELLED') AND s."terminationDate" IS NULL;
