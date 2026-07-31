import { describe, expect, it, vi } from "vitest";
import type { RunBudgetAuthority } from
  "../../src/modules/credit/application/contracts/run-budget-authority.js";
import { NativeMediaImageCreditOwner } from "../../src/process/media-image-local-credit-owner.js";
import { issuePlatformTransaction, revokePlatformTransaction } from
  "../../src/shared/unit-of-work/platform-transaction.js";

describe("NativeMediaImageCreditOwner", () => {
  it("reserves and commits one Direct Studio root in the caller transaction", async () => {
    const reserveRootBudget = vi.fn(async () => ({ kind: "accepted" as const, value: {
      executionBudgetRootRef: "00000000-0000-7000-8000-000000000101",
      creditHoldRef: "00000000-0000-7000-8000-000000000102",
      rootAllocationRef: "00000000-0000-7000-8000-000000000103",
      rootAllocationRevision: 1n,
      rootAllocationEpoch: 1n,
      authorizationSegmentRef: "00000000-0000-7000-8000-000000000104",
      segmentVersion: 1n,
      state: "reserved" as const,
      expiresAt: "2026-07-31T13:00:00.000Z",
    } }));
    const finalizeAuthorizationSegment = vi.fn(async () => ({ kind: "accepted" as const, value: {
      authorizationSegmentRef: "00000000-0000-7000-8000-000000000104",
      segmentVersion: 2n,
      state: "committed" as const,
      observedAt: "2026-07-31T12:00:00.000Z",
    } }));
    const owner = new NativeMediaImageCreditOwner({ reserveRootBudget, finalizeAuthorizationSegment,
      deriveChildAllocation: vi.fn() } satisfies Pick<RunBudgetAuthority,
        "reserveRootBudget" | "finalizeAuthorizationSegment" | "deriveChildAllocation">);
    const lease = issuePlatformTransaction({ query: async () => [], execute: async () => 1 });
    try {
      const result = await owner.reserveDirectRoot(lease.transaction, {
        ownerBinding: { source: "direct_studio", siteRef: "site:one", subjectRef: "subject:one",
          subjectGeneration: 2n, projectRef: "project:one", workloadRef: "studio:web",
          definitionRevisionRef: "image-definition:one", modelOptionRevisionRef: "model-option:one",
          authority: { siteReleaseRef: "release:one", siteSecurityEpoch: 1n, policyEpoch: 2n,
            workloadBindingEpoch: 3n, identitySessionRef: "session:one", identitySessionEpoch: 4n,
            restrictionEpoch: 5n, membershipEpoch: 6n, authorizationEpoch: 7n } },
        budgetSource: { kind: "direct_root", billingAccountRef: "billing:one",
          creditAccountRef: "00000000-0000-7000-8000-000000000201", unit: "credit",
          liabilityMerchantAccountRef: "merchant:one", ratingPolicyRevisionRef: "rating:one",
          authorizationBudgetRef: "authorization-budget:one",
          executionManifestRef: "media-manifest:one" },
        mediaOperationRef: "media-operation:one", commandRef: "media-command:one",
        ownerRequestDigest: "a".repeat(64), exactCeiling: 25n,
        consumptionScope: { surfaceRef: "studio.image", capabilityKey: "image.create", agentRef: null },
        expiresAt: "2026-07-31T13:00:00.000Z",
      });

      expect(reserveRootBudget).toHaveBeenCalledWith(lease.transaction, expect.objectContaining({
        siteId: "site:one", executionRootId: "media-operation:one", rootCeiling: 25n,
        segmentMaximum: 25n, authorizationBudgetRef: "authorization-budget:one",
        executionManifestRef: "media-manifest:one", businessOperationKey: "media-command:one",
      }));
      expect(finalizeAuthorizationSegment).toHaveBeenCalledWith(lease.transaction, {
        siteId: "site:one",
        authorizationSegmentRef: "00000000-0000-7000-8000-000000000104",
        executionManifestRef: "media-manifest:one",
        expectedSegmentVersion: 1n,
        businessOperationKey: expect.stringMatching(/^media-root-segment:[a-f0-9]{64}$/u),
        requestDigest: expect.stringMatching(/^[a-f0-9]{64}$/u),
      });
      expect(result).toEqual({
        executionBudgetRootRef: "00000000-0000-7000-8000-000000000101",
        rootHoldRef: "00000000-0000-7000-8000-000000000102",
        rootAllocationRef: "00000000-0000-7000-8000-000000000103",
        rootAllocationRevision: 1n,
        rootAllocationEpoch: 1n,
        authorizationSegmentRef: "00000000-0000-7000-8000-000000000104",
        authorizationSegmentVersion: 2n,
      });
    } finally {
      revokePlatformTransaction(lease);
    }
  });

  it("fails closed when the root Segment cannot be committed", async () => {
    const authority = {
      reserveRootBudget: vi.fn(async () => ({ kind: "accepted" as const, value: {
        executionBudgetRootRef: "root", creditHoldRef: "hold", rootAllocationRef: "allocation",
        rootAllocationRevision: 1n, rootAllocationEpoch: 1n, authorizationSegmentRef: "segment",
        segmentVersion: 1n, state: "reserved" as const, expiresAt: "2026-07-31T13:00:00.000Z",
      } })),
      finalizeAuthorizationSegment: vi.fn(async () => ({ kind: "invalid_state" as const,
        code: "CREDIT_SEGMENT_EXPIRED" })),
      deriveChildAllocation: vi.fn(),
    } satisfies Pick<RunBudgetAuthority,
      "reserveRootBudget" | "finalizeAuthorizationSegment" | "deriveChildAllocation">;
    const owner = new NativeMediaImageCreditOwner(authority);
    const lease = issuePlatformTransaction({ query: async () => [], execute: async () => 1 });
    try {
      await expect(owner.reserveDirectRoot(lease.transaction, directInput()))
        .rejects.toThrow("MEDIA_CREDIT_ROOT_FINALIZE_INVALID_STATE");
    } finally {
      revokePlatformTransaction(lease);
    }
  });
});

function directInput(): Parameters<NativeMediaImageCreditOwner["reserveDirectRoot"]>[1] {
  return {
    ownerBinding: { source: "direct_studio", siteRef: "site:one", subjectRef: "subject:one",
      subjectGeneration: 2n, projectRef: "project:one", workloadRef: "studio:web",
      definitionRevisionRef: "definition:one", modelOptionRevisionRef: "model:one",
      authority: { siteReleaseRef: "release:one", siteSecurityEpoch: 1n, policyEpoch: 2n,
        workloadBindingEpoch: 3n, identitySessionRef: "session:one", identitySessionEpoch: 4n,
        restrictionEpoch: 5n, membershipEpoch: 6n, authorizationEpoch: 7n } },
    budgetSource: { kind: "direct_root", billingAccountRef: "billing:one",
      creditAccountRef: "credit:one", unit: "credit", liabilityMerchantAccountRef: "merchant:one",
      ratingPolicyRevisionRef: "rating:one", authorizationBudgetRef: "budget:one",
      executionManifestRef: "manifest:one" },
    mediaOperationRef: "operation:one", commandRef: "command:one", ownerRequestDigest: "b".repeat(64),
    exactCeiling: 10n,
    consumptionScope: { surfaceRef: "studio.image", capabilityKey: "image.create", agentRef: null },
    expiresAt: "2026-07-31T13:00:00.000Z",
  };
}
