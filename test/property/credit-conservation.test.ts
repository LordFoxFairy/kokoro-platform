import { describe, expect, it } from "vitest";
import {
  commitAuthorizationSegment,
  planGrantReservation,
  reconcileUnknownAuthorizationSegment,
  releaseReservedAuthorizationSegment,
  type AuthorizationSegmentState,
  type BudgetAllocationRevision,
} from "../../src/modules/credit/domain/allocation.js";

describe("Credit allocation conservation", () => {
  it("reserves the full requested amount in canonical Grant burn order without partial success", () => {
    const plan = planGrantReservation(
      [
        grant("permanent", 20n, null, 10, "2026-01-01T00:00:00.000Z"),
        grant("late", 30n, "2026-09-01T00:00:00.000Z", 10, "2026-01-01T00:00:00.000Z"),
        grant("early-low-priority", 40n, "2026-08-01T00:00:00.000Z", 20, "2026-01-01T00:00:00.000Z"),
        grant("early-high-priority", 25n, "2026-08-01T00:00:00.000Z", 10, "2026-01-02T00:00:00.000Z"),
      ],
      80n,
    );

    expect(plan).toEqual([
      { creditGrantId: "early-high-priority", amount: 25n, ordinal: 0 },
      { creditGrantId: "early-low-priority", amount: 40n, ordinal: 1 },
      { creditGrantId: "late", amount: 15n, ordinal: 2 },
    ]);
    expect(() => planGrantReservation([grant("only", 9n, null, 1, "2026-01-01T00:00:00.000Z")], 10n))
      .toThrowError("CREDIT_INSUFFICIENT_AVAILABLE");
  });

  it("preserves allocation stock and cumulative-flow conservation across many Segment commits", () => {
    for (let seed = 1; seed <= 200; seed += 1) {
      const ceiling = BigInt(50 + seed);
      const maximum = BigInt(1 + (seed % 50));
      const allocation = revision({ ceiling, unassigned: ceiling });
      const segment = reservedSegment(maximum);

      const committed = commitAuthorizationSegment({ allocation, segment });

      expect(stockTotal(committed.allocation)).toBe(ceiling);
      expect(committed.allocation.unassignedStock).toBe(ceiling - maximum);
      expect(committed.allocation.committedStock).toBe(maximum);
      expect(committed.allocation.revision).toBe(2n);
      expect(committed.segment.state).toBe("committed");
      expect(committed.segment.aggregateVersion).toBe(2n);
      expect(committed.segment.fenceEpoch).toBe(2n);
    }
  });

  it("fences stale Segment commits and never releases a committed or unknown effect", () => {
    const allocation = revision({ ceiling: 100n, unassigned: 100n });
    const segment = reservedSegment(25n);
    const committed = commitAuthorizationSegment({ allocation, segment });

    expect(() => commitAuthorizationSegment({ allocation: committed.allocation, segment }))
      .toThrowError("CREDIT_SEGMENT_ALLOCATION_REVISION_STALE");
    expect(() => releaseReservedAuthorizationSegment(committed.segment, "2026-07-29T00:01:00.000Z"))
      .toThrowError("CREDIT_SEGMENT_NOT_RELEASABLE");

    const unknown = reconcileUnknownAuthorizationSegment(
      committed.segment,
      "owner-evidence:dispatch-outcome-unknown",
      "2026-07-29T00:02:00.000Z",
    );
    expect(unknown.state).toBe("reconciliation_required");
    expect(unknown.aggregateVersion).toBe(3n);
    expect(unknown.fenceEpoch).toBe(3n);
    expect(() => releaseReservedAuthorizationSegment(unknown, "2026-07-29T00:03:00.000Z"))
      .toThrowError("CREDIT_SEGMENT_NOT_RELEASABLE");
  });

  it("releases only an uncommitted Segment and leaves allocation stock untouched", () => {
    const allocation = revision({ ceiling: 75n, unassigned: 75n });
    const released = releaseReservedAuthorizationSegment(
      reservedSegment(25n),
      "2026-07-29T00:01:00.000Z",
    );

    expect(released.state).toBe("released");
    expect(released.resolutionKind).toBe("not_dispatched");
    expect(released.aggregateVersion).toBe(2n);
    expect(stockTotal(allocation)).toBe(75n);
  });
});

function grant(
  creditGrantId: string,
  availableAmount: bigint,
  expiresAt: string | null,
  burnPriority: number,
  issuedAt: string,
) {
  return { creditGrantId, availableAmount, expiresAt, burnPriority, issuedAt };
}

function revision(input: Readonly<{ ceiling: bigint; unassigned: bigint }>): BudgetAllocationRevision {
  return {
    revision: 1n,
    allocationEpoch: 1n,
    creditCeiling: input.ceiling,
    unassignedStock: input.unassigned,
    activeChildReservedStock: 0n,
    committedStock: 0n,
    capturedCumulative: 0n,
    returnedToParentCumulative: 0n,
    state: "active",
  };
}

function reservedSegment(maximumAmount: bigint): AuthorizationSegmentState {
  return {
    state: "reserved",
    maximumAmount,
    allocationEpoch: 1n,
    preparedAgainstAllocationRevision: 1n,
    committedFromAllocationRevision: null,
    committedToAllocationRevision: null,
    aggregateVersion: 1n,
    fenceEpoch: 1n,
    resolutionKind: null,
    resolutionRef: null,
    committedAt: null,
    settledAt: null,
    releasedAt: null,
  };
}

function stockTotal(revision: BudgetAllocationRevision): bigint {
  return revision.unassignedStock + revision.activeChildReservedStock + revision.committedStock
    + revision.capturedCumulative + revision.returnedToParentCumulative;
}
