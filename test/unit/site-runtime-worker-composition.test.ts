import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { createSiteRuntimeWorkerProductionComposition } from "../../src/process/site-runtime-worker-composition.js";

describe("Site runtime worker production composition", () => {
  it("fails closed when the provider registry is not explicitly configured", async () => {
    await expect(createSiteRuntimeWorkerProductionComposition({
      database: {} as never,
      workerId: "site-worker-01",
      environment: {},
    })).rejects.toThrow("PLATFORM_SITE_PROVIDER_REGISTRY_FILE_REQUIRED");
  });

  it("is wired into the production worker lifecycle with lease draining", async () => {
    const source = await readFile(new URL("../../src/process/site-worker.ts", import.meta.url), "utf8");
    expect(source).toContain("createSiteRuntimeWorkerProductionComposition");
    expect(source).toContain("siteRuntime.runOneCycle");
    expect(source).toContain("siteRuntime.stopClaiming");
    expect(source).toContain("siteRuntime.returnLease");
  });

  it.each([
    ["PLATFORM_SITE_OUTBOX_CLAIM_LIMIT", "0"],
    ["PLATFORM_SITE_OUTBOX_CLAIM_LIMIT", "101"],
    ["PLATFORM_SITE_OUTBOX_LEASE_SECONDS", "0"],
    ["PLATFORM_SITE_OUTBOX_LEASE_SECONDS", "301"],
    ["PLATFORM_SITE_OUTBOX_LEASE_SECONDS", "9007199254740992"],
  ])("fails fast for an unsafe %s=%s", async (name, value) => {
    await expect(createSiteRuntimeWorkerProductionComposition({
      database: {} as never,
      workerId: "site-worker-01",
      environment: {
        PLATFORM_SITE_PROVIDER_REGISTRY_FILE: "/not-read-before-validation",
        PLATFORM_AUTHORIZATION_EVENT_KEY_RING_FILE: "/not-read-before-validation",
        [name]: value,
      },
    })).rejects.toThrow(`${name}_INVALID`);
  });
});
