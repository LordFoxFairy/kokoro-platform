import { describe, expect, it, vi } from "vitest";
import type { PlatformPublicOperationExecution } from
  "../../src/interfaces/http/platform-public-operation-registry.js";
import type { VerifiedRequestSecurityContext } from "../../src/shared/security-context/index.js";
import type { PlatformTransaction } from "../../src/shared/unit-of-work/platform-transaction.js";
import { MediaPublicQuoteService } from
  "../../src/modules/media/application/media-public-quote-service.js";
import type {
  MediaPublicQuoteJournalPort,
  MediaPublicQuotePricingPort,
} from "../../src/modules/media/application/contracts/media-public-quote-ports.js";
import type { MediaPublicReadRepository, ResolvedMediaPublicOwnerAuthority } from
  "../../src/modules/media/application/contracts/media-public-read-ports.js";

const transaction = Object.freeze({}) as PlatformTransaction;
const authority: ResolvedMediaPublicOwnerAuthority = Object.freeze({
  siteRef: "site-1", siteReleaseRef: "release-1", siteProjectBindingRef: "binding-1",
  deploymentRef: "deployment-1", workloadIdentityRef: "spiffe://kokoro.test/site-1/web",
  workloadBindingEpoch: 2n, siteSecurityEpoch: 3n, policyEpoch: 4n,
  environment: "production", region: "us-east-1", audience: "platform-public",
  subjectRef: "subject-1", subjectGeneration: 5n, identitySessionRef: "session-1",
  identitySessionEpoch: 6n, restrictionEpoch: 7n, credentialEpoch: 8n,
  projectRef: "project-1", membershipEpoch: 9n, authorizationEpoch: 10n,
  modelOptionCatalogRef: `site-release-model-catalog:sha256:${"a".repeat(64)}`,
});

describe("MediaPublicQuoteService", () => {
  it("persists and replays the exact owner-safe quote instead of treating maximum credit as price", async () => {
    const committed: unknown[] = [];
    const journal: MediaPublicQuoteJournalPort = {
      begin: vi.fn(async () => ({ kind: "started" as const, leaseRef: "quote-lease:one" })),
      commit: vi.fn(async (_transaction, input) => { committed.push(input); return input.quote; }),
    };
    const pricing: MediaPublicQuotePricingPort = { rate: vi.fn(async () => ({ amount: 7n, unit: "credit",
      definitionRevisionRef: "image.text_to_image@v1:revision:1",
      modelOptionRevisionRef: `model-option:sha256:${"b".repeat(64)}`,
      ratingPolicyRevisionRef: "rating-policy:image-v1", expiresAt: "2026-07-31T12:05:00.000Z" })) };
    const service = quoteService(journal, pricing);

    const result = await service.quoteMediaOperation(execution());

    expect(result.quote).toEqual({ quoteRef: "media-quote:one", nonBinding: true,
      definitionRevisionRef: "image.text_to_image@v1:revision:1",
      modelOptionRevisionRef: `model-option:sha256:${"b".repeat(64)}`,
      estimate: { amount: "7", creditUnit: "credit" }, expiresAt: "2026-07-31T12:05:00.000Z" });
    expect(committed).toHaveLength(1);
    expect(committed[0]).toMatchObject({ ratingPolicyRevisionRef: "rating-policy:image-v1" });
    expect(pricing.rate).toHaveBeenCalledOnce();
  });

  it("returns a durable replay without invoking pricing again", async () => {
    const replay = Object.freeze({ quoteRef: "media-quote:prior", nonBinding: true as const,
      definitionRevisionRef: "image.text_to_image@v1:revision:1",
      modelOptionRevisionRef: `model-option:sha256:${"b".repeat(64)}`,
      estimate: Object.freeze({ amount: "8", creditUnit: "credit" }),
      expiresAt: "2026-07-31T12:04:00.000Z" });
    const journal: MediaPublicQuoteJournalPort = {
      begin: vi.fn(async () => ({ kind: "replayed" as const, quote: replay })),
      commit: vi.fn(),
    };
    const pricing: MediaPublicQuotePricingPort = { rate: vi.fn() };

    await expect(quoteService(journal, pricing).quoteMediaOperation(execution()))
      .resolves.toEqual({ quote: replay });
    expect(pricing.rate).not.toHaveBeenCalled();
  });

  it("fails closed on a negative or mismatched owner rating", async () => {
    const journal: MediaPublicQuoteJournalPort = {
      begin: vi.fn(async () => ({ kind: "started" as const, leaseRef: "quote-lease:one" })),
      commit: vi.fn(),
    };
    const pricing: MediaPublicQuotePricingPort = { rate: vi.fn(async () => ({ amount: -1n,
      unit: "credit", definitionRevisionRef: "another-definition:revision:1",
      modelOptionRevisionRef: `model-option:sha256:${"b".repeat(64)}`,
      ratingPolicyRevisionRef: "rating-policy:image-v1",
      expiresAt: "2026-07-31T12:05:00.000Z" })) };

    await expect(quoteService(journal, pricing).quoteMediaOperation(execution()))
      .rejects.toThrow("MEDIA_PUBLIC_QUOTE_RATING_CORRUPT");
    expect(journal.commit).not.toHaveBeenCalled();
  });
});

function quoteService(journal: MediaPublicQuoteJournalPort, pricing: MediaPublicQuotePricingPort) {
  const readRepository = {
    resolveOwnerAuthority: vi.fn(async () => authority),
  } as unknown as MediaPublicReadRepository;
  return new MediaPublicQuoteService({
    unitOfWork: { execute: async (_fence, work) => work(transaction) },
    readRepository, journal, pricing, commandDigestKey: Buffer.alloc(32, 11),
    reference: () => "media-quote:one", clock: () => new Date("2026-07-31T12:00:00.000Z"),
  });
}

function execution(): PlatformPublicOperationExecution<"quoteMediaOperation"> {
  const operationId = "quoteMediaOperation" as const;
  const session = Object.freeze({ identitySessionRef: "session-1", subjectRef: "subject-1",
    siteRef: "site-1", subjectGeneration: "5", identitySessionEpoch: "6", restrictionEpoch: "7",
    credentialEpoch: "8", authenticationMethods: ["password" as const],
    authenticatedAt: "2026-07-31T00:00:00.000Z", expiresAt: "2026-08-01T00:00:00.000Z" });
  const workload = Object.freeze({ certificateSha256: "c".repeat(64),
    workloadIdentityId: authority.workloadIdentityRef, siteProjectBindingRef: "binding-1",
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
    headers: { "Kokoro-Contract-Version": "1" as const, "X-Kokoro-Command-Id": "0".repeat(32),
      "Idempotency-Key": "idempotency-key-1", "X-CSRF-Token": "x".repeat(32) },
    path: { projectRef: "project-1" }, query: null,
    body: { kind: "image_text_to_image" as const,
      definitionRevisionRef: "image.text_to_image@v1:revision:1",
      modelOptionRevisionRef: `model-option:sha256:${"b".repeat(64)}`,
      promptIntent: "Draw a fox", aspectRatio: "square_1_1" as const, candidateCount: 1,
      outputFormat: "png" as const },
    receiptRecoveryCapability: null, signal: new AbortController().signal });
}
