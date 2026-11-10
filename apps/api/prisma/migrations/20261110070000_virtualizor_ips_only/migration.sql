-- Virtualizor plans: IPs are assigned by Virtualizor only, so customers can't pick one
UPDATE "Product" SET "allowIpSelection" = false WHERE "provisioner" = 'VIRTUALIZOR';
