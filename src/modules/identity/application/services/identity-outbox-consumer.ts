import { timingSafeEqual } from "node:crypto";
import type { IdentityAuditDigesterPort, SealedVerificationEnvelope } from
  "../contracts/identity-security-ports.js";
import type {
  ClaimedOutboxEvent,
  OutboxDeliveryAcknowledgement,
} from "../../../../shared/outbox-inbox/outbox.js";
import { OUTBOX_ROUTE_CATALOG } from "../../../../shared/outbox-inbox/outbox.js";

export const IDENTITY_EFFECT_EVENT_TYPES = OUTBOX_ROUTE_CATALOG.identity.eventTypes;

type IdentityEffectBase = Readonly<{
  eventId: string;
  aggregateId: string;
  payloadDigest: string;
  correlationId: string;
  causationId: string | null;
  leaseToken: string;
  attempt: number;
}>;

export type IdentityVerificationDeliveryEffect = IdentityEffectBase & Readonly<{
  payload: Readonly<{
    kind: "sealed_identity_verification_v1";
    credentialRevision: number;
    sealedEnvelope: SealedVerificationEnvelope;
  }>;
}>;

export type IdentityNamespaceAllocationEffect = IdentityEffectBase & Readonly<{
  payload: Readonly<{
    kind: "identity_namespace_allocation_v1";
    siteRef: string;
    subjectRef: string;
    workspaceRef: string;
    projectRef: string;
    executionSpaceRef: string;
    executionNamespace: string;
    namespaceIntentRef: string;
  }>;
}>;

export type IdentityEffect =
  | IdentityVerificationDeliveryEffect
  | IdentityNamespaceAllocationEffect;

export interface IdentityVerificationDeliveryPort {
  publish(
    effect: IdentityVerificationDeliveryEffect,
    signal: AbortSignal,
  ): Promise<OutboxDeliveryAcknowledgement>;
}

export interface IdentityEffectFailure {
  readonly errorCode: string;
  readonly retryAt: string | null;
  readonly maxAttempts: number;
  readonly permanent: boolean;
}

export interface IdentityEffectEventQueue {
  claim(): Promise<readonly ClaimedOutboxEvent[]>;
  renew(eventId: string, leaseToken: string): Promise<void>;
  prepareVerification(
    effect: IdentityVerificationDeliveryEffect,
  ): Promise<"dispatch" | "superseded">;
  completeVerification(
    effect: IdentityVerificationDeliveryEffect,
    acknowledgement: OutboxDeliveryAcknowledgement,
  ): Promise<void>;
  applyNamespace(effect: IdentityNamespaceAllocationEffect): Promise<void>;
  fail(event: ClaimedOutboxEvent | IdentityEffect, failure: IdentityEffectFailure): Promise<void>;
  releaseOwned(reason: "shutdown" | "shutdown-deadline" | "stop-claim-failed"): Promise<void>;
}

export class IdentityOutboxConsumer {
  readonly #active = new Map<string, ClaimedOutboxEvent>();
  readonly #now: () => string;
  readonly #baseRetryMs: number;
  readonly #maxRetryMs: number;
  readonly #maxAttempts: number;
  readonly #leaseHeartbeatMs: number;
  #claiming = true;

  constructor(
    private readonly queue: IdentityEffectEventQueue,
    private readonly delivery: IdentityVerificationDeliveryPort,
    private readonly options: Readonly<{
      auditDigest: IdentityAuditDigesterPort;
      now?: () => string;
      baseRetryMs?: number;
      maxRetryMs?: number;
      maxAttempts?: number;
      leaseHeartbeatMs?: number;
    }>,
  ) {
    this.#now = options.now ?? (() => new Date().toISOString());
    this.#baseRetryMs = boundedInteger(
      options.baseRetryMs ?? 1_000,
      100,
      60_000,
      "IDENTITY_OUTBOX_RETRY_BASE_INVALID",
    );
    this.#maxRetryMs = boundedInteger(
      options.maxRetryMs ?? 60_000,
      this.#baseRetryMs,
      900_000,
      "IDENTITY_OUTBOX_RETRY_MAX_INVALID",
    );
    this.#maxAttempts = boundedInteger(
      options.maxAttempts ?? 12,
      1,
      100,
      "IDENTITY_OUTBOX_RETRY_ATTEMPTS_INVALID",
    );
    this.#leaseHeartbeatMs = boundedInteger(
      options.leaseHeartbeatMs ?? 10_000,
      100,
      120_000,
      "IDENTITY_OUTBOX_LEASE_HEARTBEAT_INVALID",
    );
  }

  async runOneCycle(context: Readonly<{ signal: AbortSignal }>): Promise<void> {
    if (!this.#claiming) return;
    context.signal.throwIfAborted();
    const events = await this.queue.claim();
    for (const event of events) this.#active.set(event.eventId, event);
    const outcomes = await Promise.allSettled(events.map((event) =>
      this.#processEvent(event, context.signal)));
    if (context.signal.aborted) throw context.signal.reason;
    const failures = outcomes.flatMap((outcome) => outcome.status === "rejected"
      ? [outcome.reason instanceof Error
          ? outcome.reason
          : new Error("IDENTITY_OUTBOX_EVENT_PROCESSING_FAILED")]
      : []);
    if (failures.length > 0) {
      throw new AggregateError(failures, "IDENTITY_OUTBOX_BATCH_FAILED");
    }
  }

  stopClaiming(): Promise<void> {
    this.#claiming = false;
    return Promise.resolve();
  }

  returnLeases(
    reason: "shutdown" | "shutdown-deadline" | "stop-claim-failed",
  ): Promise<void> {
    return this.queue.releaseOwned(reason);
  }

  async #processEvent(event: ClaimedOutboxEvent, signal: AbortSignal): Promise<void> {
    try {
      signal.throwIfAborted();
      let effect: IdentityEffect;
      try {
        effect = identityEffect(event, this.options.auditDigest);
      } catch (error) {
        await this.#recordFailure(event, error);
        return;
      }
      if (isVerificationEffect(effect)) {
        try {
          const disposition = await this.queue.prepareVerification(effect);
          if (disposition === "superseded") return;
        } catch (error) {
          await this.#recordFailure(effect, error);
          return;
        }
        let acknowledgement: OutboxDeliveryAcknowledgement;
        try {
          acknowledgement = await this.#deliverWithLeaseHeartbeat(effect, signal);
        } catch (error) {
          if (signal.aborted) throw signal.reason ?? error;
          await this.#recordFailure(effect, error);
          return;
        }
        signal.throwIfAborted();
        // The provider already acknowledged an idempotent external effect. If this commit is
        // ambiguous, leave the lease untouched so a replacement worker repeats the same eventId.
        await this.queue.completeVerification(effect, acknowledgement);
        return;
      }
      try {
        await this.queue.applyNamespace(effect);
      } catch (error) {
        if (signal.aborted) throw signal.reason ?? error;
        await this.#recordFailure(effect, error);
      }
    } finally {
      this.#active.delete(event.eventId);
    }
  }

  async #deliverWithLeaseHeartbeat(
    effect: IdentityVerificationDeliveryEffect,
    signal: AbortSignal,
  ): Promise<OutboxDeliveryAcknowledgement> {
    let heartbeatFailure: unknown;
    let heartbeat = Promise.resolve();
    const timer = setInterval(() => {
      heartbeat = heartbeat.then(() => this.queue.renew(effect.eventId, effect.leaseToken))
        .catch((error: unknown) => { heartbeatFailure = error; });
    }, this.#leaseHeartbeatMs);
    timer.unref();
    try {
      const acknowledgement = await this.delivery.publish(effect, signal);
      await heartbeat;
      if (heartbeatFailure !== undefined) throw heartbeatFailure;
      return acknowledgement;
    } finally {
      clearInterval(timer);
      await heartbeat;
    }
  }

  #recordFailure(
    event: ClaimedOutboxEvent | IdentityEffect,
    error: unknown,
  ): Promise<void> {
    const failure = classify(error);
    return this.queue.fail(event, {
      errorCode: failure.code,
      retryAt: failure.permanent ? null : this.#retryAt(event.attempt),
      maxAttempts: this.#maxAttempts,
      permanent: failure.permanent,
    });
  }

  #retryAt(attempt: number): string {
    const exponent = Math.max(0, Math.min(attempt - 1, 20));
    const delay = Math.min(this.#maxRetryMs, this.#baseRetryMs * (2 ** exponent));
    return new Date(Date.parse(this.#now()) + delay).toISOString();
  }
}

function identityEffect(
  event: ClaimedOutboxEvent,
  auditDigest: IdentityAuditDigesterPort,
): IdentityEffect {
  if (
    event.owner !== "identity" ||
    !safeDigestEqual(event.payloadDigest, auditDigest(event.payload)) ||
    !record(event.payload) ||
    !boundedText(event.eventId, 128) ||
    !boundedText(event.aggregateId, 256) ||
    !boundedText(event.correlationId, 128) ||
    (event.causationId !== null && !boundedText(event.causationId, 128))
  ) return invalid();
  if (
    event.eventType === "identity.verification.delivery.requested" &&
    exactKeys(event.payload, ["kind", "credentialRevision", "sealedEnvelope"]) &&
    event.payload.kind === "sealed_identity_verification_v1" &&
    Number.isInteger(event.payload.credentialRevision) &&
    Number(event.payload.credentialRevision) >= 0 &&
    Number(event.payload.credentialRevision) <= 20 &&
    verificationEnvelope(event.payload.sealedEnvelope)
  ) {
    return Object.freeze({
      eventId: event.eventId,
      aggregateId: event.aggregateId,
      payloadDigest: event.payloadDigest,
      correlationId: event.correlationId,
      causationId: event.causationId,
      leaseToken: event.leaseToken,
      attempt: event.attempt,
      payload: Object.freeze({
        kind: "sealed_identity_verification_v1" as const,
        credentialRevision: Number(event.payload.credentialRevision),
        sealedEnvelope: event.payload.sealedEnvelope,
      }),
    });
  }
  if (
    event.eventType === "identity.namespace.allocation.requested" &&
    exactKeys(event.payload, [
      "kind", "siteRef", "subjectRef", "workspaceRef", "projectRef",
      "executionSpaceRef", "executionNamespace", "namespaceIntentRef",
    ]) &&
    event.payload.kind === "identity_namespace_allocation_v1" &&
    boundedText(event.payload.siteRef, 128) &&
    boundedText(event.payload.subjectRef, 256) &&
    boundedText(event.payload.workspaceRef, 256) &&
    boundedText(event.payload.projectRef, 256) &&
    boundedText(event.payload.executionSpaceRef, 256) &&
    boundedText(event.payload.executionNamespace, 128, 32) &&
    boundedText(event.payload.namespaceIntentRef, 128) &&
    event.aggregateId === event.payload.executionSpaceRef
  ) {
    return Object.freeze({
      eventId: event.eventId,
      aggregateId: event.aggregateId,
      payloadDigest: event.payloadDigest,
      correlationId: event.correlationId,
      causationId: event.causationId,
      leaseToken: event.leaseToken,
      attempt: event.attempt,
      payload: Object.freeze({
        kind: "identity_namespace_allocation_v1" as const,
        siteRef: event.payload.siteRef,
        subjectRef: event.payload.subjectRef,
        workspaceRef: event.payload.workspaceRef,
        projectRef: event.payload.projectRef,
        executionSpaceRef: event.payload.executionSpaceRef,
        executionNamespace: event.payload.executionNamespace,
        namespaceIntentRef: event.payload.namespaceIntentRef,
      }),
    });
  }
  return invalid();
}

function isVerificationEffect(effect: IdentityEffect): effect is IdentityVerificationDeliveryEffect {
  return effect.payload.kind === "sealed_identity_verification_v1";
}

function verificationEnvelope(value: unknown): value is SealedVerificationEnvelope {
  if (!record(value) || !exactKeys(value, [
    "algorithm", "keyRevision", "nonce", "ciphertext", "authenticationTag",
  ])) return false;
  return value.algorithm === "A256GCM" &&
    typeof value.keyRevision === "string" && /^[A-Za-z0-9_-]{1,128}$/u.test(value.keyRevision) &&
    encodedBytes(value.nonce, 12, 12) &&
    encodedBytes(value.authenticationTag, 16, 16) &&
    encodedBytes(value.ciphertext, 1, 8 * 1024);
}

function encodedBytes(value: unknown, minimum: number, maximum: number): boolean {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/u.test(value)) return false;
  const bytes = Buffer.from(value, "base64url");
  return bytes.byteLength >= minimum && bytes.byteLength <= maximum &&
    bytes.toString("base64url") === value;
}

function safeDigestEqual(left: string, right: string): boolean {
  if (!/^[a-f0-9]{64}$/u.test(left) || !/^[a-f0-9]{64}$/u.test(right)) return false;
  return timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}

function classify(error: unknown): Readonly<{ code: string; permanent: boolean }> {
  const candidate = error instanceof Error && /^[A-Z][A-Z0-9_:.-]{2,127}$/u.test(error.message)
    ? error.message
    : "IDENTITY_OUTBOX_EFFECT_FAILED";
  const retryable = record(error) && typeof error.retryable === "boolean"
    ? error.retryable
    : candidate !== "IDENTITY_OUTBOX_EVENT_INVALID" &&
      candidate !== "IDENTITY_VERIFICATION_DELIVERY_NOT_DELIVERABLE" &&
      candidate !== "IDENTITY_NAMESPACE_ALLOCATION_MISMATCH";
  return Object.freeze({ code: candidate.slice(0, 128), permanent: !retryable });
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  return Object.keys(value).sort().join("\0") === [...expected].sort().join("\0");
}

function boundedText(value: unknown, maximum: number, minimum = 1): value is string {
  return typeof value === "string" && value.length >= minimum && value.length <= maximum &&
    value.trim() === value && ![...value].some((character) => {
      const point = character.codePointAt(0) ?? 0;
      return point < 32 || point === 127;
    });
}

function invalid(): never {
  throw Object.assign(new Error("IDENTITY_OUTBOX_EVENT_INVALID"), { retryable: false });
}

function boundedInteger(value: number, minimum: number, maximum: number, code: string): number {
  if (!Number.isInteger(value) || value < minimum || value > maximum) throw new Error(code);
  return value;
}
