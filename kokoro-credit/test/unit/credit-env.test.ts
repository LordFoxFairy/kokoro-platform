import { describe, expect, it } from "vitest";
import { creditEnvSchema, loadCreditEnv } from "../../src/config/env.js";

const required = { DATABASE_URL_CREDIT: "mysql://root:pw@127.0.0.1:3306/credit" };

describe("creditEnvSchema", () => {
  it("applies defaults for optional vars", () => {
    const env = loadCreditEnv(required);
    expect(env.KOKORO_CREDIT_PORT).toBe(4231);
    expect(env.KOKORO_USER_BASE_URL).toBe("http://kokoro-user:4211");
  });

  it("defaults hold TTL and sweep interval, coercing overrides", () => {
    const env = loadCreditEnv(required);
    expect(env.KOKORO_CREDIT_HOLD_TTL_SECONDS).toBe(86400);
    expect(env.KOKORO_CREDIT_HOLD_SWEEP_INTERVAL_SECONDS).toBe(300);
    const overridden = loadCreditEnv({
      ...required,
      KOKORO_CREDIT_HOLD_TTL_SECONDS: "3600",
      KOKORO_CREDIT_HOLD_SWEEP_INTERVAL_SECONDS: "60",
    });
    expect(overridden.KOKORO_CREDIT_HOLD_TTL_SECONDS).toBe(3600);
    expect(overridden.KOKORO_CREDIT_HOLD_SWEEP_INTERVAL_SECONDS).toBe(60);
    expect(() => loadCreditEnv({ ...required, KOKORO_CREDIT_HOLD_TTL_SECONDS: "0" })).toThrow();
  });

  it("coerces port string and enforces range", () => {
    expect(loadCreditEnv({ ...required, KOKORO_CREDIT_PORT: "5000" }).KOKORO_CREDIT_PORT).toBe(5000);
    expect(() => loadCreditEnv({ ...required, KOKORO_CREDIT_PORT: "70000" })).toThrow();
  });

  it("rejects missing database url", () => {
    expect(() => loadCreditEnv({})).toThrow();
  });

  it("rejects non-url database value", () => {
    expect(() => loadCreditEnv({ DATABASE_URL_CREDIT: "not-a-url" })).toThrow();
  });

  it("strips unrelated process.env keys (intentional strip, not strict)", () => {
    const parsed = creditEnvSchema.parse({ ...required, PATH: "/usr/bin", HOME: "/root" });
    expect("PATH" in parsed).toBe(false);
  });
});
