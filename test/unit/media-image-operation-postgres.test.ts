import { describe, expect, it } from "vitest";
import { PostgresMediaImageOperationRepository } from
  "../../src/modules/media/infrastructure/postgres/media-image-operation-repository.js";
import { issuePlatformTransaction } from "../../src/shared/unit-of-work/platform-transaction.js";

const authority = Object.freeze({ siteReleaseRef: "release:one", siteSecurityEpoch: 2n, policyEpoch: 3n,
  workloadBindingEpoch: 4n, identitySessionRef: "session:one", identitySessionEpoch: 5n,
  restrictionEpoch: 6n, membershipEpoch: 7n, authorizationEpoch: 8n });
const command = Object.freeze({ callerAudience: "site-bff", siteRef: "site:one", subjectRef: "subject:one",
  subjectGeneration: 1n, projectRef: "project:one", workloadRef: "workload:one",
  source: "direct_studio" as const, definitionRevisionRef: "image.text_to_image@v1:revision:1",
  modelOptionRevisionRef: "image-option:one", commandRef: "command:one",
  directStudioAuthority: authority, callerRequestFingerprint: "a".repeat(64), ownerRequestDigest: "b".repeat(64) });

describe("PostgresMediaImageOperationRepository Direct Studio", () => {
  it("persists the complete Direct authority fence when beginning an idempotent command", async () => {
    const harness = transactionHarness(() => [{ outcome: "started", operationRef: null,
      callerRequestFingerprint: command.callerRequestFingerprint, receiptVersion: "1",
      receiptRecordedAt: "2026-07-31T12:00:00.000Z", receiptKind: "create_direct_studio_image_operation",
      receiptOutcome: "submit_outcome_unknown" }]);
    const result = await new PostgresMediaImageOperationRepository().begin(harness.transaction, command);
    expect(result.kind).toBe("started");
    expect(harness.calls[0]?.text).toContain("begin_direct_media_image_command");
    expect(harness.calls[0]?.values).toEqual(expect.arrayContaining([
      authority.siteReleaseRef, "2", "3", "4", authority.identitySessionRef, "5", "6", "7", "8",
    ]));
  });

  it("serializes the Direct root budget and owner authority without fabricating an Agent child", async () => {
    const harness = transactionHarness(() => [{ operationRef: "media-operation:one",
      callerRequestFingerprint: command.callerRequestFingerprint, receiptVersion: "2",
      receiptRecordedAt: "2026-07-31T12:00:00.000Z", receiptKind: "create_direct_studio_image_operation",
      receiptOutcome: "submit_accepted" }]);
    const binding = Object.freeze({ siteRef: command.siteRef, subjectRef: command.subjectRef,
      subjectGeneration: command.subjectGeneration, projectRef: command.projectRef, workloadRef: command.workloadRef,
      source: "direct_studio" as const, definitionRevisionRef: command.definitionRevisionRef,
      modelOptionRevisionRef: command.modelOptionRevisionRef, authority });
    await new PostgresMediaImageOperationRepository().complete(harness.transaction, "lease-token-value", {
      command, ownerBinding: binding,
      protectedInput: { operationInputRevisionRef: "input:one", encryptionAlgorithm: "AES-256-GCM-envelope-v1",
        keyRevisionRef: "key:one", ciphertextBase64: "YQ==", contentIvBase64: "AAAAAAAAAAAAAAAA",
        contentTagBase64: "AAAAAAAAAAAAAAAAAAAAAA==", wrappedDekBase64: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
        wrapIvBase64: "AAAAAAAAAAAAAAAA", wrapTagBase64: "AAAAAAAAAAAAAAAAAAAAAA==", plaintextBytes: 1 },
      definitionPolicy: { partialCompletion: "forbidden", minimumReadyCandidates: 1 },
      plan: { operation: { operationRef: "media-operation:one", expectedVersion: 3n, state: { kind: "queued" } },
        steps: [], candidates: [{ candidateRef: "candidate:one", definitionStepKey: "generate",
          outputSlot: "image", required: true, expectedVersion: 1n, state: { kind: "allocated" } }] } as never,
      modelInvocationCommandRefs: ["model-command:one"], artifactRefs: ["artifact:one"],
      artifactVersionRefs: ["artifact-version:one"],
      credit: { kind: "direct_root", executionBudgetRootRef: "00000000-0000-7000-8000-000000000010",
        executionManifestRef: "manifest:one", rootHoldRef: "00000000-0000-7000-8000-000000000011",
        rootAllocationRef: "00000000-0000-7000-8000-000000000012", rootAllocationRevision: 1n,
        rootAllocationEpoch: 1n, authorizationSegmentRef: "00000000-0000-7000-8000-000000000013",
        authorizationSegmentVersion: 2n, reservedCeiling: 100n, unit: "credit" },
      trustInputDecisionRef: "trust:one", dispatchOutbox: { outboxRef: "outbox:one",
        topic: "media.image.dispatch.v1", operationRef: "media-operation:one", state: "pending",
        occurredAt: "2026-07-31T12:00:00.000Z" }, createdAt: "2026-07-31T12:00:00.000Z",
    });
    expect(harness.calls[0]?.text).toContain("commit_direct_media_image_operation");
    const payload = JSON.parse(String(harness.calls[0]?.values[0])) as Readonly<{
      owner: Readonly<{ authority: Readonly<Record<string, string>> }>;
      credit: Readonly<Record<string, unknown>>;
    }>;
    expect(payload.owner.authority).toEqual({ siteReleaseRef: "release:one", siteSecurityEpoch: "2",
      policyEpoch: "3", workloadBindingEpoch: "4", identitySessionRef: "session:one",
      identitySessionEpoch: "5", restrictionEpoch: "6", membershipEpoch: "7", authorizationEpoch: "8" });
    expect(payload.credit).toMatchObject({ kind: "direct_root", rootAllocationRevision: "1",
      rootAllocationEpoch: "1", authorizationSegmentVersion: "2" });
    expect(JSON.stringify(payload)).not.toContain("childAllocationRef");
  });
});

function transactionHarness(rows: () => readonly Record<string, unknown>[]) {
  const calls: Array<{ text: string; values: readonly unknown[] }> = [];
  const lease = issuePlatformTransaction({ query: async (text, values = []) => {
    calls.push({ text, values }); return rows() as never;
  }, execute: async () => 0 });
  return { transaction: lease.transaction, calls };
}
