import type { AdminQueryPermit } from
  "../../../admin/interfaces/connect/admin-query-service.js";
import type { PlatformTransaction } from "../../../../shared/unit-of-work/index.js";

export interface AdminCreditSiteSummaryRecord {
  readonly siteId: string;
  readonly creditAccountCount: bigint;
  readonly activeCreditAccountCount: bigint;
  readonly openHoldCount: bigint;
  readonly reconciliationRequiredHoldCount: bigint;
  readonly balances: readonly CreditBalanceRecord[];
  readonly asOf: string;
}

export interface CreditBalanceRecord {
  readonly unit: string;
  readonly availableAmount: string;
  readonly reservedAmount: string;
  readonly consumedAmount: string;
  readonly expiredAmount: string;
  readonly revokedAmount: string;
  readonly recoveryExposureAmount: string;
}

export interface AdminCreditAccountRecord {
  readonly siteId: string;
  readonly creditAccountRef: string;
  readonly billingAccountRef: string;
  readonly unit: string;
  readonly state: "active" | "suspended" | "closed";
  readonly aggregateVersion: bigint;
  readonly balance: CreditBalanceRecord;
  readonly grantCount: bigint;
  readonly openHoldCount: bigint;
  readonly reconciliationRequiredHoldCount: bigint;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly asOf: string;
}

export interface AdminCreditGrantRecord {
  readonly siteId: string;
  readonly creditGrantId: string;
  readonly creditAccountRef: string;
  readonly billingAccountRef: string;
  readonly creditProgramRevisionRef: string;
  readonly sourceType: "redemption" | "payment" | "admin_grant" | "program_window";
  readonly sourceRef: string;
  readonly issuanceJournalTransactionRef: string;
  readonly uxBucketClass: "daily" | "period" | "permanent";
  readonly unit: string;
  readonly originalAmount: string;
  readonly burnPriority: number;
  readonly effectiveAt: string;
  readonly expiresAt: string | null;
  readonly issuedAt: string;
  readonly relatedHoldCount: bigint;
  readonly relatedExecutionCount: bigint;
}

export interface AdminCreditHoldRecord {
  readonly siteId: string;
  readonly creditHoldRef: string;
  readonly creditAccountRef: string;
  readonly executionRootRef: string;
  readonly unit: string;
  readonly requestedAmount: string;
  readonly reservedAmount: string;
  readonly capturedAmount: string;
  readonly releasedAmount: string;
  readonly state: "open" | "closing" | "settled" | "released" | "expired" |
    "reconciliation_required";
  readonly resolutionKind: "reservation_expiry" | "known_outcome" | "reconciled" | null;
  readonly resolutionRef: string | null;
  readonly fenceEpoch: bigint;
  readonly expiresAt: string;
  readonly settledAt: string | null;
  readonly releasedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly grantCount: bigint;
  readonly sourceCount: bigint;
}

export interface AdminCreditHoldAllocationRecord {
  readonly siteId: string;
  readonly creditHoldRef: string;
  readonly creditGrantId: string;
  readonly creditAccountRef: string;
  readonly unit: string;
  readonly reserveJournalTransactionRef: string;
  readonly allocatedAmount: string;
  readonly allocationOrdinal: number;
  readonly createdAt: string;
}

export interface AdminCreditJournalTransactionRecord {
  readonly siteId: string;
  readonly journalTransactionRef: string;
  readonly creditAccountRef: string;
  readonly unit: string;
  readonly businessOperationKey: string;
  readonly operationKind: "grant_issue" | "hold_reserve" | "hold_capture" | "hold_release" |
    "grant_expire" | "grant_revoke" | "correction" | "reversal";
  readonly entryCount: number;
  readonly reversalOfTransactionRef: string | null;
  readonly occurredAt: string;
  readonly createdAt: string;
}

export interface AdminCreditJournalEntryRecord {
  readonly siteId: string;
  readonly journalTransactionRef: string;
  readonly entryOrdinal: number;
  readonly creditAccountRef: string;
  readonly unit: string;
  readonly entrySide: "debit" | "credit";
  readonly accountType: "grant_issuance_source" | "customer_available" | "customer_reserved" |
    "customer_consumed" | "expired" | "revoked" | "adjustment" | "recovery_exposure";
  readonly amount: string;
  readonly creditGrantId: string;
  readonly creditHoldRef: string | null;
  readonly sourceType: AdminCreditGrantRecord["sourceType"];
  readonly sourceRef: string;
  readonly executionRootRef: string | null;
  readonly createdAt: string;
}

export interface AdminRatedUsageRecord {
  readonly siteId: string;
  readonly ratedUsageRef: string;
  readonly authorizationSegmentRef: string;
  readonly closureRef: string;
  readonly settlementRef: string;
  readonly evidenceRef: string;
  readonly attemptRef: string;
  readonly executionRootRef: string;
  readonly creditHoldRef: string;
  readonly creditAccountRef: string;
  readonly unit: string;
  readonly policyRatedAmount: string;
  readonly customerAmount: string;
  readonly platformExposureAmount: string;
  readonly lineItemCount: number;
  readonly ratedUsageDigest: string;
  readonly sourceCount: bigint;
  readonly createdAt: string;
}

export interface AdminRatedUsageSourceAllocationRecord {
  readonly siteId: string;
  readonly ratedUsageRef: string;
  readonly settlementRef: string;
  readonly creditGrantId: string;
  readonly direction: "capture" | "increase" | "decrease";
  readonly amount: string;
  readonly allocationOrdinal: number;
  readonly sourceOrdinal: number;
}

export interface AdminCreditMembershipPageResult<Record> {
  readonly items: readonly Record[];
  readonly membershipWatermark: string;
  readonly observedAt: string;
}

export interface AdminCreditPage {
  readonly siteId: string;
  readonly afterRef: string | null;
  readonly membershipWatermark: string | null;
  readonly limit: number;
}

export interface AdminCreditTracePage extends AdminCreditPage {
  readonly creditAccountRef: string | null;
  readonly creditGrantId: string | null;
  readonly sourceType: AdminCreditGrantRecord["sourceType"] | null;
  readonly sourceRef: string | null;
  readonly executionRootRef: string | null;
}

export interface AdminCreditReader {
  getSiteCreditSummary(permit: AdminQueryPermit, siteId: string): Promise<AdminCreditSiteSummaryRecord>;
  listCreditAccounts(permit: AdminQueryPermit, input: AdminCreditPage & Readonly<{
    billingAccountRef: string | null;
  }>): Promise<AdminCreditMembershipPageResult<AdminCreditAccountRecord>>;
  getCreditAccount(permit: AdminQueryPermit, siteId: string,
    creditAccountRef: string): Promise<AdminCreditAccountRecord | null>;
  listCreditGrants(permit: AdminQueryPermit,
    input: AdminCreditTracePage): Promise<AdminCreditMembershipPageResult<AdminCreditGrantRecord>>;
  listCreditHolds(permit: AdminQueryPermit,
    input: AdminCreditTracePage): Promise<AdminCreditMembershipPageResult<AdminCreditHoldRecord>>;
  listCreditHoldAllocations(permit: AdminQueryPermit, input: Readonly<{
    siteId: string; creditHoldRef: string | null; creditGrantId: string | null;
    afterHoldRef: string | null; afterAllocationOrdinal: number | null;
    membershipWatermark: string | null; limit: number;
  }>): Promise<AdminCreditMembershipPageResult<AdminCreditHoldAllocationRecord>>;
  listCreditJournalTransactions(permit: AdminQueryPermit,
    input: AdminCreditTracePage & Readonly<{ creditGrantId: string | null;
      creditHoldRef: string | null }>): Promise<AdminCreditMembershipPageResult<AdminCreditJournalTransactionRecord>>;
  listCreditJournalEntries(permit: AdminQueryPermit, input: Readonly<{
    siteId: string; journalTransactionRef: string; afterOrdinal: number | null;
    membershipWatermark: string | null; limit: number;
  }>): Promise<AdminCreditMembershipPageResult<AdminCreditJournalEntryRecord>>;
  listRatedUsage(permit: AdminQueryPermit, input: AdminCreditTracePage & Readonly<{
    creditHoldRef: string | null; attemptRef: string | null;
  }>): Promise<AdminCreditMembershipPageResult<AdminRatedUsageRecord>>;
  listRatedUsageSourceAllocations(permit: AdminQueryPermit, input: Readonly<{
    siteId: string; ratedUsageRef: string | null; settlementRef: string | null;
    afterRatedUsageRef: string | null; afterSourceOrdinal: number | null;
    membershipWatermark: string | null; limit: number;
  }>): Promise<AdminCreditMembershipPageResult<AdminRatedUsageSourceAllocationRecord>>;
}

export interface AdminSiteQueryTransactionHost {
  adminSiteQueryTransaction<Result>(permit: AdminQueryPermit, siteRef: string,
    work: (transaction: PlatformTransaction) => Promise<Result>): Promise<Result>;
}
