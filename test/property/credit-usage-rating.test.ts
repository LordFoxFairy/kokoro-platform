import { describe, expect, it } from "vitest";
import {
  rateAttemptUsage,
  rateSegmentUsage,
  type AttemptUsageEvidence,
  type RatingPolicyRevision,
} from "../../src/modules/credit/domain/usage-rating.js";
import {
  correctSettledAuthorizationSegmentAllocation,
  markAuthorizationSegmentRatingPending,
  settleAuthorizationSegment,
  type AuthorizationSegmentState,
  type BudgetAllocationRevision,
} from "../../src/modules/credit/domain/allocation.js";

describe("Credit usage rating and settlement conservation", () => {
  it("rates integer dimensions against the frozen policy without floating point arithmetic", () => {
    const result = rateAttemptUsage(policy(), measuredUsage({
      input_tokens: 1_501n,
      output_tokens: 1n,
    }), 25n);

    expect(result).toEqual({
      kind: "rated",
      customerAmount: 9n,
      platformExposureAmount: 0n,
      lineItems: [
        { dimensionKey: "input_tokens", quantity: 1_501n, billableQuanta: 2n, amount: 4n },
        { dimensionKey: "output_tokens", quantity: 1n, billableQuanta: 1n, amount: 5n },
      ],
    });
  });

  it("requires typed evidence for every required dimension and never treats unavailable usage as zero", () => {
    expect(rateAttemptUsage(policy(), measuredUsage({ input_tokens: 10n }), 25n))
      .toEqual({ kind: "reconciliation_required", code: "CREDIT_USAGE_REQUIRED_DIMENSION_MISSING" });
    expect(rateAttemptUsage(policy(), {
      ...usageIdentity(),
      evidenceKind: "unavailable",
      unavailableReason: "provider_usage_missing",
      dimensions: [],
    }, 25n)).toEqual({ kind: "reconciliation_required", code: "CREDIT_USAGE_UNAVAILABLE" });
  });

  it("accepts an explicit typed zero without manufacturing dimensions", () => {
    expect(rateAttemptUsage(policy(), {
      ...usageIdentity(),
      evidenceKind: "zero",
      zeroReason: "definitely_not_submitted",
      dimensions: [],
    }, 25n)).toEqual({
      kind: "rated",
      customerAmount: 0n,
      platformExposureAmount: 0n,
      lineItems: [],
    });
  });

  it("caps customer capture at the committed maximum and exposes the variance explicitly", () => {
    expect(rateAttemptUsage(policy(), measuredUsage({
      input_tokens: 10_000n,
      output_tokens: 10_000n,
    }), 25n)).toMatchObject({
      kind: "over_ceiling",
      customerAmount: 25n,
      platformExposureAmount: 45n,
    });
  });

  it("rates every canonical Attempt before applying the Segment ceiling once", () => {
    const fallback = measuredUsage({ input_tokens: 1_000n, output_tokens: 1_000n });
    const winner = {
      ...measuredUsage({ input_tokens: 1_000n, output_tokens: 1_000n }),
      attemptRef: "attempt-2",
      sourceDigest: "b".repeat(64),
    } satisfies AttemptUsageEvidence;

    expect(rateSegmentUsage(policy(), [fallback, winner], 10n)).toMatchObject({
      kind: "over_ceiling",
      customerAmount: 10n,
      platformExposureAmount: 4n,
      attemptRatings: [
        { attemptRef: "attempt-1", policyRatedAmount: 7n },
        { attemptRef: "attempt-2", policyRatedAmount: 7n },
      ],
    });
  });

  it("cannot close a Segment over duplicate Attempts or unavailable evidence", () => {
    const usage = measuredUsage({ input_tokens: 1_000n, output_tokens: 1_000n });
    expect(() => rateSegmentUsage(policy(), [usage, usage], 25n))
      .toThrowError("CREDIT_USAGE_ATTEMPT_DUPLICATE");
    expect(rateSegmentUsage(policy(), [{
      ...usageIdentity(),
      evidenceKind: "unavailable",
      unavailableReason: "provider_usage_ambiguous",
      dimensions: [],
    }], 25n)).toEqual({
      kind: "reconciliation_required",
      code: "CREDIT_USAGE_UNAVAILABLE",
    });
  });

  it("settles the exact committed segment into captured and reusable stock", () => {
    const ratingPending = markAuthorizationSegmentRatingPending(
      committedSegment(),
      "usage-closure:1",
    );
    const next = settleAuthorizationSegment({
      allocation: allocation(),
      segment: ratingPending,
      ratedAmount: 9n,
      settlementRef: "settlement:usage-1",
      settledAt: "2026-07-29T00:02:00.000Z",
    });

    expect(next.allocation).toMatchObject({
      revision: 3n,
      unassignedStock: 91n,
      committedStock: 0n,
      capturedCumulative: 9n,
    });
    expect(next.segment).toMatchObject({
      state: "settled",
      resolutionKind: "rated",
      resolutionRef: "settlement:usage-1",
      aggregateVersion: 4n,
      fenceEpoch: 4n,
    });
  });

  it("requires a durable closure before a committed Segment can settle", () => {
    expect(() => settleAuthorizationSegment({
      allocation: allocation(),
      segment: committedSegment(),
      ratedAmount: 9n,
      settlementRef: "settlement:usage-1",
      settledAt: "2026-07-29T00:02:00.000Z",
    })).toThrowError("CREDIT_SEGMENT_NOT_SETTLEABLE");
  });

  it("applies settlement corrections as new conserved allocation revisions", () => {
    const settled = { ...allocation(), revision: 3n, unassignedStock: 91n,
      committedStock: 0n, capturedCumulative: 9n };
    expect(correctSettledAuthorizationSegmentAllocation(settled, -4n)).toMatchObject({
      revision: 4n, unassignedStock: 95n, capturedCumulative: 5n,
    });
    expect(correctSettledAuthorizationSegmentAllocation(settled, 4n)).toMatchObject({
      revision: 4n, unassignedStock: 87n, capturedCumulative: 13n,
    });
  });

  it("allows authoritative evidence to settle a reconciled segment but never exceeds its maximum", () => {
    const segment: AuthorizationSegmentState = {
      ...committedSegment(),
      state: "reconciliation_required",
      resolutionKind: "outcome_unknown",
      resolutionRef: "unknown:evidence-1",
      aggregateVersion: 3n,
      fenceEpoch: 3n,
    };
    const next = settleAuthorizationSegment({
      allocation: allocation(),
      segment,
      ratedAmount: 25n,
      settlementRef: "settlement:reconciled-1",
      settledAt: "2026-07-29T00:03:00.000Z",
    });
    expect(next.segment.resolutionKind).toBe("reconciled");
    expect(() => settleAuthorizationSegment({
      allocation: allocation(),
      segment: markAuthorizationSegmentRatingPending(committedSegment(), "usage-closure:invalid"),
      ratedAmount: 26n,
      settlementRef: "settlement:invalid",
      settledAt: "2026-07-29T00:03:00.000Z",
    })).toThrowError("CREDIT_SETTLEMENT_AMOUNT_EXCEEDS_SEGMENT");
  });
});

function policy(): RatingPolicyRevision {
  return {
    ratingPolicyRevisionRef: "rating-policy-1",
    customerUnit: "credit_micros",
    chargeableAttemptOutcomes: ["succeeded", "failed_after_effect"],
    minimumAmount: 0n,
    rules: [
      { dimensionKey: "input_tokens", sourceUnit: "token", quantum: 1_000n, amountPerQuantum: 2n, required: true },
      { dimensionKey: "output_tokens", sourceUnit: "token", quantum: 1_000n, amountPerQuantum: 5n, required: true },
    ],
  };
}

function usageIdentity() {
  return {
    producerKind: "model_gateway" as const,
    producerContext: "gateway:us-east-1",
    producerGeneration: 3n,
    attemptRef: "attempt-1",
    logicalEffectRef: "effect-1",
    authorizationSegmentRef: "segment-1",
    executionManifestRef: "manifest-1",
    revision: 1n,
    correctionOfEvidenceRef: null,
    attemptOutcome: "succeeded" as const,
    occurredAt: "2026-07-29T00:01:00.000Z",
    sourceDigest: "a".repeat(64),
  };
}

function measuredUsage(quantities: Readonly<Record<string, bigint>>): AttemptUsageEvidence {
  return {
    ...usageIdentity(),
    evidenceKind: "measured",
    dimensions: Object.entries(quantities).map(([dimensionKey, quantity]) => ({
      dimensionKey,
      sourceUnit: "token",
      quantity,
    })),
  };
}

function allocation(): BudgetAllocationRevision {
  return {
    revision: 2n,
    allocationEpoch: 1n,
    creditCeiling: 100n,
    unassignedStock: 75n,
    activeChildReservedStock: 0n,
    committedStock: 25n,
    capturedCumulative: 0n,
    returnedToParentCumulative: 0n,
    state: "active",
  };
}

function committedSegment(): AuthorizationSegmentState {
  return {
    state: "committed",
    maximumAmount: 25n,
    allocationEpoch: 1n,
    preparedAgainstAllocationRevision: 1n,
    committedFromAllocationRevision: 1n,
    committedToAllocationRevision: 2n,
    aggregateVersion: 2n,
    fenceEpoch: 2n,
    resolutionKind: null,
    resolutionRef: null,
    committedAt: "2026-07-29T00:00:00.000Z",
    settledAt: null,
    releasedAt: null,
  };
}
