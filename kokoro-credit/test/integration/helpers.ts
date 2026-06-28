import { PrismaClient } from "../../generated/prisma/index.js";
import { createPrismaClient } from "../../src/infrastructure/prisma/prisma-client.js";

export function createTestPrismaClient(): PrismaClient {
  if (!process.env.DATABASE_URL_CREDIT) {
    throw new Error("DATABASE_URL_CREDIT is required for integration tests");
  }

  return createPrismaClient(process.env.DATABASE_URL_CREDIT);
}

export async function cleanCreditDatabase(prisma: PrismaClient): Promise<void> {
  await prisma.usageRecord.deleteMany();
  await prisma.creditHold.deleteMany();
  await prisma.creditLedgerEntry.deleteMany();
  await prisma.creditAccount.deleteMany();
  await prisma.pricingRule.deleteMany();
}
