import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { CreditService } from "../../src/application/credit-service.js";
import { PricingRuleNotFoundError } from "../../src/domain/errors.js";
import { PrismaCreditRepository } from "../../src/infrastructure/prisma/prisma-credit-repository.js";
import { createCreditServer } from "../../src/interfaces/http/server.js";
import { cleanCreditDatabase, createTestPrismaClient } from "./helpers.js";

const prisma = createTestPrismaClient();
const repository = new PrismaCreditRepository(prisma);
const service = new CreditService(repository);
const app = createCreditServer({ prisma });

const DAY = 24 * 60 * 60 * 1000;

async function seedRules(): Promise<void> {
  const now = Date.now();
  await prisma.pricingRule.createMany({
    data: [
      {
        featureKey: "model.call",
        labelKey: null,
        unit: "token",
        amountMicros: 100n,
        status: "active",
        effectiveFrom: new Date(now - DAY),
      },
      {
        featureKey: "model.call",
        labelKey: "gpt-4",
        unit: "token",
        amountMicros: 500n,
        status: "active",
        effectiveFrom: new Date(now - DAY),
      },
      {
        featureKey: "model.call",
        labelKey: "gpt-4",
        unit: "token",
        amountMicros: 9999n,
        status: "disabled",
        effectiveFrom: new Date(now - DAY),
      },
      {
        featureKey: "model.call",
        labelKey: "expired-label",
        unit: "token",
        amountMicros: 7777n,
        status: "active",
        effectiveFrom: new Date(now - 2 * DAY),
        effectiveUntil: new Date(now - DAY),
      },
    ],
  });
}

describe("credit quote", () => {
  beforeEach(async () => {
    await cleanCreditDatabase(prisma);
    await seedRules();
  });

  afterAll(async () => {
    await app.close();
    await prisma.$disconnect();
  });

  it("selects the exact labelKey rule over the generic one", async () => {
    const quote = await service.quote({ featureKey: "model.call", labelKey: "gpt-4", quantity: "3" });
    expect(quote.unitAmountMicros).toBe("500");
    expect(quote.amountMicros).toBe("1500");
    expect(quote.unit).toBe("token");
    expect(quote.labelKey).toBe("gpt-4");
    expect(quote.quantity).toBe("3");
  });

  it("falls back to the generic null rule when labelKey has no exact match", async () => {
    const quote = await service.quote({ featureKey: "model.call", labelKey: "unknown", quantity: "2" });
    expect(quote.unitAmountMicros).toBe("100");
    expect(quote.amountMicros).toBe("200");
    expect(quote.labelKey).toBe("unknown");
  });

  it("uses the generic rule when no labelKey is given and defaults quantity to 1", async () => {
    const quote = await service.quote({ featureKey: "model.call" });
    expect(quote.unitAmountMicros).toBe("100");
    expect(quote.amountMicros).toBe("100");
    expect(quote.quantity).toBe("1");
    expect(quote.labelKey).toBeNull();
  });

  it("skips disabled rules (would otherwise win)", async () => {
    const quote = await service.quote({ featureKey: "model.call", labelKey: "gpt-4" });
    expect(quote.unitAmountMicros).toBe("500");
  });

  it("skips expired rules and falls back to generic", async () => {
    const quote = await service.quote({ featureKey: "model.call", labelKey: "expired-label" });
    expect(quote.unitAmountMicros).toBe("100");
  });

  it("prefers the newest effectiveFrom among same-tier rules", async () => {
    const now = Date.now();
    await prisma.pricingRule.create({
      data: {
        featureKey: "tool.call",
        labelKey: null,
        unit: "call",
        amountMicros: 10n,
        status: "active",
        effectiveFrom: new Date(now - 2 * DAY),
      },
    });
    await prisma.pricingRule.create({
      data: {
        featureKey: "tool.call",
        labelKey: null,
        unit: "call",
        amountMicros: 20n,
        status: "active",
        effectiveFrom: new Date(now - DAY),
      },
    });

    const quote = await service.quote({ featureKey: "tool.call", quantity: "4" });
    expect(quote.unitAmountMicros).toBe("20");
    expect(quote.amountMicros).toBe("80");
  });

  it("throws PricingRuleNotFoundError when no rule matches", async () => {
    await expect(service.quote({ featureKey: "missing.feature" })).rejects.toBeInstanceOf(
      PricingRuleNotFoundError,
    );
  });

  it("skips deleted pricing rules and falls back to generic rules", async () => {
    const now = Date.now();
    await prisma.pricingRule.create({
      data: {
        featureKey: "deleted.quote",
        labelKey: null,
        unit: "token",
        amountMicros: 100n,
        status: "active",
        effectiveFrom: new Date(now - DAY),
      },
    });
    const specific = await prisma.pricingRule.create({
      data: {
        featureKey: "deleted.quote",
        labelKey: "premium",
        unit: "token",
        amountMicros: 900n,
        status: "active",
        effectiveFrom: new Date(now - DAY),
      },
    });

    await repository.deletePricingRule({ id: specific.id, deletedBy: "operator-1", reason: "retired" });

    const quote = await service.quote({ featureKey: "deleted.quote", labelKey: "premium", quantity: "2" });
    expect(quote.unitAmountMicros).toBe("100");
    expect(quote.amountMicros).toBe("200");
  });

  it("restores deleted pricing rules to quote eligibility", async () => {
    const rule = await prisma.pricingRule.create({
      data: {
        featureKey: "restore.quote",
        labelKey: null,
        unit: "token",
        amountMicros: 321n,
        status: "active",
        effectiveFrom: new Date(Date.now() - DAY),
      },
    });

    await repository.deletePricingRule({ id: rule.id, deletedBy: "operator-1", reason: "retired" });
    await expect(service.quote({ featureKey: "restore.quote" })).rejects.toBeInstanceOf(PricingRuleNotFoundError);

    const restored = await repository.restorePricingRule({ id: rule.id });
    expect(restored.deletedAt).toBeNull();
    const quote = await service.quote({ featureKey: "restore.quote", quantity: "3" });
    expect(quote.amountMicros).toBe("963");
  });

  it("returns 200 with the computed quote over the HTTP route", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/credit/quote",
      payload: { featureKey: "model.call", labelKey: "gpt-4", quantity: "10" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().data.amountMicros).toBe("5000");
    expect(response.json().data.unitAmountMicros).toBe("500");
  });

  it("maps a missing pricing rule to 404 over the HTTP route", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/credit/quote",
      payload: { featureKey: "missing.feature" },
    });

    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe("credit.pricing_rule_not_found");
  });
});
