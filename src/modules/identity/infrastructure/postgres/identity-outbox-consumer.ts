import { randomUUID } from "node:crypto";
import type { PlatformTransactionalDatabaseClient } from
  "../../../../infrastructure/postgres/client.js";
import type {
  IdentityEffect,
  IdentityEffectEventQueue,
  IdentityEffectFailure,
  IdentityNamespaceAllocationEffect,
  IdentityVerificationDeliveryEffect,
} from "../../application/services/identity-outbox-consumer.js";
import {
  OUTBOX_ROUTE_CATALOG,
  OutboxRepository,
  type ClaimedOutboxEvent,
  type OutboxDeliveryAcknowledgement,
} from "../../../../shared/outbox-inbox/outbox.js";
import {
  resolvePlatformTransaction,
  type PlatformTransaction,
} from "../../../../shared/unit-of-work/platform-transaction.js";

export interface IdentityOutboxOutcomeRepository {
  prepareVerification(
    transaction: PlatformTransaction,
    effect: IdentityVerificationDeliveryEffect,
  ): Promise<"dispatch" | "superseded">;
  recordVerificationDelivered(
    transaction: PlatformTransaction,
    effect: IdentityVerificationDeliveryEffect,
    acknowledgement: OutboxDeliveryAcknowledgement,
  ): Promise<void>;
  applyNamespace(
    transaction: PlatformTransaction,
    effect: IdentityNamespaceAllocationEffect,
    appliedAt: string,
  ): Promise<void>;
  recordFailure(
    transaction: PlatformTransaction,
    effect: ClaimedOutboxEvent | IdentityEffect,
    failure: IdentityEffectFailure,
  ): Promise<void>;
}

interface VerificationProjectionRow extends Record<string, unknown> {
  readonly eventId: unknown;
  readonly transactionRef: unknown;
  readonly deliveryState: unknown;
  readonly verificationState: unknown;
  readonly deliveryCredentialRevision: unknown;
  readonly verificationCredentialRevision: unknown;
  readonly credentialLive: unknown;
}

interface NamespaceProjectionRow extends Record<string, unknown> {
  readonly eventId: unknown;
  readonly intentRef: unknown;
  readonly siteRef: unknown;
  readonly subjectRef: unknown;
  readonly workspaceRef: unknown;
  readonly projectRef: unknown;
  readonly executionSpaceRef: unknown;
  readonly executionNamespace: unknown;
  readonly intentState: unknown;
  readonly executionSpaceState: unknown;
}

export class PostgresIdentityOutboxOutcomeRepository
implements IdentityOutboxOutcomeRepository {
  async prepareVerification(
    transaction: PlatformTransaction,
    effect: IdentityVerificationDeliveryEffect,
  ): Promise<"dispatch" | "superseded"> {
    const sql = resolvePlatformTransaction(transaction);
    const rows = await sql.query<VerificationProjectionRow>(
      `SELECT delivery.event_id AS "eventId",delivery.transaction_ref AS "transactionRef",
              delivery.state AS "deliveryState",verification.state AS "verificationState",
              delivery.credential_revision AS "deliveryCredentialRevision",
              verification.resend_count AS "verificationCredentialRevision",
              verification.expires_at>now() AS "credentialLive"
       FROM platform.identity_verification_delivery delivery
       JOIN platform.identity_verification_transaction verification
         ON verification.site_ref=delivery.site_ref
        AND verification.transaction_ref=delivery.transaction_ref
       WHERE delivery.event_id=$1
       LIMIT 2
       FOR UPDATE OF delivery`,
      [effect.eventId],
    );
    const row = rows[0];
    if (
      rows.length !== 1 ||
      row?.eventId !== effect.eventId ||
      row.transactionRef !== effect.aggregateId ||
      !integer(row.deliveryCredentialRevision) ||
      !integer(row.verificationCredentialRevision) ||
      row.deliveryCredentialRevision !== effect.payload.credentialRevision
    ) throw permanent("IDENTITY_VERIFICATION_DELIVERY_NOT_DELIVERABLE");
    if (
      row.deliveryState === "superseded" &&
      row.deliveryCredentialRevision < row.verificationCredentialRevision
    ) return "superseded";
    if (
      (row.deliveryState === "queued" || row.deliveryState === "dispatching") &&
      row.deliveryCredentialRevision < row.verificationCredentialRevision
    ) {
      const superseded = await sql.execute(
        `UPDATE platform.identity_verification_delivery
         SET state='superseded',superseded_at=now(),failed_at=NULL,
             last_error_code='IDENTITY_VERIFICATION_DELIVERY_SUPERSEDED',updated_at=now()
         WHERE event_id=$1 AND credential_revision=$2 AND state IN ('queued','dispatching')`,
        [effect.eventId, effect.payload.credentialRevision],
      );
      if (superseded !== 1) throw new Error("IDENTITY_VERIFICATION_DELIVERY_OUTCOME_CONFLICT");
      return "superseded";
    }
    if (
      row.deliveryCredentialRevision !== row.verificationCredentialRevision ||
      row.deliveryState !== "queued" && row.deliveryState !== "dispatching" ||
      row.verificationState !== "pending" ||
      row.credentialLive !== true
    ) throw permanent("IDENTITY_VERIFICATION_DELIVERY_NOT_DELIVERABLE");
    const dispatching = await sql.execute(
      `UPDATE platform.identity_verification_delivery
       SET state='dispatching',attempt_count=GREATEST(attempt_count,$2),
           last_error_code=NULL,updated_at=now()
       WHERE event_id=$1 AND credential_revision=$3 AND state IN ('queued','dispatching')`,
      [effect.eventId, effect.attempt, effect.payload.credentialRevision],
    );
    if (dispatching !== 1) throw new Error("IDENTITY_VERIFICATION_DELIVERY_OUTCOME_CONFLICT");
    return "dispatch";
  }

  async recordVerificationDelivered(
    transaction: PlatformTransaction,
    effect: IdentityVerificationDeliveryEffect,
    acknowledgement: OutboxDeliveryAcknowledgement,
  ): Promise<void> {
    const changed = await resolvePlatformTransaction(transaction).execute(
      `UPDATE platform.identity_verification_delivery
       SET state='delivered',attempt_count=GREATEST(attempt_count,$2),
           delivered_at=$3::timestamptz,failed_at=NULL,last_error_code=NULL,updated_at=now()
       WHERE event_id=$1 AND transaction_ref=$4 AND credential_revision=$5
         AND state='dispatching'`,
      [effect.eventId, effect.attempt, acknowledgement.acknowledgedAt, effect.aggregateId,
        effect.payload.credentialRevision],
    );
    if (changed !== 1) throw new Error("IDENTITY_VERIFICATION_DELIVERY_OUTCOME_CONFLICT");
  }

  async applyNamespace(
    transaction: PlatformTransaction,
    effect: IdentityNamespaceAllocationEffect,
    appliedAt: string,
  ): Promise<void> {
    const sql = resolvePlatformTransaction(transaction);
    const rows = await sql.query<NamespaceProjectionRow>(
      `SELECT intent.event_id AS "eventId",intent.intent_ref::text AS "intentRef",
              intent.site_ref AS "siteRef",bootstrap.subject_ref AS "subjectRef",
              bootstrap.workspace_ref AS "workspaceRef",bootstrap.project_ref AS "projectRef",
              intent.execution_space_ref AS "executionSpaceRef",
              intent.execution_namespace AS "executionNamespace",intent.state AS "intentState",
              space.state AS "executionSpaceState"
       FROM platform.identity_namespace_allocation_intent intent
       JOIN platform.identity_personal_bootstrap bootstrap
         ON bootstrap.namespace_intent_ref=intent.intent_ref
        AND bootstrap.site_ref=intent.site_ref
        AND bootstrap.execution_space_ref=intent.execution_space_ref
        AND bootstrap.execution_namespace=intent.execution_namespace
       JOIN platform.identity_execution_space space
         ON space.site_ref=intent.site_ref
        AND space.execution_space_ref=intent.execution_space_ref
        AND space.execution_namespace=intent.execution_namespace
        AND space.project_ref=bootstrap.project_ref
       WHERE intent.event_id=$1
       LIMIT 2
       FOR UPDATE OF intent,space`,
      [effect.eventId],
    );
    const row = rows[0];
    const payload = effect.payload;
    if (
      rows.length !== 1 ||
      row?.eventId !== effect.eventId ||
      row.intentRef !== payload.namespaceIntentRef ||
      row.siteRef !== payload.siteRef ||
      row.subjectRef !== payload.subjectRef ||
      row.workspaceRef !== payload.workspaceRef ||
      row.projectRef !== payload.projectRef ||
      row.executionSpaceRef !== payload.executionSpaceRef ||
      row.executionNamespace !== payload.executionNamespace ||
      row.intentState !== "pending" ||
      row.executionSpaceState !== "allocation_pending"
    ) throw permanent("IDENTITY_NAMESPACE_ALLOCATION_MISMATCH");
    const spaceChanged = await sql.execute(
      `UPDATE platform.identity_execution_space
       SET state='active',updated_at=$4::timestamptz
       WHERE site_ref=$1 AND execution_space_ref=$2 AND execution_namespace=$3
         AND state='allocation_pending'`,
      [payload.siteRef, payload.executionSpaceRef, payload.executionNamespace, appliedAt],
    );
    const intentChanged = await sql.execute(
      `UPDATE platform.identity_namespace_allocation_intent
       SET state='applied',attempt_count=GREATEST(attempt_count,$3),updated_at=$4::timestamptz
       WHERE event_id=$1 AND intent_ref=$2::uuid AND state='pending'`,
      [effect.eventId, payload.namespaceIntentRef, effect.attempt, appliedAt],
    );
    if (spaceChanged !== 1 || intentChanged !== 1) {
      throw new Error("IDENTITY_NAMESPACE_ALLOCATION_OUTCOME_CONFLICT");
    }
  }

  async recordFailure(
    transaction: PlatformTransaction,
    effect: ClaimedOutboxEvent | IdentityEffect,
    failure: IdentityEffectFailure,
  ): Promise<void> {
    const sql = resolvePlatformTransaction(transaction);
    const terminal = failure.permanent || effect.attempt >= failure.maxAttempts;
    let changed: number;
    if (eventType(effect) === "identity.verification.delivery.requested") {
      changed = await sql.execute(
        `UPDATE platform.identity_verification_delivery
         SET state=CASE WHEN $3 THEN 'failed' ELSE 'queued' END,
             attempt_count=GREATEST(attempt_count,$2),
             failed_at=CASE WHEN $3 THEN now() ELSE NULL END,last_error_code=$4,updated_at=now()
         WHERE event_id=$1 AND state IN ('queued','dispatching')`,
        [effect.eventId, effect.attempt, terminal, failure.errorCode],
      );
    } else if (eventType(effect) === "identity.namespace.allocation.requested") {
      changed = await sql.execute(
        `UPDATE platform.identity_namespace_allocation_intent
         SET state=CASE WHEN $3 AND $5 THEN 'failed' WHEN $3 THEN 'dead_letter' ELSE 'pending' END,
             attempt_count=GREATEST(attempt_count,$2),last_error_code=$4,updated_at=now()
         WHERE event_id=$1 AND state='pending'`,
        [effect.eventId, effect.attempt, terminal, failure.errorCode, failure.permanent],
      );
    } else {
      throw permanent("IDENTITY_OUTBOX_EVENT_INVALID");
    }
    if (changed !== 1) throw new Error("IDENTITY_OUTBOX_FAILURE_OUTCOME_CONFLICT");
  }
}

export function createPostgresIdentityEffectEventQueue(
  database: Pick<PlatformTransactionalDatabaseClient, "internalTransaction">,
  options: Readonly<{
    workerId: string;
    claimLimit?: number;
    leaseSeconds?: number;
    now?: () => string;
  }>,
  outcomes: IdentityOutboxOutcomeRepository = new PostgresIdentityOutboxOutcomeRepository(),
  outbox: Pick<OutboxRepository,
    "claim" | "renewLease" | "complete" | "retryOrDeadLetter" | "releaseOwnedLeases">
    = new OutboxRepository(),
): IdentityEffectEventQueue {
  const claimLimit = boundedInteger(
    options.claimLimit ?? 10,
    1,
    100,
    "IDENTITY_OUTBOX_CLAIM_LIMIT_INVALID",
  );
  const leaseSeconds = boundedInteger(
    options.leaseSeconds ?? 30,
    1,
    300,
    "IDENTITY_OUTBOX_LEASE_SECONDS_INVALID",
  );
  const now = options.now ?? (() => new Date().toISOString());
  const queue: IdentityEffectEventQueue = {
    claim: () => database.internalTransaction("identity.outbox.consume", (transaction) =>
      outbox.claim(transaction, {
        workerId: options.workerId,
        leaseToken: randomUUID(),
        consumer: OUTBOX_ROUTE_CATALOG.identity.consumer,
        eventTypes: OUTBOX_ROUTE_CATALOG.identity.eventTypes,
        limit: claimLimit,
        leaseSeconds,
      })),
    renew: (eventId, leaseToken) => database.internalTransaction(
      "identity.outbox.consume",
      (transaction) => outbox.renewLease(transaction, {
        eventId,
        leaseToken,
        workerId: options.workerId,
        owner: "identity",
        leaseSeconds,
      }),
    ),
    prepareVerification: (effect) => database.internalTransaction(
      "identity.outbox.consume",
      async (transaction) => {
        const disposition = await outcomes.prepareVerification(transaction, effect);
        if (disposition === "superseded") {
          await outbox.complete(transaction, {
            eventId: effect.eventId,
            leaseToken: effect.leaseToken,
            deliveryId: effect.eventId,
            acknowledgedAt: now(),
          });
        }
        return disposition;
      },
    ),
    completeVerification: (effect, acknowledgement) => database.internalTransaction(
      "identity.outbox.consume",
      async (transaction) => {
        await outcomes.recordVerificationDelivered(transaction, effect, acknowledgement);
        await outbox.complete(transaction, {
          eventId: effect.eventId,
          leaseToken: effect.leaseToken,
          ...acknowledgement,
        });
      },
    ),
    applyNamespace: (effect) => database.internalTransaction(
      "identity.outbox.consume",
      async (transaction) => {
        const appliedAt = now();
        await outcomes.applyNamespace(transaction, effect, appliedAt);
        await outbox.complete(transaction, {
          eventId: effect.eventId,
          leaseToken: effect.leaseToken,
          deliveryId: `identity-namespace:${effect.eventId}`,
          acknowledgedAt: appliedAt,
        });
      },
    ),
    fail: (effect, failure) => database.internalTransaction(
      "identity.outbox.consume",
      async (transaction) => {
        await outcomes.recordFailure(transaction, effect, failure);
        await outbox.retryOrDeadLetter(transaction, {
          eventId: effect.eventId,
          leaseToken: effect.leaseToken,
          errorCode: failure.errorCode,
          retryAt: failure.retryAt,
          maxAttempts: failure.maxAttempts,
        });
      },
    ),
    releaseOwned: (_reason) => database.internalTransaction(
      "identity.outbox.consume",
      async (transaction) => {
        await outbox.releaseOwnedLeases(transaction, {
          workerId: options.workerId,
          consumer: OUTBOX_ROUTE_CATALOG.identity.consumer,
        });
      },
    ),
  };
  return Object.freeze(queue);
}

function eventType(effect: ClaimedOutboxEvent | IdentityEffect): string {
  if ("eventType" in effect) return effect.eventType;
  return effect.payload.kind === "sealed_identity_verification_v1"
    ? "identity.verification.delivery.requested"
    : "identity.namespace.allocation.requested";
}

function integer(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function permanent(code: string): Error {
  return Object.assign(new Error(code), { retryable: false });
}

function boundedInteger(value: number, minimum: number, maximum: number, code: string): number {
  if (!Number.isInteger(value) || value < minimum || value > maximum) throw new Error(code);
  return value;
}
