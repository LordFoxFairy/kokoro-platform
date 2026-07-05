import { describe, expect, it } from "vitest";
import {
  accountParamsSchema,
  auditAccountParamsSchema,
  createPricingRuleRequestSchema,
  creditMutationRequestSchema,
  deleteRequestSchema,
  ensureCreditAccountRequestSchema,
  grantCreditRequestSchema,
  pricingRuleParamsSchema,
  quoteRequestSchema,
} from "../../src/interfaces/http/schemas.js";

describe("credit HTTP schemas reject unknown fields", () => {
  it("ensureCreditAccountRequestSchema rejects extra keys", () => {
    expect(() =>
      ensureCreditAccountRequestSchema.parse({ ownerKind: "user", ownerId: "u1", extra: 1 }),
    ).toThrow();
  });

  it("creditMutationRequestSchema rejects extra keys", () => {
    expect(() =>
      creditMutationRequestSchema.parse({
        accountId: "a1",
        amountMicros: "100",
        idempotencyKey: "k1",
        reason: "subscription",
        bogus: true,
      }),
    ).toThrow();
  });
});

describe("creditMutationRequestSchema.amountMicros boundaries", () => {
  const base = { accountId: "a1", idempotencyKey: "k1", reason: "subscription" as const };

  it.each(["0", "-1", "", "abc", "01", " 5", "1.5", "12.0", "5x"])(
    "rejects invalid amountMicros %j",
    (amountMicros) => {
      expect(() => creditMutationRequestSchema.parse({ ...base, amountMicros })).toThrow();
    },
  );

  it.each(["1", "1000000", "99999999999999999999999999"])(
    "accepts positive integer string %j",
    (amountMicros) => {
      expect(creditMutationRequestSchema.parse({ ...base, amountMicros }).amountMicros).toBe(
        amountMicros,
      );
    },
  );
});

describe("credit schemas enum + required", () => {
  it("rejects invalid ownerKind", () => {
    expect(() =>
      ensureCreditAccountRequestSchema.parse({ ownerKind: "org", ownerId: "u1" }),
    ).toThrow();
  });
  it("rejects empty ownerId", () => {
    expect(() =>
      ensureCreditAccountRequestSchema.parse({ ownerKind: "user", ownerId: "" }),
    ).toThrow();
  });
  it("rejects missing ownerKind", () => {
    expect(() => ensureCreditAccountRequestSchema.parse({ ownerId: "u1" })).toThrow();
  });
  it("rejects invalid reason", () => {
    expect(() =>
      creditMutationRequestSchema.parse({
        accountId: "a1",
        amountMicros: "1",
        idempotencyKey: "k1",
        reason: "gift",
      }),
    ).toThrow();
  });
  it("rejects missing idempotencyKey", () => {
    expect(() =>
      creditMutationRequestSchema.parse({
        accountId: "a1",
        amountMicros: "1",
        reason: "subscription",
      }),
    ).toThrow();
  });
  it("rejects empty accountId", () => {
    expect(() =>
      creditMutationRequestSchema.parse({
        accountId: "",
        amountMicros: "1",
        idempotencyKey: "k1",
        reason: "subscription",
      }),
    ).toThrow();
  });
  it("accepts omitted optional requestId", () => {
    expect(
      creditMutationRequestSchema.parse({
        accountId: "a1",
        amountMicros: "1",
        idempotencyKey: "k1",
        reason: "subscription",
      }).requestId,
    ).toBeUndefined();
  });
  it("rejects empty requestId", () => {
    expect(() =>
      creditMutationRequestSchema.parse({
        accountId: "a1",
        amountMicros: "1",
        idempotencyKey: "k1",
        reason: "subscription",
        requestId: "",
      }),
    ).toThrow();
  });
});

describe("grantCreditRequestSchema (admin manual grant)", () => {
  const base = { ownerKind: "user" as const, ownerId: "u1", amountMicros: "1000000", reason: "manual_adjustment" as const };

  it("accepts a valid grant payload", () => {
    expect(grantCreditRequestSchema.parse(base)).toEqual(base);
  });
  it("accepts reason=refund (退积分)", () => {
    expect(grantCreditRequestSchema.parse({ ...base, reason: "refund" }).reason).toBe("refund");
  });
  it("rejects unknown fields", () => {
    expect(() => grantCreditRequestSchema.parse({ ...base, accountId: "a1" })).toThrow();
  });
  it("rejects accountId-style body (must derive account from owner)", () => {
    expect(() =>
      grantCreditRequestSchema.parse({ accountId: "a1", amountMicros: "1", reason: "refund" }),
    ).toThrow();
  });
  it.each(["0", "-1", "", "abc", "01", " 5", "1.5"])("rejects invalid amountMicros %j", (amountMicros) => {
    expect(() => grantCreditRequestSchema.parse({ ...base, amountMicros })).toThrow();
  });
  it("rejects empty ownerId", () => {
    expect(() => grantCreditRequestSchema.parse({ ...base, ownerId: "" })).toThrow();
  });
  it("rejects invalid ownerKind", () => {
    expect(() => grantCreditRequestSchema.parse({ ...base, ownerKind: "org" })).toThrow();
  });
  it("rejects invalid reason", () => {
    expect(() => grantCreditRequestSchema.parse({ ...base, reason: "gift" })).toThrow();
  });
  it("rejects missing amountMicros", () => {
    expect(() =>
      grantCreditRequestSchema.parse({ ownerKind: "user", ownerId: "u1", reason: "refund" }),
    ).toThrow();
  });
});

describe("auditAccountParamsSchema", () => {
  it("accepts a non-empty accountId", () => {
    expect(auditAccountParamsSchema.parse({ accountId: "a1" }).accountId).toBe("a1");
  });
  it("rejects empty accountId", () => {
    expect(() => auditAccountParamsSchema.parse({ accountId: "" })).toThrow();
  });
  it("rejects unknown fields", () => {
    expect(() => auditAccountParamsSchema.parse({ accountId: "a1", extra: 1 })).toThrow();
  });
});

describe("quoteRequestSchema", () => {
  it("rejects missing featureKey", () => {
    expect(() => quoteRequestSchema.parse({ quantity: "1" })).toThrow();
  });
  it("rejects empty featureKey", () => {
    expect(() => quoteRequestSchema.parse({ featureKey: "" })).toThrow();
  });
  it("rejects unknown fields", () => {
    expect(() => quoteRequestSchema.parse({ featureKey: "model.call", bogus: 1 })).toThrow();
  });
  it.each(["0", "-1", "", "abc", "01", " 5", "1.5"])(
    "rejects invalid quantity %j",
    (quantity) => {
      expect(() => quoteRequestSchema.parse({ featureKey: "model.call", quantity })).toThrow();
    },
  );
  it("accepts minimal payload and leaves quantity/labelKey optional", () => {
    const parsed = quoteRequestSchema.parse({ featureKey: "model.call" });
    expect(parsed.quantity).toBeUndefined();
    expect(parsed.labelKey).toBeUndefined();
  });
  it("accepts labelKey and positive quantity", () => {
    const parsed = quoteRequestSchema.parse({
      featureKey: "model.call",
      labelKey: "gpt-4",
      quantity: "10",
    });
    expect(parsed.labelKey).toBe("gpt-4");
    expect(parsed.quantity).toBe("10");
  });
  it("rejects empty labelKey", () => {
    expect(() => quoteRequestSchema.parse({ featureKey: "model.call", labelKey: "" })).toThrow();
  });
});

describe("lifecycle route schemas", () => {
  it("accepts account and pricing params", () => {
    expect(accountParamsSchema.parse({ accountId: "a1" })).toEqual({ accountId: "a1" });
    expect(pricingRuleParamsSchema.parse({ pricingRuleId: "pr1" })).toEqual({ pricingRuleId: "pr1" });
  });

  it("rejects empty lifecycle params and unknown fields", () => {
    expect(() => accountParamsSchema.parse({ accountId: "" })).toThrow();
    expect(() => pricingRuleParamsSchema.parse({ pricingRuleId: "" })).toThrow();
    expect(() => accountParamsSchema.parse({ accountId: "a1", extra: 1 })).toThrow();
    expect(() => pricingRuleParamsSchema.parse({ pricingRuleId: "pr1", extra: 1 })).toThrow();
  });

  it("accepts delete audit payloads", () => {
    expect(deleteRequestSchema.parse({ deletedBy: "operator-1", reason: "closed" })).toEqual({
      deletedBy: "operator-1",
      reason: "closed",
    });
    expect(deleteRequestSchema.parse({ deletedBy: "operator-1" })).toEqual({ deletedBy: "operator-1" });
  });

  it("rejects invalid delete audit payloads", () => {
    expect(() => deleteRequestSchema.parse({ deletedBy: "" })).toThrow();
    expect(() => deleteRequestSchema.parse({ deletedBy: "operator-1", reason: "" })).toThrow();
    expect(() => deleteRequestSchema.parse({ deletedBy: "operator-1", extra: 1 })).toThrow();
  });
});

describe("createPricingRuleRequestSchema", () => {
  const base = {
    featureKey: "model.call",
    unit: "token",
    amountMicros: "100",
  };

  it("accepts a minimal active pricing rule payload", () => {
    expect(createPricingRuleRequestSchema.parse(base)).toEqual(base);
  });

  it("accepts optional label, status, and effective window", () => {
    const parsed = createPricingRuleRequestSchema.parse({
      ...base,
      labelKey: "gpt-4",
      status: "disabled",
      effectiveFrom: "2026-07-04T00:00:00.000Z",
      effectiveUntil: "2026-08-04T00:00:00.000Z",
    });
    expect(parsed.labelKey).toBe("gpt-4");
    expect(parsed.status).toBe("disabled");
    expect(parsed.effectiveFrom).toBeInstanceOf(Date);
    expect(parsed.effectiveUntil).toBeInstanceOf(Date);
  });

  it.each(["0", "-1", "", "abc", "01", "1.5"])("rejects invalid amountMicros %j", (amountMicros) => {
    expect(() => createPricingRuleRequestSchema.parse({ ...base, amountMicros })).toThrow();
  });

  it("rejects empty strings, invalid status, and unknown fields", () => {
    expect(() => createPricingRuleRequestSchema.parse({ ...base, featureKey: "" })).toThrow();
    expect(() => createPricingRuleRequestSchema.parse({ ...base, unit: "" })).toThrow();
    expect(() => createPricingRuleRequestSchema.parse({ ...base, labelKey: "" })).toThrow();
    expect(() => createPricingRuleRequestSchema.parse({ ...base, status: "archived" })).toThrow();
    expect(() => createPricingRuleRequestSchema.parse({ ...base, extra: 1 })).toThrow();
  });
});
