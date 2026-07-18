import { AppError, parsePositiveBigIntString } from "@kokoro/platform-kit";
import type { Prisma, PrismaClient } from "../../../generated/prisma/index.js";
import { parseNonNegativeBigIntString } from "../../domain/amount.js";
import type {
  CreditAccount,
  CreditHold,
  CreditHoldStatus,
  CreditLedgerEntry,
  CreditMutationResult,
  PricingRule,
  PricingRuleStatus,
  QuoteResult,
  UsageRecord,
  UsageRecordStatus,
} from "../../domain/credit.js";
import { assertCreditSpendAllowed } from "../../domain/credit-policy.js";
import {
  CreditAccountNotFoundError,
  CreditCaptureExceedsHoldError,
  CreditHoldNotActiveError,
  CreditHoldNotFoundError,
  InsufficientCreditError,
  PricingRuleNotFoundError,
} from "../../domain/errors.js";
import type {
  CaptureCreditInput,
  CreatePricingRuleInput,
  UpdatePricingRuleInput,
  CreditAmountInput,
  CreditRepository,
  EnsureCreditAccountInput,
  HoldCreditInput,
  PriceUsageInput,
  QuoteInput,
  ReleaseCreditInput,
  ResetBalanceInput,
  SetAccountQuotaInput,
} from "../../domain/repository.js";
import {
  CreditLifecycleError,
  type DeleteInput,
  type ListOptions,
  type RestoreInput,
} from "../../domain/credit-lifecycle.js";

type TransactionClient = Prisma.TransactionClient;

export class PrismaCreditRepository implements CreditRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async ensureAccount(input: EnsureCreditAccountInput): Promise<CreditAccount> {
    const where = {
      siteId_ownerKind_ownerId: {
        siteId: input.siteId,
        ownerKind: input.ownerKind,
        ownerId: input.ownerId,
      },
    };
    const existing = await this.prisma.creditAccount.findUnique({ where });
    if (existing?.deletedAt) {
      throw lifecycleError("credit.account.deleted", `credit account deleted: ${existing.id}`, 409);
    }

    const account = existing
      ? await this.prisma.creditAccount.update({
          where: { id: existing.id },
          data: { status: "active" },
        })
      : await this.prisma.creditAccount.create({
          data: {
            siteId: input.siteId,
            ownerKind: input.ownerKind,
            ownerId: input.ownerId,
            status: "active",
          },
        });

    return mapCreditAccount(account);
  }

  async grantCredits(input: CreditAmountInput): Promise<CreditMutationResult> {
    try {
      return await this.prisma.$transaction(async (tx) => {
        const existing = await this.findExistingEntry(tx, input.idempotencyKey);
        if (existing) {
          return existing;
        }

        const amount = parsePositiveBigIntString(input.amountMicros, "amountMicros");
        const before = await tx.creditAccount.findUnique({ where: { id: input.accountId } });
        assertWritableAccount(before, input.accountId);
        const account = await tx.creditAccount.update({
          where: {
            id: input.accountId,
          },
          data: {
            balanceMicros: {
              increment: amount,
            },
          },
        });
        const entry = await tx.creditLedgerEntry.create({
          data: {
            accountId: account.id,
            amountMicros: amount,
            balanceAfterMicros: account.balanceMicros,
            reason: input.reason,
            idempotencyKey: input.idempotencyKey,
            ...defined("requestId", input.requestId),
          },
        });

        return {
          account: mapCreditAccount(account),
          entry: mapLedgerEntry(entry),
        };
      });
    } catch (error) {
      return this.findExistingEntryAfterUniqueConflict(error, input.idempotencyKey);
    }
  }

  async spendCredits(input: CreditAmountInput): Promise<CreditMutationResult> {
    try {
      return await this.prisma.$transaction(async (tx) => {
        const existing = await this.findExistingEntry(tx, input.idempotencyKey);
        if (existing) {
          return existing;
        }

        const amount = parsePositiveBigIntString(input.amountMicros, "amountMicros");
        // WHY: 条件更新校验可用额(balance-held)≥amount——spend 不得动用已冻结资金，否则 capture 时余额会被扣成负。
        const spent = await tx.$executeRaw`UPDATE credit_accounts SET balanceMicros = balanceMicros - ${amount} WHERE id = ${input.accountId} AND status = 'active' AND deletedAt IS NULL AND balanceMicros - heldMicros >= ${amount}`;

        if (spent === 0) {
          const account = await tx.creditAccount.findUnique({
            where: {
              id: input.accountId,
            },
          });

          if (!account) {
            throw new CreditAccountNotFoundError(input.accountId);
          }
          if (account.deletedAt) {
            throw lifecycleError("credit.account.deleted", `credit account deleted: ${input.accountId}`, 409);
          }

          assertCreditSpendAllowed(input.accountId, account.balanceMicros - account.heldMicros, amount);
          throw new InsufficientCreditError(input.accountId);
        }

        const account = await tx.creditAccount.findUniqueOrThrow({
          where: {
            id: input.accountId,
          },
        });
        const entry = await tx.creditLedgerEntry.create({
          data: {
            accountId: account.id,
            amountMicros: -amount,
            balanceAfterMicros: account.balanceMicros,
            reason: input.reason,
            idempotencyKey: input.idempotencyKey,
            ...defined("requestId", input.requestId),
          },
        });

        return {
          account: mapCreditAccount(account),
          entry: mapLedgerEntry(entry),
        };
      });
    } catch (error) {
      return this.findExistingEntryAfterUniqueConflict(error, input.idempotencyKey);
    }
  }

  async resetBalance(input: ResetBalanceInput): Promise<CreditMutationResult> {
    try {
      return await this.prisma.$transaction(async (tx) => {
        const existing = await this.findExistingEntry(tx, input.idempotencyKey);
        if (existing) {
          return existing;
        }

        // 目标非负；不得设到低于已冻结额（否则 capture 会把余额扣成负）。
        const target = parseNonNegativeBigIntString(input.targetMicros, "targetMicros");
        const before = await tx.creditAccount.findUnique({ where: { id: input.accountId } });
        if (!before) {
          throw new CreditAccountNotFoundError(input.accountId);
        }
        if (before.deletedAt) {
          throw lifecycleError("credit.account.deleted", `credit account deleted: ${input.accountId}`, 409);
        }
        if (target < before.heldMicros) {
          throw new AppError(
            "credit.reset.below_held",
            409,
            `reset target ${target} below held ${before.heldMicros} on ${input.accountId}`,
          );
        }
        const delta = target - before.balanceMicros; // 带符号调整额（可正可负），留痕不改余额于无形。
        const account = await tx.creditAccount.update({
          where: { id: input.accountId },
          data: { balanceMicros: target },
        });
        const entry = await tx.creditLedgerEntry.create({
          data: {
            accountId: account.id,
            amountMicros: delta,
            balanceAfterMicros: account.balanceMicros,
            reason: input.reason,
            idempotencyKey: input.idempotencyKey,
            ...defined("requestId", input.requestId),
          },
        });
        return { account: mapCreditAccount(account), entry: mapLedgerEntry(entry) };
      });
    } catch (error) {
      return this.findExistingEntryAfterUniqueConflict(error, input.idempotencyKey);
    }
  }

  async holdCredits(input: HoldCreditInput): Promise<CreditHold> {
    try {
      return await this.prisma.$transaction(async (tx) => {
        const existing = await this.findExistingHold(tx, input.idempotencyKey);
        if (existing) {
          return existing;
        }

        const amount = parsePositiveBigIntString(input.amountMicros, "amountMicros");
        // WHY: 原子条件更新——可用额(balance-held)≥amount 的判断与自增在 DB 同一条语句完成，
        // 行写锁串行化并发，杜绝「读-判-写」竞态导致的超额冻结（同 spend 的条件更新模式）。
        const reserved = await tx.$executeRaw`UPDATE credit_accounts SET heldMicros = heldMicros + ${amount} WHERE id = ${input.accountId} AND status = 'active' AND deletedAt IS NULL AND balanceMicros - heldMicros >= ${amount}`;
        if (reserved === 0) {
          const existingAccount = await tx.creditAccount.findUnique({
            where: {
              id: input.accountId,
            },
          });
          if (!existingAccount) {
            throw new CreditAccountNotFoundError(input.accountId);
          }
          if (existingAccount.deletedAt) {
            throw lifecycleError("credit.account.deleted", `credit account deleted: ${input.accountId}`, 409);
          }
          throw new InsufficientCreditError(input.accountId);
        }

        const hold = await tx.creditHold.create({
          data: {
            accountId: input.accountId,
            amountMicros: amount,
            status: "active",
            idempotencyKey: input.idempotencyKey,
            ...defined("expiresAt", input.expiresAt),
            ...defined("featureKey", input.featureKey),
            ...defined("labelKey", input.labelKey),
            ...defined("modelBindingId", input.modelBindingId),
            ...defined("requestId", input.requestId),
          },
        });

        return mapCreditHold(hold);
      });
    } catch (error) {
      return this.findExistingHoldAfterUniqueConflict(error, input.idempotencyKey);
    }
  }

  async captureHold(input: CaptureCreditInput): Promise<CreditMutationResult> {
    try {
      return await this.prisma.$transaction(async (tx) => {
        const existing = await this.findExistingEntry(tx, input.idempotencyKey);
        if (existing) {
          return existing;
        }

        const actualAmount = parsePositiveBigIntString(input.actualAmountMicros, "actualAmountMicros");
        const hold = await tx.creditHold.findUnique({
          where: {
            id: input.holdId,
          },
        });

        if (!hold) {
          throw new CreditHoldNotFoundError(input.holdId);
        }
        if (hold.status !== "active") {
          throw new CreditHoldNotActiveError(input.holdId, hold.status);
        }
        if (actualAmount > hold.amountMicros) {
          throw new CreditCaptureExceedsHoldError(input.holdId);
        }

        // WHY: 原子条件转移 active→captured，防止并发对同一 hold 重复结算；只有抢到者继续扣账。
        const transition = await tx.creditHold.updateMany({
          where: {
            id: hold.id,
            status: "active",
          },
          data: {
            status: "captured",
          },
        });
        if (transition.count === 0) {
          throw new CreditHoldNotActiveError(input.holdId, "captured");
        }

        const account = await tx.creditAccount.update({
          where: {
            id: hold.accountId,
          },
          data: {
            balanceMicros: {
              decrement: actualAmount,
            },
            heldMicros: {
              decrement: hold.amountMicros,
            },
          },
        });
        const entry = await tx.creditLedgerEntry.create({
          data: {
            accountId: account.id,
            amountMicros: -actualAmount,
            balanceAfterMicros: account.balanceMicros,
            reason: input.reason,
            idempotencyKey: input.idempotencyKey,
            ...defined("requestId", input.requestId),
          },
        });
        await tx.usageRecord.create({
          data: {
            accountId: account.id,
            featureKey: input.featureKey,
            amountMicros: actualAmount,
            status: "settled",
            idempotencyKey: `${input.idempotencyKey}:usage`,
            ...defined("modelBindingId", input.modelBindingId),
            ...defined("requestId", input.requestId),
          },
        });

        return {
          account: mapCreditAccount(account),
          entry: mapLedgerEntry(entry),
        };
      });
    } catch (error) {
      return this.findExistingEntryAfterUniqueConflict(error, input.idempotencyKey);
    }
  }

  async releaseHold(input: ReleaseCreditInput): Promise<CreditHold> {
    return this.prisma.$transaction(async (tx) => {
      const hold = await tx.creditHold.findUnique({
        where: {
          id: input.holdId,
        },
      });

      if (!hold) {
        throw new CreditHoldNotFoundError(input.holdId);
      }
      if (hold.status === "released") {
        return mapCreditHold(hold);
      }
      if (hold.status !== "active") {
        throw new CreditHoldNotActiveError(input.holdId, hold.status);
      }

      // WHY: 原子条件转移 active→released，防止与并发 capture/release 竞态重复释放冻结。
      const transition = await tx.creditHold.updateMany({
        where: {
          id: hold.id,
          status: "active",
        },
        data: {
          status: "released",
        },
      });
      if (transition.count === 0) {
        const current = await tx.creditHold.findUniqueOrThrow({
          where: {
            id: hold.id,
          },
        });
        if (current.status === "released") {
          return mapCreditHold(current);
        }
        throw new CreditHoldNotActiveError(input.holdId, current.status);
      }

      await tx.creditAccount.update({
        where: {
          id: hold.accountId,
        },
        data: {
          heldMicros: {
            decrement: hold.amountMicros,
          },
        },
      });
      const released = await tx.creditHold.findUniqueOrThrow({
        where: {
          id: hold.id,
        },
      });

      return mapCreditHold(released);
    });
  }

  // 过期回收：扫出 expiresAt < now 且仍 active 的 hold，逐条在独立事务里回收（短锁、单条失败不牵连其余）。
  // 返回真正回收（本次赢下 active→expired 转移）的条数。
  async sweepExpiredHolds(now: Date = new Date()): Promise<number> {
    const expired = await this.prisma.creditHold.findMany({
      where: {
        status: "active",
        // NULL expiresAt 的 hold 不设 TTL，lt 比较天然排除。
        expiresAt: { lt: now },
      },
      select: { id: true },
    });

    let reclaimed = 0;
    for (const { id } of expired) {
      if (await this.reclaimExpiredHold(id, now)) {
        reclaimed += 1;
      }
    }
    return reclaimed;
  }

  private async reclaimExpiredHold(holdId: string, now: Date): Promise<boolean> {
    return this.prisma.$transaction(async (tx) => {
      const hold = await tx.creditHold.findUnique({ where: { id: holdId } });
      // 竞态：扫描后可能已被 capture/release 抢走，或 expiresAt 被改。已非过期 active 则跳过，不动余额。
      if (!hold || hold.status !== "active" || hold.expiresAt === null || hold.expiresAt >= now) {
        return false;
      }

      // WHY: 原子条件转移 active→expired，与并发 capture/release/其他 sweep 竞争只赢一个；只有抢到者退冻结额，杜绝双释。
      const transition = await tx.creditHold.updateMany({
        where: { id: holdId, status: "active" },
        data: { status: "expired" },
      });
      if (transition.count === 0) {
        return false;
      }

      await tx.creditAccount.update({
        where: { id: hold.accountId },
        data: { heldMicros: { decrement: hold.amountMicros } },
      });
      return true;
    });
  }

  async getHoldById(id: string): Promise<CreditHold | null> {
    const hold = await this.prisma.creditHold.findUnique({ where: { id } });
    return hold ? mapCreditHold(hold) : null;
  }

  async quote(input: QuoteInput): Promise<QuoteResult> {
    const now = new Date();
    const quantity = parsePositiveBigIntString(input.quantity, "quantity");

    const rule =
      (input.labelKey !== undefined
        ? await this.findPricingRule(input.featureKey, input.labelKey, now)
        : undefined) ?? (await this.findPricingRule(input.featureKey, null, now));

    if (!rule) {
      throw new PricingRuleNotFoundError(input.featureKey);
    }

    return {
      featureKey: input.featureKey,
      labelKey: input.labelKey ?? null,
      unit: rule.unit,
      unitAmountMicros: rule.amountMicros.toString(),
      quantity: input.quantity,
      amountMicros: (rule.amountMicros * quantity).toString(),
    };
  }

  // 按 token 用量定价：input/output 各按其 unit 规则计价后求和。0 token 的方向不入账、不要求规则；
  // 有 token 的方向缺规则则抛 PricingRuleNotFoundError（fail-closed，misconfig 早暴露）。金额计算全在 credit。
  async priceUsage(input: PriceUsageInput): Promise<string> {
    const now = new Date();
    const labelKey = input.labelKey ?? null;
    const inputCost = await this.priceLine(input.featureKey, labelKey, input.inputUnit, input.inputTokens, now);
    const outputCost = await this.priceLine(input.featureKey, labelKey, input.outputUnit, input.outputTokens, now);
    return (inputCost + outputCost).toString();
  }

  private async priceLine(
    featureKey: string,
    labelKey: string | null,
    unit: string,
    tokens: string,
    now: Date,
  ): Promise<bigint> {
    const quantity = BigInt(tokens);
    if (quantity < 0n) {
      throw new Error("token quantity must be non-negative");
    }
    if (quantity === 0n) {
      return 0n;
    }
    const rule =
      (labelKey !== null ? await this.findPricingRule(featureKey, labelKey, now, unit) : null) ??
      (await this.findPricingRule(featureKey, null, now, unit));
    if (!rule) {
      throw new PricingRuleNotFoundError(featureKey);
    }
    return rule.amountMicros * quantity;
  }

  async deleteAccount(input: DeleteInput): Promise<CreditAccount> {
    return this.prisma.$transaction(async (tx) => {
      const existing = await tx.creditAccount.findUnique({ where: { id: input.id } });
      if (!existing) {
        throw lifecycleError("credit.account.not_found", `credit account not found: ${input.id}`, 404);
      }
      if (existing.deletedAt) {
        return mapCreditAccount(existing);
      }

      const activeHolds = await tx.creditHold.count({
        where: {
          accountId: input.id,
          status: "active",
        },
      });
      if (activeHolds > 0) {
        throw lifecycleError(
          "credit.account.active_hold_exists",
          `credit account has active holds: ${input.id}`,
          409,
        );
      }

      const deleted = await tx.creditAccount.update({
        where: { id: input.id },
        data: deletionData(input),
      });
      return mapCreditAccount(deleted);
    });
  }

  async restoreAccount(input: RestoreInput): Promise<CreditAccount> {
    const existing = await this.prisma.creditAccount.findUnique({ where: { id: input.id } });
    if (!existing) {
      throw lifecycleError("credit.account.not_found", `credit account not found: ${input.id}`, 404);
    }
    if (!existing.deletedAt) {
      return mapCreditAccount(existing);
    }
    const restored = await this.prisma.creditAccount.update({
      where: { id: input.id },
      data: restoreData(),
    });
    return mapCreditAccount(restored);
  }

  async createPricingRule(input: CreatePricingRuleInput): Promise<PricingRule> {
    const amountMicros = parsePositiveBigIntString(input.amountMicros, "amountMicros");
    const rule = await this.prisma.pricingRule.create({
      data: {
        featureKey: input.featureKey,
        labelKey: input.labelKey ?? null,
        unit: input.unit,
        amountMicros,
        status: input.status ?? "active",
        effectiveFrom: input.effectiveFrom ?? new Date(),
        ...defined("effectiveUntil", input.effectiveUntil ?? undefined),
      },
    });
    return mapPricingRule(rule);
  }

  // 定价编辑：仅改传入的可变字段（价校验为正整数微单位）；身份键不可变。effectiveUntil=null 清除截止。
  async updatePricingRule(input: UpdatePricingRuleInput): Promise<PricingRule> {
    const existing = await this.prisma.pricingRule.findUnique({ where: { id: input.id } });
    if (!existing) {
      throw lifecycleError("credit.pricing_rule.not_found", `pricing rule not found: ${input.id}`, 404);
    }
    const data: {
      amountMicros?: bigint;
      status?: PricingRuleStatus;
      effectiveFrom?: Date;
      effectiveUntil?: Date | null;
    } = {};
    if (input.amountMicros !== undefined) {
      data.amountMicros = parsePositiveBigIntString(input.amountMicros, "amountMicros");
    }
    if (input.status !== undefined) {
      data.status = input.status;
    }
    if (input.effectiveFrom !== undefined) {
      data.effectiveFrom = input.effectiveFrom;
    }
    if (input.effectiveUntil !== undefined) {
      data.effectiveUntil = input.effectiveUntil;
    }
    const updated = await this.prisma.pricingRule.update({ where: { id: input.id }, data });
    return mapPricingRule(updated);
  }

  async deletePricingRule(input: DeleteInput): Promise<PricingRule> {
    const existing = await this.prisma.pricingRule.findUnique({ where: { id: input.id } });
    if (!existing) {
      throw lifecycleError("credit.pricing_rule.not_found", `pricing rule not found: ${input.id}`, 404);
    }
    if (existing.deletedAt) {
      return mapPricingRule(existing);
    }
    const deleted = await this.prisma.pricingRule.update({
      where: { id: input.id },
      data: deletionData(input),
    });
    return mapPricingRule(deleted);
  }

  async restorePricingRule(input: RestoreInput): Promise<PricingRule> {
    const existing = await this.prisma.pricingRule.findUnique({ where: { id: input.id } });
    if (!existing) {
      throw lifecycleError("credit.pricing_rule.not_found", `pricing rule not found: ${input.id}`, 404);
    }
    if (!existing.deletedAt) {
      return mapPricingRule(existing);
    }
    const restored = await this.prisma.pricingRule.update({
      where: { id: input.id },
      data: restoreData(),
    });
    return mapPricingRule(restored);
  }

  async listAccounts(siteId?: string, options?: ListOptions): Promise<CreditAccount[]> {
    const accounts = await this.prisma.creditAccount.findMany({
      where: {
        ...(siteId === undefined ? {} : { siteId }),
        ...visibleRows(options),
      },
      take: 100,
      orderBy: { createdAt: "desc" },
    });
    return accounts.map(mapCreditAccount);
  }

  async listLedgerEntries(): Promise<CreditLedgerEntry[]> {
    const entries = await this.prisma.creditLedgerEntry.findMany({
      take: 100,
      orderBy: { createdAt: "desc" },
    });
    return entries.map(mapLedgerEntry);
  }

  async listUsageRecords(): Promise<UsageRecord[]> {
    const records = await this.prisma.usageRecord.findMany({
      take: 100,
      orderBy: { createdAt: "desc" },
    });
    return records.map(mapUsageRecord);
  }

  async listPricingRules(options?: ListOptions): Promise<PricingRule[]> {
    const rules = await this.prisma.pricingRule.findMany({
      where: visibleRows(options),
      take: 100,
      orderBy: { createdAt: "desc" },
    });
    return rules.map(mapPricingRule);
  }

  async getAccountById(id: string): Promise<CreditAccount | null> {
    const account = await this.prisma.creditAccount.findUnique({ where: { id } });
    return account ? mapCreditAccount(account) : null;
  }

  async findActiveAccountByOwner(input: EnsureCreditAccountInput): Promise<CreditAccount | null> {
    const account = await this.prisma.creditAccount.findUnique({
      where: {
        siteId_ownerKind_ownerId: {
          siteId: input.siteId,
          ownerKind: input.ownerKind,
          ownerId: input.ownerId,
        },
      },
    });
    // 只读不建账、不复活：软删账户视同不存在（读面零额空流水）。
    if (!account || account.deletedAt) {
      return null;
    }
    return mapCreditAccount(account);
  }

  async setAccountQuota(input: SetAccountQuotaInput): Promise<CreditAccount> {
    const account = await this.prisma.creditAccount.findUnique({ where: { id: input.accountId } });
    if (!account || account.deletedAt) {
      throw new CreditAccountNotFoundError(input.accountId);
    }
    // quotaMicros=null 清除配额（周期口径也一并置空，回退不限）；非空则连同周期落账户。
    const quotaMicros = input.quotaMicros === null ? null : BigInt(input.quotaMicros);
    const updated = await this.prisma.creditAccount.update({
      where: { id: input.accountId },
      data: {
        quotaMicros,
        quotaPeriod: quotaMicros === null ? null : input.quotaPeriod,
      },
    });
    return mapCreditAccount(updated);
  }

  async sumCapturedUsageSince(accountId: string, since: Date): Promise<string> {
    // 本周期已结算消费=用量 capture 的账本借记（reason∈model_call/tool_call，amountMicros<0）。
    // 走 (accountId, createdAt) 索引聚合；负数求和取绝对值即消费额（无记录→0）。
    const aggregate = await this.prisma.creditLedgerEntry.aggregate({
      _sum: { amountMicros: true },
      where: {
        accountId,
        reason: { in: ["model_call", "tool_call"] },
        createdAt: { gte: since },
      },
    });
    const sum = aggregate._sum.amountMicros ?? 0n;
    return (sum < 0n ? -sum : sum).toString();
  }

  async listLedgerPage(
    accountId: string,
    opts: { limit: number; cursor?: { createdAt: Date; id: string } },
  ): Promise<CreditLedgerEntry[]> {
    const cursor = opts.cursor;
    // 复合游标：严格晚于（更旧于）游标位——createdAt 更小，或 createdAt 相等且 id 更小。
    const entries = await this.prisma.creditLedgerEntry.findMany({
      where: {
        accountId,
        ...(cursor === undefined
          ? {}
          : {
              OR: [
                { createdAt: { lt: cursor.createdAt } },
                { createdAt: cursor.createdAt, id: { lt: cursor.id } },
              ],
            }),
      },
      take: opts.limit,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    });
    return entries.map(mapLedgerEntry);
  }

  async listLedgerByAccount(accountId: string): Promise<CreditLedgerEntry[]> {
    const entries = await this.prisma.creditLedgerEntry.findMany({
      where: { accountId },
      take: 200,
      orderBy: { createdAt: "desc" },
    });
    return entries.map(mapLedgerEntry);
  }

  async listHoldsByAccount(accountId: string): Promise<CreditHold[]> {
    const holds = await this.prisma.creditHold.findMany({
      where: { accountId },
      take: 200,
      orderBy: { createdAt: "desc" },
    });
    return holds.map(mapCreditHold);
  }

  async listUsageByAccount(accountId: string): Promise<UsageRecord[]> {
    const records = await this.prisma.usageRecord.findMany({
      where: { accountId },
      take: 200,
      orderBy: { createdAt: "desc" },
    });
    return records.map(mapUsageRecord);
  }

  private async findPricingRule(
    featureKey: string,
    labelKey: string | null,
    now: Date,
    unit?: string,
  ): Promise<{ unit: string; amountMicros: bigint } | null> {
    return this.prisma.pricingRule.findFirst({
      where: {
        featureKey,
        labelKey,
        status: "active",
        deletedAt: null,
        ...(unit === undefined ? {} : { unit }),
        effectiveFrom: {
          lte: now,
        },
        OR: [{ effectiveUntil: null }, { effectiveUntil: { gt: now } }],
      },
      orderBy: {
        effectiveFrom: "desc",
      },
      select: {
        unit: true,
        amountMicros: true,
      },
    });
  }

  private async findExistingHoldAfterUniqueConflict(
    error: unknown,
    idempotencyKey: string,
  ): Promise<CreditHold> {
    if (!isUniqueConstraintError(error)) {
      throw error;
    }

    const existing = await this.findExistingHold(this.prisma, idempotencyKey);
    if (!existing) {
      throw error;
    }

    return existing;
  }

  private async findExistingHold(
    tx: TransactionClient | PrismaClient,
    idempotencyKey: string,
  ): Promise<CreditHold | undefined> {
    const hold = await tx.creditHold.findUnique({
      where: {
        idempotencyKey,
      },
    });

    if (!hold) {
      return undefined;
    }

    return mapCreditHold(hold);
  }

  private async findExistingEntryAfterUniqueConflict(
    error: unknown,
    idempotencyKey: string,
  ): Promise<CreditMutationResult> {
    if (!isUniqueConstraintError(error)) {
      throw error;
    }

    const existing = await this.findExistingEntry(this.prisma, idempotencyKey);
    if (!existing) {
      throw error;
    }

    return existing;
  }

  private async findExistingEntry(
    tx: TransactionClient | PrismaClient,
    idempotencyKey: string,
  ): Promise<CreditMutationResult | undefined> {
    const entry = await tx.creditLedgerEntry.findUnique({
      where: {
        idempotencyKey,
      },
      include: {
        account: true,
      },
    });

    if (!entry) {
      return undefined;
    }

    return {
      account: mapCreditAccount(entry.account),
      entry: mapLedgerEntry(entry),
    };
  }
}

function isUniqueConstraintError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "P2002";
}

function defined<Key extends string, Value>(
  key: Key,
  value: Value | undefined,
): Partial<Record<Key, Value>> {
  if (value === undefined) {
    return {};
  }
  const out: Partial<Record<Key, Value>> = {};
  out[key] = value;
  return out;
}

function visibleRows(options: ListOptions | undefined): { deletedAt: null } | Record<string, never> {
  return options?.includeDeleted === true ? {} : { deletedAt: null };
}

function deletionData(input: DeleteInput): {
  deletedAt: Date;
  deletedBy: string;
  deleteReason: string | null;
} {
  return {
    deletedAt: new Date(),
    deletedBy: input.deletedBy,
    deleteReason: input.reason ?? null,
  };
}

function restoreData(): {
  deletedAt: null;
  deletedBy: null;
  deleteReason: null;
} {
  return {
    deletedAt: null,
    deletedBy: null,
    deleteReason: null,
  };
}

function lifecycleError(
  code: ConstructorParameters<typeof CreditLifecycleError>[0],
  message: string,
  statusCode: number,
): CreditLifecycleError {
  return new CreditLifecycleError(code, message, statusCode);
}

function assertWritableAccount(
  account: {
    id: string;
    deletedAt: Date | null;
  } | null,
  accountId: string,
): void {
  if (!account) {
    throw new CreditAccountNotFoundError(accountId);
  }
  if (account.deletedAt) {
    throw lifecycleError("credit.account.deleted", `credit account deleted: ${accountId}`, 409);
  }
}

function mapCreditAccount(account: {
  id: string;
  siteId: string;
  ownerKind: "user" | "team";
  ownerId: string;
  status: "active" | "disabled";
  balanceMicros: bigint;
  heldMicros: bigint;
  quotaMicros: bigint | null;
  quotaPeriod: "monthly" | null;
  deletedAt: Date | null;
  deletedBy: string | null;
  deleteReason: string | null;
  createdAt: Date;
  updatedAt: Date;
}): CreditAccount {
  return {
    id: account.id,
    siteId: account.siteId,
    ownerKind: account.ownerKind,
    ownerId: account.ownerId,
    status: account.status,
    balanceMicros: account.balanceMicros.toString(),
    heldMicros: account.heldMicros.toString(),
    quotaMicros: account.quotaMicros === null ? null : account.quotaMicros.toString(),
    quotaPeriod: account.quotaPeriod,
    deletedAt: account.deletedAt,
    deletedBy: account.deletedBy,
    deleteReason: account.deleteReason,
    createdAt: account.createdAt,
    updatedAt: account.updatedAt,
  };
}

function mapCreditHold(hold: {
  id: string;
  accountId: string;
  amountMicros: bigint;
  status: CreditHoldStatus;
  idempotencyKey: string;
  expiresAt: Date | null;
  featureKey: string | null;
  labelKey: string | null;
  modelBindingId: string | null;
  requestId: string | null;
  createdAt: Date;
  updatedAt: Date;
}): CreditHold {
  return {
    id: hold.id,
    accountId: hold.accountId,
    amountMicros: hold.amountMicros.toString(),
    status: hold.status,
    idempotencyKey: hold.idempotencyKey,
    expiresAt: hold.expiresAt,
    featureKey: hold.featureKey,
    labelKey: hold.labelKey,
    modelBindingId: hold.modelBindingId,
    requestId: hold.requestId,
    createdAt: hold.createdAt,
    updatedAt: hold.updatedAt,
  };
}

function mapLedgerEntry(entry: {
  id: string;
  accountId: string;
  amountMicros: bigint;
  balanceAfterMicros: bigint;
  reason: "manual_adjustment" | "subscription" | "model_call" | "tool_call" | "refund";
  idempotencyKey: string;
  requestId: string | null;
  createdAt: Date;
}): CreditLedgerEntry {
  return {
    id: entry.id,
    accountId: entry.accountId,
    amountMicros: entry.amountMicros.toString(),
    balanceAfterMicros: entry.balanceAfterMicros.toString(),
    reason: entry.reason,
    idempotencyKey: entry.idempotencyKey,
    requestId: entry.requestId,
    createdAt: entry.createdAt,
  };
}

function mapUsageRecord(record: {
  id: string;
  accountId: string | null;
  featureKey: string;
  amountMicros: bigint;
  modelBindingId: string | null;
  requestId: string | null;
  idempotencyKey: string | null;
  status: UsageRecordStatus;
  createdAt: Date;
}): UsageRecord {
  return {
    id: record.id,
    accountId: record.accountId,
    featureKey: record.featureKey,
    amountMicros: record.amountMicros.toString(),
    modelBindingId: record.modelBindingId,
    requestId: record.requestId,
    idempotencyKey: record.idempotencyKey,
    status: record.status,
    createdAt: record.createdAt,
  };
}

function mapPricingRule(rule: {
  id: string;
  featureKey: string;
  labelKey: string | null;
  unit: string;
  amountMicros: bigint;
  status: PricingRuleStatus;
  effectiveFrom: Date;
  effectiveUntil: Date | null;
  deletedAt: Date | null;
  deletedBy: string | null;
  deleteReason: string | null;
  createdAt: Date;
  updatedAt: Date;
}): PricingRule {
  return {
    id: rule.id,
    featureKey: rule.featureKey,
    labelKey: rule.labelKey,
    unit: rule.unit,
    amountMicros: rule.amountMicros.toString(),
    status: rule.status,
    effectiveFrom: rule.effectiveFrom,
    effectiveUntil: rule.effectiveUntil,
    deletedAt: rule.deletedAt,
    deletedBy: rule.deletedBy,
    deleteReason: rule.deleteReason,
    createdAt: rule.createdAt,
    updatedAt: rule.updatedAt,
  };
}
