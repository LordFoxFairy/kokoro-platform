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

// 默认配置：estInput=1000, estOutput=1000, buffer=20%，input_token/output_token 计价 unit。
// gpt-4: in=2,out=6 → 原始 est = (1000*2 + 1000*6) * 120/100 = 9600;整积分扣费向上取整 → 冻结 10000（=1 积分）。
async function seedPricing(): Promise<void> {
  const from = new Date(Date.now() - DAY);
  await prisma.pricingRule.createMany({
    data: [
      { featureKey: "model.run", labelKey: "gpt-4", unit: "input_token", amountMicros: 2n, status: "active", effectiveFrom: from },
      { featureKey: "model.run", labelKey: "gpt-4", unit: "output_token", amountMicros: 6n, status: "active", effectiveFrom: from },
      // 通用兜底（labelKey null），用于 label 无匹配时回退。
      { featureKey: "model.run", labelKey: null, unit: "input_token", amountMicros: 1n, status: "active", effectiveFrom: from },
      { featureKey: "model.run", labelKey: null, unit: "output_token", amountMicros: 3n, status: "active", effectiveFrom: from },
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

function hold(payload: Record<string, unknown>) {
  return app.inject({
    method: "POST",
    url: "/credit/usage/hold",
    headers: { "x-kokoro-site-id": SITE },
    payload,
  });
}

function settle(payload: Record<string, unknown>) {
  return app.inject({ method: "POST", url: "/credit/usage/settle", payload });
}

describe("credit usage billing face (run hold/settle)", () => {
  beforeEach(async () => {
    await cleanCreditDatabase(prisma);
    await seedPricing();
  });

  afterAll(async () => {
    await app.close();
    await prisma.$disconnect();
  });

  it("holds an estimated amount from pricing and persists the pricing ref", async () => {
    const account = await fundedTeam("team_hold", "100000");

    const response = await hold({
      namespace: "team_hold",
      featureKey: "model.run",
      labelKey: "gpt-4",
      idempotencyKey: "run_hold_1",
      modelBindingId: "binding_9",
      requestId: "run_hold_1",
    });

    expect(response.statusCode).toBe(200);
    const data = response.json().data;
    expect(data.amountMicros).toBe("10000");
    expect(data.accountId).toBe(account.id);

    const storedAccount = await prisma.creditAccount.findUniqueOrThrow({ where: { id: account.id } });
    expect(storedAccount.heldMicros.toString()).toBe("10000");

    const storedHold = await prisma.creditHold.findUniqueOrThrow({ where: { id: data.holdId } });
    expect(storedHold.featureKey).toBe("model.run");
    expect(storedHold.labelKey).toBe("gpt-4");
    expect(storedHold.modelBindingId).toBe("binding_9");
    expect(storedHold.requestId).toBe("run_hold_1");
    expect(storedHold.status).toBe("active");
  });

  it("resolves namespace to a team-owned account", async () => {
    await fundedTeam("team_ns", "100000");
    const response = await hold({ namespace: "team_ns", featureKey: "model.run", labelKey: "gpt-4", idempotencyKey: "run_ns" });

    const storedAccount = await prisma.creditAccount.findUniqueOrThrow({ where: { id: response.json().data.accountId } });
    expect(storedAccount.ownerKind).toBe("team");
    expect(storedAccount.ownerId).toBe("team_ns");
    expect(storedAccount.siteId).toBe(SITE);
  });

  it("returns 402 credit.insufficient when balance cannot cover the estimated hold", async () => {
    await fundedTeam("team_poor", "100");
    const response = await hold({ namespace: "team_poor", featureKey: "model.run", labelKey: "gpt-4", idempotencyKey: "run_poor" });

    expect(response.statusCode).toBe(402);
    expect(response.json().error.code).toBe("credit.insufficient");
  });

  it("holds idempotently for a repeated idempotency key (=run_id)", async () => {
    const account = await fundedTeam("team_hold_idem", "100000");
    const first = await hold({ namespace: "team_hold_idem", featureKey: "model.run", labelKey: "gpt-4", idempotencyKey: "run_idem" });
    const second = await hold({ namespace: "team_hold_idem", featureKey: "model.run", labelKey: "gpt-4", idempotencyKey: "run_idem" });

    expect(second.json().data.holdId).toBe(first.json().data.holdId);
    const stored = await prisma.creditAccount.findUniqueOrThrow({ where: { id: account.id } });
    expect(stored.heldMicros.toString()).toBe("10000");
  });

  it("settles by real usage: captures actual cost, clears the hold, writes a settled usage record", async () => {
    const account = await fundedTeam("team_settle", "100000");
    const held = await hold({ namespace: "team_settle", featureKey: "model.run", labelKey: "gpt-4", idempotencyKey: "run_settle" });
    const holdId = held.json().data.holdId;

    // actual 原始 = 500*2 + 200*6 = 2200 → 向上取整到 1 积分 = 10000（< hold 10000，不超冻结）
    const response = await settle({
      holdId,
      usage: { inputTokens: 500, outputTokens: 200 },
      idempotencyKey: "run_settle",
    });

    expect(response.statusCode).toBe(200);
    const data = response.json().data;
    expect(data.outcome).toBe("captured");
    expect(data.amountMicros).toBe("10000");
    expect(data.account.balanceMicros).toBe("90000");
    expect(data.account.heldMicros).toBe("0");

    const storedHold = await prisma.creditHold.findUniqueOrThrow({ where: { id: holdId } });
    expect(storedHold.status).toBe("captured");
    const usage = await prisma.usageRecord.findUniqueOrThrow({ where: { idempotencyKey: "run_settle:usage" } });
    expect(usage.status).toBe("settled");
    expect(usage.amountMicros.toString()).toBe("10000");
    expect(usage.featureKey).toBe("model.run");
    expect(usage.modelBindingId).toBeNull();
    const stored = await prisma.creditAccount.findUniqueOrThrow({ where: { id: account.id } });
    expect(stored.balanceMicros.toString()).toBe("90000");
    expect(stored.heldMicros.toString()).toBe("0");
  });

  it("settles idempotently without double charging on replay", async () => {
    const account = await fundedTeam("team_settle_idem", "100000");
    const held = await hold({ namespace: "team_settle_idem", featureKey: "model.run", labelKey: "gpt-4", idempotencyKey: "run_si" });
    const holdId = held.json().data.holdId;

    const first = await settle({ holdId, usage: { inputTokens: 500, outputTokens: 200 }, idempotencyKey: "run_si" });
    const second = await settle({ holdId, usage: { inputTokens: 500, outputTokens: 200 }, idempotencyKey: "run_si" });

    expect(second.json().data.amountMicros).toBe(first.json().data.amountMicros);
    const usageCount = await prisma.usageRecord.count({ where: { accountId: account.id } });
    expect(usageCount).toBe(1);
    const stored = await prisma.creditAccount.findUniqueOrThrow({ where: { id: account.id } });
    expect(stored.balanceMicros.toString()).toBe("90000");
    expect(stored.heldMicros.toString()).toBe("0");
  });

  it("clamps the captured amount to the hold when real usage exceeds the estimate (never over-charges)", async () => {
    const account = await fundedTeam("team_clamp", "100000");
    const held = await hold({ namespace: "team_clamp", featureKey: "model.run", labelKey: "gpt-4", idempotencyKey: "run_clamp" });
    const holdId = held.json().data.holdId;

    // actual 原始 = 800000 >> hold 10000 → clamp 到冻结额 10000（绝不超收）
    const response = await settle({
      holdId,
      usage: { inputTokens: 100000, outputTokens: 100000 },
      idempotencyKey: "run_clamp",
    });

    expect(response.json().data.amountMicros).toBe("10000");
    const stored = await prisma.creditAccount.findUniqueOrThrow({ where: { id: account.id } });
    expect(stored.balanceMicros.toString()).toBe("90000");
    expect(stored.heldMicros.toString()).toBe("0");
  });

  it("releases the hold without charging when usage prices to zero", async () => {
    const account = await fundedTeam("team_zero", "100000");
    const held = await hold({ namespace: "team_zero", featureKey: "model.run", labelKey: "gpt-4", idempotencyKey: "run_zero" });
    const holdId = held.json().data.holdId;

    const response = await settle({ holdId, usage: { inputTokens: 0, outputTokens: 0 }, idempotencyKey: "run_zero" });

    expect(response.json().data.outcome).toBe("released");
    expect(response.json().data.amountMicros).toBe("0");
    const storedHold = await prisma.creditHold.findUniqueOrThrow({ where: { id: holdId } });
    expect(storedHold.status).toBe("released");
    const stored = await prisma.creditAccount.findUniqueOrThrow({ where: { id: account.id } });
    expect(stored.balanceMicros.toString()).toBe("100000");
    expect(stored.heldMicros.toString()).toBe("0");
    const ledger = await prisma.creditLedgerEntry.count({ where: { accountId: account.id, reason: "model_call" } });
    expect(ledger).toBe(0);
  });

  it("falls back to the generic (null-label) pricing rules when the label has no rule", async () => {
    await fundedTeam("team_fallback", "100000");
    // 通用规则 in=1,out=3 → 原始 est = 4800 → 向上取整到 1 积分 = 10000
    const response = await hold({ namespace: "team_fallback", featureKey: "model.run", labelKey: "no-such-label", idempotencyKey: "run_fb" });
    expect(response.json().data.amountMicros).toBe("10000");
  });

  it("maps a missing pricing rule to 404 at hold time", async () => {
    await fundedTeam("team_nopricing", "100000");
    const response = await hold({ namespace: "team_nopricing", featureKey: "no.pricing", idempotencyKey: "run_np" });
    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe("credit.pricing_rule_not_found");
  });

  it("returns 404 credit.hold_not_found when settling an unknown hold", async () => {
    const response = await settle({ holdId: "missing_hold", usage: { inputTokens: 1, outputTokens: 1 }, idempotencyKey: "run_missing" });
    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe("credit.hold_not_found");
  });

  it("rejects settling a raw hold that carries no pricing ref (409)", async () => {
    const account = await fundedTeam("team_raw", "100000");
    const rawHold = await service.holdCredits({ accountId: account.id, amountMicros: "5000", idempotencyKey: "raw_hold" });

    const response = await settle({ holdId: rawHold.id, usage: { inputTokens: 1, outputTokens: 1 }, idempotencyKey: "run_raw" });
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe("credit.hold_not_usage_metered");
  });

  it("rejects negative or non-integer token counts at the HTTP boundary without touching the hold", async () => {
    const account = await fundedTeam("team_bad", "100000");
    const held = await hold({ namespace: "team_bad", featureKey: "model.run", labelKey: "gpt-4", idempotencyKey: "run_bad" });
    const holdId = held.json().data.holdId;

    const negative = await settle({ holdId, usage: { inputTokens: -1, outputTokens: 1 }, idempotencyKey: "run_bad_neg" });
    expect(negative.statusCode).toBe(400);
    const fractional = await settle({ holdId, usage: { inputTokens: 1.5, outputTokens: 1 }, idempotencyKey: "run_bad_frac" });
    expect(fractional.statusCode).toBe(400);

    // 边界拒绝后冻结未动、未入账。B1：hold 已把 10000 从永久桶移出（100000→90000）且保持预留，settle 被拒不改动。
    const storedHold = await prisma.creditHold.findUniqueOrThrow({ where: { id: holdId } });
    expect(storedHold.status).toBe("active");
    const stored = await prisma.creditAccount.findUniqueOrThrow({ where: { id: account.id } });
    expect(stored.heldMicros.toString()).toBe("10000");
    expect(stored.balanceMicros.toString()).toBe("90000");
  });

  it("prices usage directly: single direction, both directions, and rejects negative tokens", async () => {
    // 仅 output 有 token：input 方向 0 → 不入账、不需要 input 规则也应为 0；此处两方向规则都在，取 output。
    const onlyOutput = await repository.priceUsage({
      featureKey: "model.run",
      labelKey: "gpt-4",
      inputUnit: "input_token",
      outputUnit: "output_token",
      inputTokens: "0",
      outputTokens: "10",
    });
    expect(onlyOutput).toBe("60"); // 10 * 6

    const both = await repository.priceUsage({
      featureKey: "model.run",
      labelKey: "gpt-4",
      inputUnit: "input_token",
      outputUnit: "output_token",
      inputTokens: "5",
      outputTokens: "10",
    });
    expect(both).toBe("70"); // 5*2 + 10*6

    await expect(
      repository.priceUsage({
        featureKey: "model.run",
        labelKey: "gpt-4",
        inputUnit: "input_token",
        outputUnit: "output_token",
        inputTokens: "-1",
        outputTokens: "1",
      }),
    ).rejects.toThrow(/non-negative/);
  });

  it("requires the site header at hold time", async () => {
    await fundedTeam("team_nosite", "100000");
    const response = await app.inject({
      method: "POST",
      url: "/credit/usage/hold",
      payload: { namespace: "team_nosite", featureKey: "model.run", labelKey: "gpt-4", idempotencyKey: "run_nosite" },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("credit.site_required");
  });
});
