import { AppError, parsePositiveBigIntString } from "@kokoro/platform-kit";
import type { Prisma, PrismaClient } from "../../../generated/prisma/index.js";
import { parseNonNegativeBigIntString } from "../../domain/amount.js";
import type {
  CreditAccount,
  CreditAdminStats,
  CreditHold,
  CreditHoldStatus,
  CreditLedgerEntry,
  CreditMutationResult,
  CreditReason,
  PricingRule,
  PricingRuleStatus,
  QuoteResult,
  UsageByModelItem,
  UsageRecord,
  UsageRecordStatus,
} from "../../domain/credit.js";
import { available, creditBack, debit, refresh, type Buckets } from "../../domain/buckets.js";
import { dailyBoundary, isStale, periodBoundary } from "../../domain/reset-boundary.js";
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

// FOR UPDATE 行读的三桶快照（hold 准入判定用）。
interface AccountBucketRow {
  dailyMicros: bigint;
  periodMicros: bigint;
  balanceMicros: bigint;
  dailyResetOn: Date | null;
  periodResetOn: Date | null;
  dailyAllowanceMicros: bigint;
  periodAllowanceMicros: bigint;
  status: string;
  deletedAt: Date | null;
}

// 懒刷新：把行读到的桶值按水位（对比 UTC 自然日/自然月边界）刷新为额度（reset 非累加）。
// 域 refresh() 是刷新逻辑唯一事实源；此处只做 now→边界→stale 标志的换算（时区决策落这一点，见 reset-boundary.ts）。
function refreshRow(
  row: Pick<AccountBucketRow, "dailyMicros" | "periodMicros" | "balanceMicros" | "dailyResetOn" | "periodResetOn" | "dailyAllowanceMicros" | "periodAllowanceMicros">,
  now: Date,
): { buckets: Buckets; dailyResetOn: Date; periodResetOn: Date } {
  const dailyBoundaryNow = dailyBoundary(now);
  const periodBoundaryNow = periodBoundary(now);
  const dailyStale = isStale(row.dailyResetOn, dailyBoundaryNow);
  const periodStale = isStale(row.periodResetOn, periodBoundaryNow);
  const buckets = refresh(
    { daily: row.dailyMicros, period: row.periodMicros, permanent: row.balanceMicros },
    { daily: row.dailyAllowanceMicros, period: row.periodAllowanceMicros },
    { dailyStale, periodStale },
  );
  return {
    buckets,
    dailyResetOn: dailyStale ? dailyBoundaryNow : (row.dailyResetOn ?? dailyBoundaryNow),
    periodResetOn: periodStale ? periodBoundaryNow : (row.periodResetOn ?? periodBoundaryNow),
  };
}

// FOR UPDATE 行读的三桶 + 当期额度（settle/release 归还夹紧用）。
interface AccountReturnRow {
  dailyMicros: bigint;
  periodMicros: bigint;
  balanceMicros: bigint;
  dailyAllowanceMicros: bigint;
  periodAllowanceMicros: bigint;
}

export class PrismaCreditRepository implements CreditRepository {
  constructor(private readonly prisma: PrismaClient) {}

  // B1 归还：把 returned（未用差额 / 全额预留）夹紧归还各桶，并把 held 减去释放的预留总额。
  // capture（returned=reserved-spent）/ release / expire（returned=reserved 全额）共用，归还逻辑单点维护。
  // 调用方须已在同一事务内完成 hold 状态转移（active→captured/released/expired），此处只动账户桶。
  private async applyBucketReturn(
    tx: Prisma.TransactionClient,
    accountId: string,
    returned: { daily: bigint; period: bigint; permanent: bigint },
    heldDecrement: bigint,
  ): Promise<Prisma.CreditAccountGetPayload<Record<string, never>>> {
    const rows = await tx.$queryRaw<AccountReturnRow[]>`
      SELECT dailyMicros, periodMicros, balanceMicros, dailyAllowanceMicros, periodAllowanceMicros
      FROM credit_accounts WHERE id = ${accountId} FOR UPDATE`;
    const acct = rows[0];
    if (!acct) {
      throw new CreditAccountNotFoundError(accountId);
    }
    const next = creditBack(
      { daily: acct.dailyMicros, period: acct.periodMicros, permanent: acct.balanceMicros },
      returned,
      { daily: acct.dailyAllowanceMicros, period: acct.periodAllowanceMicros },
    );
    return tx.creditAccount.update({
      where: { id: accountId },
      data: {
        dailyMicros: next.daily,
        periodMicros: next.period,
        balanceMicros: next.permanent,
        heldMicros: { decrement: heldDecrement },
      },
    });
  }

  async ensureAccount(input: EnsureCreditAccountInput): Promise<{ account: CreditAccount; created: boolean }> {
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

    return { account: mapCreditAccount(account), created: !existing };
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

  async spendCredits(input: CreditAmountInput, now: Date = new Date()): Promise<CreditMutationResult> {
    try {
      return await this.prisma.$transaction(async (tx) => {
        const existing = await this.findExistingEntry(tx, input.idempotencyKey);
        if (existing) {
          return existing;
        }

        const amount = parsePositiveBigIntString(input.amountMicros, "amountMicros");
        // B1：直接扣费先懒刷新（access 触发，reset 非累加）再按过期先扣（daily→period→permanent）消费三桶。
        // 预留资金已在 hold 时移出桶，故可用额=桶之和天然不含冻结——「spend 不得动用已冻结资金」由桶模型
        // 自动保证，无需再引 held。FOR UPDATE 行锁串行化并发，域函数为刷新/扣减顺序唯一事实源。
        const rows = await tx.$queryRaw<AccountBucketRow[]>`
          SELECT dailyMicros, periodMicros, balanceMicros, dailyResetOn, periodResetOn,
                 dailyAllowanceMicros, periodAllowanceMicros, status, deletedAt
          FROM credit_accounts WHERE id = ${input.accountId} FOR UPDATE`;
        const row = rows[0];
        if (!row) {
          throw new CreditAccountNotFoundError(input.accountId);
        }
        if (row.deletedAt) {
          throw lifecycleError("credit.account.deleted", `credit account deleted: ${input.accountId}`, 409);
        }
        if (row.status !== "active") {
          throw new InsufficientCreditError(input.accountId);
        }
        const fresh = refreshRow(row, now);
        const d = debit(fresh.buckets, amount);
        if (d.shortfall > 0n) {
          throw new InsufficientCreditError(input.accountId);
        }

        const account = await tx.creditAccount.update({
          where: { id: input.accountId },
          data: {
            dailyMicros: fresh.buckets.daily - d.daily,
            periodMicros: fresh.buckets.period - d.period,
            balanceMicros: fresh.buckets.permanent - d.permanent,
            dailyResetOn: fresh.dailyResetOn,
            periodResetOn: fresh.periodResetOn,
          },
        });
        const entry = await tx.creditLedgerEntry.create({
          data: {
            accountId: account.id,
            amountMicros: -amount,
            balanceAfterMicros: available({
              daily: account.dailyMicros,
              period: account.periodMicros,
              permanent: account.balanceMicros,
            }),
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

  async holdCredits(input: HoldCreditInput, now: Date = new Date()): Promise<CreditHold> {
    try {
      return await this.prisma.$transaction(async (tx) => {
        const existing = await this.findExistingHold(tx, input.idempotencyKey);
        if (existing) {
          return existing;
        }

        const amount = parsePositiveBigIntString(input.amountMicros, "amountMicros");
        // B1 三桶预留：FOR UPDATE 行锁串行化并发 hold → 读三桶+水位 → 懒刷新（access 触发，reset 非累加）→
        // 域 debit 按过期先扣（daily→period→permanent）算每桶扣减 → shortfall>0 即可用额不足。
        // 域函数是刷新/扣减顺序的唯一事实源，不在 SQL 里重复该逻辑；刷新与扣减在同一行锁内一次写完。
        const rows = await tx.$queryRaw<AccountBucketRow[]>`
          SELECT dailyMicros, periodMicros, balanceMicros, dailyResetOn, periodResetOn,
                 dailyAllowanceMicros, periodAllowanceMicros, status, deletedAt
          FROM credit_accounts WHERE id = ${input.accountId} FOR UPDATE`;
        const row = rows[0];
        if (!row) {
          throw new CreditAccountNotFoundError(input.accountId);
        }
        if (row.deletedAt) {
          throw lifecycleError("credit.account.deleted", `credit account deleted: ${input.accountId}`, 409);
        }
        if (row.status !== "active") {
          throw new InsufficientCreditError(input.accountId);
        }
        const fresh = refreshRow(row, now);
        const d = debit(fresh.buckets, amount);
        if (d.shortfall > 0n) {
          throw new InsufficientCreditError(input.accountId);
        }

        await tx.creditAccount.update({
          where: { id: input.accountId },
          data: {
            dailyMicros: fresh.buckets.daily - d.daily,
            periodMicros: fresh.buckets.period - d.period,
            balanceMicros: fresh.buckets.permanent - d.permanent,
            dailyResetOn: fresh.dailyResetOn,
            periodResetOn: fresh.periodResetOn,
            heldMicros: { increment: amount },
          },
        });

        const hold = await tx.creditHold.create({
          data: {
            accountId: input.accountId,
            amountMicros: amount,
            reservedDailyMicros: d.daily,
            reservedPeriodMicros: d.period,
            reservedPermanentMicros: d.permanent,
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

        // 实额按预留明细顺序（过期先扣）分摊为 spent；未用差额 returned=reserved-spent 夹紧归还各桶。
        // spent 已在 hold 时从桶扣走、就此定为消费；此处只补回未用部分并释放 held。
        const reserved = {
          daily: hold.reservedDailyMicros,
          period: hold.reservedPeriodMicros,
          permanent: hold.reservedPermanentMicros,
        };
        const spent = debit(reserved, actualAmount);
        const returned = {
          daily: reserved.daily - spent.daily,
          period: reserved.period - spent.period,
          permanent: reserved.permanent - spent.permanent,
        };
        const account = await this.applyBucketReturn(tx, hold.accountId, returned, hold.amountMicros);
        const entry = await tx.creditLedgerEntry.create({
          data: {
            accountId: account.id,
            amountMicros: -actualAmount,
            // balanceAfter = 结算后可用总额（三桶之和）；daily/period=0 时等同永久桶余额（向后兼容）。
            balanceAfterMicros: available({
              daily: account.dailyMicros,
              period: account.periodMicros,
              permanent: account.balanceMicros,
            }),
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

      // 全额归还预留到各桶（夹紧到当期额度），释放 held。零成本释放：无消费、无 ledger 分录。
      await this.applyBucketReturn(
        tx,
        hold.accountId,
        {
          daily: hold.reservedDailyMicros,
          period: hold.reservedPeriodMicros,
          permanent: hold.reservedPermanentMicros,
        },
        hold.amountMicros,
      );
      const released = await tx.creditHold.findUniqueOrThrow({
        where: {
          id: hold.id,
        },
      });

      return mapCreditHold(released);
    });
  }

  // 懒刷新（只读路径）：FOR UPDATE 锁行 → 按水位刷新时间桶（惰性，未过期则不动/不写）→ 持久化 → 返回新账户。
  // 与 hold/spend 内联的刷新同用 refreshRow，逻辑单点维护；这里独立成短事务供纯读路径（如余额查询）调用。
  async refreshAllowances(accountId: string, now: Date = new Date()): Promise<CreditAccount> {
    return this.prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<AccountBucketRow[]>`
        SELECT dailyMicros, periodMicros, balanceMicros, dailyResetOn, periodResetOn,
               dailyAllowanceMicros, periodAllowanceMicros, status, deletedAt
        FROM credit_accounts WHERE id = ${accountId} FOR UPDATE`;
      const row = rows[0];
      if (!row) {
        throw new CreditAccountNotFoundError(accountId);
      }
      const dailyBoundaryNow = dailyBoundary(now);
      const periodBoundaryNow = periodBoundary(now);
      const dailyStale = isStale(row.dailyResetOn, dailyBoundaryNow);
      const periodStale = isStale(row.periodResetOn, periodBoundaryNow);
      if (!dailyStale && !periodStale) {
        return mapCreditAccount(await tx.creditAccount.findUniqueOrThrow({ where: { id: accountId } }));
      }
      const fresh = refreshRow(row, now);
      const updated = await tx.creditAccount.update({
        where: { id: accountId },
        data: {
          dailyMicros: fresh.buckets.daily,
          periodMicros: fresh.buckets.period,
          dailyResetOn: fresh.dailyResetOn,
          periodResetOn: fresh.periodResetOn,
        },
      });
      return mapCreditAccount(updated);
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

      // 过期回收 = 全额归还预留到各桶（夹紧到当期额度）+ 释放 held，同 release 语义。
      await this.applyBucketReturn(
        tx,
        hold.accountId,
        {
          daily: hold.reservedDailyMicros,
          period: hold.reservedPeriodMicros,
          permanent: hold.reservedPermanentMicros,
        },
        hold.amountMicros,
      );
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

  // 运营台聚合：存活账户计数 + 余额/冻结求和 + ledger 按符号聚合发放/消费（DB 侧 aggregate,不拉全量）。
  async readAdminStats(siteId: string): Promise<CreditAdminStats> {
    const [accountsTotal, accountsActive, liveSum, granted, spent] = await Promise.all([
      this.prisma.creditAccount.count({ where: { deletedAt: null, siteId } }),
      this.prisma.creditAccount.count({ where: { deletedAt: null, status: "active", siteId } }),
      this.prisma.creditAccount.aggregate({
        where: { deletedAt: null, siteId },
        _sum: { balanceMicros: true, heldMicros: true },
      }),
      this.prisma.creditLedgerEntry.aggregate({
        where: { amountMicros: { gt: 0 }, account: { siteId } },
        _sum: { amountMicros: true },
      }),
      this.prisma.creditLedgerEntry.aggregate({
        where: { amountMicros: { lt: 0 }, account: { siteId } },
        _sum: { amountMicros: true },
      }),
    ]);
    const spentSum = spent._sum.amountMicros ?? 0n;
    return {
      accountsTotal,
      accountsActive,
      balanceSumMicros: (liveSum._sum.balanceMicros ?? 0n).toString(),
      heldSumMicros: (liveSum._sum.heldMicros ?? 0n).toString(),
      grantedTotalMicros: (granted._sum.amountMicros ?? 0n).toString(),
      // spent 分录为负,取绝对值呈现「累计消费」。
      spentTotalMicros: (spentSum < 0n ? -spentSum : spentSum).toString(),
    };
  }

  async listLedgerEntries(siteId?: string) {
    const entries = await this.prisma.creditLedgerEntry.findMany({
      where: siteId === undefined ? {} : { account: { siteId } },
      include: { account: { select: { siteId: true } } },
      take: 100,
      orderBy: { createdAt: "desc" },
    });
    return entries.map((entry) => ({ ...mapLedgerEntry(entry), siteId: entry.account.siteId }));
  }

  async listUsageRecords(siteId?: string) {
    const records = await this.prisma.usageRecord.findMany({
      where: siteId === undefined ? { account: { isNot: null } } : { account: { siteId } },
      include: { account: { select: { siteId: true } } },
      take: 100,
      orderBy: { createdAt: "desc" },
    });
    return records.flatMap((record) =>
      record.account === null ? [] : [{ ...mapUsageRecord(record), siteId: record.account.siteId }],
    );
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

  async sumUsageByModelSince(accountId: string, since: Date): Promise<UsageByModelItem[]> {
    // 按 modelBindingId 聚合已结算(settled)用量：usage_records.amountMicros 为正消费额。
    // 走 (accountId, createdAt) 索引；modelBindingId=null 单独成组（无模型归属）。降序按消费额。
    const groups = await this.prisma.usageRecord.groupBy({
      by: ["modelBindingId"],
      where: { accountId, status: "settled", createdAt: { gte: since } },
      _sum: { amountMicros: true },
      _count: { _all: true },
    });
    return groups
      .map((g) => ({
        modelBindingId: g.modelBindingId,
        spentMicros: (g._sum.amountMicros ?? 0n).toString(),
        runCount: g._count._all,
      }))
      .sort((a, b) => (BigInt(a.spentMicros) < BigInt(b.spentMicros) ? 1 : -1));
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
  dailyMicros: bigint;
  dailyResetOn: Date | null;
  periodMicros: bigint;
  periodResetOn: Date | null;
  dailyAllowanceMicros: bigint;
  periodAllowanceMicros: bigint;
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
    dailyMicros: account.dailyMicros.toString(),
    dailyResetOn: account.dailyResetOn,
    periodMicros: account.periodMicros.toString(),
    periodResetOn: account.periodResetOn,
    dailyAllowanceMicros: account.dailyAllowanceMicros.toString(),
    periodAllowanceMicros: account.periodAllowanceMicros.toString(),
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
  reservedDailyMicros: bigint;
  reservedPeriodMicros: bigint;
  reservedPermanentMicros: bigint;
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
    reservedDailyMicros: hold.reservedDailyMicros.toString(),
    reservedPeriodMicros: hold.reservedPeriodMicros.toString(),
    reservedPermanentMicros: hold.reservedPermanentMicros.toString(),
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
  reason: CreditReason;
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
