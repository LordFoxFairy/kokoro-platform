import { describe, expect, it } from "vitest";
import { PreviewRedemptionService } from
  "../../src/modules/commerce/application/services/preview-redemption.js";
import type { RedemptionRepository } from
  "../../src/modules/commerce/application/contracts/redemption-repository.js";
import { createRedemptionSecretCodec } from
  "../../src/modules/commerce/infrastructure/crypto/redemption-secret-codec.js";
import { issuePlatformTransaction, revokePlatformTransaction } from
  "../../src/shared/unit-of-work/platform-transaction.js";
import type { PlatformTransaction } from "../../src/shared/unit-of-work/platform-transaction.js";
import type { VerifiedRequestSecurityContext } from "../../src/shared/security-context/index.js";
import type { CommerceCommandFence } from "../../src/modules/commerce/application/command-fence.js";
import { CommerceLockSequence } from "../../src/workflows/commerce/lock-order.js";
import {
  isSupportedRedemptionSafeTerms,
  redemptionReleaseCapabilities,
  type RedemptionSafeTerms,
} from "../../src/modules/commerce/domain/redemption-preview.js";

describe("redemption release capabilities", () => {
  it("keeps daily and period Credit feature-off even when term metadata is complete", () => {
    expect(redemptionReleaseCapabilities).toEqual({
      creditGrantBucketClasses: ["permanent"],
      calendarWindowCreditAcquisition: false,
    });
    expect(isSupportedRedemptionSafeTerms(safeTerms("permanent"))).toBe(true);
    expect(isSupportedRedemptionSafeTerms(safeTerms("daily"))).toBe(false);
    expect(isSupportedRedemptionSafeTerms(safeTerms("period"))).toBe(false);
  });
});

describe("PreviewRedemptionService", () => {
  it("derives preview identity and TTL from the repository's DB-authoritative effect time", async () => {
    const lease = issuePlatformTransaction({ query: async () => [], execute: async () => 0 });
    const repository = new FakeRedemptionRepository();
    let referenceTime: number | null = null;
    try {
      const secrets = createRedemptionSecretCodec({
        currentCodeLookupKeyRevision: "code-1",
        codeLookupKeys: [{ keyRevision: "code-1", key: Buffer.alloc(32, 1) }],
        currentPreviewCredentialKeyRevision: "preview-1",
        previewCredentialKeys: [{ keyRevision: "preview-1", key: Buffer.alloc(32, 2) }],
        requestAuditKey: Buffer.alloc(32, 3),
      });
      const service = new PreviewRedemptionService({
        unitOfWork: { execute: async (_fence, work) => work(lease.transaction) },
        fence: new FakeFence(lease.transaction),
        repository,
        secrets,
        reference: (now) => {
          referenceTime = now;
          return "00000000-0000-7000-8000-000000000101";
        },
        previewTtlSeconds: 300,
      });

      const result = await service.execute({
        context: context(),
        commandId: "00000000-0000-7000-8000-000000000201",
        idempotencyKey: "preview-operation-0001",
        code: secrets.issueCode("site-1", "00000000-0000-7000-8000-000000000402").code,
      });

      expect(referenceTime).toBe(Date.parse("2026-07-29T01:00:30.000Z"));
      expect(repository.saved).toMatchObject({
        createdAt: "2026-07-29T01:00:30.000Z",
        expiresAt: "2026-07-29T01:05:30.000Z",
      });
      expect(result.preview.expiresAt).toBe("2026-07-29T01:05:30.000Z");
      expect(repository.candidateInput).not.toHaveProperty("now");
    } finally {
      revokePlatformTransaction(lease);
    }
  });
});

class FakeRedemptionRepository implements RedemptionRepository {
  saved: Parameters<RedemptionRepository["savePreview"]>[1] | null = null;
  candidateInput: Parameters<RedemptionRepository["resolvePreviewCandidate"]>[1] | null = null;

  async resolvePreviewBillingAccount() {
    return { billingAccountId: "billing-1", aggregateVersion: "1", membershipEpoch: "1" };
  }

  async resolvePreviewCandidate(
    _transaction: Parameters<RedemptionRepository["resolvePreviewCandidate"]>[0],
    input: Parameters<RedemptionRepository["resolvePreviewCandidate"]>[1],
  ): ReturnType<RedemptionRepository["resolvePreviewCandidate"]> {
    this.candidateInput = input;
    return Promise.resolve({
      codeRef: "00000000-0000-7000-8000-000000000401",
      batchRef: "00000000-0000-7000-8000-000000000402",
      redemptionProgramRevisionRef: "redemption-v1",
      fulfillmentProgramRevisionRef: "fulfillment-v1",
      productRevisionDigest: "a".repeat(64),
      programDigest: "b".repeat(64),
      outputPlanDigest: "c".repeat(64),
      safeCodeFingerprint: "CODE-0123456789ABCDEF",
      safeTerms: {
        productRef: "product-1", productVersionRef: "product-v1", productKind: "free",
        safeProductLabel: "Starter", planRef: null, planVersionRef: null, safePlanLabel: null,
        term: { action: "none", startsAt: null, endsAt: null, automaticRenewal: false },
        credits: [], entitlements: [], legalTermRefs: [],
      },
      observedAt: "2026-07-29T01:00:30.000Z",
    });
  }

  async savePreview(
    _transaction: Parameters<RedemptionRepository["savePreview"]>[0],
    input: Parameters<RedemptionRepository["savePreview"]>[1],
  ) {
    this.saved = input;
  }

  async findPreviewByCommand() {
    return null;
  }
}

class FakeFence {
  constructor(private readonly transaction: PlatformTransaction) {}

  async execute(
    _input: Parameters<CommerceCommandFence["execute"]>[0],
    work: Parameters<CommerceCommandFence["execute"]>[1],
  ): ReturnType<CommerceCommandFence["execute"]> {
    const outcome = await work({
      transaction: this.transaction,
      authority: { siteId: "site-1", releaseRef: "release-1", subjectId: "subject-1" },
      locks: new CommerceLockSequence(),
    });
    return { disposition: "executed" as const, ...outcome };
  }
}

function context(): VerifiedRequestSecurityContext {
  return {
    environment: "test", region: "local", audience: "site-1",
    trustedCaller: { kind: "site_product", siteId: "site-1", workloadIdentityId: "workload-1",
      siteReleaseRef: "release-1" },
    actor: { kind: "user", subjectId: "subject-1", subjectGeneration: "2" },
    target: { siteId: "site-1", purpose: "previewRedemption" },
  } as VerifiedRequestSecurityContext;
}

function safeTerms(bucketClass: "daily" | "period" | "permanent"): RedemptionSafeTerms {
  return {
    productRef: "product-1", productVersionRef: "product-v1", productKind: "subscription",
    safeProductLabel: "Subscription", planRef: "plan-1", planVersionRef: "plan-v1", safePlanLabel: "Plan",
    term: { action: "new_subscription", startsAt: "2026-11-01T05:00:00.000Z",
      endsAt: "2026-12-01T05:00:00.000Z", automaticRenewal: false },
    credits: [{ creditProgramRevisionRef: "credit-v1", bucketClass, unit: "credit", amount: "100",
      expiresAt: bucketClass === "permanent" ? null : "2026-11-02T05:00:00.000Z" }],
    entitlements: [], legalTermRefs: [],
  };
}
