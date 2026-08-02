import type { PlatformTransaction } from "../../../../shared/unit-of-work/index.js";
import type { CommandIdentity } from "../../../../shared/outbox-inbox/receipt.js";

export type CommerceAdminActor = Readonly<{
  siteId: string;
  subjectId: string;
  subjectGeneration: string;
  command: CommandIdentity;
}>;

export type CommerceAdminOutcome<Result, Kind extends "committed" | "replayed" = "committed" | "replayed"> = Readonly<{
  kind: Kind;
  command: CommandIdentity;
  recordedAt: string;
  result: Readonly<Result>;
}>;

export type CodeIssueMaterial = Readonly<{
  keyRevision: string;
  batchSelector: string;
  exportDigest: string;
  rawCodes: readonly string[];
  codes: readonly Readonly<{ codeRef: string; lookupDigest: string; safeFingerprint: string }>[];
}>;

export type CodeBatchMutationResult = Readonly<{
  batchRef: string;
  state: "draft" | "active" | "abandoned" | "suspended" | "revoked";
  approvalState?: "approved";
  changedAt: string;
}>;

export interface CommerceAdministrationRepository {
  publishCreditProgramRevision(transaction: PlatformTransaction, input: CommerceAdminActor & Readonly<{
    creditProgramRevisionRef: string;
    programRef: string;
    revision: string;
    uxBucketClass: "daily" | "period" | "permanent";
    unit: string;
    amount: string;
    burnPriority: number;
    scopePolicy: Readonly<{
      version: 1;
      surfaceRefs: readonly string[];
      capabilityKeys: readonly string[];
      agentRefs: readonly string[];
      allowUnattributedAgent: boolean;
    }>;
    liabilityMerchantAccountRef: string;
    windowKind: "none" | "daily" | "period";
    rolloverPolicy: "none";
    calendarZone: string | null;
    windowAnchor: string | null;
    expiresAfterSeconds: string | null;
    revisionDigest: string;
  }>): Promise<CommerceAdminOutcome<{
    creditProgramRevisionRef: string; revisionDigest: string; publishedAt: string;
  }>>;
  publishEntitlementTemplateRevision(transaction: PlatformTransaction, input: CommerceAdminActor & Readonly<{
    entitlementTemplateRevisionRef: string;
    templateRef: string;
    revision: string;
    capabilityKey: string;
    safeLabel: string;
    expiresAfterSeconds: string | null;
    revisionDigest: string;
  }>): Promise<CommerceAdminOutcome<{
    entitlementTemplateRevisionRef: string; revisionDigest: string; publishedAt: string;
  }>>;
  publishOffer(transaction: PlatformTransaction, input: CommerceAdminActor & Readonly<{
    productRef: string;
    productKind: "free" | "credit_pack" | "subscription" | "bundle";
    productVersionRef: string;
    productRevision: string;
    safeLabel: string;
    planVersion: Readonly<{
      planRef: string;
      planVersionRef: string;
      revision: string;
      safeLabel: string;
      termAction: "none" | "new_subscription" | "extend_from_max" | "reject_if_active";
      termSeconds: string | null;
      stackingScope: string;
      revisionDigest: string;
    }> | null;
    fulfillmentProgramRevisionRef: string;
    fulfillmentProgramRef: string;
    fulfillmentProgramRevision: string;
    outputs: readonly Readonly<{
      outputLineId: string;
      ordinal: number;
      cardinality: number;
      outputKind: "subscription_term" | "entitlement_grant" | "credit_grant" | "credit_program_enrollment";
      targetRevisionRef: string;
    }>[];
    legalTermRefs: readonly string[];
    offerDigest: string;
  }>): Promise<CommerceAdminOutcome<{ productVersionRef: string; publishedAt: string }>>;
  publishProgram(transaction: PlatformTransaction, input: CommerceAdminActor & Readonly<{
    redemptionProgramRevisionRef: string; programRef: string; revision: string; productVersionRef: string;
    fulfillmentProgramRevisionRef: string; programDigest: string; maxRedemptionsPerAccount: number;
  }>): Promise<CommerceAdminOutcome<{ redemptionProgramRevisionRef: string; publishedAt: string }>>;
  issueBatch(transaction: PlatformTransaction, input: CommerceAdminActor & Readonly<{
    batchRef: string; redemptionProgramRevisionRef: string; count: number;
    startsAt: string | null; endsAt: string | null; issueCodes: () => CodeIssueMaterial;
  }>): Promise<
    | (CommerceAdminOutcome<{ batchRef: string; codeCount: number; redemptionProgramRevisionRef: string;
        createdByOperatorRef: string; startsAt: string | null; endsAt: string | null; exportedAt: string }, "committed"> &
        Readonly<{ rawCodes: readonly string[] }>)
    | CommerceAdminOutcome<{ batchRef: string; codeCount: number; redemptionProgramRevisionRef: string;
        createdByOperatorRef: string; startsAt: string | null; endsAt: string | null; exportedAt: string }, "replayed">
  >;
  approveBatch(transaction: PlatformTransaction, input: CommerceAdminActor & Readonly<{
    batchRef: string; approvalDigest: string;
  }>): Promise<CommerceAdminOutcome<CodeBatchMutationResult>>;
  activateBatch(transaction: PlatformTransaction, input: CommerceAdminActor & Readonly<{
    batchRef: string;
  }>): Promise<CommerceAdminOutcome<CodeBatchMutationResult>>;
  abandonBatch(transaction: PlatformTransaction, input: CommerceAdminActor & Readonly<{
    batchRef: string; reasonDigest: string;
  }>): Promise<CommerceAdminOutcome<CodeBatchMutationResult>>;
  suspendBatch(transaction: PlatformTransaction, input: CommerceAdminActor & Readonly<{
    batchRef: string; reasonDigest: string;
  }>): Promise<CommerceAdminOutcome<CodeBatchMutationResult>>;
  revokeBatch(transaction: PlatformTransaction, input: CommerceAdminActor & Readonly<{
    batchRef: string; reasonDigest: string;
  }>): Promise<CommerceAdminOutcome<CodeBatchMutationResult>>;
}
