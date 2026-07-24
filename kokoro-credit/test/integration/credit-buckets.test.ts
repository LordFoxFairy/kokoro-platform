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

// B1 多桶消费机制（阶段2）：真实 daily/period 非零时，验按过期先扣消费 + 夹紧归还。
// 现有测试全是永久桶账户（daily/period=0），此处补齐三桶真行为的证明。
describe("credit 三桶消费机制（B1：过期先扣 + 明细预留 + 夹紧归还）", () => {
  beforeEach(async () => {
    await cleanCreditDatabase(prisma);
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  // 建一个三桶都非零、且时间桶带当期额度的账户。
  async function tricketAccount(ownerId: string, buckets: { daily: bigint; period: bigint; permanent: bigint }) {
    const account = await service.ensureAccount({ siteId: "site-default", ownerKind: "team", ownerId });
    await prisma.creditAccount.update({
      where: { id: account.id },
      data: {
        dailyMicros: buckets.daily,
        periodMicros: buckets.period,
        balanceMicros: buckets.permanent,
        dailyAllowanceMicros: buckets.daily,
        periodAllowanceMicros: buckets.period,
      },
    });
    return account;
  }

  it("hold 按过期先扣（daily→period→permanent）从各桶移出，明细记在 hold", async () => {
    const account = await tricketAccount("bk_hold_order", { daily: 100_000n, period: 200_000n, permanent: 1_000_000n });

    // 扣 250000：daily 100000 全扣 → period 扣 150000 → permanent 不动。
    const hold = await repository.holdCredits({
      accountId: account.id,
      amountMicros: "250000",
      idempotencyKey: "bk_hold_1",
    });

    expect(hold.reservedDailyMicros).toBe("100000");
    expect(hold.reservedPeriodMicros).toBe("150000");
    expect(hold.reservedPermanentMicros).toBe("0");

    const stored = await prisma.creditAccount.findUniqueOrThrow({ where: { id: account.id } });
    expect(stored.dailyMicros).toBe(0n); // 每日桶被扣光
    expect(stored.periodMicros).toBe(50_000n); // 200000-150000
    expect(stored.balanceMicros).toBe(1_000_000n); // 永久桶未动
    expect(stored.heldMicros).toBe(250_000n);
  });

  it("capture 按预留明细分摊实额、未用差额夹紧归还源桶（守恒）", async () => {
    const account = await tricketAccount("bk_capture", { daily: 100_000n, period: 200_000n, permanent: 1_000_000n });
    const hold = await repository.holdCredits({
      accountId: account.id,
      amountMicros: "250000",
      idempotencyKey: "bk_cap_hold",
    });

    // 实额 120000：spent=daily 100000 + period 20000；returned=period 130000 归还。
    await repository.captureHold({
      holdId: hold.id,
      actualAmountMicros: "120000",
      idempotencyKey: "bk_cap_settle",
      reason: "model_call",
      featureKey: "model.call",
    });

    const stored = await prisma.creditAccount.findUniqueOrThrow({ where: { id: account.id } });
    expect(stored.dailyMicros).toBe(0n); // daily 全消费
    expect(stored.periodMicros).toBe(180_000n); // 50000 残 + 130000 归还
    expect(stored.balanceMicros).toBe(1_000_000n);
    expect(stored.heldMicros).toBe(0n);
    // 守恒：初始可用 1_300_000 − 实扣 120_000 = 1_180_000。
    expect(stored.dailyMicros + stored.periodMicros + stored.balanceMicros).toBe(1_180_000n);
  });

  it("release 全额夹紧归还预留（可用额完全复原）", async () => {
    const account = await tricketAccount("bk_release", { daily: 100_000n, period: 200_000n, permanent: 1_000_000n });
    const hold = await repository.holdCredits({
      accountId: account.id,
      amountMicros: "250000",
      idempotencyKey: "bk_rel_hold",
    });

    await repository.releaseHold({ holdId: hold.id, idempotencyKey: "bk_rel_key" });

    const stored = await prisma.creditAccount.findUniqueOrThrow({ where: { id: account.id } });
    expect(stored.dailyMicros).toBe(100_000n); // 复原
    expect(stored.periodMicros).toBe(200_000n); // 复原
    expect(stored.balanceMicros).toBe(1_000_000n);
    expect(stored.heldMicros).toBe(0n);
  });

  it("日界夹紧：hold 后每日桶被刷新到满额，release 归还的旧赠额被夹掉（房不吃亏）", async () => {
    const account = await tricketAccount("bk_clamp", { daily: 100_000n, period: 0n, permanent: 0n });
    // hold 60000 全从每日桶移出：daily 100000→40000，reserved daily=60000。
    const hold = await repository.holdCredits({
      accountId: account.id,
      amountMicros: "60000",
      idempotencyKey: "bk_clamp_hold",
    });
    expect(hold.reservedDailyMicros).toBe("60000");

    // 模拟日界翻页：ensureAllowancesFresh 已把每日桶重置到满额 100000（当期额度）。
    await prisma.creditAccount.update({ where: { id: account.id }, data: { dailyMicros: 100_000n } });

    // release 归还 reserved daily 60000 → 若无脑相加=160000（超发）；夹紧到额度 100000。
    await repository.releaseHold({ holdId: hold.id, idempotencyKey: "bk_clamp_rel" });

    const stored = await prisma.creditAccount.findUniqueOrThrow({ where: { id: account.id } });
    expect(stored.dailyMicros).toBe(100_000n); // 夹紧到当期额度，过期赠额不复活
    expect(stored.heldMicros).toBe(0n);
  });
});
