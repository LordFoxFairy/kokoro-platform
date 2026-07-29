import type { PlatformTransaction } from "../../../../shared/unit-of-work/index.js";
import type { RedemptionPreviewCandidate, StoredRedemptionPreview } from "../../domain/redemption-preview.js";

export interface RedemptionCodeLookupCandidate {
  readonly keyRevision: string;
  readonly lookupDigest: string;
}

export type SaveRedemptionPreviewInput = StoredRedemptionPreview;

export interface RedemptionRepository {
  resolvePreviewCandidate(
    transaction: PlatformTransaction,
    input: Readonly<{
      siteId: string;
      billingAccountId: string;
      lookupCandidates: readonly RedemptionCodeLookupCandidate[];
      now: string;
    }>,
  ): Promise<RedemptionPreviewCandidate | null>;
  resolvePreviewBillingAccount(
    transaction: PlatformTransaction,
    input: Readonly<{ siteId: string; subjectId: string; subjectGeneration: string }>,
  ): Promise<Readonly<{ billingAccountId: string; aggregateVersion: string; membershipEpoch: string }> | null>;
  savePreview(transaction: PlatformTransaction, input: SaveRedemptionPreviewInput): Promise<void>;
  findPreviewByCommand(
    transaction: PlatformTransaction,
    input: Readonly<{ siteId: string; subjectId: string; subjectGeneration: string; commandId: string }>,
  ): Promise<StoredRedemptionPreview | null>;
}
