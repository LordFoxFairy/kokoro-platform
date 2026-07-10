import type { DeletionAudit } from "./credit-lifecycle.js";

export type CreditOwnerKind = "user" | "team";
export type CreditAccountStatus = "active" | "disabled";
export type CreditReason = "manual_adjustment" | "subscription" | "model_call" | "tool_call" | "refund";
export type CreditHoldStatus = "active" | "captured" | "released" | "expired";
export type UsageRecordStatus = "recorded" | "settled" | "failed";
export type PricingRuleStatus = "active" | "disabled";

export interface CreditAccount extends DeletionAudit {
  id: string;
  siteId: string;
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
  featureKey: string | null;
  labelKey: string | null;
  modelBindingId: string | null;
  requestId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface UsageRecord {
  id: string;
  accountId: string | null;
  featureKey: string;
  amountMicros: string;
  modelBindingId: string | null;
  requestId: string | null;
  idempotencyKey: string | null;
  status: UsageRecordStatus;
  createdAt: Date;
}

export interface PricingRule extends DeletionAudit {
  id: string;
  featureKey: string;
  labelKey: string | null;
  unit: string;
  amountMicros: string;
  status: PricingRuleStatus;
  effectiveFrom: Date;
  effectiveUntil: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface AccountAudit {
  account: CreditAccount;
  ledgerEntries: CreditLedgerEntry[];
  holds: CreditHold[];
  usageRecords: UsageRecord[];
}

export interface QuoteResult {
  featureKey: string;
  labelKey: string | null;
  unit: string;
  unitAmountMicros: string;
  quantity: string;
  amountMicros: string;
}

// 用量结算面结果：settle 要么 capture（实额入账）要么 release（零成本释放），统一回执给调用方。
export interface UsageSettlementResult {
  holdId: string;
  outcome: "captured" | "released";
  amountMicros: string;
  account: CreditAccount;
}
