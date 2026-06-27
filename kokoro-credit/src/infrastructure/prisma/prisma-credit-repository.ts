import { parsePositiveBigIntString } from "@kokoro/platform-kit";
import type { Prisma, PrismaClient } from "../../../generated/prisma/index.js";
import type { CreditAccount, CreditLedgerEntry, CreditMutationResult } from "../../domain/credit.js";
import { assertCreditSpendAllowed } from "../../domain/credit-policy.js";
import { CreditAccountNotFoundError, InsufficientCreditError } from "../../domain/errors.js";
import type {
  CreditAmountInput,
  CreditRepository,
  EnsureCreditAccountInput,
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
    return this.prisma.$transaction(async (tx) => {
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
  }

  async spendCredits(input: CreditAmountInput): Promise<CreditMutationResult> {
    return this.prisma.$transaction(async (tx) => {
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
  }

  private async findExistingEntry(
    tx: TransactionClient,
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

function defined<Key extends string, Value>(
  key: Key,
  value: Value | undefined,
): Record<Key, Value> | Record<string, never> {
  return value === undefined ? {} : ({ [key]: value } as Record<Key, Value>);
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
