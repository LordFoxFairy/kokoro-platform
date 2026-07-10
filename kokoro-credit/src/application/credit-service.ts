import { AppError, parsePositiveBigIntString } from "@kokoro/platform-kit";
import type { CreditAccount, PricingRule, UsageSettlementResult } from "../domain/credit.js";
import { CreditLifecycleError, type DeleteInput, type RestoreInput } from "../domain/credit-lifecycle.js";
import { CreditAccountNotFoundError, CreditHoldNotFoundError } from "../domain/errors.js";
import type {
  CaptureCreditInput,
  CreatePricingRuleInput,
  CreditAmountInput,
  CreditRepository,
  EnsureCreditAccountInput,
  HoldCreditInput,
  QuoteInput,
  ReleaseCreditInput,
} from "../domain/repository.js";

export interface QuoteCommand {
  featureKey: string;
  labelKey?: string | undefined;
  quantity?: string | undefined;
}

// run 受理时冻结：调用方只报 namespace + pricing_ref，credit 按配置化预估用量算冻结额。
export interface HoldForUsageCommand {
  siteId: string;
  namespace: string;
  featureKey: string;
  labelKey?: string | undefined;
  idempotencyKey: string;
  modelBindingId?: string | undefined;
  requestId?: string | undefined;
}

// run 终态结算：调用方只报 token 用量，credit 按 hold 上的 pricing_ref 复算实额。
export interface SettleUsageCommand {
  holdId: string;
  inputTokens: string;
  outputTokens: string;
  idempotencyKey: string;
}

// 用量计费面配置：token 计价 unit、hold 预估用量、冻结冗余系数。全部来自 env，默认值面向 dev。
export interface RunBillingConfig {
  inputUnit: string;
  outputUnit: string;
  estInputTokens: string;
  estOutputTokens: string;
  bufferPercent: number;
}

export const DEFAULT_RUN_BILLING_CONFIG: RunBillingConfig = {
  inputUnit: "input_token",
  outputUnit: "output_token",
  estInputTokens: "1000",
  estOutputTokens: "1000",
  bufferPercent: 20,
};

export type OwnerSiteRef = Pick<CreditAccount, "siteId" | "ownerKind" | "ownerId">;

// 校验 account 所属 owner 与站点是否 active；非 active 抛 AppError(409)。生产由 server 注入 HTTP 实现。
export interface OwnerSiteActiveChecker {
  ensureAccountActive(account: OwnerSiteRef): Promise<void>;
}

// 测试/本地默认放行；跨服务 enforcement 由注入的 HTTP 实现接管。
export const ALWAYS_ACTIVE_CHECKER: OwnerSiteActiveChecker = {
  async ensureAccountActive() {},
};

export class CreditService {
  constructor(
    private readonly repository: CreditRepository,
    private readonly activeChecker: OwnerSiteActiveChecker = ALWAYS_ACTIVE_CHECKER,
    private readonly runBilling: RunBillingConfig = DEFAULT_RUN_BILLING_CONFIG,
  ) {}

  async ensureAccount(input: EnsureCreditAccountInput) {
    await this.activeChecker.ensureAccountActive(input);
    return this.repository.ensureAccount(input);
  }

  async deleteAccount(input: DeleteInput): Promise<CreditAccount> {
    return this.repository.deleteAccount(input);
  }

  async restoreAccount(input: RestoreInput): Promise<CreditAccount> {
    return this.repository.restoreAccount(input);
  }

  async createPricingRule(input: CreatePricingRuleInput): Promise<PricingRule> {
    parsePositiveBigIntString(input.amountMicros, "amountMicros");
    return this.repository.createPricingRule(input);
  }

  async deletePricingRule(input: DeleteInput): Promise<PricingRule> {
    return this.repository.deletePricingRule(input);
  }

  async restorePricingRule(input: RestoreInput): Promise<PricingRule> {
    return this.repository.restorePricingRule(input);
  }

  async grantCredits(input: CreditAmountInput) {
    parsePositiveBigIntString(input.amountMicros, "amountMicros");
    await this.ensureAccountActive(input.accountId);
    return this.repository.grantCredits(input);
  }

  async spendCredits(input: CreditAmountInput) {
    parsePositiveBigIntString(input.amountMicros, "amountMicros");
    await this.ensureAccountActive(input.accountId);
    return this.repository.spendCredits(input);
  }

  async holdCredits(input: HoldCreditInput) {
    parsePositiveBigIntString(input.amountMicros, "amountMicros");
    await this.ensureAccountActive(input.accountId);
    return this.repository.holdCredits(input);
  }

  async captureHold(input: CaptureCreditInput) {
    parsePositiveBigIntString(input.actualAmountMicros, "actualAmountMicros");
    return this.repository.captureHold(input);
  }

  async releaseHold(input: ReleaseCreditInput) {
    return this.repository.releaseHold(input);
  }

  // 改账前置：禁用 owner / 停用站点即时拒绝（封号/停站跨服务即时生效）。capture/release 走 holdId，owner 已在 hold 时校验，不重复。
  private async ensureAccountActive(accountId: string): Promise<void> {
    const account = await this.repository.getAccountById(accountId);
    if (!account) {
      throw new AppError("resource.not_found", 404, `credit account not found: ${accountId}`);
    }
    if (account.deletedAt) {
      throw new CreditLifecycleError("credit.account.deleted", `credit account deleted: ${accountId}`, 409);
    }
    await this.activeChecker.ensureAccountActive(account);
  }

  async quote(command: QuoteCommand) {
    const quantity = command.quantity ?? "1";
    parsePositiveBigIntString(quantity, "quantity");
    const input: QuoteInput = {
      featureKey: command.featureKey,
      labelKey: command.labelKey,
      quantity,
    };
    return this.repository.quote(input);
  }

  // run 受理：解析 namespace→team 账户，按 pricing × 预估用量 × 冗余系数算冻结额，落 pricing_ref 到 hold。
  // 余额不足由 holdCredits 抛 InsufficientCreditError（→ 402）。
  async holdForUsage(command: HoldForUsageCommand): Promise<{ holdId: string; accountId: string; amountMicros: string }> {
    const account = await this.ensureAccount({
      siteId: command.siteId,
      ownerKind: "team",
      ownerId: command.namespace,
    });
    const estimate = await this.repository.priceUsage({
      featureKey: command.featureKey,
      labelKey: command.labelKey,
      inputUnit: this.runBilling.inputUnit,
      outputUnit: this.runBilling.outputUnit,
      inputTokens: this.runBilling.estInputTokens,
      outputTokens: this.runBilling.estOutputTokens,
    });
    const buffered = applyBufferPercent(BigInt(estimate), this.runBilling.bufferPercent);
    // 冻结额至少 1 micro：预估或价格算出 0 时也占位一分钱，避免 holdCredits 的正数守卫抛错。
    const amountMicros = (buffered > 0n ? buffered : 1n).toString();
    const hold = await this.repository.holdCredits({
      accountId: account.id,
      amountMicros,
      idempotencyKey: command.idempotencyKey,
      featureKey: command.featureKey,
      labelKey: command.labelKey,
      modelBindingId: command.modelBindingId,
      requestId: command.requestId,
    });
    return { holdId: hold.id, accountId: account.id, amountMicros: hold.amountMicros };
  }

  // run 终态：按 hold 上的 pricing_ref 与真实 token 用量复算实额，clamp 到冻结额（先守不透支），capture 入账。
  // 实额为 0（零 token 或零价）→ 释放冻结不入账。idempotencyKey=run_id，重放同结果。
  async settleUsage(command: SettleUsageCommand): Promise<UsageSettlementResult> {
    const hold = await this.repository.getHoldById(command.holdId);
    if (!hold) {
      throw new CreditHoldNotFoundError(command.holdId);
    }
    if (hold.featureKey === null) {
      throw new AppError(
        "credit.hold_not_usage_metered",
        409,
        `credit hold has no pricing ref, cannot settle by usage: ${command.holdId}`,
      );
    }

    const actual = await this.repository.priceUsage({
      featureKey: hold.featureKey,
      labelKey: hold.labelKey ?? undefined,
      inputUnit: this.runBilling.inputUnit,
      outputUnit: this.runBilling.outputUnit,
      inputTokens: command.inputTokens,
      outputTokens: command.outputTokens,
    });
    const holdAmount = BigInt(hold.amountMicros);
    const actualAmount = BigInt(actual);
    const clamped = actualAmount < holdAmount ? actualAmount : holdAmount;

    if (clamped === 0n) {
      const released = await this.repository.releaseHold({
        holdId: hold.id,
        idempotencyKey: command.idempotencyKey,
      });
      const account = await this.repository.getAccountById(released.accountId);
      if (!account) {
        throw new CreditAccountNotFoundError(released.accountId);
      }
      return { holdId: hold.id, outcome: "released", amountMicros: "0", account };
    }

    const capture = await this.repository.captureHold({
      holdId: hold.id,
      actualAmountMicros: clamped.toString(),
      idempotencyKey: command.idempotencyKey,
      reason: "model_call",
      featureKey: hold.featureKey,
      modelBindingId: hold.modelBindingId ?? undefined,
      requestId: hold.requestId ?? undefined,
    });
    // 实录金额取自账本（capture 幂等，重放/价格漂移下仍稳定），而非重算的 clamped。
    const capturedMicros = (BigInt(capture.entry.amountMicros) * -1n).toString();
    return { holdId: hold.id, outcome: "captured", amountMicros: capturedMicros, account: capture.account };
  }
}

// 冻结额冗余：base × (100 + percent) / 100，整数截断。percent=20 → +20% 头寸。
function applyBufferPercent(base: bigint, percent: number): bigint {
  return (base * BigInt(100 + percent)) / 100n;
}
