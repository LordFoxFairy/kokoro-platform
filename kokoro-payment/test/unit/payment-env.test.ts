import { describe, expect, it } from "vitest";
import { loadPaymentEnv, paymentEnvSchema } from "../../src/config/env.js";

const required = { DATABASE_URL_PAYMENT: "mysql://root:pw@127.0.0.1:3306/payment" };

describe("paymentEnvSchema", () => {
  it("applies defaults for optional vars", () => {
    const env = loadPaymentEnv(required);
    expect(env.KOKORO_PAYMENT_PORT).toBe(4241);
    expect(env.KOKORO_CREDIT_BASE_URL).toBe("http://kokoro-credit:4231");
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
});
