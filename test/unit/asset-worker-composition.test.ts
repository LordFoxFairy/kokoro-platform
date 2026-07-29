import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import {
  createAssetWorkerProductionComposition,
  createAssetWorkerUnitOfWork,
} from "../../src/process/asset-worker-composition.js";
import type { PlatformTransaction } from "../../src/shared/unit-of-work/index.js";

describe("Asset worker production composition", () => {
  it("is an explicit no-op when the Site deployment has not enabled Asset", async () => {
    const composition = await createAssetWorkerProductionComposition({
      database: {} as never,
      workerId: "platform-worker-01",
      environment: {},
    });
    await expect(composition.runOneCycle({ signal: new AbortController().signal }))
      .resolves.toBeUndefined();
    expect(composition.enabled).toBe(false);
  });

  it("fails fast when Asset is enabled without a real scanner adapter", async () => {
    await expect(createAssetWorkerProductionComposition({
      database: {} as never,
      workerId: "platform-worker-01",
      environment: { PLATFORM_ASSET_WORKER_ENABLED: "true" },
    })).rejects.toThrow("PLATFORM_ASSET_SCANNER_ADAPTER_REQUIRED");
  });

  it("builds all four cycles only from explicitly supplied production adapters", async () => {
    const composition = await createAssetWorkerProductionComposition({
      database: {} as never,
      workerId: "platform-worker-01",
      environment: {
        PLATFORM_ASSET_WORKER_ENABLED: "true",
        PLATFORM_ENVIRONMENT: "production",
        PLATFORM_REGION: "us-east-1",
      },
      adapters: {
        scanner: {} as never,
        policyResolver: {} as never,
        objectStore: {} as never,
      },
    });
    expect(composition.enabled).toBe(true);
  });

  it("binds every domain mutation to the exact Asset Site scope", async () => {
    const transaction = Object.freeze({}) as PlatformTransaction;
    const internalScopedTransaction = vi.fn(async (_scope, work) => work(transaction));
    const unitOfWork = createAssetWorkerUnitOfWork({ internalScopedTransaction } as never, {
      environment: "production",
      region: "us-east-1",
    });
    await expect(unitOfWork.execute({
      operation: "asset.scan.evaluate",
      siteRef: "site_01",
    }, async (lease) => lease)).resolves.toBe(transaction);
    expect(internalScopedTransaction).toHaveBeenCalledWith({
      operation: "asset.scan.evaluate",
      siteRef: "site_01",
      environment: "production",
      region: "us-east-1",
      scopes: ["asset:worker"],
    }, expect.any(Function));
  });

  it("is wired into the shared worker cycle and drain lifecycle", async () => {
    const source = await readFile(new URL("../../src/process/worker.ts", import.meta.url), "utf8");
    expect(source).toContain("createAssetWorkerProductionComposition");
    expect(source).toContain("assetRuntime.runOneCycle");
    expect(source).toContain("assetRuntime.stopClaiming()");
    expect(source).toContain("assetRuntime.returnLeases(reason)");
  });
});
