import type { DeletionAudit } from "./credit-lifecycle.js";

export type CreditOwnerKind = "user" | "team";
export type CreditAccountStatus = "active" | "disabled";
// 组织级配额周期：V1 仅自然月（UTC）。未设配额=不限（现状）。
export type CreditQuotaPeriod = "monthly";
export type CreditReason =
  | "manual_adjustment"
  | "subscription"
  | "model_call"
  | "tool_call"
  | "refund"
  | "welcome";
export type CreditHoldStatus = "active" | "captured" | "released" | "expired";
export type UsageRecordStatus = "recorded" | "settled" | "failed";
export type PricingRuleStatus = "active" | "disabled";

export interface CreditAccount extends DeletionAudit {
  id: string;
  siteId: string;
  ownerKind: CreditOwnerKind;
  ownerId: string;
  status: CreditAccountStatus;
  // 三桶（L3.1，按过期节奏）：balanceMicros=永久桶（积分包/欢迎，不过期）；
  // dailyMicros/periodMicros=时间型桶（懒刷新，use-or-lose）；*ResetOn=各桶水位（null=未初始化/无订阅）。
  balanceMicros: string;
  heldMicros: string;
  dailyMicros: string;
  dailyResetOn: Date | null;
  periodMicros: string;
  periodResetOn: Date | null;
  // 时间桶当期额度（懒刷新重置目标 + release/refund 归还夹紧上限）。L3.2 由生效 Plan 填；现恒 0。
  dailyAllowanceMicros: string;
  periodAllowanceMicros: string;
  // 组织级消费上限（周期上限，微单位字符串）+ 周期口径；null=不限（现状）。admin 面设置。
  quotaMicros: string | null;
  quotaPeriod: CreditQuotaPeriod | null;
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

// 按模型消费分解单项（B1d）：某 modelBindingId 在周期内已结算用量的消费额与 run 数。
// modelBindingId=null 表示无模型归属（如本地预览/工具调用未绑模型）。名称解析由上游（session）跨 model 完成。
export interface UsageByModelItem {
  modelBindingId: string | null;
  spentMicros: string;
  runCount: number;
}

export interface CreditHold {
  id: string;
  accountId: string;
  amountMicros: string;
  // B1 三桶预留明细：hold 时从各桶按序扣走的量，三者之和=amountMicros；settle/release 据此夹紧归还。
  reservedDailyMicros: string;
  reservedPeriodMicros: string;
  reservedPermanentMicros: string;
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

// 运营台聚合总览（admin B2）：全站维度的账户与流水汇总。微单位字符串（BigInt 安全）。
// 发放/消费从 ledger 分录符号聚合（正=发放/授信、负=消费/扣减,spent 取绝对值）；
// 余额/冻结从存活账户求和（软删账户不计入负债）。
export interface CreditAdminStats {
  accountsTotal: number;
  accountsActive: number;
  balanceSumMicros: string;
  heldSumMicros: string;
  grantedTotalMicros: string;
  spentTotalMicros: string;
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
