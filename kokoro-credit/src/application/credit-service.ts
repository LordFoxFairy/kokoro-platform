import { AppError, parsePositiveBigIntString } from "@kokoro/platform-kit";
import type { CreditAccount, PricingRule } from "../domain/credit.js";
import { CreditLifecycleError, type DeleteInput, type RestoreInput } from "../domain/credit-lifecycle.js";
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
}
