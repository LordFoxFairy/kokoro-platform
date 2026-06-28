export type CreditOwnerKind = "user" | "team";
export type CreditAccountStatus = "active" | "disabled";
export type CreditReason = "manual_adjustment" | "subscription" | "model_call" | "tool_call" | "refund";
export type CreditHoldStatus = "active" | "captured" | "released" | "expired";

export interface CreditAccount {
  id: string;
  ownerKind: CreditOwnerKind;
  ownerId: string;
  status: CreditAccountStatus;
  balanceMicros: string;
  heldMicros: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreditLedgerEntry {
  id: string;
  accountId: string;
  amountMicros: string;
  balanceAfterMicros: string;
  reason: CreditReason;
  idempotencyKey: string;
  requestId: string | null;
  createdAt: Date;
}

export interface CreditMutationResult {
  account: CreditAccount;
  entry: CreditLedgerEntry;
}

export interface CreditHold {
  id: string;
  accountId: string;
  amountMicros: string;
  status: CreditHoldStatus;
  idempotencyKey: string;
  expiresAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface QuoteResult {
  featureKey: string;
  labelKey: string | null;
  unit: string;
  unitAmountMicros: string;
  quantity: string;
  amountMicros: string;
}
