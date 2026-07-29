import { randomUUID } from "node:crypto";
import { OutboxRepository } from "../../../../shared/outbox-inbox/outbox.js";
import { authorizationDigest } from "../contracts/authorization-digest.js";
import type {
  SessionAuthorizationPublisher,
  SessionAuthorizationRepository,
} from "../contracts/session-authorization-ports.js";
import type { PlatformTransaction } from "../../../../shared/unit-of-work/index.js";

export class DurableSessionAuthorizationPublisher implements SessionAuthorizationPublisher {
  constructor(private readonly outbox: OutboxRepository = new OutboxRepository()) {}

  async publishGrantPrepared(transaction: Parameters<SessionAuthorizationPublisher["publishGrantPrepared"]>[0], input: Parameters<SessionAuthorizationPublisher["publishGrantPrepared"]>[1]): Promise<void> {
    const payload = {
      schemaVersion: 1,
      grantRef: input.claims.grantRef,
      siteRef: input.claims.binding.siteRef,
      projectRef: input.claims.binding.projectRef,
      subjectRef: input.claims.binding.subjectRef,
      purpose: input.claims.authorization.purpose,
      audience: input.claims.authorization.audience,
      keyRevision: input.claims.binding.keyRevision,
      policyEpoch: input.claims.binding.policyEpoch,
      revocationEpoch: input.claims.binding.revocationEpoch,
      expiresAt: input.claims.binding.expiresAt,
      claimsDigest: input.claimsDigest,
      deliveryState: "pending",
    } as const;
    await this.outbox.enqueue(transaction, {
      eventId: randomUUID(),
      owner: "authorization",
      eventType: "session.authorization.grant-prepared.v1",
      aggregateId: input.claims.grantRef,
      payload,
      payloadDigest: authorizationDigest(payload),
      correlationId: input.correlationId,
      causationId: null,
    });
  }

  async publishRevocationEpochChanged(transaction: Parameters<SessionAuthorizationPublisher["publishRevocationEpochChanged"]>[0], input: Parameters<SessionAuthorizationPublisher["publishRevocationEpochChanged"]>[1]): Promise<void> {
    const payload = {
      schemaVersion: 1,
      siteRef: input.siteRef,
      revocationEpoch: input.revocationEpoch,
      reason: input.reason,
      changedAt: input.changedAt,
    } as const;
    await this.outbox.enqueue(transaction, {
      eventId: randomUUID(),
      owner: "authorization",
      eventType: "session.authorization.revocation-epoch-changed.v1",
      aggregateId: input.siteRef,
      payload,
      payloadDigest: authorizationDigest(payload),
      correlationId: input.correlationId,
      causationId: null,
    });
  }
}

/**
 * Owner workflows call this with their existing transaction after locking the Site/User/Session
 * mutation facts. It deliberately does not open a nested transaction, so epoch bump and durable
 * revocation event cannot split.
 */
export class PublishSessionAuthorizationService {
  constructor(
    private readonly repository: SessionAuthorizationRepository,
    private readonly publisher: SessionAuthorizationPublisher,
  ) {}

  async bumpRevocationInOwnerTransaction(transaction: PlatformTransaction, input: Readonly<{
    siteRef: string;
    expectedRevocationEpoch: string;
    reason: string;
    changedAt: string;
    correlationId: string;
  }>): Promise<string> {
    const revocationEpoch = await this.repository.bumpRevocationEpoch(transaction, {
      siteRef: input.siteRef,
      expectedRevocationEpoch: input.expectedRevocationEpoch,
      changedAt: input.changedAt,
    });
    await this.publisher.publishRevocationEpochChanged(transaction, {
      siteRef: input.siteRef,
      revocationEpoch,
      reason: input.reason,
      changedAt: input.changedAt,
      correlationId: input.correlationId,
    });
    return revocationEpoch;
  }
}
