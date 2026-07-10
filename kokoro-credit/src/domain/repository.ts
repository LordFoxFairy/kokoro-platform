import type {
  CreditAccount,
  CreditHold,
  CreditLedgerEntry,
  CreditMutationResult,
  CreditOwnerKind,
  CreditReason,
  PricingRule,
  QuoteResult,
  UsageRecord,
} from "./credit.js";
import type { DeleteInput, ListOptions, RestoreInput } from "./credit-lifecycle.js";

export interface EnsureCreditAccountInput {
  siteId: string;
  ownerKind: CreditOwnerKind;
  ownerId: string;
}

export interface CreditAmountInput {
  accountId: string;
  amountMicros: string;
  idempotencyKey: string;
  reason: CreditReason;
  requestId?: string | undefined;
}

export interface HoldCreditInput {
  accountId: string;
  amountMicros: string;
  idempotencyKey: string;
  expiresAt?: Date | undefined;
  // 用量结算面在冻结时落 pricing_ref 与归属；raw hold 路径留空。
  featureKey?: string | undefined;
  labelKey?: string | undefined;
  modelBindingId?: string | undefined;
  requestId?: string | undefined;
}

export interface CaptureCreditInput {
  holdId: string;
  actualAmountMicros: string;
  idempotencyKey: string;
  reason: CreditReason;
  featureKey: string;
  modelBindingId?: string | undefined;
  requestId?: string | undefined;
}

export interface ReleaseCreditInput {
  holdId: string;
  idempotencyKey: string;
}

export interface QuoteInput {
  featureKey: string;
  labelKey?: string | undefined;
  quantity: string;
}

// 按 token 用量定价：input/output 各按其 unit 规则计价后求和。金额计算全在 credit。
export interface PriceUsageInput {
  featureKey: string;
  labelKey?: string | undefined;
  inputUnit: string;
  outputUnit: string;
  inputTokens: string;
  outputTokens: string;
}

export interface CreatePricingRuleInput {
  featureKey: string;
  labelKey?: string | null | undefined;
  unit: string;
  amountMicros: string;
  status?: PricingRule["status"] | undefined;
  effectiveFrom?: Date | undefined;
  effectiveUntil?: Date | null | undefined;
}

export interface CreditRepository {
  ensureAccount(input: EnsureCreditAccountInput): Promise<CreditAccount>;
  grantCredits(input: CreditAmountInput): Promise<CreditMutationResult>;
  spendCredits(input: CreditAmountInput): Promise<CreditMutationResult>;
  holdCredits(input: HoldCreditInput): Promise<CreditHold>;
  captureHold(input: CaptureCreditInput): Promise<CreditMutationResult>;
  releaseHold(input: ReleaseCreditInput): Promise<CreditHold>;
  getHoldById(id: string): Promise<CreditHold | null>;
  quote(input: QuoteInput): Promise<QuoteResult>;
  priceUsage(input: PriceUsageInput): Promise<string>;
  createPricingRule(input: CreatePricingRuleInput): Promise<PricingRule>;
  deleteAccount(input: DeleteInput): Promise<CreditAccount>;
  restoreAccount(input: RestoreInput): Promise<CreditAccount>;
  deletePricingRule(input: DeleteInput): Promise<PricingRule>;
  restorePricingRule(input: RestoreInput): Promise<PricingRule>;
  listAccounts(siteId?: string, options?: ListOptions): Promise<CreditAccount[]>;
  listLedgerEntries(): Promise<CreditLedgerEntry[]>;
  listUsageRecords(): Promise<UsageRecord[]>;
  listPricingRules(options?: ListOptions): Promise<PricingRule[]>;
  getAccountById(id: string): Promise<CreditAccount | null>;
  listLedgerByAccount(accountId: string): Promise<CreditLedgerEntry[]>;
  listHoldsByAccount(accountId: string): Promise<CreditHold[]>;
  listUsageByAccount(accountId: string): Promise<UsageRecord[]>;
}
