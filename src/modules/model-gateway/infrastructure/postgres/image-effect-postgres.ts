import { createHash, randomUUID } from "node:crypto";
import type { PlatformTransaction } from "../../../../shared/unit-of-work/index.js";
import type { ModelGatewayResponseEnvelope } from "../crypto/response-protector.js";
import {
  issuePlatformTransaction,
  resolvePlatformTransaction,
  revokePlatformTransaction,
} from "../../../../shared/unit-of-work/platform-transaction.js";
import type {
  ImageEffectAccessAuthorization,
  ImageEffectBudgetCommitAuthority,
  ImageEffectBudgetCommitOutcome,
  ImageEffectCommandJournal,
  ImageEffectInvocation,
  ImageEffectRepository,
  ImageEffectUnitOfWork,
} from "../../application/image-effect-service.js";
import {
  applyImageEffectObservation,
  type ImageEffectAttempt,
  type ImageEffectProviderObservation,
  type ImageEffectProviderOutput,
} from "../../domain/image-effect.js";
import type { ImageEffectOutputEvidenceIdentityAuthority } from "../../domain/image-effect-evidence.js";
import type {
  ImageEffectDispatchClaim,
  ImageEffectDispatchContext,
  ImageEffectDispatchSourceGrant,
  ImageEffectWorkerRepository,
} from "../../application/image-effect-worker.js";
import type { ImageEffectEvidenceRepository } from "../../application/image-effect-evidence-service.js";
import type {
  ImageEffectOutputAccessClaims,
  ImageEffectOutputAccessRecord,
  ImageEffectOutputEvidenceRecord,
  ImageEffectOutputRepository,
} from "../../application/image-effect-output-service.js";

interface QueryResult<Row extends Record<string, unknown> = Record<string, unknown>> {
  readonly rows: readonly Row[];
  readonly rowCount: number | null;
}

export interface ImageEffectPoolClient {
  query(text: string, values?: readonly unknown[]): Promise<QueryResult>;
  release(destroy?: boolean): void;
}

export interface ImageEffectPool {
  connect(): Promise<ImageEffectPoolClient>;
  end(): Promise<void>;
}

export interface ImageEffectSecretProtector {
  seal(plaintext: Uint8Array, context: Readonly<{
    siteId: string;
    logicalInvocationRef: string;
    purpose: "source-grants" | "retrieval-grant";
    bindingRef: string;
  }>): ModelGatewayResponseEnvelope;
  unseal(envelope: ModelGatewayResponseEnvelope, context: Readonly<{
    siteId: string;
    logicalInvocationRef: string;
    purpose: "source-grants" | "retrieval-grant";
    bindingRef: string;
  }>): Uint8Array;
}

export class PostgresImageEffectAuthority implements ImageEffectUnitOfWork, ImageEffectBudgetCommitAuthority {
  constructor(private readonly dependencies: Readonly<{ pool: ImageEffectPool }>) {}

  async execute<Result>(
    scope: Parameters<ImageEffectUnitOfWork["execute"]>[0],
    work: Parameters<ImageEffectUnitOfWork["execute"]>[1],
  ): Promise<Result> {
    accessHandle(scope.callerAccessHandle);
    if (scope.operation === "create" && scope.modelOptionAuthorizationHandle === undefined) {
      throw new Error("IMAGE_EFFECT_MODEL_OPTION_AUTHORIZATION_REQUIRED");
    }
    if (scope.operation === "create" && scope.sourceGrants === undefined) {
      throw new Error("IMAGE_EFFECT_SOURCE_GRANT_AUTHORIZATION_REQUIRED");
    }
    if (scope.modelOptionAuthorizationHandle !== undefined) accessHandle(scope.modelOptionAuthorizationHandle);
    const client = await this.dependencies.pool.connect();
    let began = false;
    try {
      await client.query("BEGIN ISOLATION LEVEL READ COMMITTED");
      began = true;
      const accessDigest = sha256(scope.callerAccessHandle);
      const accessRows = await client.query(
        `SELECT caller_access_handle_digest AS "callerAccessHandleDigest",
                caller_identity AS "callerIdentity",site_ref AS "siteId",
                caller_audience AS "callerAudience",
                workload_identity_ref AS "workloadIdentityRef",
                environment,region,
                authorization_generation AS "authorizationGeneration",
                security_epoch AS "securityEpoch",expires_at AS "expiresAt"
           FROM platform.resolve_model_image_effect_access($1,$2)`,
        [accessDigest, scope.operation],
      );
      const access = mapAccess(single(accessRows.rows, "IMAGE_EFFECT_ACCESS_DENIED"), accessDigest);
      let sourceGrantClaims: ImageEffectAccessAuthorization["sourceGrantClaims"] = Object.freeze([]);
      if (scope.sourceGrants !== undefined) {
        const sourceRefs = scope.sourceGrants.map((source) => source.sourceVersionRef);
        const grantDigests = scope.sourceGrants.map((source) => sha256(source.purposeGrantHandle));
        const sourceRows = await client.query(
          `SELECT source_version_ref AS "sourceVersionRef",
                  purpose_grant_handle_digest AS "purposeGrantHandleDigest",
                  expires_at AS "expiresAt"
             FROM platform.resolve_model_image_source_grant_authorizations($1,$2::text[],$3::text[])`,
          [accessDigest, sourceRefs, grantDigests],
        );
        if (sourceRows.rows.length !== scope.sourceGrants.length) {
          throw new Error("IMAGE_EFFECT_SOURCE_GRANT_NOT_AUTHORIZED");
        }
        sourceGrantClaims = Object.freeze(sourceRows.rows.map((row, index) =>
          mapSourceGrant(row, sourceRefs[index], grantDigests[index])));
      }
      let modelOption: ImageEffectAccessAuthorization["modelOption"];
      if (scope.modelOptionAuthorizationHandle !== undefined) {
        const modelDigest = sha256(scope.modelOptionAuthorizationHandle);
        const modelRows = await client.query(
          `SELECT model_option_authorization_handle_digest AS "authorizationHandleDigest",
                  model_option_revision_ref AS "modelOptionRevisionRef",
                  definition_role_ref AS "definitionRoleRef",deployment_ref AS "deploymentRef",
                  adapter_kind AS "adapterKind",provider_model AS "providerModel",expires_at AS "expiresAt"
             FROM platform.resolve_model_image_option_authorization($1,$2)`,
          [accessDigest, modelDigest],
        );
        modelOption = mapModel(single(modelRows.rows, "IMAGE_EFFECT_MODEL_OPTION_NOT_AUTHORIZED"), modelDigest);
      }
      await client.query(
        `SELECT set_config('app.operation',$1,true),set_config('app.site_id',$2,true),
                set_config('app.workload_kind','platform_model_gateway',true),
                set_config('app.actor_kind','workload',true),
                set_config('app.scopes','["model:image-effect"]',true)`,
        [`model-image-effect.${scope.operation}`, access.siteId],
      );
      const lease = issuePlatformTransaction({
        query: async (statement, values = []) => (await client.query(statement, values)).rows as never,
        execute: async (statement, values = []) => (await client.query(statement, values)).rowCount ?? 0,
      });
      try {
        const authorization = Object.freeze({ ...access, sourceGrantClaims,
          ...(modelOption === undefined ? {} : { modelOption }) });
        const result = await work(lease.transaction, authorization) as Result;
        await client.query("COMMIT");
        began = false;
        return result;
      } finally {
        revokePlatformTransaction(lease);
      }
    } catch (error) {
      if (began) await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async consume(
    transaction: PlatformTransaction,
    input: Parameters<ImageEffectBudgetCommitAuthority["consume"]>[1],
  ): Promise<ImageEffectBudgetCommitOutcome> {
    const slotsDigest = sha256(canonical(input.logicalOutputSlots));
    const rows = await resolvePlatformTransaction(transaction).query<BudgetRow>(
      `SELECT effect_budget_commit_ref AS "effectBudgetCommitRef",
              effect_budget_commit_digest AS "effectBudgetCommitDigest",
              attempt_ordinal AS "attemptOrdinal",expires_at AS "expiresAt",replayed
         FROM platform.consume_model_image_effect_budget_commit(
           $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
      [input.siteId, input.callerIdentity, input.effectBudgetCommitRef,
        input.effectBudgetCommitDigest, input.modelInvocationCommandRef, input.attemptOrdinal,
        input.modelOptionRevisionRef, input.deploymentRef, input.operationInputRevisionRef,
        input.operationInputRevisionDigest, slotsDigest, input.logicalInvocationRef,
        input.attemptRef, input.ownerCommandDigest],
    );
    if (rows.length === 0) return Object.freeze({ kind: "rejected", code: "EFFECT_BUDGET_REJECTED" });
    const row = single(rows, "IMAGE_EFFECT_BUDGET_RECEIPT_INVALID");
    const expiresAt = instant(row.expiresAt);
    if (row.effectBudgetCommitRef !== input.effectBudgetCommitRef ||
        row.effectBudgetCommitDigest !== input.effectBudgetCommitDigest ||
        integer(row.attemptOrdinal) !== input.attemptOrdinal || typeof row.replayed !== "boolean") {
      throw new Error("IMAGE_EFFECT_BUDGET_RECEIPT_INVALID");
    }
    return Object.freeze({
      kind: row.replayed ? "replayed" : "accepted",
      effectBudgetCommitRef: row.effectBudgetCommitRef,
      effectBudgetCommitDigest: row.effectBudgetCommitDigest,
      attemptOrdinal: input.attemptOrdinal,
      expiresAt,
    });
  }
}

interface BudgetRow extends Record<string, unknown> {
  effectBudgetCommitRef: unknown;
  effectBudgetCommitDigest: unknown;
  attemptOrdinal: unknown;
  expiresAt: unknown;
  replayed: unknown;
}

export class PostgresImageEffectRepository implements ImageEffectRepository {
  readonly #reference: () => string;
  constructor(private readonly dependencies: Readonly<{
    secretProtector: ImageEffectSecretProtector;
    reference?: () => string;
  }>) {
    this.#reference = dependencies.reference ?? (() => randomUUID());
  }

  async lockCommand(
    transaction: PlatformTransaction,
    input: Readonly<{ callerIdentity: string; callerCommandRef: string }>,
  ): Promise<ImageEffectCommandJournal | null> {
    const rows = await resolvePlatformTransaction(transaction).query<CommandRow>(
      `SELECT site_ref AS "siteId",caller_identity AS "callerIdentity",
              caller_access_handle_digest AS "callerAccessHandleDigest",
              caller_command_ref AS "callerCommandRef",command_kind AS "commandKind",
              owner_command_digest AS "ownerCommandDigest",
              caller_request_fingerprint AS "callerRequestFingerprint",
              logical_invocation_ref AS "logicalInvocationRef",attempt_ref AS "attemptRef",
              attempt_ordinal AS "attemptOrdinal",receipt_kind AS "receiptKind",
              receipt_version AS "receiptVersion",recorded_at AS "recordedAt",
              request_digest AS "requestDigest",receipt_ref AS "receiptRef",
              receipt_digest AS "receiptDigest"
         FROM platform.model_image_effect_command_journal
        WHERE caller_identity=$1 AND caller_command_ref=$2 FOR UPDATE`,
      [input.callerIdentity, input.callerCommandRef],
    );
    return rows.length === 0 ? null : mapCommand(single(rows, "IMAGE_EFFECT_COMMAND_CORRUPT"));
  }

  async lockInvocation(
    transaction: PlatformTransaction,
    input: Readonly<{
      callerIdentity: string;
      logicalInvocationRef?: string;
      modelInvocationCommandRef?: string;
    }>,
  ): Promise<ImageEffectInvocation | null> {
    if (input.logicalInvocationRef === undefined && input.modelInvocationCommandRef === undefined) {
      throw new Error("IMAGE_EFFECT_INVOCATION_LOOKUP_INVALID");
    }
    const sql = resolvePlatformTransaction(transaction);
    const rows = await sql.query<InvocationRow>(
      `${INVOCATION_SELECT}
        WHERE invocation.caller_identity=$1
          AND ($2::text IS NULL OR invocation.logical_invocation_ref=$2)
          AND ($3::text IS NULL OR invocation.model_invocation_command_ref=$3)
        FOR UPDATE`,
      [input.callerIdentity, input.logicalInvocationRef ?? null, input.modelInvocationCommandRef ?? null],
    );
    if (rows.length === 0) return null;
    const row = single(rows, "IMAGE_EFFECT_INVOCATION_CORRUPT");
    const attempts = await sql.query<AttemptRow>(
      `${ATTEMPT_SELECT} WHERE attempt.logical_invocation_ref=$1 ORDER BY attempt.attempt_ordinal`,
      [text(row.logicalInvocationRef)],
    );
    const observations = await sql.query<ObservationRow>(
      `SELECT observation.attempt_ref AS "attemptRef",observation.provider_event_ref AS "eventRef",
              observation.provider_sequence AS sequence,observation.observation_digest AS digest
         FROM platform.model_image_effect_provider_observation observation
         JOIN platform.model_image_effect_attempt attempt ON attempt.attempt_ref=observation.attempt_ref
        WHERE attempt.logical_invocation_ref=$1
        ORDER BY attempt.attempt_ordinal,observation.provider_sequence`,
      [text(row.logicalInvocationRef)],
    );
    const outputs = await sql.query<OutputRow>(
      `SELECT output.attempt_ref AS "attemptRef",output.candidate_ref AS "candidateRef",
              output.stable_output_slot_ref AS "stableOutputSlotRef",
              output.provider_output_fact_ref AS "providerOutputFactRef",
              output.retrieval_grant_handle_digest AS "retrievalGrantHandleDigest",
              output.retrieval_grant_envelope AS "retrievalGrantEnvelope"
         FROM platform.model_image_effect_output_evidence output
         JOIN platform.model_image_effect_attempt attempt ON attempt.attempt_ref=output.attempt_ref
        WHERE attempt.logical_invocation_ref=$1
        ORDER BY attempt.attempt_ordinal,output.candidate_ref`,
      [text(row.logicalInvocationRef)],
    );
    return mapInvocation(row, attempts, observations, outputs);
  }

  async create(
    transaction: PlatformTransaction,
    input: Readonly<{
      journal: ImageEffectCommandJournal;
      invocation: ImageEffectInvocation;
      sourceGrants: readonly Readonly<{ sourceVersionRef: string; purposeGrantHandle: string }>[];
    }>,
  ): Promise<void> {
    const sql = resolvePlatformTransaction(transaction);
    const attempt = onlyAttempt(input.invocation);
    const sourcePlaintext = encodeSourceGrantSecrets(input.sourceGrants);
    let sourceEnvelope: ModelGatewayResponseEnvelope;
    try {
      sourceEnvelope = this.dependencies.secretProtector.seal(sourcePlaintext,
        { siteId: input.invocation.siteId, logicalInvocationRef: input.invocation.logicalInvocationRef,
          purpose: "source-grants", bindingRef: input.invocation.operationInputRevisionRef });
    } finally {
      sourcePlaintext.fill(0);
    }
    one(await sql.execute(
      `INSERT INTO platform.model_image_effect_invocation
       (logical_invocation_ref,site_ref,caller_identity,caller_access_handle_digest,
        model_option_authorization_handle_digest,model_invocation_command_ref,owner_version,state,
        definition_role_ref,model_option_revision_ref,deployment_ref,adapter_kind,provider_model,
        model_authorization_expires_at,operation_input_revision_ref,operation_input_revision_digest,
        source_grant_refs,source_grants,logical_output_slots,trust_effect_allow_receipt_ref,
        trust_effect_allow_receipt_digest,current_attempt_ordinal,created_at,updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::timestamptz,$15,$16,
         $17::jsonb,$18::jsonb,$19::jsonb,$20,$21,$22,$23::timestamptz,$24::timestamptz)`,
      [input.invocation.logicalInvocationRef, input.invocation.siteId, input.invocation.callerIdentity,
        input.invocation.callerAccessHandleDigest, input.invocation.modelOptionAuthorizationHandleDigest,
        input.invocation.modelInvocationCommandRef, input.invocation.ownerVersion.toString(),
        input.invocation.state, input.invocation.definitionRoleRef, input.invocation.modelOptionRevisionRef,
        input.invocation.deploymentRef, input.invocation.adapterKind, input.invocation.providerModel,
        input.invocation.modelAuthorizationExpiresAt, input.invocation.operationInputRevisionRef,
        input.invocation.operationInputRevisionDigest, canonical(input.invocation.sourceGrantRefs),
        canonical(sourceEnvelope), canonical(input.invocation.logicalOutputSlots),
        input.invocation.trustEffectAllowReceiptRef, input.invocation.trustEffectAllowReceiptDigest, attempt.ordinal,
        input.invocation.createdAt, input.invocation.updatedAt],
    ), "IMAGE_EFFECT_INVOCATION_INSERT_FAILED");
    await this.#insertAttempt(sql, input.invocation, attempt);
    one(await sql.execute(
      `INSERT INTO platform.model_image_effect_dispatch_queue
       (attempt_ref,site_ref,logical_invocation_ref,state) VALUES ($1,$2,$3,'queued')`,
      [attempt.attemptRef, input.invocation.siteId, input.invocation.logicalInvocationRef],
    ), "IMAGE_EFFECT_QUEUE_INSERT_FAILED");
    await this.#insertJournal(sql, input.journal);
    await this.#insertOutbox(sql, input.invocation, "image_effect.created.v1");
  }

  async persistCommand(
    transaction: PlatformTransaction,
    input: Readonly<{ journal: ImageEffectCommandJournal; invocation: ImageEffectInvocation }>,
  ): Promise<void> {
    const sql = resolvePlatformTransaction(transaction);
    const attempt = onlyAttempt(input.invocation);
    const isAttach = input.journal.commandKind === "attach_attempt";
    one(await sql.execute(
      `UPDATE platform.model_image_effect_invocation
          SET owner_version=$1,state=$2,current_attempt_ordinal=$3,updated_at=$4::timestamptz
        WHERE logical_invocation_ref=$5 AND caller_identity=$6 AND owner_version=$7`,
      [input.invocation.ownerVersion.toString(), input.invocation.state, attempt.ordinal,
        input.invocation.updatedAt, input.invocation.logicalInvocationRef, input.invocation.callerIdentity,
        (input.invocation.ownerVersion - 1n).toString()],
    ), "IMAGE_EFFECT_INVOCATION_CAS_LOST");
    if (isAttach) {
      await this.#insertAttempt(sql, input.invocation, attempt);
      one(await sql.execute(
        `INSERT INTO platform.model_image_effect_dispatch_queue
         (attempt_ref,site_ref,logical_invocation_ref,state) VALUES ($1,$2,$3,'queued')`,
        [attempt.attemptRef, input.invocation.siteId, input.invocation.logicalInvocationRef],
      ), "IMAGE_EFFECT_QUEUE_INSERT_FAILED");
    } else {
      one(await sql.execute(
        `UPDATE platform.model_image_effect_attempt
            SET cancel_requested=TRUE,updated_at=$1::timestamptz
          WHERE attempt_ref=$2 AND logical_invocation_ref=$3`,
        [input.invocation.updatedAt, attempt.attemptRef, input.invocation.logicalInvocationRef],
      ), "IMAGE_EFFECT_CANCEL_FENCE_LOST");
    }
    await this.#insertJournal(sql, input.journal);
    await this.#insertOutbox(sql, input.invocation,
      isAttach ? "image_effect.attempt_attached.v1" : "image_effect.cancel_requested.v1");
  }

  async #insertAttempt(
    sql: ReturnType<typeof resolvePlatformTransaction>,
    invocation: ImageEffectInvocation,
    attempt: ImageEffectAttempt,
  ): Promise<void> {
    one(await sql.execute(
      `INSERT INTO platform.model_image_effect_attempt
       (attempt_ref,logical_invocation_ref,site_ref,attempt_ordinal,effect_budget_commit_ref,
        effect_budget_commit_digest,provider_operation_key,state,cancel_requested,last_provider_sequence,
        late_outcome,created_at,updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::timestamptz,$13::timestamptz)`,
      [attempt.attemptRef, invocation.logicalInvocationRef, invocation.siteId, attempt.ordinal,
        attempt.budgetCommitRef, attempt.budgetCommitDigest, attempt.providerOperationKey,
        attempt.state, attempt.cancelRequested, attempt.lastProviderSequence.toString(), attempt.lateOutcome,
        invocation.updatedAt, invocation.updatedAt],
    ), "IMAGE_EFFECT_ATTEMPT_INSERT_FAILED");
  }

  async #insertJournal(
    sql: ReturnType<typeof resolvePlatformTransaction>,
    journal: ImageEffectCommandJournal,
  ): Promise<void> {
    one(await sql.execute(
      `INSERT INTO platform.model_image_effect_command_journal
       (site_ref,caller_identity,caller_access_handle_digest,caller_command_ref,command_kind,
        owner_command_digest,caller_request_fingerprint,logical_invocation_ref,attempt_ref,
        attempt_ordinal,receipt_kind,receipt_version,recorded_at,request_digest,receipt_ref,receipt_digest)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::timestamptz,$14,$15,$16)`,
      [journal.siteId, journal.callerIdentity, journal.callerAccessHandleDigest,
        journal.callerCommandRef, journal.commandKind, journal.ownerCommandDigest,
        journal.callerRequestFingerprint, journal.receipt.logicalInvocationRef,
        journal.receipt.attemptRef, journal.receipt.attemptOrdinal, journal.receipt.kind,
        journal.receipt.receiptVersion.toString(), journal.receipt.recordedAt,
        journal.receipt.requestDigest, journal.receipt.receiptRef, journal.receipt.receiptDigest],
    ), "IMAGE_EFFECT_JOURNAL_INSERT_FAILED");
  }

  async #insertOutbox(
    sql: ReturnType<typeof resolvePlatformTransaction>,
    invocation: ImageEffectInvocation,
    eventKind: "image_effect.created.v1" | "image_effect.attempt_attached.v1" |
      "image_effect.cancel_requested.v1",
  ): Promise<void> {
    const payload = canonical({
      logicalInvocationRef: invocation.logicalInvocationRef,
      modelInvocationCommandRef: invocation.modelInvocationCommandRef,
      ownerVersion: invocation.ownerVersion.toString(),
      state: invocation.state,
      currentAttemptOrdinal: onlyAttempt(invocation).ordinal,
      observedAt: invocation.updatedAt,
    });
    one(await sql.execute(
      `INSERT INTO platform.model_image_effect_outbox
       (event_ref,site_ref,logical_invocation_ref,event_kind,evidence_revision,payload,payload_digest)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7)`,
      [this.#reference(), invocation.siteId, invocation.logicalInvocationRef, eventKind,
        invocation.ownerVersion.toString(), payload, sha256(payload)],
    ), "IMAGE_EFFECT_OUTBOX_INSERT_FAILED");
  }
}

export class PostgresImageEffectDispatchSecretLoader {
  constructor(private readonly dependencies: Readonly<{
    pool: ImageEffectPool;
    secretProtector: ImageEffectSecretProtector;
  }>) {}

  async withSourceGrants<Result>(input: Readonly<{
    attemptRef: string;
    dispatchOwnerRef: string;
    dispatchFence: bigint;
  }>, work: (grants: readonly ImageEffectDispatchSourceGrant[]) => Promise<Result>): Promise<Result> {
    text(input.attemptRef);
    text(input.dispatchOwnerRef);
    if (input.dispatchFence < 1n) throw new Error("IMAGE_EFFECT_DISPATCH_FENCE_INVALID");
    const client = await this.dependencies.pool.connect();
    let plaintext: Uint8Array | undefined;
    try {
      const result = await client.query(
        `SELECT site_ref AS "siteId",logical_invocation_ref AS "logicalInvocationRef",
                operation_input_revision_ref AS "operationInputRevisionRef",
                source_grants AS "sourceGrants"
           FROM platform.load_model_image_effect_dispatch_secrets($1,$2,$3)`,
        [input.attemptRef, input.dispatchOwnerRef, input.dispatchFence.toString()],
      );
      const row = single(result.rows, "IMAGE_EFFECT_DISPATCH_SECRET_FENCE_LOST");
      const siteId = text(row.siteId);
      const logicalInvocationRef = text(row.logicalInvocationRef);
      plaintext = this.dependencies.secretProtector.unseal(responseEnvelope(row.sourceGrants), {
        siteId,
        logicalInvocationRef,
        purpose: "source-grants",
        bindingRef: text(row.operationInputRevisionRef),
      });
      const grants = decodeSourceGrantSecrets(plaintext);
      return await work(grants);
    } finally {
      plaintext?.fill(0);
      client.release();
    }
  }
}

export class PostgresImageEffectWorkerRepository implements ImageEffectWorkerRepository {
  readonly #reference: () => string;
  readonly #clock: () => Date;

  constructor(private readonly dependencies: Readonly<{
    pool: ImageEffectPool;
    secretProtector: ImageEffectSecretProtector;
    outputIdentity: ImageEffectOutputEvidenceIdentityAuthority;
    reference?: () => string;
    clock?: () => Date;
  }>) {
    this.#reference = dependencies.reference ?? (() => randomUUID());
    this.#clock = dependencies.clock ?? (() => new Date());
  }

  async claim(input: Readonly<{
    dispatchOwnerRef: string;
    leaseMilliseconds: number;
  }>): Promise<ImageEffectDispatchClaim | null> {
    text(input.dispatchOwnerRef);
    if (!Number.isInteger(input.leaseMilliseconds) || input.leaseMilliseconds < 1_000 ||
        input.leaseMilliseconds > 300_000) throw new Error("IMAGE_EFFECT_DISPATCH_LEASE_INVALID");
    return this.#withClient(async (client) => {
      const result = await client.query(
        `SELECT site_ref AS "siteId",attempt_ref AS "attemptRef",
                logical_invocation_ref AS "logicalInvocationRef",dispatch_fence AS "dispatchFence"
           FROM platform.claim_model_image_effect_dispatch($1,$2)`,
        [input.dispatchOwnerRef, input.leaseMilliseconds],
      );
      if (result.rows.length === 0) return null;
      const row = single(result.rows, "IMAGE_EFFECT_DISPATCH_CLAIM_CORRUPT");
      return Object.freeze({ siteId: text(row.siteId), attemptRef: text(row.attemptRef),
        logicalInvocationRef: text(row.logicalInvocationRef), dispatchOwnerRef: input.dispatchOwnerRef,
        dispatchFence: positive(row.dispatchFence) });
    });
  }

  async load(claim: ImageEffectDispatchClaim): Promise<ImageEffectDispatchContext> {
    assertClaim(claim);
    return this.#withClient(async (client) => {
      const result = await client.query(
        `SELECT context FROM platform.load_model_image_effect_dispatch_context($1,$2,$3)`,
        [claim.attemptRef, claim.dispatchOwnerRef, claim.dispatchFence.toString()],
      );
      const row = single(result.rows, "IMAGE_EFFECT_DISPATCH_FENCE_LOST");
      const context = jsonObject(row.context, "IMAGE_EFFECT_DISPATCH_CONTEXT_CORRUPT");
      if (context.siteId !== claim.siteId || context.logicalInvocationRef !== claim.logicalInvocationRef) {
        throw new Error("IMAGE_EFFECT_DISPATCH_CONTEXT_CORRUPT");
      }
      return mapWorkerContext(context);
    });
  }

  async heartbeat(claim: ImageEffectDispatchClaim, leaseMilliseconds: number): Promise<boolean> {
    assertClaim(claim);
    if (!Number.isInteger(leaseMilliseconds) || leaseMilliseconds < 1_000 || leaseMilliseconds > 300_000) {
      throw new Error("IMAGE_EFFECT_DISPATCH_LEASE_INVALID");
    }
    return this.#withClient(async (client) => {
      const result = await client.query(
        `SELECT platform.heartbeat_model_image_effect_dispatch($1,$2,$3,$4) AS alive`,
        [claim.attemptRef, claim.dispatchOwnerRef, claim.dispatchFence.toString(), leaseMilliseconds],
      );
      const row = single(result.rows, "IMAGE_EFFECT_DISPATCH_HEARTBEAT_CORRUPT");
      return boolean(row.alive);
    });
  }

  async recordObservation(
    claim: ImageEffectDispatchClaim,
    observation: ImageEffectProviderObservation,
    attempt: ImageEffectAttempt,
  ): Promise<ImageEffectAttempt | null> {
    assertClaim(claim);
    if (attempt.attemptRef !== claim.attemptRef ||
        attempt.lastProviderSequence !== observation.sequence) {
      throw new Error("IMAGE_EFFECT_DISPATCH_OBSERVATION_INVALID");
    }
    const outputPayload = observation.kind === "succeeded"
      ? this.#protectOutputs(claim, attempt, observation.outputs)
      : Object.freeze([]);
    const evidencePayload = terminalEvidencePayload(observation, outputPayload);
    const attemptPayload = canonical(attemptRecordPayload(attempt));
    const outputs = canonical(outputPayload);
    const evidence = canonical(evidencePayload);
    const outboxPayload = canonical({ logicalInvocationRef: claim.logicalInvocationRef,
      attemptRef: claim.attemptRef, attemptOrdinal: attempt.ordinal, state: attempt.state,
      providerSequence: observation.sequence.toString(), observedAt: observation.observedAt });
    return this.#withClient(async (client) => {
      const result = await client.query(
        `SELECT persisted,replayed FROM platform.record_model_image_effect_observation(
          $1,$2,$3,$4,$5,$6,$7,$8,$9::timestamptz,$10::jsonb,$11::jsonb,$12::jsonb,$13,$14::jsonb,$15)`,
        [claim.attemptRef, claim.logicalInvocationRef, claim.dispatchOwnerRef,
          claim.dispatchFence.toString(), observation.eventRef, observation.sequence.toString(),
          observation.kind, observation.observationDigest, observation.observedAt, attemptPayload,
          outputs, evidence, this.#validReference(this.#reference()), outboxPayload, sha256(outboxPayload)],
      );
      if (result.rows.length === 0) return null;
      const row = single(result.rows, "IMAGE_EFFECT_OBSERVATION_PERSISTENCE_CORRUPT");
      if (!boolean(row.persisted)) return null;
      boolean(row.replayed);
      return attempt;
    });
  }

  async recordStartAmbiguity(
    claim: ImageEffectDispatchClaim,
    errorCode: string,
  ): Promise<ImageEffectAttempt | null> {
    const context = await this.load(claim);
    if (context.attempt.state !== "planned") throw new Error("IMAGE_EFFECT_START_AMBIGUITY_STATE_INVALID");
    const observedAt = this.#now();
    const core = { kind: "submission_unknown" as const, eventRef: this.#validReference(this.#reference()),
      sequence: context.attempt.lastProviderSequence + 1n, observedAt };
    const observation = Object.freeze({ ...core,
      observationDigest: sha256(canonical({ ...core, sequence: core.sequence.toString(), errorCode })) });
    const attempt = applyImageEffectObservation(context.attempt, observation).attempt;
    return this.recordObservation(claim, observation, attempt);
  }

  async recordStreamAmbiguity(
    claim: ImageEffectDispatchClaim,
    errorCode: string,
  ): Promise<ImageEffectAttempt | null> {
    const context = await this.load(claim);
    const observedAt = this.#now();
    const eventRef = this.#validReference(this.#reference());
    const outcomeEvidenceRef = this.#validReference(`image-effect-outcome-unknown:${this.#reference()}`);
    const outcomeEvidenceDigest = sha256(canonical({ eventRef, errorCode, observedAt,
      attemptRef: claim.attemptRef }));
    const observation: ImageEffectProviderObservation = Object.freeze({ kind: "outcome_unknown", eventRef,
      sequence: context.attempt.lastProviderSequence + 1n, observationDigest: sha256(canonical({ eventRef,
        errorCode, observedAt, outcomeEvidenceRef, outcomeEvidenceDigest })), observedAt,
      outcomeEvidenceRef, outcomeEvidenceDigest });
    const attempt = applyImageEffectObservation(context.attempt, observation).attempt;
    return this.recordObservation(claim, observation, attempt);
  }

  async deadLetterBeforeProviderIo(claim: ImageEffectDispatchClaim, errorCode: string): Promise<boolean> {
    assertClaim(claim);
    if (!/^[A-Z0-9_]{1,128}$/u.test(errorCode)) throw new Error("IMAGE_EFFECT_ERROR_CODE_INVALID");
    return this.#withClient(async (client) => {
      const result = await client.query(
        `SELECT platform.dead_letter_model_image_effect_before_provider_io($1,$2,$3,$4) AS changed`,
        [claim.attemptRef, claim.dispatchOwnerRef, claim.dispatchFence.toString(), errorCode],
      );
      return boolean(single(result.rows, "IMAGE_EFFECT_DEAD_LETTER_CORRUPT").changed);
    });
  }

  async returnOwnedLeases(reason: "shutdown" | "shutdown-deadline" | "stop-claim-failed",
    dispatchOwnerRef: string): Promise<number> {
    text(dispatchOwnerRef);
    const errorCode = reason === "shutdown" ? "IMAGE_EFFECT_WORKER_SHUTDOWN"
      : reason === "shutdown-deadline" ? "IMAGE_EFFECT_WORKER_SHUTDOWN_DEADLINE"
        : "IMAGE_EFFECT_WORKER_STOP_CLAIM_FAILED";
    return this.#withClient(async (client) => {
      const result = await client.query(
        `SELECT platform.return_model_image_effect_dispatch_leases($1,$2) AS "returnedCount"`,
        [dispatchOwnerRef, errorCode],
      );
      const count = nonnegative(single(result.rows, "IMAGE_EFFECT_LEASE_RETURN_CORRUPT").returnedCount);
      if (count > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("IMAGE_EFFECT_LEASE_RETURN_CORRUPT");
      return Number(count);
    });
  }

  #protectOutputs(
    claim: ImageEffectDispatchClaim,
    attempt: ImageEffectAttempt,
    outputs: readonly ImageEffectProviderOutput[],
  ): readonly ProtectedOutputPayload[] {
    return Object.freeze(outputs.map((output, index) => {
      const candidateOrdinal = index + 1;
      const identity = this.dependencies.outputIdentity(output, {
        logicalInvocationRef: claim.logicalInvocationRef,
        attemptRef: claim.attemptRef,
        candidateOrdinal,
      });
      const plaintext = new TextEncoder().encode(output.retrievalGrantHandle);
      let envelope: ModelGatewayResponseEnvelope;
      try {
        envelope = this.dependencies.secretProtector.seal(plaintext, {
          siteId: claim.siteId,
          logicalInvocationRef: claim.logicalInvocationRef,
          purpose: "retrieval-grant",
          bindingRef: imageEffectOutputSecretBinding(output.candidateRef, output.stableOutputSlotRef,
            output.providerOutputFactRef),
        });
      } finally {
        plaintext.fill(0);
      }
      return Object.freeze({ candidateOrdinal, candidateRef: output.candidateRef,
        stableOutputSlotRef: output.stableOutputSlotRef, providerOutputFactRef: output.providerOutputFactRef,
        retrievalGrantHandleDigest: sha256(output.retrievalGrantHandle), retrievalGrantEnvelope: envelope,
        outputEvidenceRef: identity.outputEvidenceRef, outputEvidenceDigest: identity.outputEvidenceDigest,
        mediaType: output.mediaType, width: output.width, height: output.height,
        ...(output.declaredByteSize === undefined ? {} : { declaredByteSize: output.declaredByteSize.toString() }) });
    }));
  }

  async #withClient<Result>(work: (client: ImageEffectPoolClient) => Promise<Result>): Promise<Result> {
    const client = await this.dependencies.pool.connect();
    try { return await work(client); }
    finally { client.release(); }
  }

  #validReference(value: string): string { text(value); return value; }
  #now(): string {
    const now = this.#clock();
    if (!Number.isFinite(now.getTime())) throw new Error("IMAGE_EFFECT_CLOCK_INVALID");
    return now.toISOString();
  }
}

export class PostgresImageEffectEvidenceRepository implements ImageEffectEvidenceRepository {
  async readPage(
    transaction: PlatformTransaction,
    input: Parameters<ImageEffectEvidenceRepository["readPage"]>[1],
  ): ReturnType<ImageEffectEvidenceRepository["readPage"]> {
    const sql = resolvePlatformTransaction(transaction);
    const invocationRows = await sql.query<Record<string, unknown>>(
      `SELECT invocation.logical_invocation_ref AS "logicalInvocationRef",
              invocation.model_invocation_command_ref AS "modelInvocationCommandRef",
              invocation.owner_version AS "ownerVersion",
              invocation.last_evidence_sequence AS "lastEvidenceSequence",
              invocation.state,invocation.current_attempt_ordinal AS "currentAttemptOrdinal",
              invocation.updated_at AS "observedAt",
              attempt.canonical_outcome_evidence_ref AS "canonicalOutcomeEvidenceRef",
              attempt.canonical_outcome_evidence_digest AS "canonicalOutcomeEvidenceDigest",
              attempt.usage_evidence_ref AS "usageEvidenceRef",
              attempt.usage_evidence_digest AS "usageEvidenceDigest"
         FROM platform.model_image_effect_invocation invocation
         JOIN platform.model_image_effect_attempt attempt
           ON attempt.logical_invocation_ref=invocation.logical_invocation_ref
          AND attempt.attempt_ordinal=invocation.current_attempt_ordinal
        WHERE invocation.caller_identity=$1 AND invocation.logical_invocation_ref=$2
        FOR SHARE OF invocation,attempt`,
      [input.callerIdentity, input.logicalInvocationRef],
    );
    if (invocationRows.length === 0) return null;
    const invocation = single(invocationRows, "IMAGE_EFFECT_EVIDENCE_INVOCATION_CORRUPT");
    const factRows = await sql.query<Record<string, unknown>>(
      `SELECT ledger.logical_invocation_ref AS "logicalInvocationRef",ledger.attempt_ref AS "attemptRef",
              ledger.evidence_sequence AS "evidenceSequence",ledger.owner_version AS "ownerVersion",
              ledger.evidence_kind AS kind,ledger.evidence_ref AS "evidenceRef",
              ledger.evidence_digest AS "evidenceDigest",ledger.recorded_at AS "recordedAt",
              ledger.candidate_ordinal AS "candidateOrdinal",ledger.candidate_ref AS "candidateRef",
              ledger.stable_output_slot_ref AS "stableOutputSlotRef",
              ledger.output_evidence_ref AS "outputEvidenceRef",
              ledger.output_evidence_digest AS "outputEvidenceDigest",
              ledger.provider_output_fact_ref AS "providerOutputFactRef",
              ledger.retrieval_grant_handle_digest AS "retrievalGrantHandleDigest",
              ledger.media_type AS "mediaType",ledger.width,ledger.height,
              ledger.declared_byte_size AS "declaredByteSize"
         FROM platform.model_image_effect_evidence_ledger ledger
        WHERE ledger.logical_invocation_ref=$1 AND ledger.evidence_sequence>$2
        ORDER BY ledger.evidence_sequence LIMIT $3`,
      [input.logicalInvocationRef, input.afterEvidenceSequence.toString(), input.limit],
    );
    const optional = (value: unknown): string | undefined => value === null || value === undefined
      ? undefined : text(value);
    const optionalDigest = (value: unknown): string | undefined => value === null || value === undefined
      ? undefined : hex(value);
    const facts = Object.freeze(factRows.map((row) => {
      const kind = enumValue(row.kind, ["outcome", "usage", "output"] as const);
      return Object.freeze({ logicalInvocationRef: text(row.logicalInvocationRef),
        attemptRef: text(row.attemptRef), evidenceSequence: positive(row.evidenceSequence),
        ownerVersion: positive(row.ownerVersion), kind, evidenceRef: text(row.evidenceRef),
        evidenceDigest: hex(row.evidenceDigest), recordedAt: instant(row.recordedAt),
        ...(kind !== "output" ? {} : { output: Object.freeze({ candidateOrdinal: integer(row.candidateOrdinal),
          candidateRef: text(row.candidateRef), stableOutputSlotRef: text(row.stableOutputSlotRef),
          outputEvidenceRef: text(row.outputEvidenceRef), outputEvidenceDigest: hex(row.outputEvidenceDigest),
          providerOutputFactRef: text(row.providerOutputFactRef),
          retrievalGrantHandleDigest: hex(row.retrievalGrantHandleDigest),
          mediaType: enumValue(row.mediaType, ["image/png", "image/jpeg", "image/webp"] as const),
          width: integer(row.width), height: integer(row.height),
          ...(row.declaredByteSize === null || row.declaredByteSize === undefined
            ? {} : { declaredByteSize: positive(row.declaredByteSize) }) }) }) });
    }));
    const canonicalOutcomeEvidenceRef = optional(invocation.canonicalOutcomeEvidenceRef);
    const canonicalOutcomeEvidenceDigest = optionalDigest(invocation.canonicalOutcomeEvidenceDigest);
    const usageEvidenceRef = optional(invocation.usageEvidenceRef);
    const usageEvidenceDigest = optionalDigest(invocation.usageEvidenceDigest);
    return Object.freeze({ invocation: Object.freeze({ logicalInvocationRef: text(invocation.logicalInvocationRef),
      modelInvocationCommandRef: text(invocation.modelInvocationCommandRef),
      ownerVersion: positive(invocation.ownerVersion), currentAttemptOrdinal: integer(invocation.currentAttemptOrdinal),
      state: enumValue(invocation.state, ["accepted", "submitted", "definitely_not_submitted",
        "submission_unknown", "running", "succeeded", "failed", "cancel_requested", "canceled",
        "outcome_unknown"] as const),
      ...(canonicalOutcomeEvidenceRef === undefined ? {} : { canonicalOutcomeEvidenceRef }),
      ...(canonicalOutcomeEvidenceDigest === undefined ? {} : { canonicalOutcomeEvidenceDigest }),
      ...(usageEvidenceRef === undefined ? {} : { usageEvidenceRef }),
      ...(usageEvidenceDigest === undefined ? {} : { usageEvidenceDigest }),
      observedAt: instant(invocation.observedAt) }),
    ownerHighWatermark: nonnegative(invocation.lastEvidenceSequence), facts });
  }
}

export class PostgresImageEffectOutputRepository implements ImageEffectOutputRepository {
  constructor(private readonly dependencies: Readonly<{ pool: ImageEffectPool }>) {}

  async lockCommand(transaction: PlatformTransaction, input: Readonly<{
    callerIdentity: string;
    outputAccessCommandRef: string;
  }>): Promise<ImageEffectOutputAccessRecord | null> {
    const rows = await resolvePlatformTransaction(transaction).query<Record<string, unknown>>(
      `${OUTPUT_ACCESS_SELECT} WHERE access.caller_identity=$1 AND access.output_access_command_ref=$2 FOR UPDATE`,
      [input.callerIdentity, input.outputAccessCommandRef],
    );
    return rows.length === 0 ? null : mapOutputAccess(single(rows, "IMAGE_EFFECT_OUTPUT_ACCESS_CORRUPT"));
  }

  async lockEvidence(transaction: PlatformTransaction, input: Readonly<{
    callerIdentity: string;
    logicalInvocationRef: string;
    outputEvidenceRef: string;
  }>): Promise<ImageEffectOutputEvidenceRecord | null> {
    const rows = await resolvePlatformTransaction(transaction).query<Record<string, unknown>>(
      `SELECT output.attempt_ref AS "attemptRef",attempt.attempt_ordinal AS "attemptOrdinal",
              attempt.logical_invocation_ref AS "logicalInvocationRef",
              output.output_evidence_ref AS "outputEvidenceRef",
              output.output_evidence_digest AS "outputEvidenceDigest",
              output.declared_byte_size AS "declaredByteSize",
              output.provider_output_fact_ref AS "providerOutputFactRef"
         FROM platform.model_image_effect_output_evidence output
         JOIN platform.model_image_effect_attempt attempt ON attempt.attempt_ref=output.attempt_ref
         JOIN platform.model_image_effect_invocation invocation
           ON invocation.logical_invocation_ref=attempt.logical_invocation_ref
        WHERE invocation.caller_identity=$1 AND invocation.logical_invocation_ref=$2
          AND output.output_evidence_ref=$3 FOR SHARE OF output,attempt,invocation`,
      [input.callerIdentity, input.logicalInvocationRef, input.outputEvidenceRef],
    );
    return rows.length === 0 ? null : mapOutputEvidence(single(rows, "IMAGE_EFFECT_OUTPUT_EVIDENCE_CORRUPT"));
  }

  async create(transaction: PlatformTransaction, record: ImageEffectOutputAccessRecord): Promise<void> {
    one(await resolvePlatformTransaction(transaction).execute(
      `INSERT INTO platform.model_image_effect_output_access
       (site_ref,caller_identity,caller_access_handle_digest,output_access_command_ref,request_digest,
        logical_invocation_ref,output_evidence_ref,output_evidence_digest,attempt_ref,attempt_ordinal,
        capability_ref,audience,max_readable_bytes,expires_at,security_epoch,source_access_handle_digest,
        recovery_envelope,receipt_version,recorded_at,receipt_ref,receipt_digest)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::timestamptz,$15,$16,$17::jsonb,
         $18,$19::timestamptz,$20,$21)`,
      [record.siteId, record.callerIdentity, record.callerAccessHandleDigest, record.outputAccessCommandRef,
        record.requestDigest, record.claims.logicalInvocationRef, record.claims.outputEvidenceRef,
        record.claims.outputEvidenceDigest, record.receipt.attemptRef, record.receipt.attemptOrdinal,
        record.claims.capabilityRef, record.claims.audience, record.claims.maxReadableBytes.toString(),
        record.claims.expiresAt, record.claims.securityEpoch.toString(), record.sourceAccessHandleDigest,
        canonical(record.recoveryEnvelope), record.receipt.receiptVersion.toString(), record.receipt.recordedAt,
        record.receipt.receiptRef, record.receipt.receiptDigest],
    ), "IMAGE_EFFECT_OUTPUT_ACCESS_INSERT_FAILED");
  }

  async authorizeRead(input: Readonly<{
    sourceAccessHandleDigest: string;
    claims: ImageEffectOutputAccessClaims;
    now: string;
  }>): Promise<ImageEffectOutputEvidenceRecord | null> {
    const client = await this.dependencies.pool.connect();
    try {
      const result = await client.query(
        `SELECT attempt_ref AS "attemptRef",attempt_ordinal AS "attemptOrdinal",
                logical_invocation_ref AS "logicalInvocationRef",output_evidence_ref AS "outputEvidenceRef",
                output_evidence_digest AS "outputEvidenceDigest",declared_byte_size AS "declaredByteSize",
                provider_output_fact_ref AS "providerOutputFactRef"
           FROM platform.authorize_model_image_effect_output_read($1,$2,$3,$4,$5,$6,$7,$8::timestamptz)`,
        [input.sourceAccessHandleDigest, input.claims.capabilityRef, input.claims.siteId,
          input.claims.callerIdentity, input.claims.outputEvidenceRef, input.claims.outputEvidenceDigest,
          input.claims.securityEpoch.toString(), input.now],
      );
      return result.rows.length === 0 ? null
        : mapOutputEvidence(single(result.rows, "IMAGE_EFFECT_OUTPUT_AUTHORIZATION_CORRUPT"));
    } finally { client.release(); }
  }
}

type ProtectedOutputPayload = Readonly<{
  candidateOrdinal: number;
  candidateRef: string;
  stableOutputSlotRef: string;
  providerOutputFactRef: string;
  retrievalGrantHandleDigest: string;
  retrievalGrantEnvelope: ModelGatewayResponseEnvelope;
  outputEvidenceRef: string;
  outputEvidenceDigest: string;
  mediaType: ImageEffectProviderOutput["mediaType"];
  width: number;
  height: number;
  declaredByteSize?: string;
}>;

function terminalEvidencePayload(
  observation: ImageEffectProviderObservation,
  outputs: readonly ProtectedOutputPayload[],
): readonly Readonly<Record<string, unknown>>[] {
  if (!["succeeded", "failed", "canceled", "outcome_unknown"].includes(observation.kind)) {
    return Object.freeze([]);
  }
  const terminal = observation as Extract<ImageEffectProviderObservation, {
    kind: "succeeded" | "failed" | "canceled" | "outcome_unknown";
  }>;
  const facts: Array<Readonly<Record<string, unknown>>> = [Object.freeze({ kind: "outcome",
    evidenceRef: terminal.outcomeEvidenceRef, evidenceDigest: terminal.outcomeEvidenceDigest })];
  if (terminal.usageEvidenceRef !== undefined && terminal.usageEvidenceDigest !== undefined) {
    facts.push(Object.freeze({ kind: "usage", evidenceRef: terminal.usageEvidenceRef,
      evidenceDigest: terminal.usageEvidenceDigest }));
  }
  for (const output of outputs) {
    facts.push(Object.freeze({ kind: "output", evidenceRef: output.outputEvidenceRef,
      evidenceDigest: output.outputEvidenceDigest, output: Object.freeze({
        candidateOrdinal: output.candidateOrdinal, candidateRef: output.candidateRef,
        stableOutputSlotRef: output.stableOutputSlotRef, outputEvidenceRef: output.outputEvidenceRef,
        outputEvidenceDigest: output.outputEvidenceDigest, providerOutputFactRef: output.providerOutputFactRef,
        retrievalGrantHandleDigest: output.retrievalGrantHandleDigest, mediaType: output.mediaType,
        width: output.width, height: output.height,
        ...(output.declaredByteSize === undefined ? {} : { declaredByteSize: output.declaredByteSize }),
      }) }));
  }
  return Object.freeze(facts);
}

function attemptRecordPayload(attempt: ImageEffectAttempt): Readonly<Record<string, unknown>> {
  return Object.freeze({ attemptRef: attempt.attemptRef, ordinal: attempt.ordinal,
    state: attempt.state, cancelRequested: attempt.cancelRequested,
    lastProviderSequence: attempt.lastProviderSequence.toString(),
    providerOperationRef: attempt.providerOperationRef ?? null,
    definitelyNotSubmittedReceiptRef: attempt.definitelyNotSubmittedReceiptRef ?? null,
    definitelyNotSubmittedReceiptDigest: attempt.definitelyNotSubmittedReceiptDigest ?? null,
    canonicalOutcomeEvidenceRef: attempt.canonicalOutcomeEvidenceRef ?? null,
    canonicalOutcomeEvidenceDigest: attempt.canonicalOutcomeEvidenceDigest ?? null,
    usageEvidenceRef: attempt.usageEvidenceRef ?? null,
    usageEvidenceDigest: attempt.usageEvidenceDigest ?? null,
    lateOutcome: attempt.lateOutcome });
}

function assertClaim(claim: ImageEffectDispatchClaim): void {
  [claim.siteId, claim.attemptRef, claim.logicalInvocationRef, claim.dispatchOwnerRef].forEach(text);
  if (claim.dispatchFence < 1n) throw new Error("IMAGE_EFFECT_DISPATCH_FENCE_INVALID");
}

function mapWorkerContext(value: Record<string, unknown>): ImageEffectDispatchContext {
  const attemptValue = jsonObject(value.attempt, "IMAGE_EFFECT_DISPATCH_CONTEXT_CORRUPT");
  const observationsValue = jsonArray(attemptValue.observations, "IMAGE_EFFECT_DISPATCH_CONTEXT_CORRUPT");
  const outputsValue = jsonArray(attemptValue.outputs, "IMAGE_EFFECT_DISPATCH_CONTEXT_CORRUPT");
  const attempt: ImageEffectAttempt = Object.freeze({
    attemptRef: text(attemptValue.attemptRef), ordinal: integer(attemptValue.ordinal),
    budgetCommitRef: text(attemptValue.budgetCommitRef), budgetCommitDigest: hex(attemptValue.budgetCommitDigest),
    providerOperationKey: text(attemptValue.providerOperationKey),
    state: enumValue(attemptValue.state, ["planned", "definitely_not_submitted", "submitted",
      "submission_unknown", "running", "succeeded", "failed", "canceled", "outcome_unknown"] as const),
    cancelRequested: boolean(attemptValue.cancelRequested),
    lastProviderSequence: nonnegative(attemptValue.lastProviderSequence),
    ...(attemptValue.providerOperationRef === null || attemptValue.providerOperationRef === undefined
      ? {} : { providerOperationRef: text(attemptValue.providerOperationRef) }),
    ...(attemptValue.definitelyNotSubmittedReceiptRef === null ||
      attemptValue.definitelyNotSubmittedReceiptRef === undefined
      ? {} : { definitelyNotSubmittedReceiptRef: text(attemptValue.definitelyNotSubmittedReceiptRef) }),
    ...(attemptValue.definitelyNotSubmittedReceiptDigest === null ||
      attemptValue.definitelyNotSubmittedReceiptDigest === undefined
      ? {} : { definitelyNotSubmittedReceiptDigest: hex(attemptValue.definitelyNotSubmittedReceiptDigest) }),
    ...(attemptValue.canonicalOutcomeEvidenceRef === null ||
      attemptValue.canonicalOutcomeEvidenceRef === undefined
      ? {} : { canonicalOutcomeEvidenceRef: text(attemptValue.canonicalOutcomeEvidenceRef) }),
    ...(attemptValue.canonicalOutcomeEvidenceDigest === null ||
      attemptValue.canonicalOutcomeEvidenceDigest === undefined
      ? {} : { canonicalOutcomeEvidenceDigest: hex(attemptValue.canonicalOutcomeEvidenceDigest) }),
    ...(attemptValue.usageEvidenceRef === null || attemptValue.usageEvidenceRef === undefined
      ? {} : { usageEvidenceRef: text(attemptValue.usageEvidenceRef) }),
    ...(attemptValue.usageEvidenceDigest === null || attemptValue.usageEvidenceDigest === undefined
      ? {} : { usageEvidenceDigest: hex(attemptValue.usageEvidenceDigest) }),
    outputs: Object.freeze(outputsValue.map((entry) => {
      const output = jsonObject(entry, "IMAGE_EFFECT_DISPATCH_CONTEXT_CORRUPT");
      return Object.freeze({ candidateRef: text(output.candidateRef),
        stableOutputSlotRef: text(output.stableOutputSlotRef),
        providerOutputFactRef: text(output.providerOutputFactRef),
        retrievalGrantHandleDigest: hex(output.retrievalGrantHandleDigest) });
    })),
    lateOutcome: boolean(attemptValue.lateOutcome),
    observations: Object.freeze(observationsValue.map((entry) => {
      const observation = jsonObject(entry, "IMAGE_EFFECT_DISPATCH_CONTEXT_CORRUPT");
      return Object.freeze({ eventRef: text(observation.eventRef), digest: hex(observation.digest),
        sequence: nonnegative(observation.sequence) });
    })),
  });
  return Object.freeze({ siteId: text(value.siteId), logicalInvocationRef: text(value.logicalInvocationRef),
    definitionRoleRef: text(value.definitionRoleRef), modelOptionRevisionRef: text(value.modelOptionRevisionRef),
    deploymentRef: text(value.deploymentRef), adapterKind: text(value.adapterKind),
    providerModel: text(value.providerModel), operationInputRevisionRef: text(value.operationInputRevisionRef),
    operationInputRevisionDigest: hex(value.operationInputRevisionDigest),
    sourceGrantRefs: referenceArray(value.sourceGrantRefs, "IMAGE_EFFECT_DISPATCH_CONTEXT_CORRUPT", 16),
    logicalOutputSlots: outputSlotArray(value.logicalOutputSlots), attempt });
}

function jsonObject(value: unknown, code: string): Record<string, unknown> {
  if (!object(value)) throw new Error(code);
  return value;
}

function jsonArray(value: unknown, code: string): readonly unknown[] {
  if (!Array.isArray(value)) throw new Error(code);
  return value;
}

interface CommandRow extends Record<string, unknown> {
  siteId: unknown; callerIdentity: unknown; callerAccessHandleDigest: unknown; callerCommandRef: unknown;
  commandKind: unknown; ownerCommandDigest: unknown; callerRequestFingerprint: unknown;
  logicalInvocationRef: unknown; attemptRef: unknown; attemptOrdinal: unknown; receiptKind: unknown;
  receiptVersion: unknown; recordedAt: unknown; requestDigest: unknown; receiptRef: unknown; receiptDigest: unknown;
}

interface InvocationRow extends Record<string, unknown> {
  logicalInvocationRef: unknown; siteId: unknown; callerIdentity: unknown; callerAccessHandleDigest: unknown;
  modelOptionAuthorizationHandleDigest: unknown; modelInvocationCommandRef: unknown; ownerVersion: unknown;
  state: unknown; definitionRoleRef: unknown; modelOptionRevisionRef: unknown; deploymentRef: unknown;
  adapterKind: unknown; providerModel: unknown; modelAuthorizationExpiresAt: unknown;
  operationInputRevisionRef: unknown; operationInputRevisionDigest: unknown; sourceGrantRefs: unknown;
  sourceGrants: unknown;
  logicalOutputSlots: unknown; trustEffectAllowReceiptRef: unknown; trustEffectAllowReceiptDigest: unknown;
  createdAt: unknown; updatedAt: unknown;
}

interface AttemptRow extends Record<string, unknown> {
  attemptRef: unknown; ordinal: unknown; budgetCommitRef: unknown; budgetCommitDigest: unknown;
  providerOperationKey: unknown; state: unknown; cancelRequested: unknown; lastProviderSequence: unknown;
  providerOperationRef: unknown; definitelyNotSubmittedReceiptRef: unknown;
  definitelyNotSubmittedReceiptDigest: unknown; canonicalOutcomeEvidenceRef: unknown;
  canonicalOutcomeEvidenceDigest: unknown; usageEvidenceRef: unknown; usageEvidenceDigest: unknown;
  lateOutcome: unknown;
}

interface ObservationRow extends Record<string, unknown> {
  attemptRef: unknown; eventRef: unknown; sequence: unknown; digest: unknown;
}

interface OutputRow extends Record<string, unknown> {
  attemptRef: unknown; candidateRef: unknown; stableOutputSlotRef: unknown;
  providerOutputFactRef: unknown; retrievalGrantHandleDigest: unknown; retrievalGrantEnvelope: unknown;
}

const OUTPUT_ACCESS_SELECT = `SELECT access.site_ref AS "siteId",
  access.caller_identity AS "callerIdentity",
  access.caller_access_handle_digest AS "callerAccessHandleDigest",
  access.output_access_command_ref AS "outputAccessCommandRef",access.request_digest AS "requestDigest",
  access.logical_invocation_ref AS "logicalInvocationRef",access.output_evidence_ref AS "outputEvidenceRef",
  access.output_evidence_digest AS "outputEvidenceDigest",access.attempt_ref AS "attemptRef",
  access.attempt_ordinal AS "attemptOrdinal",access.capability_ref AS "capabilityRef",access.audience,
  access.max_readable_bytes AS "maxReadableBytes",access.expires_at AS "expiresAt",
  access.security_epoch AS "securityEpoch",access.source_access_handle_digest AS "sourceAccessHandleDigest",
  access.recovery_envelope AS "recoveryEnvelope",access.receipt_version AS "receiptVersion",
  access.recorded_at AS "recordedAt",access.receipt_ref AS "receiptRef",
  access.receipt_digest AS "receiptDigest" FROM platform.model_image_effect_output_access access`;

function mapOutputEvidence(row: Record<string, unknown>): ImageEffectOutputEvidenceRecord {
  return Object.freeze({ logicalInvocationRef: text(row.logicalInvocationRef), attemptRef: text(row.attemptRef),
    attemptOrdinal: integer(row.attemptOrdinal), outputEvidenceRef: text(row.outputEvidenceRef),
    outputEvidenceDigest: hex(row.outputEvidenceDigest), providerOutputFactRef: text(row.providerOutputFactRef),
    ...(row.declaredByteSize === null || row.declaredByteSize === undefined
      ? {} : { declaredByteSize: positive(row.declaredByteSize) }) });
}

function mapOutputAccess(row: Record<string, unknown>): ImageEffectOutputAccessRecord {
  const audience = text(row.audience);
  if (audience !== "platform-media-worker") throw new Error("IMAGE_EFFECT_OUTPUT_ACCESS_CORRUPT");
  const callerIdentity = text(row.callerIdentity);
  const outputAccessCommandRef = text(row.outputAccessCommandRef);
  const requestDigest = hex(row.requestDigest);
  const logicalInvocationRef = text(row.logicalInvocationRef);
  const attemptRef = text(row.attemptRef);
  const attemptOrdinal = integer(row.attemptOrdinal);
  const recordedAt = instant(row.recordedAt);
  const recoveryEnvelope = responseEnvelope(row.recoveryEnvelope);
  return Object.freeze({ siteId: text(row.siteId), callerIdentity,
    callerAccessHandleDigest: hex(row.callerAccessHandleDigest), outputAccessCommandRef, requestDigest,
    receipt: Object.freeze({ callerCommandRef: outputAccessCommandRef, requestDigest,
      kind: "output_access_issued", logicalInvocationRef, attemptRef, attemptOrdinal,
      receiptVersion: positive(row.receiptVersion), recordedAt, receiptRef: text(row.receiptRef),
      receiptDigest: hex(row.receiptDigest) }),
    claims: Object.freeze({ capabilityRef: text(row.capabilityRef), siteId: text(row.siteId), callerIdentity,
      audience: "platform-media-worker", logicalInvocationRef, outputEvidenceRef: text(row.outputEvidenceRef),
      outputEvidenceDigest: hex(row.outputEvidenceDigest), maxReadableBytes: positive(row.maxReadableBytes),
      expiresAt: instant(row.expiresAt), securityEpoch: positive(row.securityEpoch) }),
    sourceAccessHandleDigest: hex(row.sourceAccessHandleDigest), recoveryEnvelope });
}

const INVOCATION_SELECT = `SELECT invocation.logical_invocation_ref AS "logicalInvocationRef",
  invocation.site_ref AS "siteId",invocation.caller_identity AS "callerIdentity",
  invocation.caller_access_handle_digest AS "callerAccessHandleDigest",
  invocation.model_option_authorization_handle_digest AS "modelOptionAuthorizationHandleDigest",
  invocation.model_invocation_command_ref AS "modelInvocationCommandRef",
  invocation.owner_version AS "ownerVersion",invocation.state,
  invocation.definition_role_ref AS "definitionRoleRef",
  invocation.model_option_revision_ref AS "modelOptionRevisionRef",
  invocation.deployment_ref AS "deploymentRef",invocation.adapter_kind AS "adapterKind",
  invocation.provider_model AS "providerModel",
  invocation.model_authorization_expires_at AS "modelAuthorizationExpiresAt",
  invocation.operation_input_revision_ref AS "operationInputRevisionRef",
  invocation.operation_input_revision_digest AS "operationInputRevisionDigest",
  invocation.source_grant_refs AS "sourceGrantRefs",invocation.source_grants AS "sourceGrants",
  invocation.logical_output_slots AS "logicalOutputSlots",
  invocation.trust_effect_allow_receipt_ref AS "trustEffectAllowReceiptRef",
  invocation.trust_effect_allow_receipt_digest AS "trustEffectAllowReceiptDigest",
  invocation.created_at AS "createdAt",invocation.updated_at AS "updatedAt"
  FROM platform.model_image_effect_invocation invocation`;

const ATTEMPT_SELECT = `SELECT attempt.attempt_ref AS "attemptRef",attempt.attempt_ordinal AS ordinal,
  attempt.effect_budget_commit_ref AS "budgetCommitRef",
  attempt.effect_budget_commit_digest AS "budgetCommitDigest",
  attempt.provider_operation_key AS "providerOperationKey",attempt.state,
  attempt.cancel_requested AS "cancelRequested",attempt.last_provider_sequence AS "lastProviderSequence",
  attempt.provider_operation_ref AS "providerOperationRef",
  attempt.definitely_not_submitted_receipt_ref AS "definitelyNotSubmittedReceiptRef",
  attempt.definitely_not_submitted_receipt_digest AS "definitelyNotSubmittedReceiptDigest",
  attempt.canonical_outcome_evidence_ref AS "canonicalOutcomeEvidenceRef",
  attempt.canonical_outcome_evidence_digest AS "canonicalOutcomeEvidenceDigest",
  attempt.usage_evidence_ref AS "usageEvidenceRef",attempt.usage_evidence_digest AS "usageEvidenceDigest",
  attempt.late_outcome AS "lateOutcome" FROM platform.model_image_effect_attempt attempt`;

function mapAccess(
  row: Record<string, unknown>,
  expectedDigest: string,
): Omit<ImageEffectAccessAuthorization, "modelOption" | "sourceGrantClaims"> {
  if (row.callerAccessHandleDigest !== expectedDigest || row.callerAudience !== "platform-media-worker") {
    throw new Error("IMAGE_EFFECT_ACCESS_DENIED");
  }
  return Object.freeze({
    callerAccessHandleDigest: expectedDigest,
    callerIdentity: text(row.callerIdentity), siteId: text(row.siteId),
    callerAudience: "platform-media-worker", workloadIdentityRef: text(row.workloadIdentityRef),
    environment: text(row.environment), region: text(row.region),
    authorizationGeneration: positive(row.authorizationGeneration),
    securityEpoch: positive(row.securityEpoch), accessExpiresAt: instant(row.expiresAt),
  });
}

function mapSourceGrant(
  row: Record<string, unknown>,
  expectedSourceRef: string | undefined,
  expectedDigest: string | undefined,
): ImageEffectAccessAuthorization["sourceGrantClaims"][number] {
  if (row.sourceVersionRef !== expectedSourceRef || row.purposeGrantHandleDigest !== expectedDigest) {
    throw new Error("IMAGE_EFFECT_SOURCE_GRANT_NOT_AUTHORIZED");
  }
  return Object.freeze({
    sourceVersionRef: text(row.sourceVersionRef),
    purposeGrantHandleDigest: hex(row.purposeGrantHandleDigest),
    expiresAt: instant(row.expiresAt),
  });
}

function mapModel(
  row: Record<string, unknown>,
  expectedDigest: string,
): NonNullable<ImageEffectAccessAuthorization["modelOption"]> {
  if (row.authorizationHandleDigest !== expectedDigest) throw new Error("IMAGE_EFFECT_MODEL_OPTION_NOT_AUTHORIZED");
  return Object.freeze({
    authorizationHandleDigest: expectedDigest,
    modelOptionRevisionRef: text(row.modelOptionRevisionRef),
    definitionRoleRef: text(row.definitionRoleRef), deploymentRef: text(row.deploymentRef),
    adapterKind: text(row.adapterKind), providerModel: text(row.providerModel), expiresAt: instant(row.expiresAt),
  });
}

function mapCommand(row: CommandRow): ImageEffectCommandJournal {
  const commandKind = enumValue(row.commandKind, ["create", "cancel", "attach_attempt"] as const);
  const kind = enumValue(row.receiptKind,
    ["create_committed", "attempt_authorization_attached", "cancel_intent_committed"] as const);
  const logicalInvocationRef = text(row.logicalInvocationRef);
  const attemptRef = text(row.attemptRef);
  const attemptOrdinal = integer(row.attemptOrdinal);
  const receiptVersion = positive(row.receiptVersion);
  const recordedAt = instant(row.recordedAt);
  return Object.freeze({
    siteId: text(row.siteId), callerIdentity: text(row.callerIdentity),
    callerAccessHandleDigest: hex(row.callerAccessHandleDigest), callerCommandRef: text(row.callerCommandRef),
    commandKind, ownerCommandDigest: hex(row.ownerCommandDigest),
    callerRequestFingerprint: hex(row.callerRequestFingerprint),
    receipt: Object.freeze({ callerCommandRef: text(row.callerCommandRef), requestDigest: hex(row.requestDigest), kind,
      logicalInvocationRef, attemptRef, attemptOrdinal, receiptVersion, recordedAt,
      receiptRef: text(row.receiptRef), receiptDigest: hex(row.receiptDigest) }),
  });
}

function mapInvocation(
  row: InvocationRow,
  attemptRows: readonly AttemptRow[],
  observationRows: readonly ObservationRow[],
  outputRows: readonly OutputRow[],
): ImageEffectInvocation {
  const siteId = text(row.siteId);
  const logicalInvocationRef = text(row.logicalInvocationRef);
  responseEnvelope(row.sourceGrants);
  const sourceGrantRefs = referenceArray(row.sourceGrantRefs, "IMAGE_EFFECT_SOURCE_GRANT_REFS_CORRUPT", 16);
  const logicalOutputSlots = outputSlotArray(row.logicalOutputSlots);
  const attempts = Object.freeze(attemptRows.map((attempt) => mapAttempt(
    attempt,
    observationRows.filter((observation) => observation.attemptRef === attempt.attemptRef),
    outputRows.filter((output) => output.attemptRef === attempt.attemptRef),
  )));
  if (attempts.length < 1 || attempts.some((attempt, index) => attempt.ordinal !== index + 1)) {
    throw new Error("IMAGE_EFFECT_ATTEMPT_LINEAGE_INVALID");
  }
  const invocation = Object.freeze({
    siteId, logicalInvocationRef, callerIdentity: text(row.callerIdentity),
    callerAccessHandleDigest: hex(row.callerAccessHandleDigest),
    modelOptionAuthorizationHandleDigest: hex(row.modelOptionAuthorizationHandleDigest),
    modelInvocationCommandRef: text(row.modelInvocationCommandRef), ownerVersion: positive(row.ownerVersion),
    state: enumValue(row.state, ["accepted", "submitted", "definitely_not_submitted", "submission_unknown",
      "running", "succeeded", "failed", "cancel_requested", "canceled", "outcome_unknown"] as const),
    definitionRoleRef: text(row.definitionRoleRef), modelOptionRevisionRef: text(row.modelOptionRevisionRef),
    deploymentRef: text(row.deploymentRef), adapterKind: text(row.adapterKind), providerModel: text(row.providerModel),
    modelAuthorizationExpiresAt: instant(row.modelAuthorizationExpiresAt),
    operationInputRevisionRef: text(row.operationInputRevisionRef),
    operationInputRevisionDigest: hex(row.operationInputRevisionDigest), sourceGrantRefs, logicalOutputSlots,
    trustEffectAllowReceiptRef: text(row.trustEffectAllowReceiptRef),
    trustEffectAllowReceiptDigest: hex(row.trustEffectAllowReceiptDigest), attempts,
    createdAt: instant(row.createdAt), updatedAt: instant(row.updatedAt),
  });
  assertOutputSlotEvidence(invocation);
  return invocation;
}

function mapAttempt(
  row: AttemptRow,
  observationRows: readonly ObservationRow[],
  outputRows: readonly OutputRow[],
): ImageEffectAttempt {
  const optional = (value: unknown): string | undefined => value === null || value === undefined ? undefined : text(value);
  const optionalHex = (value: unknown): string | undefined => value === null || value === undefined ? undefined : hex(value);
  const providerOperationRef = optional(row.providerOperationRef);
  const definitelyNotSubmittedReceiptRef = optional(row.definitelyNotSubmittedReceiptRef);
  const definitelyNotSubmittedReceiptDigest = optionalHex(row.definitelyNotSubmittedReceiptDigest);
  const canonicalOutcomeEvidenceRef = optional(row.canonicalOutcomeEvidenceRef);
  const canonicalOutcomeEvidenceDigest = optionalHex(row.canonicalOutcomeEvidenceDigest);
  const usageEvidenceRef = optional(row.usageEvidenceRef);
  const usageEvidenceDigest = optionalHex(row.usageEvidenceDigest);
  if ((canonicalOutcomeEvidenceRef === undefined) !== (canonicalOutcomeEvidenceDigest === undefined) ||
      (usageEvidenceRef === undefined) !== (usageEvidenceDigest === undefined)) {
    throw new Error("IMAGE_EFFECT_EVIDENCE_IDENTITY_CORRUPT");
  }
  const attemptRef = text(row.attemptRef);
  const observations = Object.freeze(observationRows.map((observation, index) => {
    if (text(observation.attemptRef) !== attemptRef || nonnegative(observation.sequence) !== BigInt(index + 1)) {
      throw new Error("IMAGE_EFFECT_PROVIDER_EVENT_SEQUENCE_CORRUPT");
    }
    return Object.freeze({
      eventRef: text(observation.eventRef),
      sequence: nonnegative(observation.sequence),
      digest: hex(observation.digest),
    });
  }));
  const outputs = Object.freeze(outputRows.map((output) => {
    if (text(output.attemptRef) !== attemptRef) throw new Error("IMAGE_EFFECT_OUTPUT_EVIDENCE_CORRUPT");
    const candidateRef = text(output.candidateRef);
    const stableOutputSlotRef = text(output.stableOutputSlotRef);
    const providerOutputFactRef = text(output.providerOutputFactRef);
    responseEnvelope(output.retrievalGrantEnvelope);
    return Object.freeze({ candidateRef, stableOutputSlotRef, providerOutputFactRef,
      retrievalGrantHandleDigest: hex(output.retrievalGrantHandleDigest) });
  }));
  return Object.freeze({
    attemptRef, ordinal: integer(row.ordinal), budgetCommitRef: text(row.budgetCommitRef),
    budgetCommitDigest: hex(row.budgetCommitDigest), providerOperationKey: text(row.providerOperationKey),
    state: enumValue(row.state, ["planned", "definitely_not_submitted", "submitted", "submission_unknown",
      "running", "succeeded", "failed", "canceled", "outcome_unknown"] as const),
    cancelRequested: boolean(row.cancelRequested), lastProviderSequence: nonnegative(row.lastProviderSequence),
    ...(providerOperationRef === undefined ? {} : { providerOperationRef }),
    ...(definitelyNotSubmittedReceiptRef === undefined ? {} : { definitelyNotSubmittedReceiptRef }),
    ...(definitelyNotSubmittedReceiptDigest === undefined ? {} : { definitelyNotSubmittedReceiptDigest }),
    ...(canonicalOutcomeEvidenceRef === undefined ? {} : { canonicalOutcomeEvidenceRef }),
    ...(canonicalOutcomeEvidenceDigest === undefined ? {} : { canonicalOutcomeEvidenceDigest }),
    ...(usageEvidenceRef === undefined ? {} : { usageEvidenceRef }),
    ...(usageEvidenceDigest === undefined ? {} : { usageEvidenceDigest }),
    outputs, lateOutcome: boolean(row.lateOutcome), observations,
  });
}

function assertOutputSlotEvidence(invocation: ImageEffectInvocation): void {
  const expected = new Map(invocation.logicalOutputSlots.map((slot) =>
    [slot.candidateRef, slot.stableOutputSlotRef] as const));
  for (const attempt of invocation.attempts) {
    if ((attempt.state === "succeeded") !== (attempt.outputs.length > 0) ||
        attempt.lastProviderSequence !== BigInt(attempt.observations.length)) {
      throw new Error("IMAGE_EFFECT_EVIDENCE_LINEAGE_CORRUPT");
    }
    const candidates = new Set<string>();
    const slots = new Set<string>();
    for (const output of attempt.outputs) {
      if (expected.get(output.candidateRef) !== output.stableOutputSlotRef ||
          candidates.has(output.candidateRef) || slots.has(output.stableOutputSlotRef)) {
        throw new Error("IMAGE_EFFECT_OUTPUT_SLOT_EVIDENCE_CORRUPT");
      }
      candidates.add(output.candidateRef);
      slots.add(output.stableOutputSlotRef);
    }
  }
}

export function imageEffectOutputSecretBinding(
  candidateRef: string,
  stableOutputSlotRef: string,
  providerOutputFactRef: string,
): string {
  const value = `${candidateRef}:${stableOutputSlotRef}:${providerOutputFactRef}`;
  if (value.length > 256) return sha256(value);
  return value;
}

function onlyAttempt(invocation: ImageEffectInvocation): ImageEffectAttempt {
  const attempt = invocation.attempts.at(-1);
  if (attempt === undefined || attempt.ordinal !== invocation.attempts.length) {
    throw new Error("IMAGE_EFFECT_ATTEMPT_LINEAGE_INVALID");
  }
  return attempt;
}

function referenceArray(value: unknown, code: string, maximum: number): readonly string[] {
  if (!Array.isArray(value) || value.length > maximum) throw new Error(code);
  const result = value.map(text);
  if (new Set(result).size !== result.length) throw new Error(code);
  return Object.freeze(result);
}

function encodeSourceGrantSecrets(
  grants: readonly Readonly<{ sourceVersionRef: string; purposeGrantHandle: string }>[],
): Uint8Array {
  if (grants.length > 16) throw new Error("IMAGE_EFFECT_SOURCE_GRANTS_INVALID");
  const encoder = new TextEncoder();
  const parts: Uint8Array[] = [encoder.encode("KIMG1"), uint16(grants.length)];
  let total = 7;
  for (const grant of grants) {
    const source = encoder.encode(grant.sourceVersionRef);
    const handle = encoder.encode(grant.purposeGrantHandle);
    if (source.byteLength < 1 || source.byteLength > 256 || handle.byteLength < 32 || handle.byteLength > 8192) {
      throw new Error("IMAGE_EFFECT_SOURCE_GRANTS_INVALID");
    }
    parts.push(uint16(source.byteLength), source, uint32(handle.byteLength), handle);
    total += 6 + source.byteLength + handle.byteLength;
  }
  const result = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) { result.set(part, offset); offset += part.byteLength; }
  for (const part of parts) part.fill(0);
  return result;
}

function decodeSourceGrantSecrets(plaintext: Uint8Array): readonly ImageEffectDispatchSourceGrant[] {
  if (plaintext.byteLength < 7 || new TextDecoder().decode(plaintext.subarray(0, 5)) !== "KIMG1") {
    throw new Error("IMAGE_EFFECT_SOURCE_GRANTS_CORRUPT");
  }
  const view = new DataView(plaintext.buffer, plaintext.byteOffset, plaintext.byteLength);
  const count = view.getUint16(5);
  if (count > 16) throw new Error("IMAGE_EFFECT_SOURCE_GRANTS_CORRUPT");
  let offset = 7;
  const grants: ImageEffectDispatchSourceGrant[] = [];
  const decoder = new TextDecoder("utf8", { fatal: true });
  const seen = new Set<string>();
  for (let index = 0; index < count; index += 1) {
    if (offset + 2 > plaintext.byteLength) throw new Error("IMAGE_EFFECT_SOURCE_GRANTS_CORRUPT");
    const sourceLength = view.getUint16(offset); offset += 2;
    if (sourceLength < 1 || sourceLength > 256 || offset + sourceLength + 4 > plaintext.byteLength) {
      throw new Error("IMAGE_EFFECT_SOURCE_GRANTS_CORRUPT");
    }
    const sourceVersionRef = decoder.decode(plaintext.subarray(offset, offset + sourceLength));
    offset += sourceLength;
    const handleLength = view.getUint32(offset); offset += 4;
    if (handleLength < 32 || handleLength > 8192 || offset + handleLength > plaintext.byteLength ||
        seen.has(sourceVersionRef)) throw new Error("IMAGE_EFFECT_SOURCE_GRANTS_CORRUPT");
    seen.add(sourceVersionRef);
    grants.push(Object.freeze({
      sourceVersionRef: text(sourceVersionRef),
      purposeGrantHandle: plaintext.subarray(offset, offset + handleLength),
    }));
    offset += handleLength;
  }
  if (offset !== plaintext.byteLength) throw new Error("IMAGE_EFFECT_SOURCE_GRANTS_CORRUPT");
  return Object.freeze(grants);
}

function uint16(value: number): Uint8Array {
  const result = new Uint8Array(2); new DataView(result.buffer).setUint16(0, value); return result;
}
function uint32(value: number): Uint8Array {
  const result = new Uint8Array(4); new DataView(result.buffer).setUint32(0, value); return result;
}

function outputSlotArray(value: unknown): ImageEffectInvocation["logicalOutputSlots"] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 4) {
    throw new Error("IMAGE_EFFECT_OUTPUT_SLOTS_CORRUPT");
  }
  return Object.freeze(value.map((item) => {
    if (!object(item)) throw new Error("IMAGE_EFFECT_OUTPUT_SLOTS_CORRUPT");
    return Object.freeze({ candidateRef: text(item.candidateRef), stableOutputSlotRef: text(item.stableOutputSlotRef) });
  }));
}

function single<Row extends Record<string, unknown>>(rows: readonly Row[], code: string): Row {
  if (rows.length !== 1 || rows[0] === undefined) throw new Error(code);
  return rows[0];
}
function one(value: number, code: string): void { if (value !== 1) throw new Error(code); }
function text(value: unknown): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 256 || /[\0\r\n]/u.test(value)) {
    throw new Error("IMAGE_EFFECT_ROW_CORRUPT");
  }
  return value;
}
function hex(value: unknown): string {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/u.test(value)) throw new Error("IMAGE_EFFECT_ROW_CORRUPT");
  return value;
}
function positive(value: unknown): bigint {
  const result = bigint(value); if (result < 1n) throw new Error("IMAGE_EFFECT_ROW_CORRUPT"); return result;
}
function nonnegative(value: unknown): bigint {
  const result = bigint(value); if (result < 0n) throw new Error("IMAGE_EFFECT_ROW_CORRUPT"); return result;
}
function bigint(value: unknown): bigint {
  if (typeof value === "bigint") return value;
  if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/u.test(value)) throw new Error("IMAGE_EFFECT_ROW_CORRUPT");
  return BigInt(value);
}
function integer(value: unknown): number {
  const result = typeof value === "number"
    ? value
    : typeof value === "string" && /^[1-9][0-9]*$/u.test(value)
      ? Number(value)
      : Number.NaN;
  if (!Number.isInteger(result) || result < 1 || result > 64) throw new Error("IMAGE_EFFECT_ROW_CORRUPT");
  return result;
}
function boolean(value: unknown): boolean {
  if (typeof value !== "boolean") throw new Error("IMAGE_EFFECT_ROW_CORRUPT"); return value;
}
function instant(value: unknown): string {
  const result = value instanceof Date ? value.toISOString() : value;
  if (typeof result !== "string") throw new Error("IMAGE_EFFECT_ROW_CORRUPT");
  const parsed = new Date(result);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== result) throw new Error("IMAGE_EFFECT_ROW_CORRUPT");
  return result;
}
function enumValue<const Values extends readonly string[]>(value: unknown, values: Values): Values[number] {
  if (typeof value !== "string" || !values.includes(value)) throw new Error("IMAGE_EFFECT_ROW_CORRUPT");
  return value as Values[number];
}
function canonical(value: unknown): string { return JSON.stringify(sortJson(value)); }
function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (object(value)) return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortJson(value[key])]));
  return value;
}
function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function responseEnvelope(value: unknown): ModelGatewayResponseEnvelope {
  if (!object(value) || value.algorithm !== "A256GCM") throw new Error("IMAGE_EFFECT_ENVELOPE_CORRUPT");
  if (typeof value.keyRevision !== "string" || !/^[A-Za-z0-9_-]{1,128}$/u.test(value.keyRevision)) {
    throw new Error("IMAGE_EFFECT_ENVELOPE_CORRUPT");
  }
  return Object.freeze({
    algorithm: "A256GCM",
    keyRevision: value.keyRevision,
    nonce: base64urlText(value.nonce, 64),
    ciphertext: base64urlText(value.ciphertext, 512 * 1024),
    authenticationTag: base64urlText(value.authenticationTag, 64),
  });
}
function base64urlText(value: unknown, maximumCharacters: number): string {
  if (typeof value !== "string" || value.length < 1 || value.length > maximumCharacters ||
      !/^[A-Za-z0-9_-]+$/u.test(value)) throw new Error("IMAGE_EFFECT_ENVELOPE_CORRUPT");
  return value;
}
function sha256(value: string): string { return createHash("sha256").update(value, "utf8").digest("hex"); }
function accessHandle(value: string): void {
  const size = Buffer.byteLength(value, "utf8");
  if (size < 32 || size > 8192 || /[\0\r\n]/u.test(value)) throw new Error("IMAGE_EFFECT_ACCESS_HANDLE_INVALID");
}
