import { describe, expect, it } from "vitest";
import { loadHubEnv } from "../../src/config/env.js";

describe("hub env", () => {
  it("applies defaults when only PATH-like extras are present", () => {
    const env = loadHubEnv({ PATH: "/usr/bin" });
    expect(env.KOKORO_HUB_PORT).toBe(4251);
    expect(env.KOKORO_HUB_BASE_URL).toBe("http://kokoro-hub:4251");
    expect(env.KOKORO_HUB_MONGO_URL).toBe("mongodb://127.0.0.1:27017");
    expect(env.KOKORO_HUB_MONGO_DB).toBe("kokoro_hub");
    expect(env.KOKORO_HUB_QUOTA_MAX_PACKAGES).toBe(100);
    expect(env.KOKORO_HUB_QUOTA_MAX_BYTES).toBe(200 * 1024 * 1024);
  });

  it("coerces numeric env vars from strings", () => {
    const env = loadHubEnv({
      KOKORO_HUB_PORT: "4999",
      KOKORO_HUB_QUOTA_MAX_PACKAGES: "5",
      KOKORO_HUB_QUOTA_MAX_BYTES: "1024",
    });
    expect(env.KOKORO_HUB_PORT).toBe(4999);
    expect(env.KOKORO_HUB_QUOTA_MAX_PACKAGES).toBe(5);
    expect(env.KOKORO_HUB_QUOTA_MAX_BYTES).toBe(1024);
  });

  it("rejects an out-of-range port", () => {
    expect(() => loadHubEnv({ KOKORO_HUB_PORT: "70000" })).toThrow();
  });
});
