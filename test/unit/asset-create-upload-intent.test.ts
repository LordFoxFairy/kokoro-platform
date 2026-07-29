import { describe, expect, it, vi } from "vitest";
import type { VerifiedRequestSecurityContext } from "../../src/shared/security-context/index.js";
import type { PlatformTransaction } from "../../src/shared/unit-of-work/index.js";
import type { CommandReceipt } from "../../src/shared/outbox-inbox/receipt.js";
import { markUploadCapabilityIssued, type AssetUploadIntent, type AssetUploadSession } from "../../src/modules/asset/domain/upload-intent.js";
import { CreateUploadIntentService } from "../../src/modules/asset/application/services/create-upload-intent.js";

const transaction = Object.freeze({}) as PlatformTransaction;
const context = Object.freeze({
  trustedCaller: { kind: "site_product", siteId: "site_01", siteReleaseRef: "release_01", bindingEpoch: "7",
    workloadIdentityId: "workload_01", allowedOperations: ["createAssetUploadIntent"] },
  actor: { kind: "user", subjectId: "subject_01", subjectGeneration: "4" },
  target: { siteId: "site_01", projectId: "project_01", purpose: "createAssetUploadIntent" },
  environment: "production", region: "us-east-1",
}) as unknown as VerifiedRequestSecurityContext;
const policy = Object.freeze({
  policy: Object.freeze({ policyRevisionRef: "asset_policy_01", purpose: "chat.attachment",
    storageRegion: "us-east-1", maximumFileBytes: 10_000_000n, maximumInflightBytes: 100_000_000n,
    maximumReadyBytes: 1_000_000_000n,
    allowedClientMediaTypes: Object.freeze(["image/png"]), expiresAt: "2026-07-29T12:00:00.000Z" }),
  quotaRevisionRef: "quota_revision_01", storageTenantRef: "storage_tenant_01",
  uploadAudience: "https://upload.example.test", minimumPartBytes: 5_242_880n,
  maximumPartBytes: 10_000_000n, capabilityLifetimeSeconds: 300,
});

function fixture() {
  let stored: AssetUploadIntent | null = null;
  let storedSession: AssetUploadSession | null = null;
  let storedDigest: string | null = null;
  let receipt: CommandReceipt | null = null;
  let sequence = 0;
  const issue = vi.fn(async (input: { capabilityEpoch: bigint; expiresAt: string }) => Object.freeze({
    protocolRevision: "s3-multipart-v1" as const,
    uploadEndpoint: "https://upload.example.test/v1/parts",
    credential: "opaque-upload-capability-credential-0123456789",
    capabilityEpoch: input.capabilityEpoch,
    expiresAt: input.expiresAt,
    minimumPartBytes: policy.minimumPartBytes,
    maximumPartBytes: policy.maximumPartBytes,
  }));
  const service = new CreateUploadIntentService({
    unitOfWork: { execute: async (_fence, work) => work(transaction) },
    policyResolver: { resolve: async () => policy },
    capabilityIssuer: { issue },
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
    repository: {
      claimUploadIntent: async (_transaction, input) => {
        if (stored !== null && storedSession !== null) return storedDigest === input.requestDigest
          ? { disposition: "replay" as const, intent: stored, session: storedSession }
          : { disposition: "conflict" as const };
        stored = input.intent;
        storedSession = input.session;
        storedDigest = input.requestDigest;
        return { disposition: "created" as const, intent: stored, session: storedSession };
      },
      markCapabilityIssued: async (_transaction, input) => {
        if (stored === null || storedSession === null || stored.intentRef !== input.intentRef || storedSession.expectedVersion !== input.expectedVersion) {
          throw new Error("ASSET_UPLOAD_CAPABILITY_CONFLICT");
        }
        storedSession = markUploadCapabilityIssued(storedSession, input.expectedVersion, input.capabilityEpoch, input.expiresAt);
        return storedSession;
      },
    },
    clock: () => new Date("2026-07-28T12:00:00.000Z"),
    reference: () => `asset_ref_${String(++sequence).padStart(2, "0")}`,
  });
  return { service, issue, stored: () => stored, storedSession: () => storedSession,
    receipt: () => receipt };
}

const command = Object.freeze({
  context, commandId: "0198f758-2534-7bbb-8bbb-0123456789ab",
  idempotencyKey: "upload-command-01", purpose: "chat.attachment", filename: "photo.png",
  clientMediaType: "image/png", expectedSize: 1234n, expectedChecksumSha256: "a".repeat(64),
});

describe("CreateUploadIntentService", () => {
  it("derives every authority axis, reserves once, and issues only a bounded opaque capability", async () => {
    const { service, issue, stored, storedSession, receipt } = fixture();
    const result = await service.execute(command);
    expect(result).toMatchObject({ state: "uploading", expectedVersion: 2n, safeDisplayName: "photo.png",
      commandId: command.commandId });
    expect(stored()).toMatchObject({ siteRef: "site_01", subjectGeneration: 4n, projectRef: "project_01",
      purpose: "chat.attachment" });
    expect(storedSession()).toMatchObject({ quarantineObjectRef: "quarantine/asset_ref_03",
      capabilityEpoch: 1n, state: "uploading" });
    expect(issue).toHaveBeenCalledWith(expect.objectContaining({
      siteRef: "site_01", subjectGeneration: 4n, projectRef: "project_01", purpose: "chat.attachment",
      expectedSize: 1234n, capabilityEpoch: 1n,
    }));
    expect(receipt()).toMatchObject({ state: "succeeded",
      result: { intentRef: expect.any(String), sessionRef: expect.any(String) } });
    expect(JSON.stringify(receipt()?.result)).not.toContain("credential");
  });

  it("replays the same owner identity and fails closed on a changed request digest", async () => {
    const { service } = fixture();
    const first = await service.execute(command);
    const replay = await service.execute(command);
    expect(replay.intentRef).toBe(first.intentRef);
    expect(replay.sessionRef).toBe(first.sessionRef);
    await expect(service.execute({ ...command, expectedChecksumSha256: "b".repeat(64) }))
      .rejects.toThrow("ASSET_IDEMPOTENCY_DIGEST_CONFLICT");
  });

  it("commits the owner intent before capability issuance and can safely recover an issuance failure", async () => {
    const { service, issue, stored } = fixture();
    issue.mockRejectedValueOnce(new Error("storage unavailable"));
    await expect(service.execute(command)).rejects.toThrow("storage unavailable");
    expect(stored()).toMatchObject({ state: "admitted", expectedVersion: 1n });
    await expect(service.execute(command)).resolves.toMatchObject({ state: "uploading", expectedVersion: 2n });
  });

  it("rejects untrusted Site, actor generation, project, and operation before policy resolution", async () => {
    const { service, issue } = fixture();
    await expect(service.execute({ ...command, context: { ...context, target: { ...context.target, siteId: "site_02" } } as VerifiedRequestSecurityContext }))
      .rejects.toThrow("ASSET_USER_AUTHORITY_INVALID");
    expect(issue).not.toHaveBeenCalled();
  });
});
