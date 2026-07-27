import { create } from "@bufbuild/protobuf";
import { timestampDate, timestampFromDate } from "@bufbuild/protobuf/wkt";
import type { ServiceImpl } from "@connectrpc/connect";
import { RpcFailure } from "@kokoro/platform-kit";
import {
  CommandDigestAlgorithm,
  CommandReceiptSchema,
  CommandReceiptState,
  type CommandIdentity as WireCommandIdentity,
} from "./generated/contracts/kokoro/common/v1/receipt_pb.js";
import {
  canonicalizeConsumeVerificationTokenEffect,
  canonicalizeCreateVerificationTokenEffect,
  canonicalizeRecordAuthEventEffect,
  consumeVerificationTokenEffectDigest,
  createVerificationTokenEffectDigest,
  recordAuthEventEffectDigest,
} from "./generated/contracts/admin-auth-effect-digest.js";
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

function requirePayloadDigest(identity: AdminAuthCommandIdentity, expected: string): void {
  if (identity.requestDigest !== expected) {
    throw new RpcFailure("validation", "command.digest_invalid", "Command digest does not match request");
  }
}

function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}

function requireIdentity(command: WireCommandIdentity | undefined): AdminAuthCommandIdentity {
  if (
    command === undefined ||
    command.commandId.length === 0 ||
    command.idempotencyKey.length === 0 ||
    command.digestAlgorithm !== CommandDigestAlgorithm.SHA256_PROTOBUF_V1 ||
    command.requestDigest.length === 0
  ) {
    throw new RpcFailure("validation", "command.invalid", "Command identity is required");
  }
  return {
    commandId: command.commandId,
    idempotencyKey: command.idempotencyKey,
    digestAlgorithm: "sha256_protobuf_v1",
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
      digestAlgorithm: CommandDigestAlgorithm.SHA256_PROTOBUF_V1,
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
      if (request.effect?.expires === undefined) {
        throw new RpcFailure("validation", "verification_token.invalid", "Verification token expiry is required");
      }
      const identity = requireIdentity(request.command);
      const effect = canonicalizeCreateVerificationTokenEffect(request.effect);
      const expires = timestampDate(effect.expires!);
      requirePayloadDigest(identity, createVerificationTokenEffectDigest(effect));
      const receipt = await executeAdminAuthCommand(
        store,
        identity,
        CREATE_TOKEN_OPERATION,
        currentTime(),
        async (transaction) => {
          const created = await transaction.createVerificationToken({
            identifier: effect.identifier,
            token: effect.token,
            expires,
          });
          return { kind: "verification_token", identifier: created.identifier, expires: created.expires, consumed: false };
        },
      );
      const result = requireResult(receipt, "verification_token");
      return {
        verificationToken: {
          identifier: result.identifier,
          token: effect.token,
          expires: timestampFromDate(result.expires),
        },
        receipt: receiptMessage(receipt),
      };
    },
    async consumeVerificationToken(request) {
      if (request.effect === undefined) {
        throw new RpcFailure("validation", "verification_token.invalid", "Verification token effect is required");
      }
      const identity = requireIdentity(request.command);
      const effect = canonicalizeConsumeVerificationTokenEffect(request.effect);
      requirePayloadDigest(identity, consumeVerificationTokenEffectDigest(effect));
      const receipt = await executeAdminAuthCommand(
        store,
        identity,
        CONSUME_TOKEN_OPERATION,
        currentTime(),
        async (transaction) => {
          const consumed = await transaction.consumeVerificationToken({
            identifier: effect.identifier,
            token: effect.token,
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
          token: effect.token,
          expires: timestampFromDate(result.expires),
        },
        receipt: receiptMessage(receipt),
      };
    },
    async recordAuthEvent(request) {
      if (request.effect?.occurredAt === undefined) {
        throw new RpcFailure("validation", "auth_event.invalid", "Auth event timestamp is required");
      }
      const identity = requireIdentity(request.command);
      const effect = canonicalizeRecordAuthEventEffect(request.effect);
      const event = eventValue(effect.event);
      const occurredAt = timestampDate(effect.occurredAt!);
      requirePayloadDigest(identity, recordAuthEventEffectDigest(effect));
      const receipt = await executeAdminAuthCommand(
        store,
        identity,
        RECORD_EVENT_OPERATION,
        currentTime(),
        async (transaction) => {
          await transaction.recordAuthEvent({
            email: effect.email,
            event,
            reason: effect.reason ?? null,
            occurredAt,
          });
          return { kind: "auth_event", event, occurredAt };
        },
      );
      return { receipt: receiptMessage(receipt) };
    },
    async getCommandReceipt(request) {
      if (request.digestAlgorithm !== CommandDigestAlgorithm.SHA256_PROTOBUF_V1) {
        throw new RpcFailure("validation", "command.digest_algorithm_invalid", "Command digest algorithm is invalid");
      }
      const receipt = await safeQuery(() => store.findReceiptByCommandId(request.commandId));
      if (receipt === null) throw new RpcFailure("not_found", "command.receipt_not_found", "Command receipt not found");
      if (receipt.digestAlgorithm !== "sha256_protobuf_v1" || receipt.requestDigest !== request.requestDigest) {
        throw new RpcFailure("conflict", "command.digest_conflict", "Command digest conflict");
      }
      return receiptResponse(receipt);
    },
  };
}
