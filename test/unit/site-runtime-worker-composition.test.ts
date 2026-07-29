import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { createSiteRuntimeWorkerProductionComposition } from "../../src/process/site-runtime-worker-composition.js";

describe("Site runtime worker production composition", () => {
  it("fails closed when the provider registry is not explicitly configured", async () => {
    await expect(createSiteRuntimeWorkerProductionComposition({ database: {} as never, environment: {
      PLATFORM_SITE_WORKER_ID: "site-worker-01",
    } })).rejects.toThrow("PLATFORM_SITE_PROVIDER_REGISTRY_FILE_REQUIRED");
  });

  it("is wired into the production worker lifecycle with lease draining", async () => {
    const source = await readFile(new URL("../../src/process/worker.ts", import.meta.url), "utf8");
    expect(source).toContain("createSiteRuntimeWorkerProductionComposition");
    expect(source).toContain("siteRuntime.runOneCycle(context)");
    expect(source).toContain("stopClaiming: siteRuntime.stopClaiming");
    expect(source).toContain("returnLease: siteRuntime.returnLease");
  });
});
