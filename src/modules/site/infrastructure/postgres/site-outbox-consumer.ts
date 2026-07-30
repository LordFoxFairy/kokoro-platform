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
import { SingleFlightLeaseHeartbeat } from
  "../../../../shared/outbox-inbox/lease-heartbeat.js";

export { SITE_EFFECT_EVENT_TYPES } from
  "../../application/contracts/site-authority-ports.js";

export interface SiteRuntimeEventQueue {
  claim(): Promise<readonly ClaimedOutboxEvent[]>;
  renew(eventId: string, leaseToken: string): Promise<void>;
  ack(eventId: string, leaseToken: string): Promise<void>;
  retry(input: Readonly<{ eventId: string; leaseToken: string; errorCode: string;
    retryAt: string | null; maxAttempts: number }>): Promise<void>;
  releaseOwned(reason: "shutdown" | "shutdown-deadline" | "stop-claim-failed"): Promise<void>;
}

type ActiveSiteLease = Readonly<{
  heartbeat: SingleFlightLeaseHeartbeat;
}>;

export class SiteOutboxConsumer {
  readonly #active = new Map<string, ActiveSiteLease>();
  readonly #now: () => string;
  readonly #baseRetryMs: number;
  readonly #maxRetryMs: number;
  readonly #maxAttempts: number;
  readonly #leaseHeartbeatMs: number;
  readonly #leaseRenewalTimeoutMs: number;
  #claiming = true;
  #cycle: Promise<void> | undefined;

  constructor(
    private readonly queue: SiteRuntimeEventQueue,
    private readonly dispatcher: Pick<SiteRuntimeDispatcher, "runActivation" | "runTrafficStop">,
    options: Readonly<{ now?: () => string; baseRetryMs?: number; maxRetryMs?: number;
      maxAttempts?: number; leaseHeartbeatMs?: number; leaseRenewalTimeoutMs?: number }> = {},
  ) {
    this.#now = options.now ?? (() => new Date().toISOString());
    this.#baseRetryMs = boundedInteger(options.baseRetryMs ?? 1_000, 100, 60_000, "SITE_RETRY_BASE_INVALID");
    this.#maxRetryMs = boundedInteger(options.maxRetryMs ?? 60_000, this.#baseRetryMs, 900_000,
      "SITE_RETRY_MAX_INVALID");
    this.#maxAttempts = boundedInteger(options.maxAttempts ?? 12, 1, 100, "SITE_RETRY_ATTEMPTS_INVALID");
    this.#leaseHeartbeatMs = boundedInteger(options.leaseHeartbeatMs ?? 10_000, 1, 100_000,
      "SITE_LEASE_HEARTBEAT_INVALID");
    this.#leaseRenewalTimeoutMs = boundedInteger(
      options.leaseRenewalTimeoutMs ?? Math.min(this.#leaseHeartbeatMs, 5_000),
      1,
      100_000,
      "SITE_LEASE_RENEWAL_TIMEOUT_INVALID",
    );
  }

  runOneCycle(context: Readonly<{ signal: AbortSignal }>): Promise<void> {
    if (this.#cycle !== undefined) return this.#cycle;
    const cycle = this.runClaimedBatch(context).finally(() => {
      if (this.#cycle === cycle) this.#cycle = undefined;
    });
    this.#cycle = cycle;
    return cycle;
  }

  private async runClaimedBatch(context: Readonly<{ signal: AbortSignal }>): Promise<void> {
    if (!this.#claiming) return;
    context.signal.throwIfAborted();
    const events = await this.queue.claim();
    for (const event of events) {
      const heartbeat = new SingleFlightLeaseHeartbeat(
        () => this.queue.renew(event.eventId, event.leaseToken),
        {
          intervalMs: this.#leaseHeartbeatMs,
          renewalTimeoutMs: this.#leaseRenewalTimeoutMs,
          timeoutCode: "SITE_OUTBOX_LEASE_RENEWAL_TIMEOUT",
        },
      );
      this.#active.set(event.eventId, { heartbeat });
      heartbeat.start();
    }
    const leaseFailures: unknown[] = [];
    try {
      for (const event of events) {
        const active = this.#active.get(event.eventId);
        if (active === undefined) continue;
        context.signal.throwIfAborted();
        try {
          await active.heartbeat.assertOwned();
          await this.dispatch(event, AbortSignal.any([context.signal, active.heartbeat.signal]));
          await active.heartbeat.assertOwned();
          context.signal.throwIfAborted();
          await this.queue.ack(event.eventId, event.leaseToken);
        } catch (error) {
          if (context.signal.aborted) throw error;
          if (active.heartbeat.lost) {
            leaseFailures.push(active.heartbeat.failure);
            continue;
          }
          if (isLeaseLost(error)) {
            leaseFailures.push(error);
            continue;
          }
          const failure = classify(error);
          await active.heartbeat.assertOwned();
          await this.queue.retry({
            eventId: event.eventId,
            leaseToken: event.leaseToken,
            errorCode: failure.code,
            retryAt: failure.permanent ? null : this.retryAt(event.attempt),
            maxAttempts: this.#maxAttempts,
          });
        } finally {
          await active.heartbeat.stop();
          this.#active.delete(event.eventId);
        }
      }
    } catch (error) {
      await this.stopActiveHeartbeats();
      this.#active.clear();
      throw error;
    }
    if (leaseFailures.length === 1) throw leaseFailures[0];
    if (leaseFailures.length > 1) {
      throw new AggregateError(leaseFailures, "SITE_OUTBOX_LEASE_RENEWAL_FAILED");
    }
  }

  stopClaiming(): Promise<void> {
    this.#claiming = false;
    return Promise.resolve();
  }

  async returnLeases(reason: "shutdown" | "shutdown-deadline" | "stop-claim-failed"): Promise<void> {
    await this.stopActiveHeartbeats();
    await this.queue.releaseOwned(reason);
    this.#active.clear();
  }

  private async stopActiveHeartbeats(): Promise<void> {
    await Promise.all([...this.#active.values()].map(({ heartbeat }) => heartbeat.stop()));
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
    renew: (eventId, leaseToken) => database.internalTransaction("site.runtime.consume",
      (transaction) => outbox.renewLease(transaction, {
        eventId, leaseToken, workerId: options.workerId, owner: "site", leaseSeconds,
      })),
    ack: (eventId, leaseToken) => database.internalTransaction("site.runtime.consume",
      async (transaction) => {
        await outbox.renewLease(transaction, {
          eventId, leaseToken, workerId: options.workerId, owner: "site", leaseSeconds,
        });
        await outbox.complete(transaction, {
          eventId, leaseToken, deliveryId: `site-runtime:${eventId}`,
          acknowledgedAt: new Date().toISOString(),
        });
      }),
    retry: (input) => database.internalTransaction("site.runtime.consume",
      async (transaction) => {
        await outbox.renewLease(transaction, {
          eventId: input.eventId, leaseToken: input.leaseToken,
          workerId: options.workerId, owner: "site", leaseSeconds,
        });
        await outbox.retryOrDeadLetter(transaction, input);
      }),
    releaseOwned: (_reason) => database.internalTransaction("site.runtime.consume",
      async (transaction) => {
        await outbox.releaseOwnedLeases(transaction, {
          workerId: options.workerId,
          consumer: "site-worker",
          eventTypes: SITE_EFFECT_EVENT_TYPES,
        });
      }),
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

function isLeaseLost(error: unknown): boolean {
  return error instanceof Error && error.message === "OUTBOX_LEASE_LOST";
}

function boundedInteger(value: number, minimum: number, maximum: number, code: string): number {
  if (!Number.isInteger(value) || value < minimum || value > maximum) throw new Error(code);
  return value;
}
