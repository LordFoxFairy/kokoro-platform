import { PrismaClient } from "../../generated/prisma/index.js";
import { createPrismaClient } from "../../src/infrastructure/prisma/prisma-client.js";

export function createTestPrismaClient(): PrismaClient {
  if (!process.env.DATABASE_URL_MODEL) {
    throw new Error("DATABASE_URL_MODEL is required for integration tests");
  }

  return createPrismaClient(process.env.DATABASE_URL_MODEL);
}

export async function cleanModelDatabase(prisma: PrismaClient): Promise<void> {
  await prisma.modelBinding.deleteMany();
  await prisma.modelLabel.deleteMany();
  await prisma.providerAccount.deleteMany();
  await prisma.siteModelPolicy.deleteMany();
}
