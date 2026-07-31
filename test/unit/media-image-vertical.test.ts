import { randomBytes } from "node:crypto";
import { create } from "@bufbuild/protobuf";
import { describe, expect, it, vi } from "vitest";
import { issuePlatformTransaction, revokePlatformTransaction } from
  "../../src/shared/unit-of-work/platform-transaction.js";
import {
  agentImageCallerRequestFingerprint,
  deriveMediaAdmissionRequestDigest,
  ImageOperationSubmissionService,
  InMemoryMediaImageOperationRepository,
  type AgentMediaChildBudgetOwner,
  type DirectStudioRootBudgetOwner,
  type MediaImageAdmissionOwnerPort,
  type MediaImageAdmissionFacts,
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
import { verifyRequestSecurityContext } from
  "../../src/shared/security-context/request-security-context.js";

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
  it("binds Agent budget fences and owner-issued handle digests into the command digest", () => {
    const admission: MediaImageAdmissionFacts = {
      ownerBinding: { siteRef: "site:one", subjectRef: "subject:one", subjectGeneration: 4n,
        projectRef: "project:one", workloadRef: "agent-workload:one", source: "agent_runtime",
        definitionRevisionRef: request.definitionRevisionRef,
        modelOptionRevisionRef: request.modelOptionRevisionRef },
      budgetSource: { kind: "agent_child", executionBudgetRootRef: "budget:root:one",
        authorizationSegmentRef: "segment:one", executionManifestRef: "manifest:one",
        parentAllocationRef: "allocation:one", expectedParentRevision: 3n,
        expectedParentAllocationEpoch: 5n, unit: "credit" },
      maximumCredit: 10n, trustInputDecisionRef: "trust:one",
      consumptionScope: { surfaceRef: "surface:image", capabilityKey: "image.create", agentRef: "agent:one" },
      expiresAt: "2026-07-31T13:00:00.000Z",
      agentCommandAuthorization: { accessAuthorizationHandleDigest: "a".repeat(64),
        projectionReservationDigest: "b".repeat(64) },
    };
    const digestKey = randomBytes(32);
    const canonicalBytes = new TextEncoder().encode("canonical image request");
    const digest = (value: MediaImageAdmissionFacts) => deriveMediaAdmissionRequestDigest({
      ownerDigestKey: digestKey, canonicalBytes, admission: value,
    });

    expect(digest({ ...admission, budgetSource: { ...admission.budgetSource,
      expectedParentRevision: 4n } })).not.toBe(digest(admission));
    expect(digest({ ...admission, agentCommandAuthorization: {
      ...admission.agentCommandAuthorization, projectionReservationDigest: "c".repeat(64),
    } })).not.toBe(digest(admission));
    expect(digest({ ...admission, maximumCredit: 11n })).not.toBe(digest(admission));
  });

  it("revalidates Direct Studio authority inside the Media transaction and reserves one root budget", async () => {
    const events: string[] = [];
    const repository = new InMemoryMediaImageOperationRepository();
    const admission: MediaImageAdmissionOwnerPort = {
      resolveDirectStudio: vi.fn(async (_transaction, input) => {
        events.push("admission");
        expect(events.at(-2)).toBe("tx.begin");
        expect(input.context.actor).toMatchObject({ kind: "user", sessionId: "identity-session:one" });
        return {
          ownerBinding: {
            siteRef: "site:one", subjectRef: "subject:one", subjectGeneration: 2n,
            projectRef: "project:one", workloadRef: "studio:web", source: "direct_studio" as const,
            definitionRevisionRef: request.definitionRevisionRef,
            modelOptionRevisionRef: request.modelOptionRevisionRef,
            authority: directAuthority(),
          },
          maximumCredit: 15n,
          trustInputDecisionRef: "trust-input:allow:one",
          consumptionScope: { surfaceRef: "surface:image", capabilityKey: "image.create", agentRef: null },
          budgetSource: { kind: "direct_root" as const,
            billingAccountRef: "billing:one", creditAccountRef: "credit-account:one",
            unit: "credit", liabilityMerchantAccountRef: "merchant:one",
            ratingPolicyRevisionRef: "rating:one", authorizationBudgetRef: "authorization-budget:one",
            executionManifestRef: "execution-manifest:one" },
          expiresAt: "2026-07-31T13:00:00.000Z",
        };
      }),
    };
    const directRoot: DirectStudioRootBudgetOwner = {
      reserveDirectRoot: vi.fn(async () => {
        events.push("credit");
        return { executionBudgetRootRef: "budget:root:one", rootHoldRef: "hold:one",
          rootAllocationRef: "budget:allocation:one", rootAllocationRevision: 1n,
          rootAllocationEpoch: 1n, authorizationSegmentRef: "segment:one",
          authorizationSegmentVersion: 2n };
      }),
    };
    const agentChild: AgentMediaChildBudgetOwner = {
      deriveChild: vi.fn(async () => { throw new Error("DIRECT_STUDIO_MUST_NOT_DERIVE_CHILD"); }),
    };
    let serial = 0;
    const service = new ImageOperationSubmissionService({
      admission,
      budgets: { kind: "direct_and_agent", directRoot, agentChild },
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
    const command = { context: await directStudioContext(), commandRef: "0198f758-2534-7bbb-8bbb-0123456789ab",
      callerRequestFingerprint, request } as const;

    const first = await service.submitDirectStudio({ signal: new AbortController().signal, ...command });
    const replay = await service.submitDirectStudio({ signal: new AbortController().signal, ...command });

    expect(first.kind).toBe("created");
    expect(replay).toEqual({ kind: "replayed", operationRef: first.operationRef,
      callerRequestFingerprint, receipt: first.receipt });
    expect(first.receipt).toEqual({ version: 2n, recordedAt: "2026-07-31T12:00:00.000Z",
      commandKind: "create_agent_image_operation", outcome: "submit_accepted" });
    const stored = repository.inspect(first.operationRef);
    expect(stored?.plan.candidates).toHaveLength(2);
    expect(stored?.modelInvocationCommandRefs).toHaveLength(1);
    expect(stored?.credit).toEqual({ kind: "direct_root", executionBudgetRootRef: "budget:root:one",
      executionManifestRef: "execution-manifest:one",
      rootHoldRef: "hold:one", rootAllocationRef: "budget:allocation:one",
      rootAllocationRevision: 1n, rootAllocationEpoch: 1n,
      authorizationSegmentRef: "segment:one", authorizationSegmentVersion: 2n,
      reservedCeiling: 15n, unit: "credit" });
    expect(stored?.dispatchOutbox).toMatchObject({ state: "pending", topic: "media.image.dispatch.v1" });
    expect(JSON.stringify(stored?.protectedInput)).not.toContain("silver fox");
    expect(events).toEqual([
      "tx.begin", "admission", "credit", "tx.end",
      "tx.begin", "admission", "tx.end",
    ]);
  });

  it("rejects a false caller fingerprint before Admission and owner-bound command reuse after Admission", async () => {
    let trustInputDecisionRef = "trust-input:one";
    const admission: MediaImageAdmissionOwnerPort = { resolveDirectStudio: vi.fn(async () => ({
      ownerBinding: { siteRef: "site:one", subjectRef: "subject:one", subjectGeneration: 2n,
        projectRef: "project:one", workloadRef: "studio:web", source: "direct_studio" as const,
        definitionRevisionRef: request.definitionRevisionRef,
        modelOptionRevisionRef: request.modelOptionRevisionRef,
        authority: directAuthority() },
      maximumCredit: 10n, trustInputDecisionRef,
      consumptionScope: { surfaceRef: "surface:image", capabilityKey: "image.create", agentRef: null },
      budgetSource: { kind: "direct_root" as const,
        billingAccountRef: "billing:one", creditAccountRef: "credit-account:one",
        unit: "credit", liabilityMerchantAccountRef: "merchant:one", ratingPolicyRevisionRef: "rating:one",
        authorizationBudgetRef: "authorization-budget:one", executionManifestRef: "execution-manifest:one" },
      expiresAt: "2026-07-31T13:00:00.000Z",
    })) };
    const repository = new InMemoryMediaImageOperationRepository();
    const service = serviceWith({ admission, repository });
    const context = await directStudioContext();
    await expect(service.submitDirectStudio({ context,
      signal: new AbortController().signal,
      commandRef: "0198f758-2534-7bbb-8bbb-0123456789ac", callerRequestFingerprint: "0".repeat(64),
      request })).rejects.toThrow("MEDIA_CALLER_FINGERPRINT_MISMATCH");
    expect(admission.resolveDirectStudio).not.toHaveBeenCalled();

    const fingerprint = await mediaCallerRequestFingerprintSha256(request);
    await service.submitDirectStudio({ context, signal: new AbortController().signal,
      commandRef: "0198f758-2534-7bbb-8bbb-0123456789ad", callerRequestFingerprint: fingerprint, request });
    trustInputDecisionRef = "trust-input:two";
    await expect(service.submitDirectStudio({ context,
      signal: new AbortController().signal,
      commandRef: "0198f758-2534-7bbb-8bbb-0123456789ad", callerRequestFingerprint: fingerprint,
      request })).rejects.toThrow("MEDIA_COMMAND_OWNER_DIGEST_CONFLICT");
  });

  it("lets GA submit semantic image intent while Platform resolves published definition and default model", async () => {
    const repository = new InMemoryMediaImageOperationRepository();
    const agentAccess = { resolveAgentImage: vi.fn(async () => ({
      ownerBinding: { siteRef: "site:one", subjectRef: "subject:one", subjectGeneration: 4n,
        projectRef: "project:one", workloadRef: "ga-run:one:slot:image-1", source: "agent_runtime" as const,
        definitionRevisionRef: "image.text_to_image@v1:revision:1",
        modelOptionRevisionRef: "image-default:revision:7" },
      budgetSource: { kind: "agent_child" as const, executionBudgetRootRef: "budget:root:one",
        authorizationSegmentRef: "segment:one", executionManifestRef: "manifest:one",
        parentAllocationRef: "budget:allocation:one", expectedParentRevision: 1n,
        expectedParentAllocationEpoch: 1n, unit: "credit" },
      maximumCredit: 10n, trustInputDecisionRef: "trust-input:one",
      consumptionScope: { surfaceRef: "surface:image", capabilityKey: "image.create", agentRef: "agent:one" },
      expiresAt: "2026-07-31T13:00:00.000Z",
      agentCommandAuthorization: { accessAuthorizationHandleDigest: "a".repeat(64),
        projectionReservationDigest: "b".repeat(64) },
    })) };
    let serial = 0;
    const service = new ImageOperationSubmissionService({ admission: {
      resolveDirectStudio: async () => { throw new Error("not used"); },
    }, agentAccess, repository,
    budgets: { kind: "agent_only", agentChild: {
      deriveChild: async () => ({ childAllocationRef: "credit-child:one",
        allocationReservationReceiptRef: "credit-receipt:one" }) } },
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
    budgets: { kind: "direct_and_agent",
      directRoot: { reserveDirectRoot: async () => ({ executionBudgetRootRef: "budget:root:one",
        rootHoldRef: "hold:one", rootAllocationRef: "budget:allocation:one",
        rootAllocationRevision: 1n, rootAllocationEpoch: 1n,
        authorizationSegmentRef: "segment:one", authorizationSegmentVersion: 2n }) },
      agentChild: { deriveChild: async () => ({ childAllocationRef: "credit-child:one",
        allocationReservationReceiptRef: "credit-receipt:one" }) } },
    inputProtector: new EnvelopeOperationInputProtector({
      activeKey: { keyRevisionRef: "media-kek:revision:1", key: randomBytes(32) },
    }),
    ownerDigestKey: randomBytes(32), reference: (kind) => `${kind}:${++serial}`,
    unitOfWork: { execute: async (_binding, work) => {
      const lease = issuePlatformTransaction({ query: async () => [], execute: async () => 1 });
      try { return await work(lease.transaction); } finally { revokePlatformTransaction(lease); }
    } },
    clock: () => new Date("2026-07-31T12:00:00.000Z"),
  });
}

function directAuthority(membershipEpoch = 17n) {
  return Object.freeze({ siteReleaseRef: "release:one", siteSecurityEpoch: 7n,
    policyEpoch: 11n, workloadBindingEpoch: 3n, identitySessionRef: "identity-session:one",
    identitySessionEpoch: 5n, restrictionEpoch: 13n, membershipEpoch,
    authorizationEpoch: 19n });
}

async function directStudioContext() {
  const now = "2026-07-31T12:00:00.000Z";
  const expiresAt = "2026-07-31T13:00:00.000Z";
  return verifyRequestSecurityContext({
    requestId: "request:one", correlationId: "correlation:one",
    trustedCaller: { kind: "site_product", workloadIdentityId: "studio:web", siteId: "site:one",
      siteReleaseRef: "release:one", siteSecurityEpoch: "7", environment: "production",
      region: "us-east-1", audience: "site-bff.media", allowedOperations: ["submitMediaOperation"],
      bindingEpoch: "3", issuedAt: now, expiresAt },
    actor: { kind: "user", subjectId: "subject:one", subjectGeneration: "2",
      sessionId: "identity-session:one", assuranceLevel: "password", factorClasses: ["password"],
      authenticatedAt: now, sessionEpoch: "5", restrictionEpoch: "13" },
    delegatedGrant: null,
    target: { siteId: "site:one", workspaceId: null, projectId: "project:one",
      purpose: "submitMediaOperation", scopes: ["submitMediaOperation"] },
    audience: "site-bff.media", environment: "production", region: "us-east-1",
    evidence: [{ kind: "mtls-certificate-sha256", evidenceId: "a".repeat(64), issuer: "fixture" }],
    policyEpoch: "11", issuedAt: now, expiresAt,
  }, { now, operation: "submitMediaOperation", expectedAudience: "site-bff.media",
    expectedEnvironment: "production", expectedRegion: "us-east-1",
    callerVerifier: { verify: async () => ({ workloadIdentityId: "studio:web", kind: "site_product",
      audience: "site-bff.media", environment: "production", region: "us-east-1",
      allowedOperations: ["submitMediaOperation"], siteId: "site:one", siteReleaseRef: "release:one",
      siteSecurityEpoch: "7", bindingEpoch: "3", issuedAt: now, expiresAt,
      issuer: "fixture", keyVersion: "fixture:1" }) } });
}
