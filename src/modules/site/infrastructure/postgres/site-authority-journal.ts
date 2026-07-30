import { createHash } from "node:crypto";
import type {
  SiteAuthorityCommand,
  SiteAuthorityJournal,
  SiteAuthorityReceipt,
  SiteEffectEventType,
  SiteEffectQueuePort,
} from "../../application/contracts/site-authority-ports.js";
import { OutboxRepository } from "../../../../shared/outbox-inbox/outbox.js";
import {
  CommandReceiptRepository,
  type CommandIdentity,
  type JsonValue,
} from "../../../../shared/outbox-inbox/receipt.js";
import type { PlatformTransaction } from "../../../../shared/unit-of-work/index.js";

export class PostgresSiteAuthorityJournal implements SiteAuthorityJournal {
  constructor(
    private readonly receipts: Pick<CommandReceiptRepository, "begin" | "recordOutcome"> =
      new CommandReceiptRepository(),
    private readonly effectQueue: SiteEffectQueuePort = new OutboxRepository(),
  ) {}

  async begin(
    transaction: PlatformTransaction,
    command: SiteAuthorityCommand,
  ): Promise<"fresh" | "replay"> {
    const receipt = await this.receipts.begin(transaction, identity(command));
    if (receipt.state === "failed") throw new Error("SITE_COMMAND_PREVIOUSLY_REJECTED");
    return receipt.state === "pending" ? "fresh" : "replay";
  }

  async succeed(
    transaction: PlatformTransaction,
    command: SiteAuthorityCommand,
    receipt: SiteAuthorityReceipt,
    context: Parameters<SiteAuthorityJournal["succeed"]>[3],
  ): Promise<void> {
    const payload = jsonValue({ ...receipt, replayed: undefined });
    const payloadDigest = digest(payload);
    const eventType = siteEffectEventType(command.operation);
    if (!receipt.replayed && eventType !== null) {
      await this.effectQueue.enqueue(transaction, {
        eventId: eventId(command.commandId),
        owner: "site",
        eventType,
        aggregateId: command.siteRef,
        payload,
        payloadDigest,
        correlationId: context.correlationId,
        causationId: context.requestId,
      });
    }
    await this.receipts.recordOutcome(transaction, identity(command), {
      state: "succeeded",
      result: payload,
      resultDigest: payloadDigest,
    });
  }
}

function siteEffectEventType(operation: string): SiteEffectEventType | null {
  if (operation === "site.activation.begin") return "site.activation.begin.v1";
  if (operation === "site.traffic-stop.request") return "site.traffic-stop.request.v1";
  return null;
}

function identity(command: SiteAuthorityCommand): CommandIdentity {
  return {
    commandId: command.commandId,
    idempotencyKey: command.idempotencyKey,
    operation: command.operation,
    environment: command.environment,
    region: command.region,
    callerIdentity: command.callerIdentity,
    requestDigest: command.requestDigest,
  };
}

function eventId(commandId: string): string {
  const hex = createHash("sha256").update("kokoro-site-event-v1\0").update(commandId).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

function jsonValue(value: unknown): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map(jsonValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).filter(([, child]) => child !== undefined)
      .map(([key, child]) => [key, jsonValue(child)]));
  }
  throw new Error("SITE_COMMAND_RESULT_INVALID");
}

function digest(value: JsonValue): string {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

function stableJson(value: JsonValue): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  return `{${Object.entries(value).sort(([left], [right]) => left.localeCompare(right))
    .map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`).join(",")}}`;
}
