import { parsePositiveBigIntString } from "@kokoro/platform-kit";
import type { Prisma, PrismaClient } from "../../../generated/prisma/index.js";
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
  CreditAmountInput,
  CreditRepository,
  EnsureCreditAccountInput,
  HoldCreditInput,
  QuoteInput,
  ReleaseCreditInput,
} from "../../domain/repository.js";

type TransactionClient = Prisma.TransactionClient;

export class PrismaCreditRepository implements CreditRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async ensureAccount(input: EnsureCreditAccountInput): Promise<CreditAccount> {
    const account = await this.prisma.creditAccount.upsert({
      where: {
        siteId_ownerKind_ownerId: {
          siteId: input.siteId,
          ownerKind: input.ownerKind,
          ownerId: input.ownerId,
        },
      },
      create: {
        siteId: input.siteId,
        ownerKind: input.ownerKind,
        ownerId: input.ownerId,
        status: "active",
      },
      update: {
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
        const spent = await tx.$executeRaw`UPDATE credit_accounts SET balanceMicros = balanceMicros - ${amount} WHERE id = ${input.accountId} AND status = 'active' AND balanceMicros - heldMicros >= ${amount}`;

        if (spent === 0) {
          const account = await tx.creditAccount.findUnique({
            where: {
              id: input.accountId,
            },
          });

          if (!account) {
            throw new CreditAccountNotFoundError(input.accountId);
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
        const reserved = await tx.$executeRaw`UPDATE credit_accounts SET heldMicros = heldMicros + ${amount} WHERE id = ${input.accountId} AND balanceMicros - heldMicros >= ${amount}`;
        if (reserved === 0) {
          const existingAccount = await tx.creditAccount.findUnique({
            where: {
              id: input.accountId,
            },
          });
          if (!existingAccount) {
            throw new CreditAccountNotFoundError(input.accountId);
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

  async listAccounts(siteId?: string): Promise<CreditAccount[]> {
    const accounts = await this.prisma.creditAccount.findMany({
      ...(siteId === undefined ? {} : { where: { siteId } }),
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

  async listPricingRules(): Promise<PricingRule[]> {
    const rules = await this.prisma.pricingRule.findMany({
      take: 100,
      orderBy: { createdAt: "desc" },
    });
    return rules.map(mapPricingRule);
  }

  async getAccountById(id: string): Promise<CreditAccount | null> {
    const account = await this.prisma.creditAccount.findUnique({ where: { id } });
    return account ? mapCreditAccount(account) : null;
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
  ): Promise<{ unit: string; amountMicros: bigint } | null> {
    return this.prisma.pricingRule.findFirst({
      where: {
        featureKey,
        labelKey,
        status: "active",
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

function mapCreditAccount(account: {
  id: string;
  siteId: string;
  ownerKind: "user" | "team";
  ownerId: string;
  status: "active" | "disabled";
  balanceMicros: bigint;
  heldMicros: bigint;
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
    createdAt: rule.createdAt,
    updatedAt: rule.updatedAt,
  };
}
