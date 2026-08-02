import type { PlatformTransaction } from "../../../../shared/unit-of-work/index.js";
import type { CreditGrantIssueReceipt, CreditGrantScopePolicy } from
  "../../../credit/application/contracts/grant-issuance.js";

export type DueCreditProgramEnrollment = Readonly<{
  enrollmentRef: string;
  siteId: string;
  billingAccountId: string;
  creditProgramRevisionRef: string;
  creditProgramRevision: bigint;
  creditProgramRevisionDigest: string;
  outputLineId: string;
  outputOrdinal: number;
  occurrence: number;
  bucketClass: "daily" | "period";
  unit: string;
  amount: string;
  liabilityMerchantAccountId: string;
  burnPriority: number;
  scopePolicy: CreditGrantScopePolicy;
  windowKey: string;
  windowStartsAt: string;
  windowEndsAt: string;
  acquiredAt: string;
}>;

export interface CreditProgramWindowRepositoryPort {
  claimDue(transaction: PlatformTransaction, limit: number): Promise<readonly DueCreditProgramEnrollment[]>;
  recordAcquisition(transaction: PlatformTransaction, input: Readonly<{
    acquisitionRef: string;
    enrollment: DueCreditProgramEnrollment;
    receipt: CreditGrantIssueReceipt;
  }>): Promise<void>;
}
