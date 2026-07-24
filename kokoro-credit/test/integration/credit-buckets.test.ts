import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { CreditService } from "../../src/application/credit-service.js";
import { PrismaCreditRepository } from "../../src/infrastructure/prisma/prisma-credit-repository.js";
import { cleanCreditDatabase, createTestPrismaClient } from "./helpers.js";

// 三桶（L3.1）阶段1：账户实体/读模型暴露每日、周期桶（balanceMicros=永久桶）。
// 时间桶 allowance 由生效 Plan 供给（L3.2 前恒 0）；本阶段只验读出，不改消费机制。
const prisma = createTestPrismaClient();
const repository = new PrismaCreditRepository(prisma);
const service = new CreditService(repository);

describe("credit 三桶：账户读模型暴露每日/周期桶", () => {
  beforeEach(async () => {
    await cleanCreditDatabase(prisma);
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("新账户三桶默认 0、时间桶水位为 null", async () => {
    const account = await service.ensureAccount({
      siteId: "site-default",
      ownerKind: "user",
      ownerId: "user_buckets_default",
    });

    const read = await repository.getAccountById(account.id);
    expect(read).not.toBeNull();
    expect(read?.balanceMicros).toBe("0");
    expect(read?.dailyMicros).toBe("0");
    expect(read?.periodMicros).toBe("0");
    expect(read?.dailyResetOn).toBeNull();
    expect(read?.periodResetOn).toBeNull();
  });

  it("读出每日/周期桶余额与水位（直接置桶值后回读）", async () => {
    const account = await service.ensureAccount({
      siteId: "site-default",
      ownerKind: "user",
      ownerId: "user_buckets_read",
    });
    const resetDay = new Date("2026-07-24T00:00:00.000Z");
    await prisma.creditAccount.update({
      where: { id: account.id },
      data: {
        dailyMicros: 500_000n,
        dailyResetOn: resetDay,
        periodMicros: 3_000_000n,
        periodResetOn: resetDay,
      },
    });

    const read = await repository.getAccountById(account.id);
    expect(read?.dailyMicros).toBe("500000");
    expect(read?.periodMicros).toBe("3000000");
    expect(read?.dailyResetOn?.toISOString()).toBe(resetDay.toISOString());
    expect(read?.periodResetOn?.toISOString()).toBe(resetDay.toISOString());
  });
});
