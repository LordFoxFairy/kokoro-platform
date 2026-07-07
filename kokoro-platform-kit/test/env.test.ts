import { z } from "zod";
import { describe, expect, it } from "vitest";
import { defineEnv, EnvValidationError } from "../src/config/env.js";

const schema = z.object({
  PORT: z.coerce.number().int().positive(),
  GATEWAY_URL: z.string().url(),
});

describe("defineEnv", () => {
  it("returns a strongly-typed, coerced config on valid source", () => {
    const env = defineEnv(schema, { PORT: "4290", GATEWAY_URL: "http://gw.local" });
    expect(env.PORT).toBe(4290);
    expect(env.GATEWAY_URL).toBe("http://gw.local");
  });

  it("throws EnvValidationError listing every failing key", () => {
    try {
      defineEnv(schema, { PORT: "not-a-number" });
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(EnvValidationError);
      const issues = (error as EnvValidationError).issues;
      const text = issues.join("\n");
      expect(text).toContain("PORT");
      expect(text).toContain("GATEWAY_URL");
      expect(issues.length).toBeGreaterThanOrEqual(2);
    }
  });
});
