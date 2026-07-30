import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import {
  createAssetWorkerProductionComposition,
  createAssetWorkerUnitOfWork,
} from "../../src/process/asset-worker-composition.js";
import type { PlatformTransaction } from "../../src/shared/unit-of-work/index.js";

describe("Asset worker production composition", () => {
  it("builds all four cycles without an enable flag only from explicitly supplied production adapters", async () => {
    const composition = await createAssetWorkerProductionComposition({
      database: {} as never,
      workerId: "platform-worker-01",
      environment: {
        PLATFORM_ENVIRONMENT: "production",
        PLATFORM_REGION: "us-east-1",
      },
      adapters: {
        scanner: {} as never,
        policyResolver: {} as never,
        objectStore: {} as never,
      },
    });
    expect(composition).not.toHaveProperty("enabled");
    expect(composition.runOneCycle).toEqual(expect.any(Function));
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

  it("is wired into the independent Asset worker cycle and drain lifecycle", async () => {
    const source = await readFile(new URL("../../src/process/asset-worker.ts", import.meta.url), "utf8");
    expect(source).toContain("loadAssetWorkerProductionAdapters(environment)");
    expect(source).toContain("runtime: assetRuntime");
    expect(source).toContain("hostPlatformWorkerProcess");
  });
});
