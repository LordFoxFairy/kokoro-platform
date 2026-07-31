import { CreditService } from "../modules/credit/application/credit-service.js";
import type { RunBudgetAuthority } from
  "../modules/credit/application/contracts/run-budget-authority.js";
import { PostgresCreditAuthorityRepository } from
  "../modules/credit/infrastructure/postgres/credit-authority-repository.js";
import type { AgentMediaChildBudgetOwner } from
  "../modules/media/application/index.js";

/**
 * Composition-root bridge between Media's owner port and native Platform Credit.
 * It opens no transport and reuses the Media unit-of-work transaction.
 */
export class NativeMediaImageCreditOwner implements AgentMediaChildBudgetOwner {
  constructor(
    private readonly authority: Pick<RunBudgetAuthority, "deriveChildAllocation"> = new CreditService({
      repository: new PostgresCreditAuthorityRepository(),
    }),
  ) {}

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
    return Object.freeze({ childAllocationRef: value.childAllocationRef,
      allocationReservationReceiptRef: value.allocationReservationReceiptRef });
  }
}

function sameScope(
  left: Readonly<{ surfaceRef: string; capabilityKey: string; agentRef: string | null }>,
  right: Readonly<{ surfaceRef: string; capabilityKey: string; agentRef: string | null }>,
): boolean {
  return left.surfaceRef === right.surfaceRef && left.capabilityKey === right.capabilityKey &&
    left.agentRef === right.agentRef;
}
