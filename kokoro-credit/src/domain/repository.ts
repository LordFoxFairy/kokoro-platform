import type {
  CreditAccount,
  CreditHold,
  CreditLedgerEntry,
  CreditMutationResult,
  CreditOwnerKind,
  CreditQuotaPeriod,
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

// 重置余额到目标值（运营/测试纠偏）：不直接改余额留白，而是落一条带符号调整分录（target-before）。
export interface ResetBalanceInput {
  accountId: string;
  targetMicros: string; // 非负目标余额；不得低于已冻结额 heldMicros。
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

// 组织级配额设置：quotaMicros=null 清除配额（回退不限）；非空则连同周期口径落账户。
export interface SetAccountQuotaInput {
  accountId: string;
  quotaMicros: string | null;
  quotaPeriod: CreditQuotaPeriod;
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

// 定价规则编辑（admin 治理）：仅改可变字段（价/状态/生效窗），身份键（featureKey/labelKey/unit）不可变——
// 换维度=另建规则。字段皆可选（缺省不动）；effectiveUntil=null 显式清除截止。
export interface UpdatePricingRuleInput {
  id: string;
  amountMicros?: string | undefined;
  status?: PricingRule["status"] | undefined;
  effectiveFrom?: Date | undefined;
  effectiveUntil?: Date | null | undefined;
}

export interface CreditRepository {
  ensureAccount(input: EnsureCreditAccountInput): Promise<CreditAccount>;
  grantCredits(input: CreditAmountInput): Promise<CreditMutationResult>;
  spendCredits(input: CreditAmountInput): Promise<CreditMutationResult>;
  resetBalance(input: ResetBalanceInput): Promise<CreditMutationResult>;
  holdCredits(input: HoldCreditInput): Promise<CreditHold>;
  captureHold(input: CaptureCreditInput): Promise<CreditMutationResult>;
  releaseHold(input: ReleaseCreditInput): Promise<CreditHold>;
  // 过期回收：expiresAt < now 且仍 active 的 hold → 退冻结额、status 置 expired。返回回收条数。幂等、与 capture/release 竞争只赢一个。
  sweepExpiredHolds(now?: Date): Promise<number>;
  getHoldById(id: string): Promise<CreditHold | null>;
  quote(input: QuoteInput): Promise<QuoteResult>;
  priceUsage(input: PriceUsageInput): Promise<string>;
  createPricingRule(input: CreatePricingRuleInput): Promise<PricingRule>;
  updatePricingRule(input: UpdatePricingRuleInput): Promise<PricingRule>;
  deleteAccount(input: DeleteInput): Promise<CreditAccount>;
  restoreAccount(input: RestoreInput): Promise<CreditAccount>;
  deletePricingRule(input: DeleteInput): Promise<PricingRule>;
  restorePricingRule(input: RestoreInput): Promise<PricingRule>;
  listAccounts(siteId?: string, options?: ListOptions): Promise<CreditAccount[]>;
  listLedgerEntries(): Promise<CreditLedgerEntry[]>;
  listUsageRecords(): Promise<UsageRecord[]>;
  listPricingRules(options?: ListOptions): Promise<PricingRule[]>;
  getAccountById(id: string): Promise<CreditAccount | null>;
  // 组织级配额落账户（admin 面）：quotaMicros=null 清除、非空则设本周期上限。
  setAccountQuota(input: SetAccountQuotaInput): Promise<CreditAccount>;
  // 本周期已结算消费累计（既有 ledger 聚合，不建新表）：sum |amountMicros| of 用量 capture
  // （reason∈model_call/tool_call）since 周期起点。返回微单位字符串（>=0）。
  sumCapturedUsageSince(accountId: string, since: Date): Promise<string>;
  // 只读按 owner 三元组定位账户（不建账、不复活软删）：命中活跃账户返之，缺失/已软删→null。
  findActiveAccountByOwner(input: EnsureCreditAccountInput): Promise<CreditAccount | null>;
  listLedgerByAccount(accountId: string): Promise<CreditLedgerEntry[]>;
  // 流水复合游标分页（createdAt desc、id desc 稳定序）：cursor 之后（更旧于）至多 limit 条。
  listLedgerPage(
    accountId: string,
    opts: { limit: number; cursor?: { createdAt: Date; id: string } },
  ): Promise<CreditLedgerEntry[]>;
  listHoldsByAccount(accountId: string): Promise<CreditHold[]>;
  listUsageByAccount(accountId: string): Promise<UsageRecord[]>;
}
