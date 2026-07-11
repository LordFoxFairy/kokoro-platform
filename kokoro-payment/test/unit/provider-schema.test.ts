import { describe, expect, it } from "vitest";
import { upsertProviderRequestSchema } from "../../src/interfaces/http/schemas.js";

describe("upsertProviderRequestSchema", () => {
  it("accepts a valid provider config with env-name secret ref", () => {
    const parsed = upsertProviderRequestSchema.parse({
      key: "mockpay",
      kind: "mock",
      webhookSecretRef: "KOKORO_PAYMENT_WEBHOOK_SECRET_MOCK",
    });
    expect(parsed.enabled).toBe(true);
  });

  it("accepts enabled=false", () => {
    const parsed = upsertProviderRequestSchema.parse({
      key: "stripe_main",
      kind: "stripe",
      webhookSecretRef: "STRIPE_WEBHOOK_SECRET",
      enabled: false,
    });
    expect(parsed.enabled).toBe(false);
  });

  it.each([
    // 形如密钥明文/非 env 变量名的 secretRef 一律拒绝，保证密钥不落库。
    "whsec_51H8xLkE2eZvKYlo2C",
    "mysecret",
    "lower_case_ref",
    "1STARTS_WITH_DIGIT",
    "HAS SPACE",
    "",
  ])("rejects a non-env-name webhookSecretRef %j", (webhookSecretRef) => {
    const result = upsertProviderRequestSchema.safeParse({
      key: "mockpay",
      kind: "mock",
      webhookSecretRef,
    });
    expect(result.success).toBe(false);
  });

  it.each(["", "UPPER", "-leading", "has space", "0digit"])("rejects invalid provider key %j", (key) => {
    const result = upsertProviderRequestSchema.safeParse({
      key,
      kind: "mock",
      webhookSecretRef: "KOKORO_PAYMENT_WEBHOOK_SECRET_MOCK",
    });
    expect(result.success).toBe(false);
  });

  it("rejects unknown kinds and unknown fields", () => {
    expect(
      upsertProviderRequestSchema.safeParse({
        key: "paddle_main",
        kind: "paddle",
        webhookSecretRef: "PADDLE_WEBHOOK_SECRET",
      }).success,
    ).toBe(false);
    expect(
      upsertProviderRequestSchema.safeParse({
        key: "mockpay",
        kind: "mock",
        webhookSecretRef: "KOKORO_PAYMENT_WEBHOOK_SECRET_MOCK",
        bogus: 1,
      }).success,
    ).toBe(false);
  });
});
