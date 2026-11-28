ALTER TABLE "Service" ADD COLUMN IF NOT EXISTS "lastIps" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
-- start from the IPs each service has now (primary first)
UPDATE "Service" s SET "lastIps" = sub.addrs
FROM (SELECT "serviceId", array_agg("address" ORDER BY "isPrimary" DESC, "address") AS addrs FROM "IpAddress" WHERE "serviceId" IS NOT NULL GROUP BY "serviceId") sub
WHERE sub."serviceId" = s."id";
