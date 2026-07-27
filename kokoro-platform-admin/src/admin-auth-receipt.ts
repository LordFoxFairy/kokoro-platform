import { RpcFailure } from "@kokoro/platform-kit";

export interface AdminAuthCommandIdentity {
  commandId: string;
  idempotencyKey: string;
  digestAlgorithm: "sha256_protobuf_v1";
  requestDigest: string;
}

export type AdminAuthEventValue = "signin" | "signout" | "denied";

export type AdminAuthReceiptResult =
  | { kind: "verification_token"; identifier: string; expires: Date; consumed: boolean }
  | { kind: "auth_event"; event: AdminAuthEventValue; occurredAt: Date };

export interface AdminAuthReceiptRecord extends AdminAuthCommandIdentity {
  operation: string;
  state: "accepted" | "committed" | "rejected" | "outcome_unknown";
  result: AdminAuthReceiptResult | null;
  recordedAt: Date;
}

export type NewAdminAuthReceipt = Omit<AdminAuthReceiptRecord, "state" | "result">;

export interface AdminAuthOperator {
  id: string;
  email: string;
  displayName: string;
  status: "active" | "disabled";
}

export interface AdminVerificationToken {
  identifier: string;
  token: string;
  expires: Date;
}

export interface AdminAuthTransaction {
  findReceiptByCommandId(commandId: string): Promise<AdminAuthReceiptRecord | null>;
  findReceiptByIdempotencyKey(idempotencyKey: string): Promise<AdminAuthReceiptRecord | null>;
  createReceipt(receipt: NewAdminAuthReceipt): Promise<AdminAuthReceiptRecord>;
  commitReceipt(
    commandId: string,
    result: AdminAuthReceiptResult,
    recordedAt: Date,
  ): Promise<AdminAuthReceiptRecord>;
  createVerificationToken(value: AdminVerificationToken): Promise<AdminVerificationToken>;
  consumeVerificationToken(
    value: Pick<AdminVerificationToken, "identifier" | "token">,
  ): Promise<AdminVerificationToken | null>;
  recordAuthEvent(value: {
    email: string;
    event: AdminAuthEventValue;
    reason: string | null;
    occurredAt: Date;
  }): Promise<void>;
}

export interface AdminAuthStore {
  findOperatorByEmail(email: string): Promise<AdminAuthOperator | null>;
  findOperatorById(id: string): Promise<AdminAuthOperator | null>;
  findReceiptByCommandId(commandId: string): Promise<AdminAuthReceiptRecord | null>;
  transaction<T>(run: (transaction: AdminAuthTransaction) => Promise<T>): Promise<T>;
}

export class ReceiptAlreadyExistsError extends Error {
  constructor() {
    super("receipt already exists");
    this.name = "ReceiptAlreadyExistsError";
  }
}

function replayOrConflict(
  receipt: AdminAuthReceiptRecord,
  identity: AdminAuthCommandIdentity,
  operation: string,
): AdminAuthReceiptRecord {
  if (
    receipt.commandId !== identity.commandId ||
    receipt.idempotencyKey !== identity.idempotencyKey ||
    receipt.digestAlgorithm !== identity.digestAlgorithm ||
    receipt.operation !== operation
  ) {
    throw new RpcFailure("conflict", "command.identity_conflict", "Command identity conflict");
  }
  if (receipt.requestDigest !== identity.requestDigest) {
    throw new RpcFailure("conflict", "command.digest_conflict", "Command digest conflict");
  }
  if (receipt.state !== "committed" || receipt.result === null) {
    throw new RpcFailure("unavailable", "command.outcome_unknown", "Command outcome requires reconciliation", {
      retryClass: "reconcile_receipt",
      receiptRef: receipt.commandId,
    });
  }
  return receipt;
}

async function executeOnce(
  store: AdminAuthStore,
  identity: AdminAuthCommandIdentity,
  operation: string,
  recordedAt: Date,
  effect: (transaction: AdminAuthTransaction) => Promise<AdminAuthReceiptResult>,
): Promise<AdminAuthReceiptRecord> {
  return store.transaction(async (transaction) => {
    const byCommand = await transaction.findReceiptByCommandId(identity.commandId);
    if (byCommand !== null) return replayOrConflict(byCommand, identity, operation);
    const byIdempotency = await transaction.findReceiptByIdempotencyKey(identity.idempotencyKey);
    if (byIdempotency !== null) return replayOrConflict(byIdempotency, identity, operation);

    await transaction.createReceipt({ ...identity, operation, recordedAt });
    const result = await effect(transaction);
    return transaction.commitReceipt(identity.commandId, result, recordedAt);
  });
}

export async function executeAdminAuthCommand(
  store: AdminAuthStore,
  identity: AdminAuthCommandIdentity,
  operation: string,
  recordedAt: Date,
  effect: (transaction: AdminAuthTransaction) => Promise<AdminAuthReceiptResult>,
): Promise<AdminAuthReceiptRecord> {
  try {
    return await executeOnce(store, identity, operation, recordedAt, effect);
  } catch (error) {
    if (error instanceof ReceiptAlreadyExistsError) {
      try {
        return await executeOnce(store, identity, operation, recordedAt, effect);
      } catch (retryError) {
        if (retryError instanceof RpcFailure) throw retryError;
        throw new RpcFailure("unavailable", "admin_auth.persistence_unavailable", "Admin Auth persistence unavailable", {
          cause: retryError,
          retryClass: "reconcile_receipt",
          receiptRef: identity.commandId,
        });
      }
    }
    if (error instanceof RpcFailure) throw error;
    throw new RpcFailure("unavailable", "admin_auth.persistence_unavailable", "Admin Auth persistence unavailable", {
      cause: error,
      retryClass: "reconcile_receipt",
      receiptRef: identity.commandId,
    });
  }
}
