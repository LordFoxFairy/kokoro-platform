import type { PrismaClient } from "@prisma/client";
import { createPrismaClient } from "../../src/infrastructure/prisma/prisma-client.js";

export function createTestPrismaClient(): PrismaClient {
  if (!process.env.DATABASE_URL_USER) {
    throw new Error("DATABASE_URL_USER is required for integration tests");
  }

  return createPrismaClient(process.env.DATABASE_URL_USER);
}

export async function cleanUserDatabase(prisma: PrismaClient): Promise<void> {
  await prisma.userAuditLog.deleteMany();
  await prisma.serviceAccount.deleteMany();
  await prisma.invite.deleteMany();
  await prisma.membership.deleteMany();
  await prisma.role.deleteMany();
  await prisma.team.deleteMany();
  await prisma.user.deleteMany();
}
