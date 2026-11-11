-- cPanel / WHM hosting
ALTER TYPE "ServerType" ADD VALUE 'CPANEL';
ALTER TYPE "Provisioner" ADD VALUE 'CPANEL';
ALTER TABLE "Server" ADD COLUMN "nameservers" TEXT[] DEFAULT ARRAY[]::TEXT[];
