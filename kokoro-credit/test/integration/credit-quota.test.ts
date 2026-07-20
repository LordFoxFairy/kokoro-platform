import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { CreditService } from "../../src/application/credit-service.js";
import { PrismaCreditRepository } from "../../src/infrastructure/prisma/prisma-credit-repository.js";
import { createCreditServer } from "../../src/interfaces/http/server.js";
import { cleanCreditDatabase, createTestPrismaClient } from "./helpers.js";

const prisma = createTestPrismaClient();
const repository = new PrismaCreditRepository(prisma);
const service = new CreditService(repository);
const app = createCreditServer({ prisma });

const SITE = "site-default";
const DAY = 24 * 60 * 60 * 1000;

// 默认计价：gpt-4 in=2,out=6，est 1000/1000，buffer 20% → 每次 hold 冻结 9600 micros。
async function seedPricing(): Promise<void> {
  const from = new Date(Date.now() - DAY);
  await prisma.pricingRule.createMany({
    data: [
      { featureKey: "model.run", labelKey: "gpt-4", unit: "input_token", amountMicros: 2n, status: "active", effectiveFrom: from },
      { featureKey: "model.run", labelKey: "gpt-4", unit: "output_token", amountMicros: 6n, status: "active", effectiveFrom: from },
      // 高价档:整积分扣费下,只有冻结≫实收时才存在"释放的 buffer",配额不双算才可验。
      { featureKey: "model.run", labelKey: "gpt-4-big", unit: "input_token", amountMicros: 20n, status: "active", effectiveFrom: from },
      { featureKey: "model.run", labelKey: "gpt-4-big", unit: "output_token", amountMicros: 60n, status: "active", effectiveFrom: from },
    ],
  });
}

async function fundedTeam(namespace: string, grantMicros: string) {
  const account = await service.ensureAccount({ siteId: SITE, ownerKind: "team", ownerId: namespace });
  await service.grantCredits({
    accountId: account.id,
    amountMicros: grantMicros,
    idempotencyKey: `${namespace}_grant`,
    reason: "subscription",
  });
  return account;
}

function setQuota(accountId: string, body: Record<string, unknown>) {
  return app.inject({ method: "POST", url: `/admin/credits/accounts/${accountId}/quota`, payload: body });
}

function hold(namespace: string, idempotencyKey: string, labelKey = "gpt-4") {
  return app.inject({
    method: "POST",
    url: "/credit/usage/hold",
    headers: { "x-kokoro-site-id": SITE },
    payload: { namespace, featureKey: "model.run", labelKey, idempotencyKey },
  });
}

function settle(holdId: string, idempotencyKey: string, inputTokens: number, outputTokens: number) {
  return app.inject({
    method: "POST",
    url: "/credit/usage/settle",
    payload: { holdId, usage: { inputTokens, outputTokens }, idempotencyKey },
  });
}

describe("credit organisation quota (period consumption cap)", () => {
  beforeEach(async () => {
    await cleanCreditDatabase(prisma);
    await seedPricing();
  });

  afterAll(async () => {
    await app.close();
    await prisma.$disconnect();
  });

  it("admin sets a quota that persists on the account", async () => {
    const account = await fundedTeam("q_set", "1000000");
    const response = await setQuota(account.id, { quotaMicros: "50000" });
    expect(response.statusCode).toBe(200);
    expect(response.json().data.quotaMicros).toBe("50000");
    expect(response.json().data.quotaPeriod).toBe("monthly");
    const stored = await prisma.creditAccount.findUniqueOrThrow({ where: { id: account.id } });
    expect(stored.quotaMicros).toBe(50000n);
    expect(stored.quotaPeriod).toBe("monthly");
  });

  it("does not restrict holds when no quota is set (unset = unlimited)", async () => {
    await fundedTeam("q_unset", "1000000");
    // 三次冻结共 28800 micros，无配额一律放行（余额充足）。
    for (const i of [1, 2, 3]) {
      const res = await hold("q_unset", `q_unset_${i}`);
      expect(res.statusCode).toBe(200);
    }
  });

  it("rejects with 402 credit.quota_exceeded once settled + in-flight holds + incoming exceed the quota", async () => {
    const account = await fundedTeam("q_fill", "1000000");
    await setQuota(account.id, { quotaMicros: "15000" });

    // 首次：settled 0 + held 0 + 10000 = 10000 <= 15000 → 放行（在持 10000=1 积分）。
    const first = await hold("q_fill", "q_fill_1");
    expect(first.statusCode).toBe(200);

    // 再来：settled 0 + held 10000 + 10000 = 20000 > 15000 → 402 quota_exceeded（在持 hold 计入本周期）。
    const second = await hold("q_fill", "q_fill_2");
    expect(second.statusCode).toBe(402);
    expect(second.json().error.code).toBe("credit.quota_exceeded");

    // 配额拒绝不动冻结额（第二次未落 hold）。
    const stored = await prisma.creditAccount.findUniqueOrThrow({ where: { id: account.id } });
    expect(stored.heldMicros).toBe(10000n);
  });

  it("distinguishes quota_exceeded from credit.insufficient (balance sufficient, period cap full)", async () => {
    const account = await fundedTeam("q_distinct", "1000000"); // 余额远超上限
    await setQuota(account.id, { quotaMicros: "5000" }); // 上限 < 单次冻结 10000
    const res = await hold("q_distinct", "q_distinct_1");
    expect(res.statusCode).toBe(402);
    expect(res.json().error.code).toBe("credit.quota_exceeded");
  });

  it("only counts the current natural-month period (last month's usage does not count)", async () => {
    const account = await fundedTeam("q_period", "1000000");
    await setQuota(account.id, { quotaMicros: "10000" });
    // 上月已结算 8000（reason model_call，借记 -8000）：本周期不计入。
    const lastMonth = new Date(Date.UTC(2000, 0, 15));
    await prisma.creditLedgerEntry.create({
      data: {
        accountId: account.id,
        amountMicros: -8000n,
        balanceAfterMicros: 992000n,
        reason: "model_call",
        idempotencyKey: "q_period_lastmonth",
        createdAt: lastMonth,
      },
    });
    // 本周期消费=0，held 0，incoming 10000 <= 10000 → 放行（上月 8000 未计）。
    const res = await hold("q_period", "q_period_1");
    expect(res.statusCode).toBe(200);
  });

  it("counts settled captures within the period but not the released buffer (clamp complements quota)", async () => {
    const account = await fundedTeam("q_settle", "1000000");
    await setQuota(account.id, { quotaMicros: "150000" });

    // 高价档:冻结 est=(1000*20+1000*60)*1.2=96000 → 向上取整 100000(10 积分)。
    // 实额 500*20+200*60=22000 → 向上取整 30000(3 积分);故释放 buffer=70000,配额不应计它。
    const held = await hold("q_settle", "q_settle_run1", "gpt-4-big");
    expect(held.statusCode).toBe(200);
    const holdId = held.json().data.holdId;
    const settled = await settle(holdId, "q_settle_run1", 500, 200);
    expect(settled.json().data.amountMicros).toBe("30000");

    // 本周期已结算 30000 + held 0 + incoming 100000 = 130000 <= 150000 → 放行。
    // 若把释放的 buffer(70000) 也算进配额，100000+100000=200000 会拒——此处放行即证明不双算。
    const next = await hold("q_settle", "q_settle_run2", "gpt-4-big");
    expect(next.statusCode).toBe(200);
  });

  it("clears the quota when set to null (reverts to unlimited)", async () => {
    const account = await fundedTeam("q_clear", "1000000");
    await setQuota(account.id, { quotaMicros: "5000" });
    const blocked = await hold("q_clear", "q_clear_1");
    expect(blocked.statusCode).toBe(402);

    const cleared = await setQuota(account.id, { quotaMicros: null });
    expect(cleared.statusCode).toBe(200);
    expect(cleared.json().data.quotaMicros).toBeNull();
    expect(cleared.json().data.quotaPeriod).toBeNull();

    const allowed = await hold("q_clear", "q_clear_2");
    expect(allowed.statusCode).toBe(200);
  });
});
