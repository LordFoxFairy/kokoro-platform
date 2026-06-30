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

export interface CreditRepository {
  ensureAccount(input: EnsureCreditAccountInput): Promise<CreditAccount>;
  grantCredits(input: CreditAmountInput): Promise<CreditMutationResult>;
  spendCredits(input: CreditAmountInput): Promise<CreditMutationResult>;
  holdCredits(input: HoldCreditInput): Promise<CreditHold>;
  captureHold(input: CaptureCreditInput): Promise<CreditMutationResult>;
  releaseHold(input: ReleaseCreditInput): Promise<CreditHold>;
  quote(input: QuoteInput): Promise<QuoteResult>;
  listAccounts(siteId?: string): Promise<CreditAccount[]>;
  listLedgerEntries(): Promise<CreditLedgerEntry[]>;
  listUsageRecords(): Promise<UsageRecord[]>;
  listPricingRules(): Promise<PricingRule[]>;
  getAccountById(id: string): Promise<CreditAccount | null>;
  listLedgerByAccount(accountId: string): Promise<CreditLedgerEntry[]>;
  listHoldsByAccount(accountId: string): Promise<CreditHold[]>;
  listUsageByAccount(accountId: string): Promise<UsageRecord[]>;
}
