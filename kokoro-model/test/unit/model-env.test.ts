import { describe, expect, it } from "vitest";
import { loadModelEnv, modelEnvSchema } from "../../src/config/env.js";

const required = { DATABASE_URL_MODEL: "mysql://root:pw@127.0.0.1:3306/model" };

describe("modelEnvSchema", () => {
  it("applies defaults for optional vars", () => {
    const env = loadModelEnv(required);
    expect(env.KOKORO_MODEL_PORT).toBe(4221);
    expect(env.KOKORO_USER_BASE_URL).toBe("http://kokoro-user:4211");
  });

  it("coerces port string and enforces range", () => {
    expect(loadModelEnv({ ...required, KOKORO_MODEL_PORT: "5000" }).KOKORO_MODEL_PORT).toBe(5000);
    expect(() => loadModelEnv({ ...required, KOKORO_MODEL_PORT: "70000" })).toThrow();
  });

  it("rejects missing database url", () => {
    expect(() => loadModelEnv({})).toThrow();
  });

  it("rejects non-url database value", () => {
    expect(() => loadModelEnv({ DATABASE_URL_MODEL: "not-a-url" })).toThrow();
  });

  it("strips unrelated process.env keys (intentional strip, not strict)", () => {
    const parsed = modelEnvSchema.parse({ ...required, PATH: "/usr/bin", HOME: "/root" });
    expect("PATH" in parsed).toBe(false);
  });
});
