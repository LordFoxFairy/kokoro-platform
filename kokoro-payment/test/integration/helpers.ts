import { PrismaClient } from "../../generated/prisma/index.js";
import { createPrismaClient } from "../../src/infrastructure/prisma/prisma-client.js";
import type {
  GrantPurchaseCredits,
  GrantPurchaseCreditsInput,
} from "../../src/domain/repository.js";

export function recordingGrant(): {
  grantPurchaseCredits: GrantPurchaseCredits;
  grants: GrantPurchaseCreditsInput[];
} {
  const grants: GrantPurchaseCreditsInput[] = [];
  return {
    grants,
    grantPurchaseCredits: async (input) => {
      grants.push(input);
    },
  };
}

export function createTestPrismaClient(): PrismaClient {
  if (!process.env.DATABASE_URL_PAYMENT) {
    throw new Error("DATABASE_URL_PAYMENT is required for integration tests");
  }

  return createPrismaClient(process.env.DATABASE_URL_PAYMENT);
}

export async function cleanPaymentDatabase(prisma: PrismaClient): Promise<void> {
  await prisma.paymentEvent.deleteMany();
  await prisma.order.deleteMany();
  await prisma.plan.deleteMany();
}
