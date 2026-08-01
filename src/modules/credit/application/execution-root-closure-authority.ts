import { rehydrateBudgetAllocationRevision, type BudgetAllocationRevision } from "../domain/allocation.js";
import { planHoldRelease } from "../domain/settlement.js";
import type { HoldAllocationAvailability } from "../domain/settlement.js";

export type ExecutionRootClosureCode =
  | "ROOT_NOT_OPEN"
  | "SOURCE_AUTHORITY_MISMATCH"
  | "CHILD_PENDING"
  | "SEGMENT_PENDING"
  | "ATTEMPT_PENDING"
  | "FENCE_EXHAUSTED"
  | "RATING_MISMATCH"
  | "HOLD_SOURCE_MISMATCH";

export type ExecutionRootClosureBudget = Readonly<{
  executionBudgetRootRef: string;
  executionManifestRef: string;
  rootHoldRef: string;
  rootAllocationRef: string;
  rootAllocationRevision: bigint;
  rootAllocationEpoch: bigint;
  authorizationSegmentRef: string;
  authorizationSegmentVersion: bigint;
  reservedCeiling: bigint;
  unit: string;
}>;

export type ExecutionRootSettlement = Readonly<{
  settlementRef: string;
  authorizationSegmentRef: string;
  closureRef: string;
  closureRevision: bigint;
  state: "settled";
  customerAmount: bigint;
  platformExposureAmount: bigint;
}>;

export type ExecutionRootClosureCommand = Readonly<{
  siteId: string;
  sourceRef: string;
  budget: ExecutionRootClosureBudget;
  settlement: ExecutionRootSettlement;
}>;

export type StoredExecutionRootClosure = Readonly<{
  siteId: string;
  sourceRef: string;
  executionBudgetRootRef: string;
  rootState: "open" | "closing" | "settled" | "reconciliation_required";
  rootVersion: bigint;
  creditHoldRef: string;
  holdState: "open" | "closing" | "settled" | "released" | "expired" | "reconciliation_required";
  holdFenceEpoch: bigint;
  holdReservedAmount: bigint;
  holdCapturedAmount: bigint;
  holdReleasedAmount: bigint;
  rootAllocationRef: string;
  sourceBudget: Omit<ExecutionRootClosureBudget,
    "executionBudgetRootRef" | "rootHoldRef" | "rootAllocationRef" | "authorizationSegmentRef">;
  allocation: BudgetAllocationRevision;
  openChildCount: bigint;
  openSegmentCount: bigint;
  openAttemptCount: bigint;
  settlement: Readonly<{
    settlementRef: string;
    authorizationSegmentRef: string;
    executionBudgetRootRef: string;
    budgetAllocationRef: string;
    creditHoldRef: string;
    unit: string;
    customerAmount: bigint;
    closureRef: string;
    closureRevision: bigint;
    platformExposureAmount: bigint;
  }>;
  holdAllocations: readonly HoldAllocationAvailability[];
}>;

export type ExecutionRootClosurePlan = Readonly<{
  allocation: BudgetAllocationRevision;
  rootState: "settled";
  rootVersion: bigint;
  holdState: "settled" | "released";
  holdFenceEpoch: bigint;
  capturedAmount: bigint;
  releasedAmount: bigint;
  releases: readonly Readonly<{ creditGrantId: string; ordinal: number; amount: bigint }>[];
}>;

export type ExecutionRootClosureDecision =
  | Readonly<{ kind: "ready"; value: ExecutionRootClosurePlan }>
  | Readonly<{ kind: "invalid_state"; code: ExecutionRootClosureCode }>
  | Readonly<{ kind: "reconciliation_required"; code: ExecutionRootClosureCode }>;

/**
 * Sole source-neutral Credit policy for terminalizing an execution root. Source adapters prove
 * their terminal fact and persist this plan; they never reimplement conservation or release rules.
 */
export class ExecutionRootClosureAuthority {
  decide(current: StoredExecutionRootClosure, command: ExecutionRootClosureCommand): ExecutionRootClosureDecision {
    if (current.rootState !== "open" || current.holdState !== "open" || current.allocation.state !== "active") {
      return Object.freeze({ kind: "invalid_state", code: "ROOT_NOT_OPEN" });
    }
    if (!sameAuthority(current, command)) {
      return Object.freeze({ kind: "reconciliation_required", code: "SOURCE_AUTHORITY_MISMATCH" });
    }
    if (current.openChildCount !== 0n || current.allocation.activeChildReservedStock !== 0n) {
      return Object.freeze({ kind: "invalid_state", code: "CHILD_PENDING" });
    }
    if (current.openSegmentCount !== 0n || current.allocation.committedStock !== 0n) {
      return Object.freeze({ kind: "invalid_state", code: "SEGMENT_PENDING" });
    }
    if (current.openAttemptCount !== 0n) {
      return Object.freeze({ kind: "invalid_state", code: "ATTEMPT_PENDING" });
    }
    if (current.rootVersion === POSTGRES_INT8_MAX || current.holdFenceEpoch === POSTGRES_INT8_MAX ||
        current.allocation.revision === POSTGRES_INT8_MAX ||
        current.allocation.allocationEpoch === POSTGRES_INT8_MAX) {
      return Object.freeze({ kind: "invalid_state", code: "FENCE_EXHAUSTED" });
    }

    const capturedAmount = current.allocation.capturedCumulative;
    const releasedAmount = current.allocation.unassignedStock;
    if (capturedAmount !== command.settlement.customerAmount ||
        capturedAmount !== current.settlement.customerAmount ||
        capturedAmount !== current.holdCapturedAmount ||
        capturedAmount + releasedAmount !== command.budget.reservedCeiling ||
        current.holdCapturedAmount + current.holdReleasedAmount + releasedAmount !==
          current.holdReservedAmount) {
      return Object.freeze({ kind: "reconciliation_required", code: "RATING_MISMATCH" });
    }

    const allocated = current.holdAllocations.reduce((total, source) => total + source.allocatedAmount, 0n);
    const captured = current.holdAllocations.reduce((total, source) => total + source.netCustomerAmount, 0n);
    if (allocated !== current.holdReservedAmount || captured !== capturedAmount) {
      return Object.freeze({ kind: "reconciliation_required", code: "HOLD_SOURCE_MISMATCH" });
    }
    let releases: readonly Readonly<{ creditGrantId: string; ordinal: number; amount: bigint }>[];
    try {
      releases = planHoldRelease(current.holdAllocations, releasedAmount);
    } catch {
      return Object.freeze({ kind: "reconciliation_required", code: "HOLD_SOURCE_MISMATCH" });
    }
    if (releases.reduce((total, release) => total + release.amount, 0n) !== releasedAmount) {
      return Object.freeze({ kind: "reconciliation_required", code: "HOLD_SOURCE_MISMATCH" });
    }

    const allocation = rehydrateBudgetAllocationRevision(Object.freeze({
      ...current.allocation,
      revision: current.allocation.revision + 1n,
      allocationEpoch: current.allocation.allocationEpoch + 1n,
      unassignedStock: 0n,
      returnedToParentCumulative: current.allocation.returnedToParentCumulative + releasedAmount,
      state: "terminal" as const,
    }));
    return Object.freeze({ kind: "ready", value: Object.freeze({
      allocation,
      rootState: "settled" as const,
      rootVersion: current.rootVersion + 1n,
      holdState: capturedAmount === 0n ? "released" as const : "settled" as const,
      holdFenceEpoch: current.holdFenceEpoch + 1n,
      capturedAmount,
      releasedAmount,
      releases: Object.freeze([...releases]),
    }) });
  }
}

function sameAuthority(current: StoredExecutionRootClosure, command: ExecutionRootClosureCommand): boolean {
  const budget = command.budget;
  const settlement = current.settlement;
  const sourceBudget = current.sourceBudget;
  return current.siteId === command.siteId && current.sourceRef === command.sourceRef &&
    current.executionBudgetRootRef === budget.executionBudgetRootRef &&
    current.creditHoldRef === budget.rootHoldRef && current.rootAllocationRef === budget.rootAllocationRef &&
    current.allocation.creditCeiling === budget.reservedCeiling &&
    current.holdReservedAmount === budget.reservedCeiling &&
    sourceBudget.executionManifestRef === budget.executionManifestRef &&
    sourceBudget.rootAllocationRevision === budget.rootAllocationRevision &&
    sourceBudget.rootAllocationEpoch === budget.rootAllocationEpoch &&
    sourceBudget.authorizationSegmentVersion === budget.authorizationSegmentVersion &&
    sourceBudget.reservedCeiling === budget.reservedCeiling && sourceBudget.unit === budget.unit &&
    settlement.settlementRef === command.settlement.settlementRef &&
    settlement.authorizationSegmentRef === budget.authorizationSegmentRef &&
    settlement.executionBudgetRootRef === budget.executionBudgetRootRef &&
    settlement.budgetAllocationRef === budget.rootAllocationRef && settlement.creditHoldRef === budget.rootHoldRef &&
    settlement.unit === budget.unit && settlement.closureRef === command.settlement.closureRef &&
    settlement.closureRevision === command.settlement.closureRevision &&
    settlement.customerAmount === command.settlement.customerAmount &&
    settlement.platformExposureAmount === command.settlement.platformExposureAmount;
}

const POSTGRES_INT8_MAX = 9_223_372_036_854_775_807n;
