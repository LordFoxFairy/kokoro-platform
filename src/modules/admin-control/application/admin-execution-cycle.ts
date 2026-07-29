import {
  OutboxRepository,
  type ClaimedOutboxEvent,
} from "../../../shared/outbox-inbox/outbox.js";
import type { JsonValue } from "../../../shared/outbox-inbox/receipt.js";
import type { PlatformTransaction } from "../../../shared/unit-of-work/index.js";
import { digestAdminValue } from "./admin-digest.js";

interface AdminExecutionTransactionFence {
  readonly operation: string;
  readonly siteRef: string | null;
  readonly environment: string;
  readonly region: string;
  readonly makerRef: string;
  readonly makerGeneration: bigint;
  readonly makerAuthorizationEpoch: bigint;
  readonly checkerRef: string;
  readonly checkerGeneration: bigint;
  readonly checkerAuthorizationEpoch: bigint;
}

interface AdminExecutionCycleDatabasePort {
  internalTransaction<Result>(
    operation: "admin.execution.claim" | "admin.execution.retry",
    work: (transaction: PlatformTransaction) => Promise<Result>,
  ): Promise<Result>;
  adminExecutionTransaction<Result>(
    fence: AdminExecutionTransactionFence,
    work: (transaction: PlatformTransaction) => Promise<Result>,
  ): Promise<Result>;
}

interface AdminExecutionCycleOutboxPort {
  claim(
    transaction: PlatformTransaction,
    input: Parameters<OutboxRepository["claim"]>[1],
  ): Promise<readonly ClaimedOutboxEvent[]>;
  retryOrDeadLetter(
    transaction: PlatformTransaction,
    input: Parameters<OutboxRepository["retryOrDeadLetter"]>[1],
  ): Promise<void>;
}

export function createAdminExecutionCycle(input: Readonly<{
  database: AdminExecutionCycleDatabasePort;
  executor: Readonly<{
    executeClaim(transaction: PlatformTransaction, event: ClaimedOutboxEvent): Promise<void>;
  }>;
  outbox?: AdminExecutionCycleOutboxPort;
  workerId: string;
  reference: () => string;
  clock?: () => Date;
  limit?: number;
  leaseSeconds?: number;
  maxAttempts?: number;
  canClaim?: () => boolean;
}>): (context: Readonly<{ signal: AbortSignal }>) => Promise<void> {
  bounded(input.workerId);
  const outbox = input.outbox ?? new OutboxRepository();
  const clock = input.clock ?? (() => new Date());
  const limit = input.limit ?? 20;
  const leaseSeconds = input.leaseSeconds ?? 30;
  const maxAttempts = input.maxAttempts ?? 8;
  return async ({ signal }) => {
    signal.throwIfAborted();
    if (input.canClaim?.() === false) return;
    const leaseToken = input.reference();
    bounded(leaseToken);
    const events = await input.database.internalTransaction("admin.execution.claim", (transaction) =>
      outbox.claim(transaction, {
        workerId: input.workerId,
        leaseToken,
        owners: ["admin-execution"],
        limit,
        leaseSeconds,
      }));
    for (const event of events) {
      signal.throwIfAborted();
      try {
        const fence = executionFence(event);
        await input.database.adminExecutionTransaction(fence, (transaction) =>
          input.executor.executeClaim(transaction, event));
      } catch (error) {
        const now = clock();
        const retryAt = new Date(now.getTime() + retryDelayMs(event.attempt)).toISOString();
        await input.database.internalTransaction("admin.execution.retry", (transaction) =>
          outbox.retryOrDeadLetter(transaction, {
            eventId: event.eventId,
            leaseToken: event.leaseToken,
            errorCode: safeCode(error),
            retryAt,
            maxAttempts,
          }));
      }
    }
  };
}

function executionFence(event: ClaimedOutboxEvent): AdminExecutionTransactionFence {
  if (event.owner !== "admin-execution" ||
    event.eventType !== "admin.approval.execution.requested" ||
    event.payloadDigest !== digestAdminValue(event.payload) || event.payload === null ||
    typeof event.payload !== "object" || Array.isArray(event.payload)) {
    throw new Error("ADMIN_EXECUTION_ENVELOPE_INVALID");
  }
  const payload = event.payload as Record<string, JsonValue>;
  const text = (field: string): string => {
    const value = payload[field];
    if (typeof value !== "string") throw new Error("ADMIN_EXECUTION_ENVELOPE_INVALID");
    bounded(value);
    return value;
  };
  const epoch = (field: string): bigint => {
    const value = payload[field];
    if (typeof value !== "string" || !/^[1-9][0-9]{0,19}$/u.test(value)) {
      throw new Error("ADMIN_EXECUTION_ENVELOPE_INVALID");
    }
    return BigInt(value);
  };
  const siteRef = payload.siteRef;
  if (siteRef !== null && typeof siteRef !== "string") {
    throw new Error("ADMIN_EXECUTION_ENVELOPE_INVALID");
  }
  if (typeof siteRef === "string") bounded(siteRef);
  return Object.freeze({
    operation: text("ownerOperation"),
    siteRef: siteRef as string | null,
    environment: text("environment"),
    region: text("region"),
    makerRef: text("makerRef"),
    makerGeneration: epoch("makerGeneration"),
    makerAuthorizationEpoch: epoch("makerAuthorizationEpoch"),
    checkerRef: text("checkerRef"),
    checkerGeneration: epoch("checkerGeneration"),
    checkerAuthorizationEpoch: epoch("checkerAuthorizationEpoch"),
  });
}

function retryDelayMs(attempt: number): number {
  return Math.min(60_000, 500 * 2 ** Math.max(0, Math.min(attempt - 1, 7)));
}

function safeCode(error: unknown): string {
  const value = error instanceof Error ? error.message : "ADMIN_EXECUTION_FAILED";
  return /^ADMIN_[A-Z0-9_]{1,120}$/u.test(value) ? value : "ADMIN_EXECUTION_FAILED";
}

function bounded(value: string): void {
  if (value.length < 1 || value.length > 128 || hasControlCharacter(value)) {
    throw new Error("ADMIN_EXECUTION_ENVELOPE_INVALID");
  }
}

function hasControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const point = character.codePointAt(0) ?? 0;
    return point < 32 || point === 127;
  });
}
