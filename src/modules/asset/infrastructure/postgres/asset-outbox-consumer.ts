import { randomUUID } from "node:crypto";
import type { PlatformTransactionalDatabaseClient } from
  "../../../../infrastructure/postgres/client.js";
import {
  OutboxRepository,
  type ClaimedOutboxEvent,
} from "../../../../shared/outbox-inbox/outbox.js";
import { digestAssetCommand } from "../../application/asset-digest.js";
import type { ProcessAssetObjectCleanupService } from
  "../../application/services/process-asset-object-cleanup.js";
import type { ProcessAssetPromotionService } from
  "../../application/services/process-asset-promotion.js";
import type { ProcessAssetScanService } from
  "../../application/services/process-asset-scan.js";
import type { ProcessUploadCompletionService } from
  "../../application/services/process-upload-completion.js";

export const ASSET_EFFECT_EVENT_TYPES = Object.freeze([
  "asset.upload.completion.requested",
  "asset.scan.requested",
  "asset.blob.promotion.requested",
  "asset.object.cleanup.requested",
] as const);

export interface AssetEffectEventQueue {
  claim(): Promise<readonly ClaimedOutboxEvent[]>;
  ack(eventId: string, leaseToken: string): Promise<void>;
  retry(input: Readonly<{ eventId: string; leaseToken: string; errorCode: string;
    retryAt: string | null; maxAttempts: number }>): Promise<void>;
  release(eventId: string, leaseToken: string,
    reason: "shutdown" | "shutdown-deadline" | "stop-claim-failed"): Promise<void>;
}

export interface AssetEffectServices {
  completion: Pick<ProcessUploadCompletionService, "execute">;
  scan: Pick<ProcessAssetScanService, "execute">;
  promotion: Pick<ProcessAssetPromotionService, "execute">;
  cleanup: Pick<ProcessAssetObjectCleanupService, "execute">;
}

type AssetEffectResult = Awaited<
  ReturnType<AssetEffectServices[keyof AssetEffectServices]["execute"]>
>;

export class AssetOutboxConsumer {
  readonly #active = new Map<string, ClaimedOutboxEvent>();
  readonly #now: () => string;
  readonly #baseRetryMs: number;
  readonly #maxRetryMs: number;
  readonly #maxAttempts: number;
  #claiming = true;

  constructor(
    private readonly queue: AssetEffectEventQueue,
    private readonly services: AssetEffectServices,
    options: Readonly<{ now?: () => string; baseRetryMs?: number; maxRetryMs?: number;
      maxAttempts?: number }> = {},
  ) {
    this.#now = options.now ?? (() => new Date().toISOString());
    this.#baseRetryMs = boundedInteger(options.baseRetryMs ?? 1_000, 100, 60_000,
      "ASSET_RETRY_BASE_INVALID");
    this.#maxRetryMs = boundedInteger(options.maxRetryMs ?? 60_000, this.#baseRetryMs, 900_000,
      "ASSET_RETRY_MAX_INVALID");
    this.#maxAttempts = boundedInteger(options.maxAttempts ?? 12, 1, 100,
      "ASSET_RETRY_ATTEMPTS_INVALID");
  }

  async runOneCycle(context: Readonly<{ signal: AbortSignal }>): Promise<void> {
    if (!this.#claiming) return;
    context.signal.throwIfAborted();
    const events = await this.queue.claim();
    for (const event of events) this.#active.set(event.eventId, event);
    for (const event of events) {
      context.signal.throwIfAborted();
      try {
        const result = await this.dispatch(event);
        if (result.disposition === "retry") {
          await this.queue.retry({
            eventId: event.eventId,
            leaseToken: event.leaseToken,
            errorCode: result.code,
            retryAt: this.retryAt(event.attempt),
            maxAttempts: this.#maxAttempts,
          });
        } else {
          await this.queue.ack(event.eventId, event.leaseToken);
        }
      } catch (error) {
        const failure = classify(error);
        await this.queue.retry({
          eventId: event.eventId,
          leaseToken: event.leaseToken,
          errorCode: failure.code,
          retryAt: failure.permanent ? null : this.retryAt(event.attempt),
          maxAttempts: this.#maxAttempts,
        });
      } finally {
        this.#active.delete(event.eventId);
      }
    }
  }

  stopClaiming(): Promise<void> {
    this.#claiming = false;
    return Promise.resolve();
  }

  async returnLeases(
    reason: "shutdown" | "shutdown-deadline" | "stop-claim-failed",
  ): Promise<void> {
    await Promise.all([...this.#active.values()].map((event) =>
      this.queue.release(event.eventId, event.leaseToken, reason)));
  }

  private dispatch(event: ClaimedOutboxEvent): Promise<AssetEffectResult> {
    const command = assetEffectCommand(event);
    const common = {
      eventId: event.eventId,
      siteRef: command.siteRef,
      expectedVersion: command.expectedVersion,
      correlationId: event.correlationId,
    };
    switch (command.kind) {
      case "completion":
        return this.services.completion.execute({
          ...common, intentRef: command.intentRef, sessionRef: command.sessionRef,
        });
      case "scan":
        return this.services.scan.execute({ ...common, candidateRef: command.candidateRef });
      case "promotion":
        return this.services.promotion.execute({ ...common, promotionRef: command.promotionRef });
      case "cleanup":
        return this.services.cleanup.execute({ ...common, cleanupRef: command.cleanupRef });
    }
  }

  private retryAt(attempt: number): string {
    const exponent = Math.max(0, Math.min(attempt - 1, 20));
    const delay = Math.min(this.#maxRetryMs, this.#baseRetryMs * (2 ** exponent));
    return new Date(Date.parse(this.#now()) + delay).toISOString();
  }
}

export function createPostgresAssetEffectEventQueue(
  database: Pick<PlatformTransactionalDatabaseClient, "internalTransaction">,
  options: Readonly<{ workerId: string; claimLimit?: number; leaseSeconds?: number }>,
  outbox: OutboxRepository = new OutboxRepository(),
): AssetEffectEventQueue {
  const claimLimit = boundedInteger(options.claimLimit ?? 10, 1, 100,
    "ASSET_CLAIM_LIMIT_INVALID");
  const leaseSeconds = boundedInteger(options.leaseSeconds ?? 30, 1, 300,
    "ASSET_LEASE_SECONDS_INVALID");
  const queue: AssetEffectEventQueue = {
    claim: () => database.internalTransaction("asset.outbox.consume", (lease) => outbox.claim(lease, {
      workerId: options.workerId,
      leaseToken: randomUUID(),
      owners: ["asset"],
      eventTypes: ASSET_EFFECT_EVENT_TYPES,
      limit: claimLimit,
      leaseSeconds,
    })),
    ack: (eventId, leaseToken) => database.internalTransaction("asset.outbox.consume",
      (lease) => outbox.complete(lease, {
      eventId,
      leaseToken,
      deliveryId: `asset-worker:${eventId}`,
      acknowledgedAt: new Date().toISOString(),
    })),
    retry: (input) => database.internalTransaction("asset.outbox.consume",
      (lease) => outbox.retryOrDeadLetter(lease, input)),
    release: (eventId, leaseToken, reason) => database.internalTransaction(
      "asset.outbox.consume", (lease) => outbox.release(lease, {
      eventId,
      leaseToken,
      errorCode: `ASSET_${reason.toUpperCase().replaceAll("-", "_")}`,
    })),
  };
  return Object.freeze(queue);
}

type AssetEffectCommand =
  | Readonly<{ kind: "completion"; siteRef: string; intentRef: string; sessionRef: string;
    expectedVersion: bigint }>
  | Readonly<{ kind: "scan"; siteRef: string; candidateRef: string; expectedVersion: bigint }>
  | Readonly<{ kind: "promotion"; siteRef: string; promotionRef: string;
    expectedVersion: bigint }>
  | Readonly<{ kind: "cleanup"; siteRef: string; cleanupRef: string; expectedVersion: bigint }>;

function assetEffectCommand(event: ClaimedOutboxEvent): AssetEffectCommand {
  if (event.owner !== "asset" || digestAssetCommand(event.payload) !== event.payloadDigest ||
      !record(event.payload) || !identifier(event.correlationId)) invalid();
  const payload = event.payload as Record<string, unknown>;
  const siteRef = requiredIdentifier(payload.siteRef);
  const expectedVersion = positiveBigint(payload.expectedVersion);
  if (event.eventType === "asset.upload.completion.requested" &&
      exactKeys(payload, ["kind", "siteRef", "intentRef", "sessionRef", "expectedVersion"]) &&
      payload.kind === "asset_upload_completion_requested_v1") {
    const intentRef = requiredIdentifier(payload.intentRef);
    const sessionRef = requiredIdentifier(payload.sessionRef);
    if (event.aggregateId !== sessionRef) invalid();
    return Object.freeze({ kind: "completion", siteRef, intentRef, sessionRef, expectedVersion });
  }
  if (event.eventType === "asset.scan.requested" &&
      exactKeys(payload, ["kind", "siteRef", "candidateRef", "expectedVersion"]) &&
      payload.kind === "asset_scan_requested_v1") {
    const candidateRef = requiredIdentifier(payload.candidateRef);
    if (event.aggregateId !== candidateRef) invalid();
    return Object.freeze({ kind: "scan", siteRef, candidateRef, expectedVersion });
  }
  if (event.eventType === "asset.blob.promotion.requested" &&
      exactKeys(payload, ["kind", "siteRef", "promotionRef", "expectedVersion"]) &&
      payload.kind === "asset_blob_promotion_requested_v1") {
    const promotionRef = requiredIdentifier(payload.promotionRef);
    if (event.aggregateId !== promotionRef) invalid();
    return Object.freeze({ kind: "promotion", siteRef, promotionRef, expectedVersion });
  }
  if (event.eventType === "asset.object.cleanup.requested" &&
      exactKeys(payload, ["kind", "siteRef", "cleanupRef", "expectedVersion"]) &&
      payload.kind === "asset_object_cleanup_requested_v1") {
    const cleanupRef = requiredIdentifier(payload.cleanupRef);
    if (event.aggregateId !== cleanupRef) invalid();
    return Object.freeze({ kind: "cleanup", siteRef, cleanupRef, expectedVersion });
  }
  return invalid();
}

function classify(error: unknown): Readonly<{ code: string; permanent: boolean }> {
  const code = error instanceof Error && /^[A-Z][A-Z0-9_:.-]{2,127}$/u.test(error.message)
    ? error.message
    : "ASSET_WORKER_UNEXPECTED";
  return Object.freeze({
    code: code.slice(0, 128),
    permanent: code === "ASSET_OUTBOX_EVENT_INVALID",
  });
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  return Object.keys(value).sort().join("\0") === [...expected].sort().join("\0");
}

function requiredIdentifier(value: unknown): string {
  if (typeof value !== "string" || !identifier(value)) return invalid();
  return value;
}

function identifier(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._:/-]{2,127}$/u.test(value);
}

function positiveBigint(value: unknown): bigint {
  if (typeof value !== "string" || !/^[1-9][0-9]{0,18}$/u.test(value)) return invalid();
  const parsed = BigInt(value);
  if (parsed > 9_223_372_036_854_775_807n) return invalid();
  return parsed;
}

function invalid(): never {
  throw new Error("ASSET_OUTBOX_EVENT_INVALID");
}

function boundedInteger(value: number, minimum: number, maximum: number, code: string): number {
  if (!Number.isInteger(value) || value < minimum || value > maximum) throw new Error(code);
  return value;
}
