import { describe, expect, it } from "vitest";
import {
  ASSET_PUBLIC_OPERATION_IDS,
  createAssetPublicOperations,
} from "../../src/modules/asset/interfaces/http/asset-public-operations.js";

describe("Asset public operations", () => {
  it("maps only generated owner inputs and never recovers a capability", async () => {
    const calls: unknown[] = [];
    const command = Object.freeze({
      receipt: Object.freeze({ commandId: "0198f758-2534-7bbb-8bbb-0123456789ab",
        receiptRef: "asset-command:1", operation: "create_asset_upload_intent" as const,
        state: "succeeded" as const, receivedAt: "2026-07-28T12:00:00.000Z",
        updatedAt: "2026-07-28T12:00:01.000Z" }),
      upload: Object.freeze({ intentRef: "intent_01", sessionRef: "session_01", projectRef: "project_01",
        purpose: "chat.attachment", safeDisplayName: "photo.png", clientMediaType: "image/png",
        expectedSize: "1234", expectedVersion: "2", stage: "uploading" as const, terminal: false,
        retryClass: "after_user_action" as const, retryAfter: null, safeReasonCode: null, trustedGrant: null }),
    });
    const operations = createAssetPublicOperations({
      create: { execute: async (input) => { calls.push({ create: input }); return {
        ...command.upload, state: "uploading" as const, expectedVersion: 2n, expectedSize: 1234n,
        expiresAt: "2026-07-28T12:05:00.000Z", commandId: command.receipt.commandId,
        capability: { protocolRevision: "s3-multipart-v1" as const,
          uploadEndpoint: "https://upload.example.test/v1/multipart", credential: "x".repeat(40),
          capabilityEpoch: 1n, expiresAt: "2026-07-28T12:05:00.000Z",
          minimumPartBytes: 100n, maximumPartBytes: 10_000n },
      }; } },
      complete: { execute: async (input) => { calls.push({ complete: input }); return {} as never; } },
      queries: {
        readCommand: async (input) => { calls.push({ readCommand: input }); return command; },
        getUploadStatus: async () => command.upload,
        getTrustedGrant: async () => ({ state: "ready" }) as never,
      },
    });
    expect(operations.map((operation) => operation.operationId)).toEqual(ASSET_PUBLIC_OPERATION_IDS);
    const create = operations.find((operation) => operation.operationId === "createAssetUploadIntent")!;
    const result = await create.execute({
      context: { context: true }, path: { projectRef: "project_01" },
      headers: { "X-Kokoro-Command-Id": command.receipt.commandId, "Idempotency-Key": "upload-command-01" },
      body: { purpose: "chat.attachment", filename: "photo.png", clientMediaType: "image/png",
        expectedSize: "1234", expectedChecksumSha256: "a".repeat(64) },
    } as never);
    expect(create.targetProjectRef?.({ body: null, path: { projectRef: "project_01" } } as never))
      .toBe("project_01");
    expect(result).toMatchObject({ capability: { capabilityEpoch: "1", minimumPartBytes: "100" },
      receipt: { state: "succeeded" }, upload: { stage: "uploading" } });

    const recover = operations.find((operation) => operation.operationId === "recoverAssetUploadCommand")!;
    const recovered = await recover.execute({ context: { context: true },
      path: { projectRef: "project_01", commandId: command.receipt.commandId } } as never);
    expect(JSON.stringify(recovered)).not.toContain("credential");
  });
});
