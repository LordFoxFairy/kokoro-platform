import { describe, expect, it, vi } from "vitest";
import type { CommandReceipt, JsonValue } from "../../src/shared/outbox-inbox/receipt.js";
import type { VerifiedRequestSecurityContext } from "../../src/shared/security-context/index.js";
import type { PlatformTransaction } from "../../src/shared/unit-of-work/index.js";
import { CompleteUploadService } from "../../src/modules/asset/application/services/complete-upload.js";
import { beginUploadCompletion, createUploadIntent, createUploadSession } from "../../src/modules/asset/domain/upload-intent.js";

const transaction = Object.freeze({}) as PlatformTransaction;
const context = Object.freeze({
  environment: "production", region: "us-east-1", correlationId: "correlation_01",
  trustedCaller: { kind: "site_product", workloadIdentityId: "workload_01", siteId: "site_01",
    siteReleaseRef: "release_01", bindingEpoch: "7", allowedOperations: ["asset.complete-upload"] },
  actor: { kind: "user", subjectId: "subject_01", subjectGeneration: "4" },
  target: { siteId: "site_01", projectId: "project_01", purpose: "asset.complete-upload" },
}) as unknown as VerifiedRequestSecurityContext;
const intent = createUploadIntent({
  intentRef: "upload_intent_01", siteRef: "site_01", workloadIdentityId: "workload_01",
  siteReleaseRef: "release_01", bindingEpoch: 7n, subjectRef: "subject_01", subjectGeneration: 4n,
  projectRef: "project_01", purpose: "chat.attachment", filename: "photo.png",
  clientMediaType: "image/png", expectedSize: 1234n, expectedChecksumSha256: "a".repeat(64),
  policy: { policyRevisionRef: "asset_policy_01", purpose: "chat.attachment", storageRegion: "us-east-1",
    maximumFileBytes: 10_000_000n, maximumInflightBytes: 100_000_000n,
    allowedClientMediaTypes: ["image/png"], expiresAt: "2026-07-29T12:00:00.000Z" },
  now: "2026-07-28T12:00:00.000Z",
});
const uploading = {
  ...createUploadSession({ sessionRef: "upload_session_01", intent, quotaRevisionRef: "quota_revision_01",
    storageTenantRef: "storage_tenant_01", storageRegion: "us-east-1",
    quarantineObjectRef: "quarantine/opaque_0123456789", capabilityAudience: "https://upload.example.test",
    minimumPartBytes: 100n, maximumPartBytes: 10_000_000n, capabilityLifetimeSeconds: 300 }),
  state: "uploading" as const, capabilityEpoch: 1n, capabilityExpiresAt: "2026-07-28T12:05:00.000Z",
  expectedVersion: 2n,
};

function fixture() {
  let receipt: CommandReceipt | null = null;
  const beginCompletion = vi.fn(async (_transaction, input: { expectedVersion: bigint }) =>
    beginUploadCompletion(uploading, input.expectedVersion));
  const enqueue = vi.fn(async () => undefined);
  const service = new CompleteUploadService({
    unitOfWork: { execute: async (_fence, work) => work(transaction) },
    repository: { beginCompletion },
    receipts: {
      begin: async (_transaction, identity) => {
        receipt ??= { ...identity, state: "pending", result: null, resultDigest: null };
        if (receipt.requestDigest !== identity.requestDigest) throw new Error("COMMAND_DIGEST_CONFLICT");
        return receipt;
      },
      recordOutcome: async (_transaction, identity, outcome) => {
        receipt = { ...identity, ...outcome };
        return receipt;
      },
    },
    outbox: { enqueue },
    eventId: () => "0198f758-2534-7aaa-8aaa-0123456789ab",
  });
  return { service, beginCompletion, enqueue, receipt: () => receipt };
}

const command = Object.freeze({
  context, commandId: "0198f758-2534-7bbb-8bbb-0123456789ab", idempotencyKey: "complete-command-01",
  intentRef: "upload_intent_01", sessionRef: "upload_session_01", expectedVersion: 2n,
});

describe("CompleteUploadService", () => {
  it("commits completing and its durable worker request in one owner transaction", async () => {
    const { service, enqueue, receipt } = fixture();
    await expect(service.execute(command)).resolves.toEqual({
      intentRef: "upload_intent_01", sessionRef: "upload_session_01", state: "completing",
      expectedVersion: 3n, completionReceiptRef: "0198f758-2534-7aaa-8aaa-0123456789ab",
    });
    expect(enqueue).toHaveBeenCalledWith(transaction, expect.objectContaining({
      owner: "asset", eventType: "asset.upload.completion.requested", aggregateId: "upload_session_01",
      payload: { kind: "asset_upload_completion_requested_v1", siteRef: "site_01",
        intentRef: "upload_intent_01", sessionRef: "upload_session_01", expectedVersion: "3" },
    }));
    expect(JSON.stringify(receipt()?.result as JsonValue)).not.toContain("quarantine");
  });

  it("replays the committed receipt without another state transition or outbox event", async () => {
    const { service, beginCompletion, enqueue } = fixture();
    const first = await service.execute(command);
    const replay = await service.execute(command);
    expect(replay).toEqual(first);
    expect(beginCompletion).toHaveBeenCalledTimes(1);
    expect(enqueue).toHaveBeenCalledTimes(1);
  });

  it("rejects a different Site authority before opening owner work", async () => {
    const { service, beginCompletion } = fixture();
    await expect(service.execute({ ...command,
      context: { ...context, target: { ...context.target, siteId: "site_02" } } as VerifiedRequestSecurityContext,
    })).rejects.toThrow("ASSET_USER_AUTHORITY_INVALID");
    expect(beginCompletion).not.toHaveBeenCalled();
  });
});
