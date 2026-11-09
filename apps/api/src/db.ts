import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "./generated/prisma/client";
import { config } from "./config";

export * from "./generated/prisma/client";

const adapter = new PrismaPg({ connectionString: config.databaseUrl });
export const prisma = new PrismaClient({ adapter });

export type Tx = Parameters<Parameters<typeof prisma.$transaction>[0]>[0];
export type Db = typeof prisma | Tx;
