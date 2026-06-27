import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { CreditService } from "../../src/application/credit-service.js";
import { InsufficientCreditError } from "../../src/domain/errors.js";
import { PrismaCreditRepository } from "../../src/infrastructure/prisma/prisma-credit-repository.js";
import { cleanCreditDatabase, createTestPrismaClient } from "./helpers.js";

const prisma = createTestPrismaClient();
const repository = new PrismaCreditRepository(prisma);
const service = new CreditService(repository);

describe("PrismaCreditRepository", () => {
  beforeEach(async () => {
    await cleanCreditDatabase(prisma);
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("ensures an account and grants credits idempotently", async () => {
    const account = await service.ensureAccount({
      ownerKind: "team",
      ownerId: "team_1",
    });

    const first = await service.grantCredits({
      accountId: account.id,
      amountMicros: "5000000",
      idempotencyKey: "grant_1",
      reason: "manual_adjustment",
    });

    const second = await service.grantCredits({
      accountId: account.id,
      amountMicros: "5000000",
      idempotencyKey: "grant_1",
      reason: "manual_adjustment",
    });

    expect(second.entry.id).toBe(first.entry.id);
    expect(second.account.balanceMicros).toBe("5000000");
  });

  it("handles concurrent grant requests with the same idempotency key", async () => {
    const account = await service.ensureAccount({
      ownerKind: "team",
      ownerId: "team_concurrent_grant",
    });

    const [first, second] = await Promise.all([
      service.grantCredits({
        accountId: account.id,
        amountMicros: "7000000",
        idempotencyKey: "grant_concurrent",
        reason: "manual_adjustment",
      }),
      service.grantCredits({
        accountId: account.id,
        amountMicros: "7000000",
        idempotencyKey: "grant_concurrent",
        reason: "manual_adjustment",
      }),
    ]);

    const storedAccount = await prisma.creditAccount.findUniqueOrThrow({
      where: {
        id: account.id,
      },
    });

    expect(second.entry.id).toBe(first.entry.id);
    expect(storedAccount.balanceMicros.toString()).toBe("7000000");
  });

  it("spends credits and writes a negative ledger entry", async () => {
    const account = await service.ensureAccount({
      ownerKind: "team",
      ownerId: "team_2",
    });

    await service.grantCredits({
      accountId: account.id,
      amountMicros: "9000000",
      idempotencyKey: "grant_2",
      reason: "subscription",
    });

    const spend = await service.spendCredits({
      accountId: account.id,
      amountMicros: "3000000",
      idempotencyKey: "spend_1",
      reason: "model_call",
    });

    expect(spend.account.balanceMicros).toBe("6000000");
    expect(spend.entry.amountMicros).toBe("-3000000");
  });

  it("handles concurrent spend requests with the same idempotency key", async () => {
    const account = await service.ensureAccount({
      ownerKind: "team",
      ownerId: "team_concurrent_spend",
    });

    await service.grantCredits({
      accountId: account.id,
      amountMicros: "9000000",
      idempotencyKey: "grant_before_concurrent_spend",
      reason: "subscription",
    });

    const [first, second] = await Promise.all([
      service.spendCredits({
        accountId: account.id,
        amountMicros: "3000000",
        idempotencyKey: "spend_concurrent",
        reason: "model_call",
      }),
      service.spendCredits({
        accountId: account.id,
        amountMicros: "3000000",
        idempotencyKey: "spend_concurrent",
        reason: "model_call",
      }),
    ]);

    const storedAccount = await prisma.creditAccount.findUniqueOrThrow({
      where: {
        id: account.id,
      },
    });

    expect(second.entry.id).toBe(first.entry.id);
    expect(storedAccount.balanceMicros.toString()).toBe("6000000");
  });

  it("rejects spending more than the available balance", async () => {
    const account = await service.ensureAccount({
      ownerKind: "team",
      ownerId: "team_3",
    });

    await expect(
      service.spendCredits({
        accountId: account.id,
        amountMicros: "1",
        idempotencyKey: "spend_overdraft",
        reason: "model_call",
      }),
    ).rejects.toBeInstanceOf(InsufficientCreditError);
  });
});
