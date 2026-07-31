import { describe, expect, it, vi } from "vitest";
import { createPlatformPublicOperationRegistry } from
  "../../src/interfaces/http/platform-public-operation-registry.js";
import {
  createMediaPublicOperations,
  MEDIA_PUBLIC_OPERATION_IDS,
  type MediaPublicOperationOwner,
} from "../../src/modules/media/interfaces/http/index.js";

describe("Media public generated operation ownership", () => {
  it("requires and registers the complete project-scoped Direct Studio surface", () => {
    const execute = vi.fn(async () => ({}));
    const owner = Object.fromEntries(MEDIA_PUBLIC_OPERATION_IDS.map((id) => [id, execute])) as
      unknown as MediaPublicOperationOwner;
    const operations = createMediaPublicOperations(owner);
    const registry = createPlatformPublicOperationRegistry(operations, MEDIA_PUBLIC_OPERATION_IDS);

    expect(operations.map((item) => item.operationId)).toEqual(MEDIA_PUBLIC_OPERATION_IDS);
    expect(registry.match("POST", "/v1/projects/project:one/media-operations"))
      .toMatchObject({ descriptor: { operationId: "submitMediaOperation" },
        path: { projectRef: "project:one" } });
  });
});
