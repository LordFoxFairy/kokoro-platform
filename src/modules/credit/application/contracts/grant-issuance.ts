import type { PlatformTransaction } from "../../../../shared/unit-of-work/index.js";

declare const creditGrantRefBrand: unique symbol;
declare const preparedCreditGrantAccountsBrand: unique symbol;

export type CreditGrantRef = string & Readonly<{ [creditGrantRefBrand]: "CreditGrantRef" }>;

export type CreditGrantAccountIdentity = Readonly<{
  siteId: string;
  billingAccountId: string;
  unit: string;
  liabilityMerchantAccountId: string;
}>;

export type CreditGrantScopePolicy = Readonly<{
  version: 1;
  surfaceRefs: readonly string[];
  capabilityKeys: readonly string[];
  agentRefs: readonly string[];
  allowUnattributedAgent: boolean;
}>;

export type CreditGrantSourceType = "redemption" | "payment" | "admin_grant" | "program_window";

export type PreparedCreditGrantIssuance = Readonly<{
  [preparedCreditGrantAccountsBrand]: true;
  accountCount: number;
  grantCount: number;
  intentDigest: string;
}>;

export type PrepareCreditGrantIssuanceResult =
  | Readonly<{ kind: "ready"; preparation: PreparedCreditGrantIssuance }>
  | Readonly<{
    kind: "unavailable";
    reason: "credit_account_suspended" | "credit_account_closed";
  }>;

export type CreditGrantIssue = Readonly<{
  account: CreditGrantAccountIdentity;
  outputLineId: string;
  outputOrdinal: number;
  occurrence: number;
  creditProgramRevisionRef: string;
  creditProgramRevision: bigint;
  creditProgramRevisionDigest: string;
  sourceType: CreditGrantSourceType;
  sourceRef: string;
  businessOperationKey: string;
  bucketClass: "daily" | "period" | "permanent";
  amount: string;
  burnPriority: number;
  scopePolicy: CreditGrantScopePolicy;
  acquiredAt: string;
  effectiveAt: string;
  expiresAt: string | null;
}>;

export type CreditGrantIssueReceipt = Readonly<{
  outputLineId: string;
  outputOrdinal: number;
  occurrence: number;
  creditProgramRevisionRef: string;
  creditGrantRef: CreditGrantRef;
  outputVersion: 1;
  outputDigest: string;
}>;

export interface CreditGrantIssuancePort {
  prepareIssuance(
    transaction: PlatformTransaction,
    input: Readonly<{
      commandId: string;
      grants: readonly CreditGrantIssue[];
    }>,
  ): Promise<PrepareCreditGrantIssuanceResult>;

  issuePrepared(
    transaction: PlatformTransaction,
    input: Readonly<{
      preparation: PreparedCreditGrantIssuance;
    }>,
  ): Promise<readonly CreditGrantIssueReceipt[]>;
}
