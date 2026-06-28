import { PrismaClient } from "../../../generated/prisma/index.js";

export function createPrismaClient(databaseUrl = process.env.DATABASE_URL_SITE): PrismaClient {
  if (!databaseUrl) {
    throw new Error("DATABASE_URL_SITE is required");
  }

  return new PrismaClient({
    datasources: {
      db: {
        url: databaseUrl,
      },
    },
  });
}
