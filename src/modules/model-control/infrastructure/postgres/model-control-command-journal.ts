import { createHash } from "node:crypto";
import { OutboxRepository } from "../../../../shared/outbox-inbox/outbox.js";
import {
  CommandReceiptRepository,
  type CommandIdentity,
  type JsonValue,
} from "../../../../shared/outbox-inbox/receipt.js";
import type { PlatformTransaction } from "../../../../shared/unit-of-work/index.js";
import type { ModelControlCommandJournal } from "../../application/contracts/model-control-command-journal.js";
import {
  modelControlEventFor,
  type ModelControlCommand,
  type ModelControlCommandReceipt,
} from "../../application/model-control-command.js";

export class PostgresModelControlCommandJournal implements ModelControlCommandJournal {
  constructor(
    private readonly receipts: Pick<CommandReceiptRepository, "begin" | "recordOutcome"> =
      new CommandReceiptRepository(),
    private readonly outbox: Pick<OutboxRepository, "enqueue"> = new OutboxRepository(),
  ) {}

  async begin(transaction: PlatformTransaction, command: ModelControlCommand): Promise<void> {
    await this.receipts.begin(transaction, identity(command));
  }

  async succeed(
    transaction: PlatformTransaction,
    command: ModelControlCommand,
    receipt: ModelControlCommandReceipt,
    trace: { readonly requestId: string; readonly correlationId: string },
  ): Promise<void> {
    const event = modelControlEventFor(command, receipt);
    const result = jsonValue({
      schemaVersion: 1,
      commandId: command.commandId,
      requestDigest: command.requestDigest,
      operation: command.operation,
      siteId: "siteId" in command.input.effect
        ? command.input.effect.siteId
        : null,
      outcome: event.receipt,
    });
    if (!receipt.replayed) {
      await this.outbox.enqueue(transaction, {
        eventId: event.eventId,
        owner: event.owner,
        eventType: event.eventType,
        aggregateId: event.aggregateId,
        payload: jsonValue(event.payload),
        payloadDigest: event.payloadDigest,
        correlationId: trace.correlationId,
        causationId: trace.requestId,
      });
    }
    await this.receipts.recordOutcome(transaction, identity(command), {
      state: "succeeded",
      result,
      resultDigest: digest(result),
    });
  }
}

function identity(command: ModelControlCommand): CommandIdentity {
  return {
    commandId: command.commandId,
    environment: command.input.security.environment,
    region: command.input.security.region,
    callerIdentity: command.input.security.callerIdentity,
    operation: command.operation,
    idempotencyKey: command.input.idempotencyKey,
    requestDigest: command.requestDigest,
  };
}

function jsonValue(value: unknown): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map(jsonValue);
  if (value && typeof value === "object") {
    const result: Record<string, JsonValue> = {};
    for (const [key, child] of Object.entries(value)) {
      if (child !== undefined) result[key] = jsonValue(child);
    }
    return result;
  }
  throw new Error("MODEL_CONTROL_COMMAND_RESULT_INVALID");
}

function digest(value: JsonValue): string {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

function stableJson(value: JsonValue): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  return `{${Object.entries(value)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`)
    .join(",")}}`;
}
