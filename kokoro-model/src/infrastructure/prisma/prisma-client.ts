import { PrismaClient } from "../../../generated/prisma/index.js";

export function createPrismaClient(databaseUrl = process.env.DATABASE_URL_MODEL): PrismaClient {
  if (!databaseUrl) {
    throw new Error("DATABASE_URL_MODEL is required");
  }

  return new PrismaClient({
    datasources: {
      db: {
        url: databaseUrl,
      },
    },
  });
}
