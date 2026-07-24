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

// L3.1 阶段3：懒刷新（access 触发，非 cron；水位过期→reset 非累加；未过期→惰性不重复刷新）。
// 真实验证过期水位场景（此前测试全用 allowance=0 账户，从未真正触发过 stale 分支）。
describe("credit 懒刷新（ensureAllowancesFresh：access 触发，reset 非累加，惰性不重复刷新）", () => {
  beforeEach(async () => {
    await cleanCreditDatabase(prisma);
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  const YESTERDAY = new Date("2026-07-23T12:00:00.000Z"); // 昨日水位（相对 dailyBoundary("今日")过期）
  const LAST_MONTH = new Date("2026-06-01T00:00:00.000Z"); // 上月水位（相对 periodBoundary("本月")过期）
  const NOW = new Date("2026-07-24T10:00:00.000Z");

  async function staleAccount(ownerId: string) {
    const account = await service.ensureAccount({ siteId: "site-default", ownerKind: "team", ownerId });
    await prisma.creditAccount.update({
      where: { id: account.id },
      data: {
        dailyMicros: 10_000n, // 陈旧残留（应被 overwrite，非累加）
        dailyResetOn: YESTERDAY,
        dailyAllowanceMicros: 100_000n,
        periodMicros: 50_000n,
        periodResetOn: LAST_MONTH,
        periodAllowanceMicros: 2_000_000n,
      },
    });
    return account;
  }

  it("hold 触发懒刷新：过期水位先重置为额度（非累加），再从刷新后的桶按序扣", async () => {
    const account = await staleAccount("lazy_hold");

    // 扣 120000：daily 刷新到 100000 全扣 → period 刷新到 2000000 再扣 20000。
    const hold = await repository.holdCredits({ accountId: account.id, amountMicros: "120000", idempotencyKey: "lazy_hold_1" }, NOW);

    expect(hold.reservedDailyMicros).toBe("100000"); // 刷新后的额度，不是陈旧的 10000+新扣
    expect(hold.reservedPeriodMicros).toBe("20000");

    const stored = await prisma.creditAccount.findUniqueOrThrow({ where: { id: account.id } });
    expect(stored.dailyMicros).toBe(0n);
    expect(stored.periodMicros).toBe(1_980_000n); // 2000000-20000
    expect(stored.dailyResetOn?.toISOString()).toBe("2026-07-24T00:00:00.000Z"); // 水位推进到今日边界
    expect(stored.periodResetOn?.toISOString()).toBe("2026-07-01T00:00:00.000Z"); // 水位推进到本月边界
  });

  it("spend 触发懒刷新：同 hold，直接扣费前先重置过期桶", async () => {
    const account = await staleAccount("lazy_spend");

    const result = await service.spendCredits(
      { accountId: account.id, amountMicros: "150000", idempotencyKey: "lazy_spend_1", reason: "model_call" },
    );
    void result;

    const stored = await prisma.creditAccount.findUniqueOrThrow({ where: { id: account.id } });
    // daily 刷新到 100000 全扣 → period 刷新到 2000000 扣 50000 → period 剩 1950000。
    expect(stored.dailyMicros).toBe(0n);
    expect(stored.periodMicros).toBe(1_950_000n);
  });

  it("refreshAllowances（只读路径）：过期水位刷新为额度并持久化，未过期字段维持", async () => {
    const account = await staleAccount("lazy_read");

    const refreshed = await repository.refreshAllowances(account.id, NOW);

    expect(refreshed.dailyMicros).toBe("100000"); // overwrite 为额度，非 10000+100000
    expect(refreshed.periodMicros).toBe("2000000");
    expect(refreshed.dailyResetOn?.toISOString()).toBe("2026-07-24T00:00:00.000Z");
    expect(refreshed.periodResetOn?.toISOString()).toBe("2026-07-01T00:00:00.000Z");

    const stored = await prisma.creditAccount.findUniqueOrThrow({ where: { id: account.id } });
    expect(stored.dailyMicros).toBe(100_000n); // 已持久化（非只读视图）
  });

  it("惰性：同一周期内重复刷新不重复 reset（水位已在当期，不再 overwrite）", async () => {
    const account = await staleAccount("lazy_idempotent");

    await repository.refreshAllowances(account.id, NOW);
    // 手动动一下桶值，验证「未过期」时第二次刷新不会把它 overwrite 回额度。
    await prisma.creditAccount.update({ where: { id: account.id }, data: { dailyMicros: 30_000n } });

    const secondNow = new Date("2026-07-24T20:00:00.000Z"); // 同一 UTC 自然日
    const refreshed = await repository.refreshAllowances(account.id, secondNow);

    expect(refreshed.dailyMicros).toBe("30000"); // 未被重置回额度 100000，惰性不重复刷新
  });

  it("未过期水位的账户：hold 不触发刷新，桶值原样参与扣减", async () => {
    const account = await service.ensureAccount({ siteId: "site-default", ownerKind: "team", ownerId: "lazy_fresh" });
    await prisma.creditAccount.update({
      where: { id: account.id },
      data: {
        dailyMicros: 40_000n,
        dailyResetOn: new Date("2026-07-24T00:00:00.000Z"), // 已是今日边界，未过期
        dailyAllowanceMicros: 100_000n,
      },
    });

    const hold = await repository.holdCredits({ accountId: account.id, amountMicros: "10000", idempotencyKey: "lazy_fresh_1" }, NOW);
    expect(hold.reservedDailyMicros).toBe("10000"); // 从原样 40000 扣，不是从刷新后的 100000 扣

    const stored = await prisma.creditAccount.findUniqueOrThrow({ where: { id: account.id } });
    expect(stored.dailyMicros).toBe(30_000n); // 40000-10000
  });
});
