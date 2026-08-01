import { createHash } from "node:crypto";
import {
  CommandReceiptConflictError,
  CommandReceiptRepository,
  canonicalCommandId,
  type CommandIdentity,
  type CommandReceipt,
  type JsonValue,
} from "../../../../shared/outbox-inbox/receipt.js";
import type { PlatformTransaction } from "../../../../shared/unit-of-work/index.js";
import type { ProductCatalogPublicationJournal } from
  "../../application/contracts/product-catalog-publication-journal.js";
import type { CompletedProductPublication } from
  "../../application/contracts/product-catalog-publication-journal.js";
import type {
  ProductPublicationCommand,
  ProductPublicationReceipt,
} from "../../application/product-publication-command.js";
import { resolvePlatformTransaction } from "../../../../shared/unit-of-work/platform-transaction.js";

export class PostgresProductCatalogPublicationJournal
  implements ProductCatalogPublicationJournal {
  constructor(
    private readonly receipts: Pick<CommandReceiptRepository, "begin" | "recordOutcome"> =
      new CommandReceiptRepository(),
  ) {}

  async findSucceeded(
    transaction: PlatformTransaction,
    command: ProductPublicationCommand,
  ): Promise<CompletedProductPublication | null> {
    const expected = identity(command);
    const rows = await resolvePlatformTransaction(transaction).query<CommandReceipt & Record<string, unknown>>(
      `SELECT command_id AS "commandId",environment,region,caller_identity AS "callerIdentity",
              operation,idempotency_key AS "idempotencyKey",request_digest AS "requestDigest",
              state,result,result_digest AS "resultDigest",updated_at AS "recordedAt"
       FROM platform.command_receipt
       WHERE environment=$1 AND caller_identity=$2 AND operation=$3 AND idempotency_key=$4`,
      [expected.environment, expected.callerIdentity, expected.operation, expected.idempotencyKey],
    );
    const receipt = rows[0];
    if (receipt === undefined) return null;
    assertIdentity(receipt, expected);
    if (receipt.requestDigest !== expected.requestDigest) throw new CommandReceiptConflictError("digest");
    if (receipt.state === "failed") throw new Error("PRODUCT_PUBLICATION_COMMAND_TERMINAL");
    return receipt.state === "succeeded" ? completed(normalizeReceipt(receipt), command) : null;
  }

  async begin(
    transaction: PlatformTransaction,
    command: ProductPublicationCommand,
  ): Promise<CompletedProductPublication | null> {
    const receipt = await this.receipts.begin(transaction, identity(command));
    if (receipt.state === "failed") throw new Error("PRODUCT_PUBLICATION_COMMAND_TERMINAL");
    return receipt.state === "succeeded" ? completed(receipt, command) : null;
  }

  async succeed(
    transaction: PlatformTransaction,
    command: ProductPublicationCommand,
    receipt: ProductPublicationReceipt,
  ): Promise<CompletedProductPublication> {
    const result: JsonValue = {
      schemaVersion: 1,
      commandId: command.commandId,
      requestDigest: command.requestDigest,
      operation: command.operation,
      binding: {
        ref: receipt.binding.ref,
        revision: receipt.binding.revision.toString(),
        digest: receipt.binding.digest,
      },
      publicationReplayed: receipt.replayed,
    };
    const persisted = await this.receipts.recordOutcome(transaction, identity(command), {
      state: "succeeded",
      result,
      resultDigest: createHash("sha256").update(stableJson(result)).digest("hex"),
    });
    if (persisted.recordedAt === undefined) {
      throw new Error("PRODUCT_PUBLICATION_RECEIPT_TIMESTAMP_MISSING");
    }
    return Object.freeze({
      binding: receipt.binding,
      publicationReplayed: receipt.replayed,
      recordedAt: persisted.recordedAt,
    });
  }
}

function completed(
  receipt: CommandReceipt,
  command: ProductPublicationCommand,
): CompletedProductPublication {
  if (receipt.recordedAt === undefined || receipt.result === null ||
      typeof receipt.result !== "object" || Array.isArray(receipt.result)) {
    throw new Error("PRODUCT_PUBLICATION_COMPLETED_RECEIPT_INVALID");
  }
  const result = receipt.result;
  const binding = result.binding;
  if (result.schemaVersion !== 1 || result.commandId !== command.commandId ||
      result.requestDigest !== command.requestDigest || result.operation !== command.operation ||
      typeof result.publicationReplayed !== "boolean" || binding === null ||
      typeof binding !== "object" || Array.isArray(binding) ||
      typeof binding.ref !== "string" || typeof binding.revision !== "string" ||
      !/^[1-9][0-9]*$/u.test(binding.revision) || typeof binding.digest !== "string" ||
      !/^sha256:[a-f0-9]{64}$/u.test(binding.digest) ||
      binding.ref !== command.binding.ref || BigInt(binding.revision) !== command.binding.revision ||
      binding.digest !== command.binding.digest) {
    throw new Error("PRODUCT_PUBLICATION_COMPLETED_RECEIPT_INVALID");
  }
  if (receipt.resultDigest === null ||
      createHash("sha256").update(stableJson(result)).digest("hex") !== receipt.resultDigest) {
    throw new Error("PRODUCT_PUBLICATION_COMPLETED_RECEIPT_DIGEST_INVALID");
  }
  return Object.freeze({
    binding: Object.freeze({ ref: binding.ref, revision: BigInt(binding.revision), digest: binding.digest }),
    publicationReplayed: result.publicationReplayed,
    recordedAt: receipt.recordedAt,
  });
}

function normalizeReceipt(receipt: CommandReceipt): CommandReceipt {
  const raw = receipt.recordedAt as unknown;
  const recordedAt = raw instanceof Date ? raw.toISOString()
    : typeof raw === "string" ? new Date(raw).toISOString() : undefined;
  if (recordedAt === undefined || !Number.isFinite(Date.parse(recordedAt))) {
    throw new Error("PRODUCT_PUBLICATION_COMPLETED_RECEIPT_TIME_INVALID");
  }
  return Object.freeze({ ...receipt, recordedAt });
}

function assertIdentity(receipt: CommandReceipt, expected: CommandIdentity): void {
  if (canonicalCommandId(receipt.commandId) !== canonicalCommandId(expected.commandId) ||
      receipt.environment !== expected.environment || receipt.region !== expected.region ||
      receipt.callerIdentity !== expected.callerIdentity || receipt.operation !== expected.operation ||
      receipt.idempotencyKey !== expected.idempotencyKey) {
    throw new CommandReceiptConflictError("identity");
  }
}

function identity(command: ProductPublicationCommand): CommandIdentity {
  return {
    commandId: command.commandId,
    environment: command.security.environment,
    region: command.security.region,
    callerIdentity: command.security.callerIdentity,
    operation: command.operation,
    idempotencyKey: command.idempotencyKey,
    requestDigest: command.requestDigest,
  };
}

function stableJson(value: JsonValue): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  return `{${Object.entries(value).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`).join(",")}}`;
}
