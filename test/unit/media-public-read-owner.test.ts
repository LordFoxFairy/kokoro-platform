import { describe, expect, it, vi } from "vitest";
import type { PlatformPublicOperationExecution } from
  "../../src/interfaces/http/platform-public-operation-registry.js";
import type { VerifiedRequestSecurityContext } from
  "../../src/shared/security-context/index.js";
import type { PlatformTransaction } from
  "../../src/shared/unit-of-work/platform-transaction.js";
import { MediaPublicReadOwner } from
  "../../src/modules/media/application/media-public-read-owner.js";
import type {
  MediaPublicReadRepository,
  ResolvedMediaPublicOwnerAuthority,
} from "../../src/modules/media/application/contracts/media-public-read-ports.js";
import { HmacMediaPublicCursorCodec } from
  "../../src/modules/media/infrastructure/crypto/media-public-cursor.js";

const transaction = Object.freeze({}) as PlatformTransaction;
const authority: ResolvedMediaPublicOwnerAuthority = Object.freeze({
  siteRef: "site-1", siteReleaseRef: "release-1", siteProjectBindingRef: "binding-1",
  deploymentRef: "deployment-1", environment: "production", region: "us-east-1",
  audience: "platform-public",
  workloadIdentityRef: "spiffe://kokoro.test/site-1/web", workloadBindingEpoch: 2n,
  siteSecurityEpoch: 3n, policyEpoch: 4n,
  subjectRef: "subject-1", subjectGeneration: 5n,
  identitySessionRef: "session-1", identitySessionEpoch: 6n,
  restrictionEpoch: 7n, credentialEpoch: 8n,
  projectRef: "project-1", membershipEpoch: 9n, authorizationEpoch: 10n,
  modelOptionCatalogRef: `site-release-model-catalog:sha256:${"a".repeat(64)}`,
});

describe("MediaPublicReadOwner", () => {
  it("revalidates authority and returns a release-published definition page", async () => {
    const events: string[] = [];
    const repository = repositoryStub({
      resolveOwnerAuthority: vi.fn(async () => { events.push("authority"); return authority; }),
      listDefinitions: vi.fn(async () => { events.push("definitions"); return [definitionRecord()]; }),
    });
    const owner = service(repository);

    const result = await owner.listMediaOperationDefinitions(execution("listMediaOperationDefinitions", {
      path: { projectRef: "project-1" }, query: { limit: 50 }, body: null,
    }));

    expect(events).toEqual(["authority", "definitions"]);
    expect(result).toEqual({ items: [{
      definitionKey: "image.text_to_image@v1",
      definitionRef: "image.text_to_image@v1",
      definitionRevisionRef: "image.text_to_image@v1:revision:1",
      description: "Generate images from a text prompt.",
      kind: "image_text_to_image",
      maximumCandidateCount: 4,
      modelOptionCatalogRevisionRef: "surface-model-catalog:image:sha256:catalog",
      promptMaximumUtf8Bytes: 32768,
      publishedAt: "2026-07-31T00:00:00.000Z",
      supportedAspectRatios: ["square_1_1"],
      supportedOutputFormats: ["png"],
      title: "Text to image",
    }], pageInfo: { hasMore: false, nextCursor: null } });
  });

  it("fails closed before reading when the owner authority is stale", async () => {
    const repository = repositoryStub({ resolveOwnerAuthority: vi.fn(async () => null) });
    const owner = service(repository);

    await expect(owner.getMediaOperationDefinition(execution("getMediaOperationDefinition", {
      path: { projectRef: "project-1", definitionRef: "image.text_to_image@v1" },
      query: null, body: null,
    }))).rejects.toThrow("MEDIA_PUBLIC_NOT_AVAILABLE");
    expect(repository.getDefinition).not.toHaveBeenCalled();
  });

  it("projects safe published model options without provider internals", async () => {
    const repository = repositoryStub({
      listModelOptions: vi.fn(async () => ({ definitionRevisionRef: "image.text_to_image@v1:revision:1",
        options: [{ position: 0,
        definitionRevisionRef: "image.text_to_image@v1:revision:1",
        modelOptionRevisionRef: `model-option:sha256:${"b".repeat(64)}`,
        optionKey: "image.standard", label: "Standard image", description: null,
        inputModalities: ["text"], outputModalities: ["image"], supportedEfforts: [], badges: ["default"],
        availability: "available" as const }]})),
    });
    const owner = service(repository);

    const result = await owner.listMediaOperationModelOptions(execution("listMediaOperationModelOptions", {
      path: { projectRef: "project-1", definitionRef: "image.text_to_image@v1" },
      query: { limit: 50 }, body: null,
    }));

    expect(result.definitionRevisionRef).toBe("image.text_to_image@v1:revision:1");
    expect(result.items[0]).not.toHaveProperty("provider");
    expect(result.items[0]).not.toHaveProperty("price");
  });

  it("maps terminal financial facts and strips internal failure evidence", async () => {
    const repository = repositoryStub({
      getOperation: vi.fn(async () => operationRecord()),
    });
    const owner = service(repository);

    const result = await owner.getMediaOperation(execution("getMediaOperation", {
      path: { projectRef: "project-1", operationRef: "media-operation:one" }, query: null, body: null,
    }));

    expect(result.operation).toMatchObject({ state: "failed", progressBps: 10000,
      costProjection: { state: "final", amount: { amount: "7", creditUnit: "credit" } },
      safeFailure: { code: "generation_failed", retryClass: "never" } });
    expect(JSON.stringify(result)).not.toContain("logical-invocation:secret");
    expect(result.operation.candidates[0]).toMatchObject({ state: "restricted",
      safeFailure: { code: "artifact_restricted" } });
  });
});

function service(repository: MediaPublicReadRepository): MediaPublicReadOwner {
  return new MediaPublicReadOwner({
    unitOfWork: { execute: async (_fence, work) => work(transaction) },
    repository,
    cursors: new HmacMediaPublicCursorCodec(Buffer.alloc(32, 9)),
    clock: () => new Date("2026-07-31T12:00:00.000Z"),
  });
}

function repositoryStub(overrides: Partial<MediaPublicReadRepository> = {}): MediaPublicReadRepository {
  return {
    resolveOwnerAuthority: vi.fn(async () => authority),
    listDefinitions: vi.fn(async () => []),
    getDefinition: vi.fn(async () => null),
    listModelOptions: vi.fn(async () => null),
    listOperations: vi.fn(async () => []),
    getOperation: vi.fn(async () => null),
    ...overrides,
  };
}

function definitionRecord() {
  return Object.freeze({ definitionKey: "image.text_to_image@v1" as const,
    definitionRevisionRef: "image.text_to_image@v1:revision:1",
    mediaKind: "image_text_to_image" as const, maximumCandidateCount: 4,
    promptMaximumUtf8Bytes: 32768 as const, supportedAspectRatios: ["square_1_1" as const],
    supportedOutputFormats: ["png" as const], publishedAt: "2026-07-31T00:00:00.000Z",
    modelOptionCatalogRevisionRef: "surface-model-catalog:image:sha256:catalog" });
}

function operationRecord() {
  return Object.freeze({ operationRef: "media-operation:one", definitionKey: "image.text_to_image@v1" as const,
    definitionRevisionRef: "image.text_to_image@v1:revision:1",
    modelOptionRevisionRef: `model-option:sha256:${"b".repeat(64)}`, state: "failed" as const,
    outcomeClass: "canonical" as const, ownerVersion: 12n,
    terminalFailure: { kind: "gateway_effect_failed", logicalInvocationRef: "logical-invocation:secret",
      canonicalOutcomeEvidenceRef: "secret", canonicalOutcomeEvidenceDigest: "c".repeat(64) },
    financialReceiptRef: "financial-receipt:one", actualCost: 7n, terminalCreditUnit: "credit",
    createdAt: "2026-07-31T00:00:00.000Z", updatedAt: "2026-07-31T00:01:00.000Z",
    candidates: [{ candidateRef: "media-candidate:one", ordinal: 1, ownerVersion: 3n,
      state: "restricted" as const, artifactRef: "artifact:secret", artifactVersionRef: "version:secret" }],
  });
}

function execution<Id extends "listMediaOperationDefinitions" | "getMediaOperationDefinition" |
  "listMediaOperationModelOptions" | "getMediaOperation">(
  operationId: Id,
  request: Pick<PlatformPublicOperationExecution<Id>, "path" | "query" | "body">,
): PlatformPublicOperationExecution<Id> {
  const session = Object.freeze({ identitySessionRef: "session-1", subjectRef: "subject-1",
    siteRef: "site-1", subjectGeneration: "5", identitySessionEpoch: "6", restrictionEpoch: "7",
    credentialEpoch: "8", authenticationMethods: ["password" as const],
    authenticatedAt: "2026-07-31T00:00:00.000Z", expiresAt: "2026-08-01T00:00:00.000Z" });
  const workload = Object.freeze({ certificateSha256: "c".repeat(64),
    workloadIdentityId: "spiffe://kokoro.test/site-1/web", siteProjectBindingRef: "binding-1",
    deploymentRef: "deployment-1", siteRef: "site-1", siteReleaseRef: "release-1",
    webArtifactDigest: "d".repeat(64), sessionContractRevision: "session-v1",
    environment: "production" as const, region: "us-east-1", audience: "platform-public",
    allowedOperations: [operationId], bindingEpoch: "2", siteSecurityEpoch: "3", policyEpoch: "4",
    csrfSha256: "e".repeat(64) });
  const context = Object.freeze({ trustedCaller: { kind: "site_product", siteId: "site-1",
    siteReleaseRef: "release-1", workloadIdentityId: workload.workloadIdentityId, bindingEpoch: "2",
    siteSecurityEpoch: "3" }, actor: { kind: "user", subjectId: "subject-1", subjectGeneration: "5",
    sessionId: "session-1", sessionEpoch: "6", restrictionEpoch: "7" },
    target: { siteId: "site-1", projectId: "project-1" }, policyEpoch: "4",
    environment: "production", region: "us-east-1", audience: "platform-public" }) as
    unknown as VerifiedRequestSecurityContext;
  return Object.freeze({ operationId, workload, session, context,
    headers: { "Kokoro-Contract-Version": "1" as const },
    ...request, receiptRecoveryCapability: null, signal: new AbortController().signal }) as
    unknown as PlatformPublicOperationExecution<Id>;
}
