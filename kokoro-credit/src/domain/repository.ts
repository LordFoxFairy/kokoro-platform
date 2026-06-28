import type {
  CreditAccount,
  CreditHold,
  CreditMutationResult,
  CreditOwnerKind,
  CreditReason,
  QuoteResult,
} from "./credit.js";

export interface EnsureCreditAccountInput {
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
}
