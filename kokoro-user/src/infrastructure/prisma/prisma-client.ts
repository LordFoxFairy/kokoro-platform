import { PrismaClient } from "@prisma/client";

export function createPrismaClient(databaseUrl = process.env.DATABASE_URL_USER): PrismaClient {
  if (!databaseUrl) {
    throw new Error("DATABASE_URL_USER is required");
  }

  return new PrismaClient({
    datasources: {
      db: {
        url: databaseUrl,
      },
    },
  });
}
