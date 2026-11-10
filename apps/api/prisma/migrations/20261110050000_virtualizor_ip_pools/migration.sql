-- IP subnets imported from Virtualizor pools
ALTER TABLE "IpSubnet" ADD COLUMN "externalPoolId" INTEGER;
ALTER TABLE "IpSubnet" ADD COLUMN "nodeIds" TEXT[] DEFAULT ARRAY[]::TEXT[];
