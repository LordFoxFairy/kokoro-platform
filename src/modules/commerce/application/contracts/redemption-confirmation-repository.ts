import type { PlatformTransaction } from "../../../../shared/unit-of-work/index.js";

export type RedemptionOutputReceipt = Readonly<{
  kind: "subscription_term" | "entitlement_grant" | "credit_grant";
  outputLineId: string;
  resourceRef: string;
  templateRevisionRef: string;
}>;

export type StoredRedemptionReceipt = Readonly<{
  commandId: string;
  commandReceivedAt: string;
  commandUpdatedAt: string;
  redemptionId: string;
  fulfillmentRef: string;
  outputSetDigest: string;
  outputs: readonly RedemptionOutputReceipt[];
  planRef: string | null;
  planVersionRef: string | null;
  productRef: string;
  productVersionRef: string;
  redeemedAt: string;
  safeCodeFingerprint: string;
  state: "fulfilled" | "reversed" | "reconciliation_required";
  stateObservedAt: string;
  reversalRefs: readonly string[];
}>;

export type ConfirmRedemptionRepositoryInput = Readonly<{
  siteId: string;
  subjectId: string;
  subjectGeneration: string;
  commandId: string;
  previewRef: string;
  credentialKeyRevision: string;
  credentialDigest: string;
  legalAcceptanceRefs: readonly string[];
  authorityReleaseRef: string;
  workloadIdentityId: string;
  confirmedAt: string;
}>;

export type ConfirmRedemptionRepositoryResult =
  | Readonly<{ kind: "succeeded"; receipt: StoredRedemptionReceipt }>
  | Readonly<{ kind: "rejected"; code: "REDEEM_NOT_ACCEPTED" }>;

export type StoredRedemptionConfirmation =
  | Readonly<{ state: "succeeded"; receipt: StoredRedemptionReceipt }>
  | Readonly<{
    state: "failed";
    commandReceivedAt: string;
    commandUpdatedAt: string;
    code: "REDEEM_NOT_ACCEPTED";
  }>
  | Readonly<{
    state: "pending" | "outcome_unknown";
    commandReceivedAt: string;
    commandUpdatedAt: string;
  }>;

/**
 * Confirmation owns the irreversible Code claim and fulfillment transaction.
 * Implementations must perform the whole operation on the supplied Platform UoW.
 */
export interface RedemptionConfirmationRepository {
  confirmRedemption(
    transaction: PlatformTransaction,
    input: ConfirmRedemptionRepositoryInput,
  ): Promise<ConfirmRedemptionRepositoryResult>;
  findConfirmationByCommand(
    transaction: PlatformTransaction,
    input: Readonly<{
      siteId: string;
      subjectId: string;
      subjectGeneration: string;
      commandId: string;
    }>,
  ): Promise<StoredRedemptionConfirmation | null>;
}
