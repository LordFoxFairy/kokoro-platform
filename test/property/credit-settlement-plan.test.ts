import { describe, expect, it } from "vitest";
import {
  planHoldCapture,
  planSettlementCorrection,
  type HoldAllocationAvailability,
} from "../../src/modules/credit/domain/settlement.js";

describe("Credit exact-source settlement planning", () => {
  it("captures in the frozen HoldAllocation ordinal without crossing Grant sources", () => {
    expect(planHoldCapture(allocations().map((allocation) => ({ ...allocation, netCustomerAmount: 0n })), 45n)).toEqual([
      { creditGrantId: "grant-a", amount: 30n, ordinal: 0 },
      { creditGrantId: "grant-b", amount: 15n, ordinal: 1 },
    ]);
  });

  it("fails closed instead of manufacturing capture outside the Hold", () => {
    expect(() => planHoldCapture(allocations().map((allocation) => ({ ...allocation, netCustomerAmount: 0n })), 61n))
      .toThrowError("CREDIT_SETTLEMENT_HOLD_CAPACITY_EXCEEDED");
  });

  it("appends a correction over the exact previously captured sources", () => {
    expect(planSettlementCorrection(allocations(), -20n)).toEqual([
      { creditGrantId: "grant-a", amount: 20n, ordinal: 0, direction: "decrease" },
    ]);
    expect(planSettlementCorrection(allocations(), 20n)).toEqual([
      { creditGrantId: "grant-b", amount: 20n, ordinal: 1, direction: "increase" },
    ]);
  });

  it("reverses the newest captured Grant first so original burn priority remains stable", () => {
    expect(planSettlementCorrection([
      { creditGrantId: "grant-a", ordinal: 0, allocatedAmount: 30n, netCustomerAmount: 30n },
      { creditGrantId: "grant-b", ordinal: 1, allocatedAmount: 30n, netCustomerAmount: 20n },
    ], -25n)).toEqual([
      { creditGrantId: "grant-b", amount: 20n, ordinal: 1, direction: "decrease" },
      { creditGrantId: "grant-a", amount: 5n, ordinal: 0, direction: "decrease" },
    ]);
  });
});

function allocations(): readonly HoldAllocationAvailability[] {
  return [
    { creditGrantId: "grant-a", ordinal: 0, allocatedAmount: 30n, netCustomerAmount: 30n },
    { creditGrantId: "grant-b", ordinal: 1, allocatedAmount: 30n, netCustomerAmount: 0n },
  ];
}
