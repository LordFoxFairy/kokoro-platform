import type { Prisma, PrismaClient } from "../generated/prisma/index.js";
import {
  ReceiptAlreadyExistsError,
  type AdminAuthReceiptRecord,
  type AdminAuthReceiptResult,
  type AdminAuthStore,
  type AdminAuthTransaction,
} from "./admin-auth-receipt.js";

export type {
  AdminAuthCommandIdentity,
  AdminAuthEventValue,
  AdminAuthOperator,
  AdminAuthReceiptRecord,
  AdminAuthReceiptResult,
  AdminAuthStore,
  AdminAuthTransaction,
  AdminVerificationToken,
  NewAdminAuthReceipt,
} from "./admin-auth-receipt.js";

type PrismaTransaction = Prisma.TransactionClient;

function isUniqueConflict(error: unknown): boolean {
  return typeof error === "object" && error !== null && Reflect.get(error, "code") === "P2002";
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && Reflect.get(error, "code") === "P2025";
}

function serializeResult(result: AdminAuthReceiptResult): Prisma.InputJsonValue {
  if (result.kind === "verification_token") {
    return {
      kind: result.kind,
      identifier: result.identifier,
      expires: result.expires.toISOString(),
      consumed: result.consumed,
    };
  }
  return { kind: result.kind, event: result.event, occurredAt: result.occurredAt.toISOString() };
}

function parseResult(value: Prisma.JsonValue | null): AdminAuthReceiptResult | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  if (
    value.kind === "verification_token" &&
    typeof value.identifier === "string" &&
    typeof value.expires === "string" &&
    typeof value.consumed === "boolean"
  ) {
    return {
      kind: "verification_token",
      identifier: value.identifier,
      expires: new Date(value.expires),
      consumed: value.consumed,
    };
  }
  if (
    value.kind === "auth_event" &&
    (value.event === "signin" || value.event === "signout" || value.event === "denied") &&
    typeof value.occurredAt === "string"
  ) {
    return { kind: "auth_event", event: value.event, occurredAt: new Date(value.occurredAt) };
  }
  return null;
}

function mapReceipt(value: {
  commandId: string;
  idempotencyKey: string;
  digestAlgorithm: "sha256_protobuf_v1";
  requestDigest: string;
  operation: string;
  state: "accepted" | "committed" | "rejected" | "outcome_unknown";
  result: Prisma.JsonValue | null;
  updatedAt: Date;
}): AdminAuthReceiptRecord {
  return {
    commandId: value.commandId,
    idempotencyKey: value.idempotencyKey,
    digestAlgorithm: value.digestAlgorithm,
    requestDigest: value.requestDigest,
    operation: value.operation,
    state: value.state,
    result: parseResult(value.result),
    recordedAt: value.updatedAt,
  };
}

const receiptSelect = {
  commandId: true,
  idempotencyKey: true,
  digestAlgorithm: true,
  requestDigest: true,
  operation: true,
  state: true,
  result: true,
  updatedAt: true,
} as const;

function makeTransaction(transaction: PrismaTransaction): AdminAuthTransaction {
  return {
    async findReceiptByCommandId(commandId) {
      const receipt = await transaction.adminAuthCommandReceipt.findUnique({
        where: { commandId },
        select: receiptSelect,
      });
      return receipt === null ? null : mapReceipt(receipt);
    },
    async findReceiptByIdempotencyKey(idempotencyKey) {
      const receipt = await transaction.adminAuthCommandReceipt.findUnique({
        where: { idempotencyKey },
        select: receiptSelect,
      });
      return receipt === null ? null : mapReceipt(receipt);
    },
    async createReceipt(receipt) {
      try {
        return mapReceipt(
          await transaction.adminAuthCommandReceipt.create({
            data: {
              commandId: receipt.commandId,
              idempotencyKey: receipt.idempotencyKey,
              digestAlgorithm: receipt.digestAlgorithm,
              requestDigest: receipt.requestDigest,
              operation: receipt.operation,
              state: "accepted",
              createdAt: receipt.recordedAt,
              updatedAt: receipt.recordedAt,
            },
            select: receiptSelect,
          }),
        );
      } catch (error) {
        if (isUniqueConflict(error)) throw new ReceiptAlreadyExistsError();
        throw error;
      }
    },
    async commitReceipt(commandId, result, recordedAt) {
      return mapReceipt(
        await transaction.adminAuthCommandReceipt.update({
          where: { commandId },
          data: { state: "committed", result: serializeResult(result), updatedAt: recordedAt },
          select: receiptSelect,
        }),
      );
    },
    async createVerificationToken(value) {
      return transaction.verificationToken.create({ data: value });
    },
    async consumeVerificationToken({ identifier, token }) {
      try {
        return await transaction.verificationToken.delete({
          where: { identifier_token: { identifier, token } },
        });
      } catch (error) {
        if (isNotFound(error)) return null;
        throw error;
      }
    },
    async recordAuthEvent(value) {
      await transaction.authEvent.create({ data: value });
    },
  };
}

export function makePrismaAdminAuthStore(prisma: PrismaClient): AdminAuthStore {
  const operatorSelect = { id: true, email: true, displayName: true, status: true } as const;
  return {
    async findOperatorByEmail(email) {
      return prisma.operatorAccount.findUnique({ where: { email }, select: operatorSelect });
    },
    async findOperatorById(id) {
      return prisma.operatorAccount.findUnique({ where: { id }, select: operatorSelect });
    },
    async findReceiptByCommandId(commandId) {
      const receipt = await prisma.adminAuthCommandReceipt.findUnique({
        where: { commandId },
        select: receiptSelect,
      });
      return receipt === null ? null : mapReceipt(receipt);
    },
    async transaction(run) {
      return prisma.$transaction(async (transaction) => run(makeTransaction(transaction)));
    },
  };
}
