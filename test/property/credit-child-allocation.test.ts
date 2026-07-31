import { describe, expect, it } from "vitest";
import {
  deriveChildAllocation,
  deriveMediaChildReturnReason,
  rehydrateChildAllocationRevision,
  returnChildAllocation,
  type BudgetAllocationRevision,
  type ChildAllocationRevision,
} from "../../src/modules/credit/domain/allocation.js";

describe("Credit Media child allocation conservation", () => {
  it("moves exact parent stock into a conserved initial child revision", () => {
    const derived = deriveChildAllocation({
      parent: revision({ creditCeiling: 100n, unassignedStock: 80n, committedStock: 20n }),
      expectedParentRevision: 3n,
      expectedParentAllocationEpoch: 2n,
      reservedSegmentStock: 10n,
      exactCeiling: 35n,
    });

    expect(derived.parent).toMatchObject({
      revision: 4n,
      allocationEpoch: 2n,
      unassignedStock: 45n,
      activeChildReservedStock: 35n,
      committedStock: 20n,
    });
    expect(derived.child).toEqual({
      revision: 1n,
      allocationEpoch: 1n,
      creditCeiling: 35n,
      unassignedStock: 35n,
      activeChildReservedStock: 0n,
      committedStock: 0n,
      capturedCumulative: 0n,
      returnedToParentCumulative: 0n,
      state: "active",
      terminalReceiptDigest: null,
      parentAppliedRevision: null,
    });
    expect(stockTotal(derived.parent)).toBe(100n);
    expect(stockTotal(derived.child)).toBe(35n);
  });

  it("fences stale parent versions and protects existing reserved Segment capacity", () => {
    const parent = revision({ creditCeiling: 100n, unassignedStock: 80n, committedStock: 20n });
    expect(() => deriveChildAllocation({ parent, expectedParentRevision: 2n,
      expectedParentAllocationEpoch: 2n, reservedSegmentStock: 10n, exactCeiling: 1n }))
      .toThrow("CREDIT_CHILD_PARENT_REVISION_STALE");
    expect(() => deriveChildAllocation({ parent, expectedParentRevision: 3n,
      expectedParentAllocationEpoch: 1n, reservedSegmentStock: 10n, exactCeiling: 1n }))
      .toThrow("CREDIT_CHILD_PARENT_EPOCH_STALE");
    expect(() => deriveChildAllocation({ parent, expectedParentRevision: 3n,
      expectedParentAllocationEpoch: 2n, reservedSegmentStock: 50n, exactCeiling: 31n }))
      .toThrow("CREDIT_CHILD_ALLOCATION_CAPACITY_EXCEEDED");
  });

  it("returns unspent stock, rolls captured stock into the parent, and permanently terminals the child", () => {
    const parent = revision({ creditCeiling: 100n, unassignedStock: 40n,
      activeChildReservedStock: 50n, committedStock: 10n, revision: 7n, allocationEpoch: 3n });
    const child = childRevision({ creditCeiling: 50n, unassignedStock: 30n,
      capturedCumulative: 20n, revision: 4n, allocationEpoch: 2n });
    const returned = returnChildAllocation({
      parent,
      child,
      expectedParentRevision: 7n,
      expectedParentAllocationEpoch: 3n,
      expectedChildRevision: 4n,
      expectedChildAllocationEpoch: 2n,
      receiptDigest: "d".repeat(64),
    });

    expect(returned.parent).toMatchObject({ revision: 8n, unassignedStock: 70n,
      activeChildReservedStock: 0n, capturedCumulative: 20n });
    expect(returned.child).toMatchObject({ revision: 5n, allocationEpoch: 3n,
      unassignedStock: 0n, capturedCumulative: 20n, returnedToParentCumulative: 30n,
      state: "terminal", terminalReceiptDigest: "d".repeat(64), parentAppliedRevision: 8n });
    expect(stockTotal(returned.parent)).toBe(100n);
    expect(stockTotal(returned.child)).toBe(50n);
  });

  it("fails closed for committed, descendant, reconciliation, or already-terminal child stock", () => {
    const parent = revision({ creditCeiling: 100n, unassignedStock: 50n,
      activeChildReservedStock: 50n });
    const base = { parent, expectedParentRevision: 3n, expectedParentAllocationEpoch: 2n,
      expectedChildRevision: 2n, expectedChildAllocationEpoch: 1n, receiptDigest: "e".repeat(64) };
    expect(() => returnChildAllocation({ ...base,
      child: childRevision({ creditCeiling: 50n, unassignedStock: 40n, committedStock: 10n }) }))
      .toThrow("CREDIT_CHILD_COMMITTED_STOCK_PENDING");
    expect(() => returnChildAllocation({ ...base,
      child: childRevision({ creditCeiling: 50n, unassignedStock: 40n, activeChildReservedStock: 10n }) }))
      .toThrow("CREDIT_CHILD_DESCENDANT_PENDING");
    expect(() => returnChildAllocation({ ...base,
      child: childRevision({ creditCeiling: 50n, unassignedStock: 50n,
        state: "reconciliation_required" }) }))
      .toThrow("CREDIT_CHILD_RECONCILIATION_REQUIRED");
    expect(() => returnChildAllocation({ ...base,
      child: childRevision({ creditCeiling: 50n, unassignedStock: 0n,
        returnedToParentCumulative: 50n, state: "terminal",
        terminalReceiptDigest: "f".repeat(64), parentAppliedRevision: 4n }) }))
      .toThrow("CREDIT_CHILD_ALREADY_TERMINAL");
  });

  it("rejects corrupt persisted child revisions during rehydration", () => {
    expect(() => rehydrateChildAllocationRevision(childRevision({
      creditCeiling: 50n,
      unassignedStock: 40n,
    }))).toThrow("CREDIT_ALLOCATION_CONSERVATION_VIOLATION");
    expect(() => rehydrateChildAllocationRevision(childRevision({
      creditCeiling: 50n,
      unassignedStock: 50n,
      state: "terminal",
      terminalReceiptDigest: null,
      parentAppliedRevision: null,
    }))).toThrow("CREDIT_CHILD_TERMINAL_REVISION_INVALID");
  });

  it("derives the closed return-reason matrix from root state, owner outcome, and captured stock", () => {
    expect(deriveMediaChildReturnReason({ rootState: "open", ownerOutcome: "completed", capturedAmount: 9n }))
      .toBe("completed");
    expect(deriveMediaChildReturnReason({ rootState: "open", ownerOutcome: "canceled", capturedAmount: 0n }))
      .toBe("canceled_before_effect");
    for (const [ownerOutcome, capturedAmount] of [["partial", 0n], ["failed", 0n], ["canceled", 1n]] as const) {
      expect(deriveMediaChildReturnReason({ rootState: "open", ownerOutcome, capturedAmount }))
        .toBe("fenced_recovery");
    }
    expect(deriveMediaChildReturnReason({ rootState: "closing", ownerOutcome: "completed", capturedAmount: 9n }))
      .toBe("root_closing");
  });
});

function revision(overrides: Partial<BudgetAllocationRevision> = {}): BudgetAllocationRevision {
  return {
    revision: 3n,
    allocationEpoch: 2n,
    creditCeiling: 100n,
    unassignedStock: 100n,
    activeChildReservedStock: 0n,
    committedStock: 0n,
    capturedCumulative: 0n,
    returnedToParentCumulative: 0n,
    state: "active",
    ...overrides,
  };
}

function childRevision(overrides: Partial<ChildAllocationRevision> = {}): ChildAllocationRevision {
  return {
    revision: 2n,
    allocationEpoch: 1n,
    creditCeiling: 50n,
    unassignedStock: 50n,
    activeChildReservedStock: 0n,
    committedStock: 0n,
    capturedCumulative: 0n,
    returnedToParentCumulative: 0n,
    state: "active",
    terminalReceiptDigest: null,
    parentAppliedRevision: null,
    ...overrides,
  };
}

function stockTotal(revisionValue: BudgetAllocationRevision): bigint {
  return revisionValue.unassignedStock + revisionValue.activeChildReservedStock
    + revisionValue.committedStock + revisionValue.capturedCumulative
    + revisionValue.returnedToParentCumulative;
}
