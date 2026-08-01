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

export type PreparedCreditGrantAccounts = Readonly<{
  [preparedCreditGrantAccountsBrand]: true;
  accountCount: number;
}>;

export type PrepareCreditGrantAccountsResult =
  | Readonly<{ kind: "ready"; preparation: PreparedCreditGrantAccounts }>
  | Readonly<{
    kind: "unavailable";
    reason: "credit_account_suspended" | "credit_account_closed";
  }>;

export type CreditGrantIssue = Readonly<{
  account: CreditGrantAccountIdentity;
  outputLineId: string;
  occurrence: number;
  creditProgramRevisionRef: string;
  sourceType: CreditGrantSourceType;
  sourceRef: string;
  businessOperationKey: string;
  bucketClass: "daily" | "period" | "permanent";
  amount: string;
  burnPriority: number;
  scopePolicy: CreditGrantScopePolicy;
  effectiveAt: string;
  expiresAt: string | null;
}>;

export type CreditGrantIssueReceipt = Readonly<{
  outputLineId: string;
  occurrence: number;
  creditProgramRevisionRef: string;
  creditGrantRef: CreditGrantRef;
}>;

export interface CreditGrantIssuancePort {
  prepareAccounts(
    transaction: PlatformTransaction,
    input: Readonly<{ accounts: readonly CreditGrantAccountIdentity[] }>,
  ): Promise<PrepareCreditGrantAccountsResult>;

  issueGrants(
    transaction: PlatformTransaction,
    input: Readonly<{
      preparation: PreparedCreditGrantAccounts;
      commandId: string;
      grants: readonly CreditGrantIssue[];
    }>,
  ): Promise<readonly CreditGrantIssueReceipt[]>;
}
