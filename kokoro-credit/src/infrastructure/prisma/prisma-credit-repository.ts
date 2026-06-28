import { parsePositiveBigIntString } from "@kokoro/platform-kit";
import type { Prisma, PrismaClient } from "../../../generated/prisma/index.js";
import type {
  CreditAccount,
  CreditHold,
  CreditHoldStatus,
  CreditLedgerEntry,
  CreditMutationResult,
} from "../../domain/credit.js";
import { assertCreditSpendAllowed } from "../../domain/credit-policy.js";
import {
  CreditAccountNotFoundError,
  CreditCaptureExceedsHoldError,
  CreditHoldNotActiveError,
  CreditHoldNotFoundError,
  InsufficientCreditError,
} from "../../domain/errors.js";
import type {
  CaptureCreditInput,
  CreditAmountInput,
  CreditRepository,
  EnsureCreditAccountInput,
  HoldCreditInput,
  ReleaseCreditInput,
} from "../../domain/repository.js";

type TransactionClient = Prisma.TransactionClient;

export class PrismaCreditRepository implements CreditRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async ensureAccount(input: EnsureCreditAccountInput): Promise<CreditAccount> {
    const account = await this.prisma.creditAccount.upsert({
      where: {
        ownerKind_ownerId: {
          ownerKind: input.ownerKind,
          ownerId: input.ownerId,
        },
      },
      create: {
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
        const update = await tx.creditAccount.updateMany({
          where: {
            id: input.accountId,
            status: "active",
            balanceMicros: {
              gte: amount,
            },
          },
          data: {
            balanceMicros: {
              decrement: amount,
            },
          },
        });

        if (update.count === 0) {
          const account = await tx.creditAccount.findUnique({
            where: {
              id: input.accountId,
            },
          });

          if (!account) {
            throw new CreditAccountNotFoundError(input.accountId);
          }

          assertCreditSpendAllowed(input.accountId, account.balanceMicros, amount);
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
        const existingAccount = await tx.creditAccount.findUnique({
          where: {
            id: input.accountId,
          },
        });

        if (!existingAccount) {
          throw new CreditAccountNotFoundError(input.accountId);
        }

        const available = existingAccount.balanceMicros - existingAccount.heldMicros;
        if (available < amount) {
          throw new InsufficientCreditError(input.accountId);
        }

        const account = await tx.creditAccount.update({
          where: {
            id: input.accountId,
          },
          data: {
            heldMicros: {
              increment: amount,
            },
          },
        });
        const hold = await tx.creditHold.create({
          data: {
            accountId: account.id,
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
        await tx.creditHold.update({
          where: {
            id: hold.id,
          },
          data: {
            status: "captured",
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
      const released = await tx.creditHold.update({
        where: {
          id: hold.id,
        },
        data: {
          status: "released",
        },
      });

      return mapCreditHold(released);
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
