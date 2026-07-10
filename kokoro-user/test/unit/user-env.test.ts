import { describe, expect, it } from "vitest";
import { loadUserEnv, userEnvSchema } from "../../src/config/env.js";

const required = { DATABASE_URL_USER: "mysql://root:pw@127.0.0.1:3306/user" };

describe("userEnvSchema", () => {
  it("applies defaults for optional vars", () => {
    const env = loadUserEnv(required);
    expect(env.KOKORO_USER_PORT).toBe(4211);
    expect(env.KOKORO_CREDIT_BASE_URL).toBe("http://kokoro-credit:4231");
  });

  it("defaults auth signing vars and leaves secret unset", () => {
    const env = loadUserEnv(required);
    expect(env.KOKORO_AUTH_JWT_SECRET).toBeUndefined();
    expect(env.KOKORO_AUTH_JWT_TTL_SECONDS).toBe(3600);
    expect(env.KOKORO_AUTH_JWT_ISSUER).toBe("kokoro-user");
  });

  it("coerces auth ttl and enforces its range", () => {
    expect(
      loadUserEnv({ ...required, KOKORO_AUTH_JWT_TTL_SECONDS: "900" }).KOKORO_AUTH_JWT_TTL_SECONDS,
    ).toBe(900);
    expect(() => loadUserEnv({ ...required, KOKORO_AUTH_JWT_TTL_SECONDS: "10" })).toThrow();
    expect(() => loadUserEnv({ ...required, KOKORO_AUTH_JWT_TTL_SECONDS: "100000" })).toThrow();
  });

  it("coerces port string and enforces range", () => {
    expect(loadUserEnv({ ...required, KOKORO_USER_PORT: "5000" }).KOKORO_USER_PORT).toBe(5000);
    expect(() => loadUserEnv({ ...required, KOKORO_USER_PORT: "70000" })).toThrow();
  });

  it("rejects missing database url", () => {
    expect(() => loadUserEnv({})).toThrow();
  });

  it("rejects non-url database value", () => {
    expect(() => loadUserEnv({ DATABASE_URL_USER: "not-a-url" })).toThrow();
  });

  it("strips unrelated process.env keys (intentional strip, not strict)", () => {
    const parsed = userEnvSchema.parse({ ...required, PATH: "/usr/bin", HOME: "/root" });
    expect("PATH" in parsed).toBe(false);
  });
});
