import { describe, expect, it, vi } from "vitest";
import { createArtifactDataPlaneProductionComposition } from
  "../../src/process/artifact-data-plane-composition.js";
import type { ProductWorkloadRegistry } from
  "../../src/modules/authorization/infrastructure/transport/product-workload-registry.js";

const database = {
  connect: vi.fn(async () => undefined), checkHealth: vi.fn(async () => undefined),
  disconnect: vi.fn(async () => undefined), transaction: vi.fn(),
};

describe("Artifact data-plane production composition", () => {
  it("fails closed while the durable owner and private object provider revision are not certified", async () => {
    const loadWorkloads = vi.fn();

    await expect(createArtifactDataPlaneProductionComposition({
      database,
      environment: {
        PLATFORM_ARTIFACT_DATA_PLANE_OWNER_ADAPTER_REVISION: "candidate-v1",
      },
      loadWorkloads,
    })).rejects.toThrow("ARTIFACT_DATA_PLANE_OWNER_ADAPTER_NOT_CERTIFIED");
    expect(loadWorkloads).not.toHaveBeenCalled();
  });

  it("activates only the built-in certified PostgreSQL/S3 owner revision", async () => {
    const runtime = {
      redeem: vi.fn(), checkHealth: vi.fn(async () => undefined), close: vi.fn(async () => undefined),
    };
    const composition = await createArtifactDataPlaneProductionComposition({
      database,
      environment: { PLATFORM_ARTIFACT_DATA_PLANE_OWNER_ADAPTER_REVISION: "postgres-s3-v1" },
      loadWorkloads: async () => ({ authenticate: vi.fn() }) as unknown as ProductWorkloadRegistry,
      loadRuntime: async () => runtime,
      loadTls: async () => ({}),
    });

    await expect(composition.checkHealth()).resolves.toBeUndefined();
    await expect(composition.close()).resolves.toBeUndefined();
    expect(runtime.checkHealth).toHaveBeenCalledOnce();
    expect(runtime.close).toHaveBeenCalledOnce();
  });
});
