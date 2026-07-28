import { describe, expect, it } from "vitest";
import { loadPaymentEnv, paymentEnvSchema } from "../../src/config/env.js";

const required = { DATABASE_URL_PAYMENT: "mysql://root:pw@127.0.0.1:3306/payment" };

describe("paymentEnvSchema", () => {
  it("applies defaults for optional vars", () => {
    const env = loadPaymentEnv(required);
    expect(env.KOKORO_PAYMENT_PORT).toBe(4241);
    expect(env).not.toHaveProperty("KOKORO_CREDIT_BASE_URL");
  });

  it("coerces port string and enforces range", () => {
    expect(loadPaymentEnv({ ...required, KOKORO_PAYMENT_PORT: "5000" }).KOKORO_PAYMENT_PORT).toBe(
      5000,
    );
    expect(() => loadPaymentEnv({ ...required, KOKORO_PAYMENT_PORT: "70000" })).toThrow();
  });

  it("rejects missing database url", () => {
    expect(() => loadPaymentEnv({})).toThrow();
  });

  it("rejects non-url database value", () => {
    expect(() => loadPaymentEnv({ DATABASE_URL_PAYMENT: "not-a-url" })).toThrow();
  });

  it("strips unrelated process.env keys (intentional strip, not strict)", () => {
    const parsed = paymentEnvSchema.parse({ ...required, PATH: "/usr/bin", HOME: "/root" });
    expect("PATH" in parsed).toBe(false);
  });

  it.each([
    ["KOKORO_PAYMENT_ENABLED_PROVIDERS", "stripe,mock"],
    ["KOKORO_PAYMENT_CONFIRM_SWEEP_INTERVAL_SECONDS", "1"],
    ["KOKORO_PAYMENT_CONFIRM_STALE_SECONDS", "1"],
    ["KOKORO_PAYMENT_WEBHOOK_SECRET_MOCK", "secret"],
    ["KOKORO_PAYMENT_WEBHOOK_SECRET_STRIPE", "secret"],
    ["KOKORO_PAYMENT_ALIPAY_PUBLIC_KEY", "public-key"],
    ["KOKORO_PAYMENT_WECHAT_PLATFORM_CERT", "certificate"],
    ["STRIPE_WEBHOOK_SECRET", "secret"],
    ["PAYPAL_WEBHOOK_SECRET", "secret"],
    ["WEBHOOK_SECRET", "secret"],
    ["KOKORO_PAYMENT_WEBHOOK_SIGNING_SECRET", "secret"],
    ["STRIPE_WEBHOOK_SIGNING_SECRET", "secret"],
  ])("fails fast with a stable error when deprecated acquisition variable %s is non-empty", (key, value) => {
    let thrown: unknown;
    try {
      loadPaymentEnv({ ...required, [key]: value });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toMatchObject({
      code: "payment.acquisition_env_forbidden",
      variables: [key],
    });
  });

  it.each([
    ["WEBHOOK_URL", "https://example.test/hooks"],
    ["SECRET_ROTATION_ID", "rotation-1"],
  ])("does not reject unrelated variable %s", (key, value) => {
    expect(loadPaymentEnv({ ...required, [key]: value })).toEqual({
      ...required,
      KOKORO_PAYMENT_PORT: 4241,
    });
  });

  it("allows empty deprecated variables during a rolling configuration cleanup", () => {
    const parsed = loadPaymentEnv({
      ...required,
      KOKORO_PAYMENT_ENABLED_PROVIDERS: "",
      KOKORO_PAYMENT_CONFIRM_SWEEP_INTERVAL_SECONDS: "  ",
      STRIPE_WEBHOOK_SECRET: "",
    });
    expect(parsed).toEqual({ ...required, KOKORO_PAYMENT_PORT: 4241 });
  });

  it("reports every non-empty deprecated acquisition variable deterministically", () => {
    let thrown: unknown;
    try {
      loadPaymentEnv({
        ...required,
        KOKORO_PAYMENT_CONFIRM_STALE_SECONDS: "1",
        KOKORO_PAYMENT_ENABLED_PROVIDERS: "stripe",
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toMatchObject({
      code: "payment.acquisition_env_forbidden",
      variables: [
        "KOKORO_PAYMENT_CONFIRM_STALE_SECONDS",
        "KOKORO_PAYMENT_ENABLED_PROVIDERS",
      ],
    });
  });
});
