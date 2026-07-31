import { describe, expect, it } from "vitest";
import { loadModelImageWorkerProductionAdapters } from
  "../../src/process/model-image-worker-composition.js";

describe("model image worker production composition", () => {
  it("fails startup closed while no independently certified provider adapter is pinned", () => {
    expect(() => loadModelImageWorkerProductionAdapters())
      .toThrow("PLATFORM_MODEL_IMAGE_WORKER_CERTIFIED_PROVIDER_NOT_CONFIGURED");
  });
});
