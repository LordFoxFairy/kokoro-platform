import { createHash } from "node:crypto";
import { CreditService } from "../modules/credit/application/credit-service.js";
import type { RunBudgetAuthority } from
  "../modules/credit/application/contracts/run-budget-authority.js";
import { PostgresCreditAuthorityRepository } from
  "../modules/credit/infrastructure/postgres/credit-authority-repository.js";
import type { AgentMediaChildBudgetOwner, DirectStudioRootBudgetOwner } from
  "../modules/media/application/index.js";

/**
 * Composition-root bridge between Media's owner port and native Platform Credit.
 * It opens no transport and reuses the Media unit-of-work transaction.
 */
export class NativeMediaImageCreditOwner implements AgentMediaChildBudgetOwner, DirectStudioRootBudgetOwner {
  constructor(
    private readonly authority: Pick<RunBudgetAuthority,
      "reserveRootBudget" | "finalizeAuthorizationSegment" | "deriveChildAllocation"> = new CreditService({
      repository: new PostgresCreditAuthorityRepository(),
    }),
  ) {}

  async reserveDirectRoot(
    transaction: Parameters<DirectStudioRootBudgetOwner["reserveDirectRoot"]>[0],
    input: Parameters<DirectStudioRootBudgetOwner["reserveDirectRoot"]>[1],
  ): ReturnType<DirectStudioRootBudgetOwner["reserveDirectRoot"]> {
    const source = input.budgetSource;
    const reserved = await this.authority.reserveRootBudget(transaction, {
      siteId: input.ownerBinding.siteRef,
      billingAccountId: source.billingAccountRef,
      creditAccountId: source.creditAccountRef,
      unit: source.unit,
      liabilityMerchantAccountId: source.liabilityMerchantAccountRef,
      executionRootId: input.mediaOperationRef,
      authorizationBudgetRef: source.authorizationBudgetRef,
      ratingPolicyRevisionRef: source.ratingPolicyRevisionRef,
      executionManifestRef: source.executionManifestRef,
      consumptionScope: input.consumptionScope,
      businessOperationKey: input.commandRef,
      requestDigest: input.ownerRequestDigest,
      rootCeiling: input.exactCeiling,
      segmentMaximum: input.exactCeiling,
      expiresAt: input.expiresAt,
    });
    if (reserved.kind !== "accepted" && reserved.kind !== "replayed") {
      throw new Error(`MEDIA_CREDIT_ROOT_RESERVE_${reserved.kind.toUpperCase()}`);
    }
    const root = reserved.value;
    if (root.state !== "reserved" || root.segmentVersion !== 1n ||
        root.rootAllocationRevision !== 1n || root.rootAllocationEpoch !== 1n ||
        root.expiresAt !== input.expiresAt) {
      throw new Error("MEDIA_CREDIT_ROOT_RECEIPT_INVALID");
    }
    const committed = await this.authority.finalizeAuthorizationSegment(transaction, {
      siteId: input.ownerBinding.siteRef,
      authorizationSegmentRef: root.authorizationSegmentRef,
      executionManifestRef: source.executionManifestRef,
      expectedSegmentVersion: root.segmentVersion,
      businessOperationKey: rootCommitOperationKey(input.commandRef, root.authorizationSegmentRef),
      requestDigest: rootCommitRequestDigest(input.ownerRequestDigest, root.authorizationSegmentRef,
        source.executionManifestRef),
    });
    if (committed.kind !== "accepted" && committed.kind !== "replayed") {
      throw new Error(`MEDIA_CREDIT_ROOT_FINALIZE_${committed.kind.toUpperCase()}`);
    }
    if (committed.value.state !== "committed" ||
        committed.value.authorizationSegmentRef !== root.authorizationSegmentRef ||
        committed.value.segmentVersion !== root.segmentVersion + 1n) {
      throw new Error("MEDIA_CREDIT_ROOT_FINALIZE_RECEIPT_INVALID");
    }
    return Object.freeze({
      executionBudgetRootRef: root.executionBudgetRootRef,
      rootHoldRef: root.creditHoldRef,
      rootAllocationRef: root.rootAllocationRef,
      rootAllocationRevision: root.rootAllocationRevision,
      rootAllocationEpoch: root.rootAllocationEpoch,
      authorizationSegmentRef: root.authorizationSegmentRef,
      authorizationSegmentVersion: committed.value.segmentVersion,
    });
  }

  async deriveChild(
    transaction: Parameters<AgentMediaChildBudgetOwner["deriveChild"]>[0],
    input: Parameters<AgentMediaChildBudgetOwner["deriveChild"]>[1],
  ): ReturnType<AgentMediaChildBudgetOwner["deriveChild"]> {
    const outcome = await this.authority.deriveChildAllocation(transaction, {
      siteId: input.ownerBinding.siteRef,
      executionBudgetRootRef: input.executionBudgetRootRef,
      parentAllocationRef: input.parentAllocationRef,
      expectedParentRevision: input.expectedParentRevision,
      expectedParentAllocationEpoch: input.expectedParentAllocationEpoch,
      mediaOperationRef: input.mediaOperationRef,
      businessOperationKey: input.commandRef,
      requestDigest: input.ownerRequestDigest,
      exactCeiling: input.exactCeiling,
      executionManifestRef: input.executionManifestRef,
      audience: "media",
      purpose: "media_operation",
      consumptionScope: input.consumptionScope,
      expiresAt: input.expiresAt,
    });
    if (outcome.kind !== "accepted" && outcome.kind !== "replayed") {
      throw new Error(`MEDIA_CREDIT_CHILD_${outcome.kind.toUpperCase()}`);
    }
    const value = outcome.value;
    if (value.executionBudgetRootRef !== input.executionBudgetRootRef ||
        value.parentAllocationRef !== input.parentAllocationRef ||
        value.mediaOperationRef !== input.mediaOperationRef ||
        value.parentRevisionBefore !== input.expectedParentRevision ||
        value.parentRevisionAfter !== input.expectedParentRevision + 1n ||
        value.parentAllocationEpoch !== input.expectedParentAllocationEpoch ||
        value.childRevisionBefore !== 0n || value.childRevisionAfter !== 1n ||
        value.childAllocationEpoch !== 1n || value.state !== "active" ||
        value.reservedCeiling !== input.exactCeiling || value.audience !== "media" ||
        value.purpose !== "media_operation" || value.expiresAt !== input.expiresAt ||
        !sameScope(value.consumptionScope, input.consumptionScope)) {
      throw new Error("MEDIA_CREDIT_CHILD_RECEIPT_INVALID");
    }
    const committed = await this.authority.finalizeAuthorizationSegment(transaction, {
      siteId: input.ownerBinding.siteRef,
      authorizationSegmentRef: value.childAuthorizationSegmentRef,
      executionManifestRef: input.executionManifestRef,
      expectedSegmentVersion: value.childAuthorizationSegmentVersion,
      businessOperationKey: childCommitOperationKey(input.commandRef, value.childAuthorizationSegmentRef),
      requestDigest: childCommitRequestDigest(input.ownerRequestDigest,
        value.childAuthorizationSegmentRef, input.executionManifestRef),
    });
    if (committed.kind !== "accepted" && committed.kind !== "replayed") {
      throw new Error(`MEDIA_CREDIT_CHILD_FINALIZE_${committed.kind.toUpperCase()}`);
    }
    if (committed.value.state !== "committed" ||
        committed.value.authorizationSegmentRef !== value.childAuthorizationSegmentRef ||
        committed.value.segmentVersion !== value.childAuthorizationSegmentVersion + 1n) {
      throw new Error("MEDIA_CREDIT_CHILD_FINALIZE_RECEIPT_INVALID");
    }
    return Object.freeze({ childAllocationRef: value.childAllocationRef,
      allocationReservationReceiptRef: value.allocationReservationReceiptRef,
      authorizationSegmentRef: value.childAuthorizationSegmentRef,
      authorizationSegmentVersion: committed.value.segmentVersion });
  }
}

function rootCommitOperationKey(commandRef: string, authorizationSegmentRef: string): string {
  return `media-root-segment:${createHash("sha256")
    .update("kokoro.platform.media.direct-root-segment-operation.v1\0")
    .update(commandRef)
    .update("\0")
    .update(authorizationSegmentRef)
    .digest("hex")}`;
}

function childCommitOperationKey(commandRef: string, authorizationSegmentRef: string): string {
  return `media-child-segment:${createHash("sha256")
    .update("kokoro.platform.media.child-segment-operation.v1\0")
    .update(commandRef).update("\0").update(authorizationSegmentRef).digest("hex")}`;
}

function childCommitRequestDigest(
  ownerRequestDigest: string,
  authorizationSegmentRef: string,
  executionManifestRef: string,
): string {
  return createHash("sha256")
    .update("kokoro.platform.media.child-segment-request.v1\0")
    .update(ownerRequestDigest).update("\0").update(authorizationSegmentRef)
    .update("\0").update(executionManifestRef).digest("hex");
}

function rootCommitRequestDigest(
  ownerRequestDigest: string,
  authorizationSegmentRef: string,
  executionManifestRef: string,
): string {
  return createHash("sha256")
    .update("kokoro.platform.media.direct-root-segment-request.v1\0")
    .update(ownerRequestDigest)
    .update("\0")
    .update(authorizationSegmentRef)
    .update("\0")
    .update(executionManifestRef)
    .digest("hex");
}

function sameScope(
  left: Readonly<{ surfaceRef: string; capabilityKey: string; agentRef: string | null }>,
  right: Readonly<{ surfaceRef: string; capabilityKey: string; agentRef: string | null }>,
): boolean {
  return left.surfaceRef === right.surfaceRef && left.capabilityKey === right.capabilityKey &&
    left.agentRef === right.agentRef;
}
