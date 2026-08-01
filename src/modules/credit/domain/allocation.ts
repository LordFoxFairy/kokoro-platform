import { CreditDomainError, type CreditDomainErrorCode } from "./credit-domain-error.js";

export type GrantAvailability = Readonly<{
  creditGrantId: string;
  availableAmount: bigint;
  bucketClass: "daily" | "period" | "permanent";
  expiresAt: string | null;
  burnPriority: number;
  acquiredAt: string;
}>;

export type PlannedHoldAllocation = Readonly<{
  creditGrantId: string;
  amount: bigint;
  ordinal: number;
}>;

export type BudgetAllocationRevision = Readonly<{
  revision: bigint;
  allocationEpoch: bigint;
  creditCeiling: bigint;
  unassignedStock: bigint;
  activeChildReservedStock: bigint;
  committedStock: bigint;
  capturedCumulative: bigint;
  returnedToParentCumulative: bigint;
  state: "active" | "returning" | "terminal" | "reconciliation_required";
}>;

export type ChildAllocationRevision = BudgetAllocationRevision & Readonly<{
  terminalReceiptDigest: string | null;
  parentAppliedRevision: bigint | null;
}>;

export type MediaChildReturnReason =
  | "completed"
  | "canceled_before_effect"
  | "fenced_recovery"
  | "root_closing";

export type MediaChildOwnerOutcome = "completed" | "partial" | "failed" | "canceled";

export function deriveMediaChildReturnReason(input: Readonly<{
  rootState: "open" | "closing";
  ownerOutcome: MediaChildOwnerOutcome;
  capturedAmount: bigint;
}>): MediaChildReturnReason {
  if (input.capturedAmount < 0n) throw new CreditDomainError("CREDIT_CHILD_CAPTURED_AMOUNT_INVALID");
  if (input.rootState === "closing") return "root_closing";
  if (input.ownerOutcome === "completed") return "completed";
  if (input.ownerOutcome === "canceled" && input.capturedAmount === 0n) return "canceled_before_effect";
  return "fenced_recovery";
}

export type AuthorizationSegmentState = Readonly<{
  state: "reserved" | "committed" | "rating_pending" | "settled" | "released" | "expired" | "reconciliation_required";
  maximumAmount: bigint;
  allocationEpoch: bigint;
  preparedAgainstAllocationRevision: bigint;
  committedFromAllocationRevision: bigint | null;
  committedToAllocationRevision: bigint | null;
  aggregateVersion: bigint;
  fenceEpoch: bigint;
  resolutionKind: "not_dispatched" | "reservation_expiry" | "outcome_unknown" | "rated" | "reconciled" | null;
  resolutionRef: string | null;
  committedAt: string | null;
  settledAt: string | null;
  releasedAt: string | null;
}>;

export function planGrantReservation(
  grants: readonly GrantAvailability[],
  requestedAmount: bigint,
): readonly PlannedHoldAllocation[] {
  if (requestedAmount <= 0n) throw new CreditDomainError("CREDIT_RESERVATION_AMOUNT_INVALID");
  const ordered = [...grants].map(validateGrant).sort(compareGrantBurnOrder);
  const plan: PlannedHoldAllocation[] = [];
  let remaining = requestedAmount;
  for (const grant of ordered) {
    if (remaining === 0n) break;
    if (grant.availableAmount === 0n) continue;
    const amount = grant.availableAmount < remaining ? grant.availableAmount : remaining;
    plan.push(Object.freeze({ creditGrantId: grant.creditGrantId, amount, ordinal: plan.length }));
    remaining -= amount;
  }
  if (remaining !== 0n) throw new CreditDomainError("CREDIT_INSUFFICIENT_AVAILABLE");
  return Object.freeze(plan);
}

export function deriveChildAllocation(input: Readonly<{
  parent: BudgetAllocationRevision;
  expectedParentRevision: bigint;
  expectedParentAllocationEpoch: bigint;
  reservedSegmentStock: bigint;
  exactCeiling: bigint;
}>): Readonly<{
  parent: BudgetAllocationRevision;
  child: ChildAllocationRevision;
}> {
  const parent = rehydrateBudgetAllocationRevision(input.parent);
  if (parent.revision !== input.expectedParentRevision) {
    throw new CreditDomainError("CREDIT_CHILD_PARENT_REVISION_STALE");
  }
  if (parent.allocationEpoch !== input.expectedParentAllocationEpoch) {
    throw new CreditDomainError("CREDIT_CHILD_PARENT_EPOCH_STALE");
  }
  if (parent.state !== "active") throw new CreditDomainError("CREDIT_CHILD_PARENT_NOT_ACTIVE");
  if (input.reservedSegmentStock < 0n || input.reservedSegmentStock > parent.unassignedStock) {
    throw new CreditDomainError("CREDIT_CHILD_RESERVED_SEGMENT_STOCK_INVALID");
  }
  if (input.exactCeiling <= 0n ||
      input.exactCeiling > parent.unassignedStock - input.reservedSegmentStock) {
    throw new CreditDomainError("CREDIT_CHILD_ALLOCATION_CAPACITY_EXCEEDED");
  }
  const nextParent = rehydrateBudgetAllocationRevision(Object.freeze({
    ...parent,
    revision: parent.revision + 1n,
    unassignedStock: parent.unassignedStock - input.exactCeiling,
    activeChildReservedStock: parent.activeChildReservedStock + input.exactCeiling,
  }));
  const child = rehydrateChildAllocationRevision(Object.freeze({
    revision: 1n,
    allocationEpoch: 1n,
    creditCeiling: input.exactCeiling,
    unassignedStock: input.exactCeiling,
    activeChildReservedStock: 0n,
    committedStock: 0n,
    capturedCumulative: 0n,
    returnedToParentCumulative: 0n,
    state: "active" as const,
    terminalReceiptDigest: null,
    parentAppliedRevision: null,
  }));
  return Object.freeze({ parent: nextParent, child });
}

export function returnChildAllocation(input: Readonly<{
  parent: BudgetAllocationRevision;
  child: ChildAllocationRevision;
  expectedParentRevision: bigint;
  expectedParentAllocationEpoch: bigint;
  expectedChildRevision: bigint;
  expectedChildAllocationEpoch: bigint;
  receiptDigest: string;
}>): Readonly<{
  parent: BudgetAllocationRevision;
  child: ChildAllocationRevision;
}> {
  const parent = rehydrateBudgetAllocationRevision(input.parent);
  const child = rehydrateChildAllocationRevision(input.child);
  if (parent.revision !== input.expectedParentRevision) {
    throw new CreditDomainError("CREDIT_CHILD_PARENT_REVISION_STALE");
  }
  if (parent.allocationEpoch !== input.expectedParentAllocationEpoch) {
    throw new CreditDomainError("CREDIT_CHILD_PARENT_EPOCH_STALE");
  }
  if (child.revision !== input.expectedChildRevision) {
    throw new CreditDomainError("CREDIT_CHILD_REVISION_STALE");
  }
  if (child.allocationEpoch !== input.expectedChildAllocationEpoch) {
    throw new CreditDomainError("CREDIT_CHILD_EPOCH_STALE");
  }
  if (parent.state !== "active" && parent.state !== "returning") {
    throw new CreditDomainError("CREDIT_CHILD_PARENT_NOT_RETURNABLE");
  }
  if (child.state === "reconciliation_required") {
    throw new CreditDomainError("CREDIT_CHILD_RECONCILIATION_REQUIRED");
  }
  if (child.state === "terminal") throw new CreditDomainError("CREDIT_CHILD_ALREADY_TERMINAL");
  if (child.state !== "active" && child.state !== "returning") {
    throw new CreditDomainError("CREDIT_CHILD_NOT_RETURNABLE");
  }
  if (child.activeChildReservedStock !== 0n) throw new CreditDomainError("CREDIT_CHILD_DESCENDANT_PENDING");
  if (child.committedStock !== 0n) throw new CreditDomainError("CREDIT_CHILD_COMMITTED_STOCK_PENDING");
  if (child.returnedToParentCumulative !== 0n) throw new CreditDomainError("CREDIT_CHILD_PARTIAL_RETURN_INVALID");
  if (parent.activeChildReservedStock < child.creditCeiling) {
    throw new CreditDomainError("CREDIT_CHILD_PARENT_STOCK_INVALID");
  }
  if (!DIGEST.test(input.receiptDigest)) throw new CreditDomainError("CREDIT_CHILD_RECEIPT_DIGEST_INVALID");
  const parentRevision = parent.revision + 1n;
  const nextParent = rehydrateBudgetAllocationRevision(Object.freeze({
    ...parent,
    revision: parentRevision,
    unassignedStock: parent.unassignedStock + child.unassignedStock,
    activeChildReservedStock: parent.activeChildReservedStock - child.creditCeiling,
    capturedCumulative: parent.capturedCumulative + child.capturedCumulative,
  }));
  const nextChild = rehydrateChildAllocationRevision(Object.freeze({
    ...child,
    revision: child.revision + 1n,
    allocationEpoch: child.allocationEpoch + 1n,
    unassignedStock: 0n,
    returnedToParentCumulative: child.returnedToParentCumulative + child.unassignedStock,
    state: "terminal" as const,
    terminalReceiptDigest: input.receiptDigest,
    parentAppliedRevision: parentRevision,
  }));
  return Object.freeze({ parent: nextParent, child: nextChild });
}

export function rehydrateBudgetAllocationRevision(
  input: BudgetAllocationRevision,
): BudgetAllocationRevision {
  if (input.revision <= 0n || input.revision > POSTGRES_INT8_MAX ||
      input.allocationEpoch <= 0n || input.allocationEpoch > POSTGRES_INT8_MAX ||
      !ALLOCATION_STATES.has(input.state)) {
    throw new CreditDomainError("CREDIT_ALLOCATION_REVISION_INVALID");
  }
  assertConserved(input);
  return Object.freeze({ ...input });
}

export function rehydrateChildAllocationRevision(
  input: ChildAllocationRevision,
): ChildAllocationRevision {
  rehydrateBudgetAllocationRevision(input);
  if (input.state === "terminal") {
    if (!DIGEST.test(input.terminalReceiptDigest ?? "") || input.parentAppliedRevision === null ||
        input.parentAppliedRevision <= 0n || input.parentAppliedRevision > POSTGRES_INT8_MAX ||
        input.unassignedStock !== 0n ||
        input.activeChildReservedStock !== 0n || input.committedStock !== 0n) {
      throw new CreditDomainError("CREDIT_CHILD_TERMINAL_REVISION_INVALID");
    }
  } else if (input.terminalReceiptDigest !== null || input.parentAppliedRevision !== null) {
    throw new CreditDomainError("CREDIT_CHILD_TERMINAL_REVISION_INVALID");
  }
  return Object.freeze({ ...input });
}

export function commitAuthorizationSegment(input: Readonly<{
  allocation: BudgetAllocationRevision;
  segment: AuthorizationSegmentState;
  committedAt?: string;
}>): Readonly<{ allocation: BudgetAllocationRevision; segment: AuthorizationSegmentState }> {
  const { allocation, segment } = input;
  assertConserved(allocation);
  if (segment.preparedAgainstAllocationRevision !== allocation.revision ||
      segment.allocationEpoch !== allocation.allocationEpoch) {
    throw new CreditDomainError("CREDIT_SEGMENT_ALLOCATION_REVISION_STALE");
  }
  if (segment.state !== "reserved") throw new CreditDomainError("CREDIT_SEGMENT_NOT_COMMITTABLE");
  if (segment.maximumAmount <= 0n || segment.maximumAmount > allocation.unassignedStock) {
    throw new CreditDomainError("CREDIT_SEGMENT_CAPACITY_EXCEEDED");
  }
  const nextRevision = allocation.revision + 1n;
  const nextAllocation = Object.freeze({
    ...allocation,
    revision: nextRevision,
    unassignedStock: allocation.unassignedStock - segment.maximumAmount,
    committedStock: allocation.committedStock + segment.maximumAmount,
  });
  const nextSegment = Object.freeze({
    ...segment,
    state: "committed" as const,
    committedFromAllocationRevision: allocation.revision,
    committedToAllocationRevision: nextRevision,
    aggregateVersion: segment.aggregateVersion + 1n,
    fenceEpoch: segment.fenceEpoch + 1n,
    committedAt: instant(input.committedAt ?? "1970-01-01T00:00:00.000Z"),
  });
  assertConserved(nextAllocation);
  return Object.freeze({ allocation: nextAllocation, segment: nextSegment });
}

export function releaseReservedAuthorizationSegment(
  segment: AuthorizationSegmentState,
  releasedAt: string,
  evidenceRef = `no-dispatch:${releasedAt}`,
): AuthorizationSegmentState {
  if (segment.state !== "reserved") throw new CreditDomainError("CREDIT_SEGMENT_NOT_RELEASABLE");
  return Object.freeze({
    ...segment,
    state: "released" as const,
    resolutionKind: "not_dispatched" as const,
    resolutionRef: text(evidenceRef, "CREDIT_SEGMENT_RELEASE_EVIDENCE_INVALID"),
    aggregateVersion: segment.aggregateVersion + 1n,
    fenceEpoch: segment.fenceEpoch + 1n,
    releasedAt: instant(releasedAt),
  });
}

export function reconcileUnknownAuthorizationSegment(
  segment: AuthorizationSegmentState,
  evidenceRef: string,
  _observedAt: string,
): AuthorizationSegmentState {
  if (segment.state !== "committed" && segment.state !== "rating_pending") {
    throw new CreditDomainError("CREDIT_SEGMENT_NOT_RECONCILABLE");
  }
  return Object.freeze({
    ...segment,
    state: "reconciliation_required" as const,
    resolutionKind: "outcome_unknown" as const,
    resolutionRef: text(evidenceRef, "CREDIT_SEGMENT_RECONCILIATION_EVIDENCE_INVALID"),
    aggregateVersion: segment.aggregateVersion + 1n,
    fenceEpoch: segment.fenceEpoch + 1n,
  });
}

export function markAuthorizationSegmentRatingPending(
  segment: AuthorizationSegmentState,
  closureRef: string,
): AuthorizationSegmentState {
  if (segment.state !== "committed") throw new CreditDomainError("CREDIT_SEGMENT_NOT_RATABLE");
  text(closureRef, "CREDIT_USAGE_CLOSURE_REFERENCE_INVALID");
  return Object.freeze({
    ...segment,
    state: "rating_pending" as const,
    aggregateVersion: segment.aggregateVersion + 1n,
    fenceEpoch: segment.fenceEpoch + 1n,
  });
}

export function settleAuthorizationSegment(input: Readonly<{
  allocation: BudgetAllocationRevision;
  segment: AuthorizationSegmentState;
  ratedAmount: bigint;
  settlementRef: string;
  settledAt: string;
}>): Readonly<{ allocation: BudgetAllocationRevision; segment: AuthorizationSegmentState }> {
  const { allocation, segment } = input;
  assertConserved(allocation);
  if (segment.state !== "rating_pending" && segment.state !== "reconciliation_required") {
    throw new CreditDomainError("CREDIT_SEGMENT_NOT_SETTLEABLE");
  }
  if (segment.allocationEpoch !== allocation.allocationEpoch) {
    throw new CreditDomainError("CREDIT_SEGMENT_ALLOCATION_EPOCH_STALE");
  }
  if (input.ratedAmount < 0n || input.ratedAmount > segment.maximumAmount) {
    throw new CreditDomainError("CREDIT_SETTLEMENT_AMOUNT_EXCEEDS_SEGMENT");
  }
  if (segment.maximumAmount > allocation.committedStock) {
    throw new CreditDomainError("CREDIT_SETTLEMENT_COMMITTED_STOCK_INVALID");
  }
  const nextAllocation = Object.freeze({
    ...allocation,
    revision: allocation.revision + 1n,
    unassignedStock: allocation.unassignedStock + segment.maximumAmount - input.ratedAmount,
    committedStock: allocation.committedStock - segment.maximumAmount,
    capturedCumulative: allocation.capturedCumulative + input.ratedAmount,
  });
  const nextSegment = Object.freeze({
    ...segment,
    state: "settled" as const,
    resolutionKind: segment.state === "reconciliation_required" ? "reconciled" as const : "rated" as const,
    resolutionRef: text(input.settlementRef, "CREDIT_SETTLEMENT_REFERENCE_INVALID"),
    aggregateVersion: segment.aggregateVersion + 1n,
    fenceEpoch: segment.fenceEpoch + 1n,
    settledAt: instant(input.settledAt),
  });
  assertConserved(nextAllocation);
  return Object.freeze({ allocation: nextAllocation, segment: nextSegment });
}

export function correctSettledAuthorizationSegmentAllocation(
  allocation: BudgetAllocationRevision,
  customerAmountDelta: bigint,
): BudgetAllocationRevision {
  assertConserved(allocation);
  if (allocation.state !== "active" && allocation.state !== "reconciliation_required") {
    throw new CreditDomainError("CREDIT_SETTLEMENT_CORRECTION_ALLOCATION_NOT_OPEN");
  }
  if (customerAmountDelta > allocation.unassignedStock ||
      -customerAmountDelta > allocation.capturedCumulative) {
    throw new CreditDomainError("CREDIT_SETTLEMENT_CORRECTION_CAPACITY_INVALID");
  }
  const next = Object.freeze({
    ...allocation,
    revision: allocation.revision + 1n,
    unassignedStock: allocation.unassignedStock - customerAmountDelta,
    capturedCumulative: allocation.capturedCumulative + customerAmountDelta,
  });
  assertConserved(next);
  return next;
}

export function assertConserved(revision: BudgetAllocationRevision): void {
  const terms = [
    revision.creditCeiling,
    revision.unassignedStock,
    revision.activeChildReservedStock,
    revision.committedStock,
    revision.capturedCumulative,
    revision.returnedToParentCumulative,
  ];
  if (terms.some((term) => term < 0n) || revision.creditCeiling !==
    revision.unassignedStock + revision.activeChildReservedStock + revision.committedStock +
      revision.capturedCumulative + revision.returnedToParentCumulative) {
    throw new CreditDomainError("CREDIT_ALLOCATION_CONSERVATION_VIOLATION");
  }
}

function validateGrant(grant: GrantAvailability): GrantAvailability {
  text(grant.creditGrantId, "CREDIT_GRANT_ID_INVALID");
  if (grant.availableAmount < 0n || !Number.isSafeInteger(grant.burnPriority)) {
    throw new CreditDomainError("CREDIT_GRANT_AVAILABILITY_INVALID");
  }
  if (!(grant.bucketClass in BUCKET_RANK)) {
    throw new CreditDomainError("CREDIT_GRANT_AVAILABILITY_INVALID");
  }
  if (grant.expiresAt !== null) instant(grant.expiresAt);
  instant(grant.acquiredAt);
  return grant;
}

function compareGrantBurnOrder(left: GrantAvailability, right: GrantAvailability): number {
  const bucket = BUCKET_RANK[left.bucketClass] - BUCKET_RANK[right.bucketClass];
  if (bucket !== 0) return bucket;
  if (left.expiresAt === null && right.expiresAt !== null) return 1;
  if (left.expiresAt !== null && right.expiresAt === null) return -1;
  if (left.expiresAt !== right.expiresAt) return compareCodeUnits(left.expiresAt ?? "", right.expiresAt ?? "");
  if (left.burnPriority !== right.burnPriority) return left.burnPriority - right.burnPriority;
  if (left.acquiredAt !== right.acquiredAt) return compareCodeUnits(left.acquiredAt, right.acquiredAt);
  return compareCodeUnits(left.creditGrantId, right.creditGrantId);
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function instant(value: string): string {
  if (!Number.isFinite(Date.parse(value))) throw new CreditDomainError("CREDIT_INSTANT_INVALID");
  return value;
}

function text(value: string, code: CreditDomainErrorCode): string {
  if (value.length < 1 || value.length > 256 || hasMalformedUtf16(value)) throw new CreditDomainError(code);
  return value;
}

function hasMalformedUtf16(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) return true;
  }
  return false;
}

const ALLOCATION_STATES = new Set<string>([
  "active",
  "returning",
  "terminal",
  "reconciliation_required",
]);
const BUCKET_RANK = Object.freeze({ daily: 0, period: 1, permanent: 2 } as const);
const DIGEST = /^[a-f0-9]{64}$/u;
const POSTGRES_INT8_MAX = 9_223_372_036_854_775_807n;
