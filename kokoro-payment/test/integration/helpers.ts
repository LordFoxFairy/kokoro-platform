import { PrismaClient } from "../../generated/prisma/index.js";
import { createPrismaClient } from "../../src/infrastructure/prisma/prisma-client.js";
import type {
  GrantPurchaseCredits,
  GrantPurchaseCreditsInput,
  ReverseCredits,
  ReverseCreditsInput,
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

export function recordingReverse(): {
  reverseCredits: ReverseCredits;
  reversals: ReverseCreditsInput[];
} {
  const reversals: ReverseCreditsInput[] = [];
  return {
    reversals,
    reverseCredits: async (input) => {
      reversals.push(input);
    },
  };
}

export const TEST_SITE_ID = "site_test";
export const siteHeaders: Record<string, string> = { "x-kokoro-site-id": TEST_SITE_ID };

export function createTestPrismaClient(): PrismaClient {
  if (!process.env.DATABASE_URL_PAYMENT) {
    throw new Error("DATABASE_URL_PAYMENT is required for integration tests");
  }

  return createPrismaClient(process.env.DATABASE_URL_PAYMENT);
}

export async function cleanPaymentDatabase(prisma: PrismaClient): Promise<void> {
  await prisma.refund.deleteMany();
  await prisma.subscription.deleteMany();
  await prisma.paymentEvent.deleteMany();
  await prisma.order.deleteMany();
  await prisma.plan.deleteMany();
  await prisma.paymentProvider.deleteMany();
}
