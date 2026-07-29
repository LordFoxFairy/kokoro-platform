import type {
  AccountProductsResponse,
  CreditGrantResponse,
  CreditSummaryResponse,
  UsageDetailResponse,
} from "../../../../interfaces/http/generated/platform-public/types.gen.js";
import type { PlatformTransaction } from "../../../../shared/unit-of-work/index.js";

export type AccountReadIdentity = Readonly<{
  siteId: string;
  subjectId: string;
  subjectGeneration: string;
}>;

export interface AccountReadRepository {
  getCreditGrant(transaction: PlatformTransaction, input: AccountReadIdentity & { grantId: string }): Promise<CreditGrantResponse | null>;
  getCreditSummary(transaction: PlatformTransaction, input: AccountReadIdentity): Promise<CreditSummaryResponse>;
  getUsageDetail(transaction: PlatformTransaction, input: AccountReadIdentity & { usageId: string }): Promise<UsageDetailResponse | null>;
  listAccountProducts(transaction: PlatformTransaction, input: AccountReadIdentity): Promise<AccountProductsResponse>;
}
