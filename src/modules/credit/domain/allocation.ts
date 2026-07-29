export type GrantAvailability = Readonly<{
  creditGrantId: string;
  availableAmount: bigint;
  expiresAt: string | null;
  burnPriority: number;
  issuedAt: string;
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
  if (requestedAmount <= 0n) throw new Error("CREDIT_RESERVATION_AMOUNT_INVALID");
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
  if (remaining !== 0n) throw new Error("CREDIT_INSUFFICIENT_AVAILABLE");
  return Object.freeze(plan);
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
    throw new Error("CREDIT_SEGMENT_ALLOCATION_REVISION_STALE");
  }
  if (segment.state !== "reserved") throw new Error("CREDIT_SEGMENT_NOT_COMMITTABLE");
  if (segment.maximumAmount <= 0n || segment.maximumAmount > allocation.unassignedStock) {
    throw new Error("CREDIT_SEGMENT_CAPACITY_EXCEEDED");
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
  if (segment.state !== "reserved") throw new Error("CREDIT_SEGMENT_NOT_RELEASABLE");
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
    throw new Error("CREDIT_SEGMENT_NOT_RECONCILABLE");
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
    throw new Error("CREDIT_ALLOCATION_CONSERVATION_VIOLATION");
  }
}

function validateGrant(grant: GrantAvailability): GrantAvailability {
  text(grant.creditGrantId, "CREDIT_GRANT_ID_INVALID");
  if (grant.availableAmount < 0n || !Number.isSafeInteger(grant.burnPriority)) {
    throw new Error("CREDIT_GRANT_AVAILABILITY_INVALID");
  }
  if (grant.expiresAt !== null) instant(grant.expiresAt);
  instant(grant.issuedAt);
  return grant;
}

function compareGrantBurnOrder(left: GrantAvailability, right: GrantAvailability): number {
  if (left.expiresAt === null && right.expiresAt !== null) return 1;
  if (left.expiresAt !== null && right.expiresAt === null) return -1;
  if (left.expiresAt !== right.expiresAt) return (left.expiresAt ?? "").localeCompare(right.expiresAt ?? "");
  if (left.burnPriority !== right.burnPriority) return left.burnPriority - right.burnPriority;
  if (left.issuedAt !== right.issuedAt) return left.issuedAt.localeCompare(right.issuedAt);
  return left.creditGrantId.localeCompare(right.creditGrantId);
}

function instant(value: string): string {
  if (!Number.isFinite(Date.parse(value))) throw new Error("CREDIT_INSTANT_INVALID");
  return value;
}

function text(value: string, code: string): string {
  if (value.length < 1 || value.length > 256) throw new Error(code);
  return value;
}
