import { describe, expect, it } from "vitest";
import {
  creditMutationRequestSchema,
  ensureCreditAccountRequestSchema,
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
