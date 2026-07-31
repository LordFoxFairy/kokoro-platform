import { describe, expect, it, vi } from "vitest";
import {
  ARTIFACT_PUBLIC_OPERATION_IDS,
  createArtifactPublicApplicationOperations,
  createArtifactPublicOperations,
} from "../../src/modules/artifact/index.js";

describe("Artifact public control plane", () => {
  it("keeps metadata and authorization JSON operations separate from binary redemption", async () => {
    const owner = Object.fromEntries(ARTIFACT_PUBLIC_OPERATION_IDS.map((operationId) => [
      operationId,
      vi.fn(async () => ({ operationId })),
    ])) as never;
    const operations = createArtifactPublicOperations(owner);

    expect(operations.map((operation) => operation.operationId)).toEqual([
      "listArtifacts",
      "getArtifact",
      "listArtifactVersions",
      "getArtifactVersion",
      "issueArtifactDeliveryAuthorization",
      "revokeArtifactDeliveryAuthorization",
    ]);
    expect(operations.some((operation) =>
      operation.operationId === "redeemArtifactDeliveryAuthorization")).toBe(false);
  });

  it("adapts generated HTTP DTOs to the application owner without leaking transport fields", async () => {
    const listArtifacts = vi.fn(async () => ({ items: [], pageInfo: { hasMore: false, nextCursor: null } }));
    const issueDeliveryAuthorization = vi.fn(async () => ({ authorization: {} }));
    const revokeDeliveryAuthorization = vi.fn(async () => ({ receipt: {} }));
    const operations = createArtifactPublicApplicationOperations({
      listArtifacts,
      getArtifact: vi.fn(), listArtifactVersions: vi.fn(), getArtifactVersion: vi.fn(),
      issueDeliveryAuthorization,
      revokeDeliveryAuthorization,
    } as never);
    const context = Object.freeze({ target: { projectId: "project_01" } });
    await operation(operations, "listArtifacts").execute({
      context, query: { cursor: "cursor_01", limit: 5 }, path: { projectRef: "project_01" },
    } as never);
    await operation(operations, "issueArtifactDeliveryAuthorization").execute({
      context, path: { projectRef: "project_01", artifactRef: "artifact_01",
        artifactVersionRef: "version_01" }, body: { purpose: "preview", viewportClass: "canvas" },
    } as never);
    await operation(operations, "revokeArtifactDeliveryAuthorization").execute({
      context, path: { projectRef: "project_01", authorizationRef: "authorization_01" },
      body: { reason: "user_requested" },
    } as never);

    expect(listArtifacts).toHaveBeenCalledWith({ context, cursor: "cursor_01", limit: 5 });
    expect(issueDeliveryAuthorization).toHaveBeenCalledWith({ context,
      artifactRef: "artifact_01", artifactVersionRef: "version_01",
      request: { purpose: "preview", viewportClass: "canvas" } });
    expect(revokeDeliveryAuthorization).toHaveBeenCalledWith({
      context, authorizationRef: "authorization_01", reason: "user_requested",
    });
  });
});

function operation(operations: readonly { operationId: string; execute(input: never): Promise<unknown> }[],
  operationId: string) {
  const match = operations.find((candidate) => candidate.operationId === operationId);
  if (match === undefined) throw new Error("OPERATION_MISSING");
  return match;
}
