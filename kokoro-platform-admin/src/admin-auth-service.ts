import { createHash } from "node:crypto";
import { create } from "@bufbuild/protobuf";
import { timestampDate, timestampFromDate } from "@bufbuild/protobuf/wkt";
import type { ServiceImpl } from "@connectrpc/connect";
import { RpcFailure } from "@kokoro/platform-kit";
import {
  CommandReceiptSchema,
  CommandReceiptState,
} from "./generated/contracts/kokoro/common/v1/receipt_pb.js";
import {
  AdminAuthService,
  AuthEventKind,
  GetCommandReceiptResponseSchema,
  OperatorStatus,
} from "./generated/contracts/kokoro/platform/admin/v1/admin_auth_pb.js";
import {
  executeAdminAuthCommand,
  type AdminAuthCommandIdentity,
  type AdminAuthEventValue,
  type AdminAuthReceiptRecord,
  type AdminAuthReceiptResult,
  type AdminAuthStore,
} from "./admin-auth-receipt.js";

export interface AdminAuthServiceOptions {
  now?: () => Date;
}

const CREATE_TOKEN_OPERATION = "admin_auth.create_verification_token";
const CONSUME_TOKEN_OPERATION = "admin_auth.consume_verification_token";
const RECORD_EVENT_OPERATION = "admin_auth.record_auth_event";

function payloadDigest(operation: string, payload: Record<string, string>): string {
  return createHash("sha256").update(JSON.stringify({ operation, payload }), "utf8").digest("hex");
}

function requirePayloadDigest(identity: AdminAuthCommandIdentity, expected: string): void {
  if (identity.requestDigest !== expected) {
    throw new RpcFailure("validation", "command.digest_invalid", "Command digest does not match request");
  }
}

function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}

function requireIdentity(command: AdminAuthCommandIdentity | undefined): AdminAuthCommandIdentity {
  if (
    command === undefined ||
    command.commandId.length === 0 ||
    command.idempotencyKey.length === 0 ||
    command.requestDigest.length === 0
  ) {
    throw new RpcFailure("validation", "command.invalid", "Command identity is required");
  }
  return {
    commandId: command.commandId,
    idempotencyKey: command.idempotencyKey,
    requestDigest: command.requestDigest,
  };
}

function eventValue(value: AuthEventKind): AdminAuthEventValue {
  if (value === AuthEventKind.SIGN_IN) return "signin";
  if (value === AuthEventKind.SIGN_OUT) return "signout";
  if (value === AuthEventKind.DENIED) return "denied";
  throw new RpcFailure("validation", "auth_event.invalid", "Auth event is invalid");
}

function eventKind(value: AdminAuthEventValue): AuthEventKind {
  if (value === "signin") return AuthEventKind.SIGN_IN;
  if (value === "signout") return AuthEventKind.SIGN_OUT;
  return AuthEventKind.DENIED;
}

function receiptMessage(receipt: AdminAuthReceiptRecord) {
  return create(CommandReceiptSchema, {
    identity: {
      commandId: receipt.commandId,
      idempotencyKey: receipt.idempotencyKey,
      requestDigest: receipt.requestDigest,
    },
    operation: receipt.operation,
    state:
      receipt.state === "committed"
        ? CommandReceiptState.COMMITTED
        : receipt.state === "accepted"
          ? CommandReceiptState.ACCEPTED
          : receipt.state === "rejected"
            ? CommandReceiptState.REJECTED
            : CommandReceiptState.OUTCOME_UNKNOWN,
    recordedAt: timestampFromDate(receipt.recordedAt),
  });
}

function receiptResponse(receipt: AdminAuthReceiptRecord) {
  const base = { receipt: receiptMessage(receipt) };
  if (receipt.result?.kind === "verification_token") {
    return create(GetCommandReceiptResponseSchema, {
      ...base,
      result: {
        case: "verificationToken",
        value: {
          identifier: receipt.result.identifier,
          expires: timestampFromDate(receipt.result.expires),
          consumed: receipt.result.consumed,
        },
      },
    });
  }
  if (receipt.result?.kind === "auth_event") {
    return create(GetCommandReceiptResponseSchema, {
      ...base,
      result: {
        case: "authEvent",
        value: {
          event: eventKind(receipt.result.event),
          occurredAt: timestampFromDate(receipt.result.occurredAt),
        },
      },
    });
  }
  return create(GetCommandReceiptResponseSchema, { ...base, result: { case: undefined } });
}

function requireResult<T extends AdminAuthReceiptResult["kind"]>(
  receipt: AdminAuthReceiptRecord,
  kind: T,
): Extract<AdminAuthReceiptResult, { kind: T }> {
  if (receipt.result?.kind !== kind) {
    throw new RpcFailure("unavailable", "command.result_unavailable", "Command result unavailable", {
      retryClass: "reconcile_receipt",
      receiptRef: receipt.commandId,
    });
  }
  return receipt.result as Extract<AdminAuthReceiptResult, { kind: T }>;
}

async function safeQuery<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof RpcFailure) throw error;
    throw new RpcFailure("unavailable", "admin_auth.persistence_unavailable", "Admin Auth persistence unavailable", {
      cause: error,
      retryClass: "after_delay",
    });
  }
}

export function createAdminAuthService(
  store: AdminAuthStore,
  options: AdminAuthServiceOptions = {},
): ServiceImpl<typeof AdminAuthService> {
  const currentTime = options.now ?? (() => new Date());
  return {
    async getOperatorByEmail(request) {
      const operator = await safeQuery(() => store.findOperatorByEmail(normalizeEmail(request.email)));
      if (operator === null) throw new RpcFailure("not_found", "operator.not_found", "Operator not found");
      return {
        operator: {
          id: operator.id,
          email: operator.email,
          displayName: operator.displayName,
          status: operator.status === "active" ? OperatorStatus.ACTIVE : OperatorStatus.DISABLED,
        },
      };
    },
    async getOperator(request) {
      const operator = await safeQuery(() => store.findOperatorById(request.id));
      if (operator === null) throw new RpcFailure("not_found", "operator.not_found", "Operator not found");
      return {
        operator: {
          id: operator.id,
          email: operator.email,
          displayName: operator.displayName,
          status: operator.status === "active" ? OperatorStatus.ACTIVE : OperatorStatus.DISABLED,
        },
      };
    },
    async createVerificationToken(request) {
      if (request.expires === undefined) {
        throw new RpcFailure("validation", "verification_token.invalid", "Verification token expiry is required");
      }
      const identity = requireIdentity(request.command);
      const expires = timestampDate(request.expires);
      const identifier = normalizeEmail(request.identifier);
      requirePayloadDigest(
        identity,
        payloadDigest(CREATE_TOKEN_OPERATION, {
          identifier,
          token: request.token,
          expires: expires.toISOString(),
        }),
      );
      const receipt = await executeAdminAuthCommand(
        store,
        identity,
        CREATE_TOKEN_OPERATION,
        currentTime(),
        async (transaction) => {
          const created = await transaction.createVerificationToken({
            identifier,
            token: request.token,
            expires,
          });
          return { kind: "verification_token", identifier: created.identifier, expires: created.expires, consumed: false };
        },
      );
      const result = requireResult(receipt, "verification_token");
      return {
        verificationToken: {
          identifier: result.identifier,
          token: request.token,
          expires: timestampFromDate(result.expires),
        },
        receipt: receiptMessage(receipt),
      };
    },
    async consumeVerificationToken(request) {
      const identity = requireIdentity(request.command);
      const identifier = normalizeEmail(request.identifier);
      requirePayloadDigest(identity, payloadDigest(CONSUME_TOKEN_OPERATION, { identifier, token: request.token }));
      const receipt = await executeAdminAuthCommand(
        store,
        identity,
        CONSUME_TOKEN_OPERATION,
        currentTime(),
        async (transaction) => {
          const consumed = await transaction.consumeVerificationToken({
            identifier,
            token: request.token,
          });
          if (consumed === null) {
            throw new RpcFailure("not_found", "verification_token.not_found", "Verification token not found");
          }
          return { kind: "verification_token", identifier: consumed.identifier, expires: consumed.expires, consumed: true };
        },
      );
      const result = requireResult(receipt, "verification_token");
      return {
        verificationToken: {
          identifier: result.identifier,
          token: request.token,
          expires: timestampFromDate(result.expires),
        },
        receipt: receiptMessage(receipt),
      };
    },
    async recordAuthEvent(request) {
      if (request.occurredAt === undefined) {
        throw new RpcFailure("validation", "auth_event.invalid", "Auth event timestamp is required");
      }
      const identity = requireIdentity(request.command);
      const event = eventValue(request.event);
      const occurredAt = timestampDate(request.occurredAt);
      const email = normalizeEmail(request.email);
      requirePayloadDigest(
        identity,
        payloadDigest(RECORD_EVENT_OPERATION, {
          email,
          event,
          reason: request.reason ?? "",
          occurredAt: occurredAt.toISOString(),
        }),
      );
      const receipt = await executeAdminAuthCommand(
        store,
        identity,
        RECORD_EVENT_OPERATION,
        currentTime(),
        async (transaction) => {
          await transaction.recordAuthEvent({
            email,
            event,
            reason: request.reason ?? null,
            occurredAt,
          });
          return { kind: "auth_event", event, occurredAt };
        },
      );
      return { receipt: receiptMessage(receipt) };
    },
    async getCommandReceipt(request) {
      const receipt = await safeQuery(() => store.findReceiptByCommandId(request.commandId));
      if (receipt === null) throw new RpcFailure("not_found", "command.receipt_not_found", "Command receipt not found");
      if (receipt.requestDigest !== request.requestDigest) {
        throw new RpcFailure("conflict", "command.digest_conflict", "Command digest conflict");
      }
      return receiptResponse(receipt);
    },
  };
}
