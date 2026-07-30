import { randomUUID } from "node:crypto";
import type { PlatformTransactionalDatabaseClient } from "../../../../infrastructure/postgres/client.js";
import {
  OutboxRepository,
  type ClaimedOutboxEvent,
} from "../../../../shared/outbox-inbox/outbox.js";
import { SiteProviderEffectError } from "../../application/contracts/site-deployment-provider.js";
import {
  SiteRuntimePendingError,
  type SiteRuntimeDispatcher,
} from "../../application/services/site-runtime-dispatcher.js";
import { SITE_EFFECT_EVENT_TYPES } from
  "../../application/contracts/site-authority-ports.js";

export { SITE_EFFECT_EVENT_TYPES } from
  "../../application/contracts/site-authority-ports.js";

export interface SiteRuntimeEventQueue {
  claim(): Promise<readonly ClaimedOutboxEvent[]>;
  ack(eventId: string, leaseToken: string): Promise<void>;
  retry(input: Readonly<{ eventId: string; leaseToken: string; errorCode: string;
    retryAt: string | null; maxAttempts: number }>): Promise<void>;
  release(eventId: string, leaseToken: string, reason: string): Promise<void>;
}

export class SiteOutboxConsumer {
  readonly #active = new Map<string, ClaimedOutboxEvent>();
  readonly #now: () => string;
  readonly #baseRetryMs: number;
  readonly #maxRetryMs: number;
  readonly #maxAttempts: number;
  #claiming = true;

  constructor(
    private readonly queue: SiteRuntimeEventQueue,
    private readonly dispatcher: Pick<SiteRuntimeDispatcher, "runActivation" | "runTrafficStop">,
    options: Readonly<{ now?: () => string; baseRetryMs?: number; maxRetryMs?: number;
      maxAttempts?: number }> = {},
  ) {
    this.#now = options.now ?? (() => new Date().toISOString());
    this.#baseRetryMs = boundedInteger(options.baseRetryMs ?? 1_000, 100, 60_000, "SITE_RETRY_BASE_INVALID");
    this.#maxRetryMs = boundedInteger(options.maxRetryMs ?? 60_000, this.#baseRetryMs, 900_000,
      "SITE_RETRY_MAX_INVALID");
    this.#maxAttempts = boundedInteger(options.maxAttempts ?? 12, 1, 100, "SITE_RETRY_ATTEMPTS_INVALID");
  }

  async runOneCycle(context: Readonly<{ signal: AbortSignal }>): Promise<void> {
    if (!this.#claiming) return;
    context.signal.throwIfAborted();
    const events = await this.queue.claim();
    for (const event of events) {
      context.signal.throwIfAborted();
      this.#active.set(event.eventId, event);
      try {
        await this.dispatch(event, context.signal);
        await this.queue.ack(event.eventId, event.leaseToken);
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

  async returnLeases(reason: "shutdown" | "shutdown-deadline" | "stop-claim-failed"): Promise<void> {
    const events = [...this.#active.values()];
    await Promise.all(events.map((event) => this.queue.release(event.eventId, event.leaseToken, reason)));
  }

  private async dispatch(event: ClaimedOutboxEvent, signal: AbortSignal): Promise<void> {
    if (event.owner !== "site") throw new Error("SITE_OUTBOX_OWNER_INVALID");
    if (event.eventType === "site.activation.begin.v1") {
      await this.dispatcher.runActivation(attemptRef(event.payload), signal);
      return;
    }
    if (event.eventType === "site.traffic-stop.request.v1") {
      await this.dispatcher.runTrafficStop(attemptRef(event.payload), signal);
      return;
    }
    throw new Error("SITE_OUTBOX_EVENT_UNSUPPORTED");
  }

  private retryAt(attempt: number): string {
    const exponent = Math.max(0, Math.min(attempt - 1, 20));
    const delay = Math.min(this.#maxRetryMs, this.#baseRetryMs * (2 ** exponent));
    return new Date(Date.parse(this.#now()) + delay).toISOString();
  }
}

export function createPostgresSiteRuntimeEventQueue(
  database: PlatformTransactionalDatabaseClient,
  options: Readonly<{ workerId: string; claimLimit?: number; leaseSeconds?: number }> ,
  outbox: OutboxRepository = new OutboxRepository(),
): SiteRuntimeEventQueue {
  const claimLimit = boundedInteger(options.claimLimit ?? 10, 1, 100, "SITE_CLAIM_LIMIT_INVALID");
  const leaseSeconds = boundedInteger(options.leaseSeconds ?? 30, 1, 300, "SITE_LEASE_SECONDS_INVALID");
  const queue: SiteRuntimeEventQueue = {
    claim: () => database.internalTransaction("site.runtime.consume", (transaction) => outbox.claim(transaction, {
      workerId: options.workerId,
      leaseToken: randomUUID(),
      consumer: "site-worker",
      eventTypes: SITE_EFFECT_EVENT_TYPES,
      limit: claimLimit,
      leaseSeconds,
    })),
    ack: (eventId, leaseToken) => database.internalTransaction("site.runtime.consume",
      (transaction) => outbox.complete(transaction, {
        eventId, leaseToken, deliveryId: `site-runtime:${eventId}`,
        acknowledgedAt: new Date().toISOString(),
      })),
    retry: (input) => database.internalTransaction("site.runtime.consume",
      (transaction) => outbox.retryOrDeadLetter(transaction, input)),
    release: (eventId, leaseToken, reason) => database.internalTransaction("site.runtime.consume",
      (transaction) => outbox.release(transaction, { eventId, leaseToken, errorCode: `SITE_${reason
        .toUpperCase().replaceAll("-", "_")}` })),
  };
  return Object.freeze(queue);
}

function attemptRef(payload: ClaimedOutboxEvent["payload"]): string {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("SITE_OUTBOX_PAYLOAD_INVALID");
  }
  const keys = Object.keys(payload);
  if (keys.some((key) => key !== "attemptRef" && key !== "state") ||
      typeof payload.attemptRef !== "string" ||
      !/^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/u.test(payload.attemptRef) ||
      typeof payload.state !== "string") {
    throw new Error("SITE_OUTBOX_PAYLOAD_INVALID");
  }
  return payload.attemptRef;
}

function classify(error: unknown): Readonly<{ code: string; permanent: boolean }> {
  if (error instanceof SiteRuntimePendingError || error instanceof SiteProviderEffectError) {
    return { code: error instanceof SiteRuntimePendingError ? error.code : error.code, permanent: false };
  }
  const code = error instanceof Error && /^[A-Z][A-Z0-9_:.-]{2,127}$/u.test(error.message)
    ? error.message : "SITE_RUNTIME_UNEXPECTED";
  return { code: code.slice(0, 128), permanent:
    code.startsWith("SITE_OUTBOX_") || code.startsWith("SITE_PROVIDER_NOT_CONFIGURED:") };
}

function boundedInteger(value: number, minimum: number, maximum: number, code: string): number {
  if (!Number.isInteger(value) || value < minimum || value > maximum) throw new Error(code);
  return value;
}
