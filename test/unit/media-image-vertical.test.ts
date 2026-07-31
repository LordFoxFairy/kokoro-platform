import { randomBytes } from "node:crypto";
import { create } from "@bufbuild/protobuf";
import { describe, expect, it, vi } from "vitest";
import { issuePlatformTransaction, revokePlatformTransaction } from
  "../../src/shared/unit-of-work/platform-transaction.js";
import {
  agentImageCallerRequestFingerprint,
  ImageOperationSubmissionService,
  InMemoryMediaImageOperationRepository,
  type MediaImageAdmissionOwnerPort,
  type MediaImageLocalCreditAllocationOwner,
} from "../../src/modules/media/application/image-operation-submission.js";
import {
  CanonicalImageAspectRatio,
  CanonicalImageOutputFormat,
} from "../../src/interfaces/connect/generated-media-runtime/kokoro/platform/media/v1/media_canonical_pb.js";
import { AgentImageIntentV1Schema } from
  "../../src/interfaces/connect/generated-media-runtime/kokoro/platform/media/v1/media_runtime_pb.js";
import { EnvelopeOperationInputProtector } from
  "../../src/modules/media/application/operation-input-protection.js";
import { mediaCallerRequestFingerprintSha256 } from
  "../../src/interfaces/http/generated/platform-public/media-canonical.js";

const request = Object.freeze({
  contractMajor: 1 as const,
  definitionRevisionRef: "image.text_to_image@v1:revision:1",
  kind: "image_text_to_image" as const,
  promptIntent: "a silver fox",
  aspectRatio: "square_1_1" as const,
  candidateCount: 2 as const,
  modelOptionRevisionRef: "image-option:revision:1",
  outputFormat: "png" as const,
});

describe("image.text_to_image submission authority", () => {
  it("persists one encrypted plan, child Credit receipt and dispatch outbox, then replays exactly", async () => {
    const events: string[] = [];
    const repository = new InMemoryMediaImageOperationRepository();
    const admission: MediaImageAdmissionOwnerPort = {
      resolveDirectStudio: vi.fn(async () => {
        events.push("admission");
        return {
          ownerBinding: {
            siteRef: "site:one", subjectRef: "subject:one", subjectGeneration: 2n,
            projectRef: "project:one", workloadRef: "studio:web", source: "direct_studio" as const,
            definitionRevisionRef: request.definitionRevisionRef,
            modelOptionRevisionRef: request.modelOptionRevisionRef,
          },
          executionBudgetRootRef: "budget:root:one",
          parentAllocationRef: "budget:allocation:one",
          maximumCredit: 15n,
          trustInputDecisionRef: "trust-input:allow:one",
          expectedParentRevision: 1n, expectedParentAllocationEpoch: 1n,
          consumptionScope: { surfaceRef: "surface:image", capabilityKey: "image.create", agentRef: null },
          expiresAt: "2026-07-31T13:00:00.000Z",
        };
      }),
    };
    const credit: MediaImageLocalCreditAllocationOwner = {
      deriveChild: vi.fn(async () => {
        events.push("credit");
        return { childAllocationRef: "credit-child:one",
          allocationReservationReceiptRef: "credit-child-receipt:one" };
      }),
    };
    let serial = 0;
    const service = new ImageOperationSubmissionService({
      admission,
      credit,
      repository,
      inputProtector: new EnvelopeOperationInputProtector({
        activeKey: { keyRevisionRef: "media-kek:revision:1", key: randomBytes(32) },
      }),
      ownerDigestKey: randomBytes(32),
      reference: (kind) => `${kind}:${++serial}`,
      unitOfWork: { execute: async (_binding, work) => {
        events.push("tx.begin");
        const lease = issuePlatformTransaction({ query: async () => [], execute: async () => 1 });
        try { return await work(lease.transaction); } finally { revokePlatformTransaction(lease); events.push("tx.end"); }
      } },
      clock: () => new Date("2026-07-31T12:00:00.000Z"),
    });
    const callerRequestFingerprint = await mediaCallerRequestFingerprintSha256(request);
    const command = { callerAudience: "site-bff.media", commandRef: "command:one",
      callerRequestFingerprint, request } as const;

    const first = await service.submitDirectStudio({ caller: { sessionGrant: "opaque-session-grant" },
      signal: new AbortController().signal, ...command });
    const replay = await service.submitDirectStudio({ caller: { sessionGrant: "opaque-session-grant" },
      signal: new AbortController().signal, ...command });

    expect(first.kind).toBe("created");
    expect(replay).toEqual({ kind: "replayed", operationRef: first.operationRef,
      callerRequestFingerprint, receipt: first.receipt });
    expect(first.receipt).toEqual({ version: 2n, recordedAt: "2026-07-31T12:00:00.000Z",
      commandKind: "create_agent_image_operation", outcome: "submit_accepted" });
    const stored = repository.inspect(first.operationRef);
    expect(stored?.plan.candidates).toHaveLength(2);
    expect(stored?.modelInvocationCommandRefs).toHaveLength(1);
    expect(stored?.credit).toEqual({ executionBudgetRootRef: "budget:root:one",
      parentAllocationRef: "budget:allocation:one", childAllocationRef: "credit-child:one",
      allocationReservationReceiptRef: "credit-child-receipt:one" });
    expect(stored?.dispatchOutbox).toMatchObject({ state: "pending", topic: "media.image.dispatch.v1" });
    expect(JSON.stringify(stored?.protectedInput)).not.toContain("silver fox");
    expect(events).toEqual([
      "admission", "tx.begin", "credit", "tx.end",
      "admission", "tx.begin", "tx.end",
    ]);
  });

  it("rejects a false caller fingerprint before Admission and owner-bound command reuse after Admission", async () => {
    let workloadRef = "studio:web";
    const admission: MediaImageAdmissionOwnerPort = { resolveDirectStudio: vi.fn(async () => ({
      ownerBinding: { siteRef: "site:one", subjectRef: "subject:one", subjectGeneration: 1n,
        projectRef: "project:one", workloadRef, source: "direct_studio" as const,
        definitionRevisionRef: request.definitionRevisionRef,
        modelOptionRevisionRef: request.modelOptionRevisionRef },
      executionBudgetRootRef: "budget:root:one", parentAllocationRef: "budget:allocation:one",
      maximumCredit: 10n, trustInputDecisionRef: "trust-input:one",
      expectedParentRevision: 1n, expectedParentAllocationEpoch: 1n,
      consumptionScope: { surfaceRef: "surface:image", capabilityKey: "image.create", agentRef: null },
      expiresAt: "2026-07-31T13:00:00.000Z",
    })) };
    const repository = new InMemoryMediaImageOperationRepository();
    const service = serviceWith({ admission, repository });
    await expect(service.submitDirectStudio({ caller: { sessionGrant: "grant" },
      signal: new AbortController().signal,
      callerAudience: "site-bff.media", commandRef: "command:false", callerRequestFingerprint: "0".repeat(64),
      request })).rejects.toThrow("MEDIA_CALLER_FINGERPRINT_MISMATCH");
    expect(admission.resolveDirectStudio).not.toHaveBeenCalled();

    const fingerprint = await mediaCallerRequestFingerprintSha256(request);
    await service.submitDirectStudio({ caller: { sessionGrant: "grant" },
      signal: new AbortController().signal, callerAudience: "site-bff.media",
      commandRef: "command:bound", callerRequestFingerprint: fingerprint, request });
    workloadRef = "studio:other";
    await expect(service.submitDirectStudio({ caller: { sessionGrant: "grant" },
      signal: new AbortController().signal,
      callerAudience: "site-bff.media", commandRef: "command:bound", callerRequestFingerprint: fingerprint,
      request })).rejects.toThrow("MEDIA_COMMAND_OWNER_DIGEST_CONFLICT");
  });

  it("lets GA submit semantic image intent while Platform resolves published definition and default model", async () => {
    const repository = new InMemoryMediaImageOperationRepository();
    const agentAccess = { resolveAgentImage: vi.fn(async () => ({
      ownerBinding: { siteRef: "site:one", subjectRef: "subject:one", subjectGeneration: 4n,
        projectRef: "project:one", workloadRef: "ga-run:one:slot:image-1", source: "agent_runtime" as const,
        definitionRevisionRef: "image.text_to_image@v1:revision:1",
        modelOptionRevisionRef: "image-default:revision:7" },
      executionBudgetRootRef: "budget:root:one", parentAllocationRef: "budget:allocation:one",
      maximumCredit: 10n, trustInputDecisionRef: "trust-input:one",
      expectedParentRevision: 1n, expectedParentAllocationEpoch: 1n,
      consumptionScope: { surfaceRef: "surface:image", capabilityKey: "image.create", agentRef: "agent:one" },
      expiresAt: "2026-07-31T13:00:00.000Z",
    })) };
    let serial = 0;
    const service = new ImageOperationSubmissionService({ admission: {
      resolveDirectStudio: async () => { throw new Error("not used"); },
    }, agentAccess, repository,
    credit: { deriveChild: async () => ({ childAllocationRef: "credit-child:one",
      allocationReservationReceiptRef: "credit-receipt:one" }) },
    inputProtector: new EnvelopeOperationInputProtector({ activeKey: {
      keyRevisionRef: "media-kek:revision:1", key: randomBytes(32),
    } }), ownerDigestKey: randomBytes(32), reference: (kind) => `${kind}:${++serial}`,
    unitOfWork: { execute: async (_binding, work) => {
      const lease = issuePlatformTransaction({ query: async () => [], execute: async () => 1 });
      try { return await work(lease.transaction); } finally { revokePlatformTransaction(lease); }
    } } });
    const imageIntent = create(AgentImageIntentV1Schema, { promptIntent: "fox in rain",
      aspectRatio: CanonicalImageAspectRatio.LANDSCAPE_16_9, candidateCount: 1,
      outputFormat: CanonicalImageOutputFormat.PNG });
    const callerRequestFingerprint = agentImageCallerRequestFingerprint({
      stableOutputSlotRef: "slot:image-1", imageIntent,
    });

    const outcome = await service.submitAgentImage({ mediaAccessHandle: "media-access:" + "a".repeat(32),
      mediaProjectionReservationHandle: "projection-reservation:" + "p".repeat(32),
      stableOutputSlotRef: "slot:image-1", agentMediaCommandRef: "agent-media-command:one",
      callerRequestFingerprint, imageIntent, signal: new AbortController().signal });

    expect(outcome.kind).toBe("created");
    expect(agentAccess.resolveAgentImage).toHaveBeenCalledWith({
      mediaAccessHandle: "media-access:" + "a".repeat(32),
      mediaProjectionReservationHandle: "projection-reservation:" + "p".repeat(32),
      stableOutputSlotRef: "slot:image-1", agentMediaCommandRef: "agent-media-command:one", imageIntent,
    }, expect.any(AbortSignal));
    const stored = repository.inspect(outcome.operationRef);
    expect(stored?.ownerBinding).toMatchObject({ source: "agent_runtime",
      definitionRevisionRef: "image.text_to_image@v1:revision:1",
      modelOptionRevisionRef: "image-default:revision:7" });
  });
});

function serviceWith(input: Readonly<{
  admission: MediaImageAdmissionOwnerPort;
  repository: InMemoryMediaImageOperationRepository;
}>): ImageOperationSubmissionService {
  let serial = 0;
  return new ImageOperationSubmissionService({
    ...input,
    credit: { deriveChild: async () => ({ childAllocationRef: "credit-child:one",
      allocationReservationReceiptRef: "credit-receipt:one" }) },
    inputProtector: new EnvelopeOperationInputProtector({
      activeKey: { keyRevisionRef: "media-kek:revision:1", key: randomBytes(32) },
    }),
    ownerDigestKey: randomBytes(32), reference: (kind) => `${kind}:${++serial}`,
    unitOfWork: { execute: async (_binding, work) => {
      const lease = issuePlatformTransaction({ query: async () => [], execute: async () => 1 });
      try { return await work(lease.transaction); } finally { revokePlatformTransaction(lease); }
    } },
  });
}
