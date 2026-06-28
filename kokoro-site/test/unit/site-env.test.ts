import { describe, expect, it } from "vitest";
import { ZodError } from "zod";
import { loadSiteEnv } from "../../src/config/env.js";

describe("loadSiteEnv", () => {
  it("applies defaults when only DATABASE_URL_SITE is set", () => {
    const env = loadSiteEnv({ DATABASE_URL_SITE: "mysql://root:pw@127.0.0.1:3307/kokoro" });

    expect(env.DATABASE_URL_SITE).toBe("mysql://root:pw@127.0.0.1:3307/kokoro");
    expect(env.KOKORO_SITE_PORT).toBe(4201);
    expect(env.KOKORO_SITE_BASE_URL).toBe("http://kokoro-site:4201");
  });

  it("coerces a numeric port from a string", () => {
    const env = loadSiteEnv({
      DATABASE_URL_SITE: "mysql://root:pw@127.0.0.1:3307/kokoro",
      KOKORO_SITE_PORT: "5000",
    });

    expect(env.KOKORO_SITE_PORT).toBe(5000);
  });

  it("throws when DATABASE_URL_SITE is missing", () => {
    expect(() => loadSiteEnv({})).toThrow(ZodError);
  });

  it("throws when DATABASE_URL_SITE is not a URL", () => {
    expect(() => loadSiteEnv({ DATABASE_URL_SITE: "not-a-url" })).toThrow(ZodError);
  });

  it("rejects an out-of-range port", () => {
    expect(() =>
      loadSiteEnv({ DATABASE_URL_SITE: "mysql://root:pw@127.0.0.1:3307/kokoro", KOKORO_SITE_PORT: "70000" }),
    ).toThrow(ZodError);
  });
});
