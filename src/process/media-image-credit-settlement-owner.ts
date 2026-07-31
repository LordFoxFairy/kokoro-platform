import { createHash } from "node:crypto";
import type { CreditMediaBudgetFinalizationService, CreditMediaTypedUsageFact } from
  "../modules/credit/application/media-budget-finalization-service.js";
import type { MediaImageCreditSettlementPort } from "../modules/media/application/index.js";
import type { PostgresMediaImageTypedUsageFactOwner } from
  "../modules/media/infrastructure/postgres/media-image-typed-usage-owner.js";
import type { ImageEffectUsageFact } from "../modules/model-gateway/domain/image-effect.js";
import type { PlatformTransaction } from "../shared/unit-of-work/index.js";

export interface CreditMediaFinalizationTransactionHost {
  execute<Result>(fence: Readonly<{
    siteId: string;
    operation: "credit.media-image.finalize";
  }>, work: (transaction: PlatformTransaction) => Promise<Result>): Promise<Result>;
}

export interface MediaImageCreditLeaseAuthority {
  assertOwned(input: Readonly<{ taskRef: string; operationRef: string; leaseEpoch: bigint;
    leaseTokenHash: string }>): Promise<void>;
}

/**
 * Media-to-Credit adapter. The function-only worker identity first resolves the
 * exact immutable Model Gateway fact under its live task lease. Only then is the
 * fact handed to the Credit-owned transaction and rating/closure authority.
 */
export class NativeMediaImageCreditSettlementOwner implements MediaImageCreditSettlementPort {
  constructor(private readonly dependencies: Readonly<{
    typedUsage: Pick<PostgresMediaImageTypedUsageFactOwner, "loadCertified">;
    leaseAuthority: MediaImageCreditLeaseAuthority;
    finalizer: Pick<CreditMediaBudgetFinalizationService, "finalize">;
    transactionHost: CreditMediaFinalizationTransactionHost;
  }>) {}

  async finalizeBudget(input: Parameters<MediaImageCreditSettlementPort["finalizeBudget"]>[0]):
  ReturnType<MediaImageCreditSettlementPort["finalizeBudget"]> {
    let attempt: Parameters<CreditMediaBudgetFinalizationService["finalize"]>[1]["attempt"];
    const leaseTokenHash = createHash("sha256").update(input.leaseToken, "utf8").digest("hex");
    if (input.usage === undefined) {
      if (input.outcome !== "canceled" || input.cancelIntentReceiptRef === undefined ||
          input.logicalInvocationRef !== undefined) {
        throw new Error("MEDIA_CREDIT_ZERO_CLOSURE_AUTHORITY_INVALID");
      }
      await this.dependencies.leaseAuthority.assertOwned({ taskRef: input.taskRef,
        operationRef: input.operationRef, leaseEpoch: input.leaseEpoch, leaseTokenHash });
    } else {
      const logicalInvocationRef = input.logicalInvocationRef;
      if (logicalInvocationRef === undefined) throw new Error("MEDIA_CREDIT_LOGICAL_INVOCATION_REQUIRED");
      const resolved = await this.dependencies.typedUsage.loadCertified({
        taskRef: input.taskRef, operationRef: input.operationRef, leaseEpoch: input.leaseEpoch,
        leaseTokenHash,
        modelInvocationCommandRef: input.modelInvocationCommandRef, logicalInvocationRef,
        usageEvidenceRef: input.usage.usageEvidence.ref,
        usageEvidenceDigest: input.usage.usageEvidence.digest,
      });
      if (resolved.kind === "reconciliation_required") {
        return Object.freeze({ kind: "reconciliation_required" as const,
          reconciliationReceiptRef: input.usage.attemptUsageEvidenceReceiptRef, code: resolved.code });
      }
      if (resolved.authorizationSegmentRef !== input.budget.authorizationSegmentRef ||
          resolved.executionManifestRef !== input.budget.executionManifestRef ||
          resolved.logicalEffectRef !== logicalInvocationRef) {
        throw new Error("MEDIA_CREDIT_USAGE_AUTHORITY_SCOPE_MISMATCH");
      }
      attempt = Object.freeze({ attemptAuthorizationRef: resolved.attemptAuthorizationRef,
        attemptAuthorizationFenceEpoch: resolved.attemptAuthorizationFenceEpoch,
        attemptAuthorizationDigest: resolved.attemptAuthorizationDigest,
        usageEvidenceRef: input.usage.usageEvidence.ref,
        usageEvidenceDigest: input.usage.usageEvidence.digest,
        producerKind: resolved.producerKind, producerContext: resolved.producerContext,
        producerGeneration: resolved.producerGeneration, attemptRef: resolved.attemptRef,
        logicalEffectRef: resolved.logicalEffectRef, fact: creditFact(resolved.fact) });
    }
    return this.dependencies.transactionHost.execute({ siteId: input.siteId,
      operation: "credit.media-image.finalize" }, (transaction) =>
      this.dependencies.finalizer.finalize(transaction, {
        siteId: input.siteId, operationRef: input.operationRef, budget: input.budget,
        effectClosureReceiptRef: input.effectClosureReceiptRef, outcome: input.outcome,
        ...(attempt === undefined ? {} : { attempt }),
      }));
  }
}

function creditFact(fact: ImageEffectUsageFact): CreditMediaTypedUsageFact {
  const base = { attemptOutcome: fact.attemptOutcome, occurredAt: fact.occurredAt,
    sourceDigest: fact.sourceDigest };
  if (fact.evidenceKind === "measured") return Object.freeze({ ...base, evidenceKind: "measured" as const,
    dimensions: Object.freeze([...fact.dimensions]) });
  if (fact.evidenceKind === "zero") return Object.freeze({ ...base, evidenceKind: "zero" as const,
    dimensions: Object.freeze([]) as readonly [] });
  return Object.freeze({ ...base, evidenceKind: "unavailable" as const,
    dimensions: Object.freeze([]) as readonly [], unavailableReason: unavailableReason(fact.unavailableReasonCode) });
}

function unavailableReason(value: string | undefined):
"provider_usage_missing" | "provider_usage_ambiguous" | "producer_integrity_failure" {
  if (value === "PROVIDER_USAGE_AMBIGUOUS") return "provider_usage_ambiguous";
  if (value === "PRODUCER_INTEGRITY_FAILURE") return "producer_integrity_failure";
  return "provider_usage_missing";
}
