import { CommandReceiptConflictError, CommandReceiptRepository } from "../../../../shared/outbox-inbox/receipt.js";
import {
  acquirePlatformSqlAdvisoryLock,
  resolvePlatformTransaction,
} from "../../../../shared/unit-of-work/platform-transaction.js";
import { assertSha256 } from "../../domain/command-identity.js";
import { compileFulfillmentOutputPlan, validateActualOutputSet } from "../../domain/output-line.js";
import { canonicalFulfillmentTransaction } from "../../domain/canonical-fulfillment.js";
import type {
  ClaimFulfillmentInput,
  CommerceRepository,
  FulfillmentOutputReceipt,
} from "../../application/contracts/repository.js";

export class PostgresCommerceRepository implements CommerceRepository {
  readonly #receipts = new CommandReceiptRepository();

  async claimCommand(transaction: Parameters<CommerceRepository["claimCommand"]>[0], identity: Parameters<CommerceRepository["claimCommand"]>[1]): ReturnType<CommerceRepository["claimCommand"]> {
    let receipt;
    try {
      receipt = await this.#receipts.begin(transaction, {
        commandId: identity.commandId, environment: identity.environment, region: identity.region,
        callerIdentity: identity.callerIdentity, operation: identity.operation,
        idempotencyKey: identity.idempotencyKey, requestDigest: identity.requestDigest,
      });
    } catch (error) {
      if (error instanceof CommandReceiptConflictError &&
          (error.kind === "identity" || error.kind === "digest")) throw new Error("IDEMPOTENCY_CONFLICT");
      throw error;
    }
    if (receipt.commandId !== identity.commandId) throw new Error("IDEMPOTENCY_CONFLICT");
    const sql = resolvePlatformTransaction(transaction);
    const inserted = await sql.query<{ commandId: string }>(
      `INSERT INTO platform.commerce_command
       (command_id,site_ref,actor_kind,actor_subject,authorization_subject_ref,actor_generation,command_version)
       VALUES ($1,$2,$3,$4,$5,$6::bigint,$7) ON CONFLICT (command_id) DO NOTHING
       RETURNING command_id AS "commandId"`,
      [receipt.commandId, identity.siteId, identity.actorKind, identity.actorSubject,
        identity.actorKind === "user" ? identity.actorSubject : null, identity.actorGeneration, identity.commandVersion],
    );
    if (inserted.length > 0) return Object.freeze({ disposition: "execute", commandId: receipt.commandId });
    const rows = await sql.query<{ siteId: string; actorKind: string; actorSubject: string; actorGeneration: bigint; commandVersion: string }>(
      `SELECT site_ref AS "siteId", actor_kind AS "actorKind", actor_subject AS "actorSubject",
              actor_generation AS "actorGeneration", command_version AS "commandVersion"
       FROM platform.commerce_command WHERE command_id=$1 FOR UPDATE`,
      [receipt.commandId],
    );
    const command = rows[0];
    if (!command || command.siteId !== identity.siteId || command.actorKind !== identity.actorKind ||
      command.actorSubject !== identity.actorSubject || command.actorGeneration.toString() !== identity.actorGeneration ||
      command.commandVersion !== identity.commandVersion) {
      throw new Error("IDEMPOTENCY_CONFLICT");
    }
    const snapshot = Object.freeze({ state: receipt.state, result: receipt.result, resultDigest: receipt.resultDigest });
    return receipt.state === "pending" || receipt.state === "outcome_unknown"
      ? Object.freeze({ disposition: "in_progress", commandId: receipt.commandId, receipt: snapshot })
      : Object.freeze({ disposition: "replay", commandId: receipt.commandId, receipt: snapshot });
  }

  async completeCommand(transaction: Parameters<CommerceRepository["completeCommand"]>[0], identity: Parameters<CommerceRepository["completeCommand"]>[1], outcome: Parameters<CommerceRepository["completeCommand"]>[2]): Promise<void> {
    await this.#receipts.recordOutcome(transaction, identity, outcome);
    const changed = await resolvePlatformTransaction(transaction).execute(
      `UPDATE platform.commerce_command SET completed_at=now() WHERE command_id=(
         SELECT command_id FROM platform.command_receipt
         WHERE environment=$1 AND caller_identity=$2 AND operation=$3 AND idempotency_key=$4
       ) AND completed_at IS NULL`,
      [identity.environment, identity.callerIdentity, identity.operation, identity.idempotencyKey],
    );
    if (changed !== 1) throw new Error("COMMERCE_COMMAND_COMPLETION_CONFLICT");
  }

  async claimFulfillment(
    transaction: Parameters<CommerceRepository["claimFulfillment"]>[0],
    input: ClaimFulfillmentInput,
  ): ReturnType<CommerceRepository["claimFulfillment"]> {
    assertSha256(input.source.idempotencyKey);
    assertSha256(input.snapshot.fulfillmentProgramDigest);
    assertSha256(input.snapshot.sourceDigest);
    const sql = resolvePlatformTransaction(transaction);
    await acquirePlatformSqlAdvisoryLock(sql, input.source.idempotencyKey);
    const storedRows = await sql.query<FulfillmentRow>(FULFILLMENT_BY_IDEMPOTENCY_SQL, [
      input.source.idempotencyKey,
    ]);
    const stored = storedRows[0];
    if (stored === undefined) {
      if (storedRows.length !== 0) throw new Error("FULFILLMENT_CLAIM_AMBIGUOUS");
      return Object.freeze({ disposition: "execute" as const, fulfillmentId: input.fulfillmentId });
    }
    if (storedRows.length !== 1) throw new Error("FULFILLMENT_CLAIM_AMBIGUOUS");
    if (!sameFulfillmentClaim(stored, input)) throw new Error("FULFILLMENT_SOURCE_CONFLICT");
    const rawOutputRows = await sql.query<FulfillmentOutputReceiptRow>(
      FULFILLMENT_OUTPUT_RECEIPT_SQL,
      [stored.fulfillmentId],
    );
    const outputRows = Object.freeze(rawOutputRows.map(decodeFulfillmentOutputReceiptRow));
    const canonical = canonicalFulfillmentTransaction({
      platformTransactionRef: stored.fulfillmentId,
      siteRef: stored.siteId,
      acquisition: { sourceKind: stored.sourceType, sourceRef: stored.sourceRef,
        sourceVersion: stored.sourceVersion, sourceDigest: stored.sourceDigest,
        acquiredAt: instant(stored.acquiredAt) },
      program: { fulfillmentProgramRevisionRef: stored.fulfillmentProgramRevisionRef,
        fulfillmentProgramRevision: stored.fulfillmentProgramRevision,
        fulfillmentProgramDigest: stored.fulfillmentProgramDigest },
      outputs: outputRows.map((output) => ({ ...output, outputRef: output.resourceRef })),
      committedAt: instant(stored.committedAt),
    });
    if (canonical.transactionDigest !== stored.transactionDigest) {
      throw new Error("FULFILLMENT_TRANSACTION_DIGEST_MISMATCH");
    }
    if (canonical.outputSetDigest !== stored.outputSetDigest) throw new Error("FULFILLMENT_OUTPUT_SET_DIGEST_MISMATCH");
    if (stored.transactionVersion !== 1n) throw new Error("FULFILLMENT_TRANSACTION_VERSION_INVALID");
    return Object.freeze({
      disposition: "replay" as const,
      receipt: Object.freeze({
        fulfillmentId: stored.fulfillmentId,
        transactionVersion: 1 as const,
        transactionDigest: stored.transactionDigest,
        outputSetDigest: stored.outputSetDigest,
        outputs: Object.freeze(outputRows.map((output) => Object.freeze({
          kind: output.kind,
          outputLineId: output.outputLineId,
          outputOrdinal: output.outputOrdinal,
          occurrence: output.occurrence,
          resourceRef: output.resourceRef,
          templateRevisionRef: output.templateRevisionRef,
          outputVersion: output.outputVersion,
          outputDigest: output.outputDigest,
        }))),
      }),
    });
  }

  async commitFulfillment(
    transaction: Parameters<CommerceRepository["commitFulfillment"]>[0],
    input: Parameters<CommerceRepository["commitFulfillment"]>[1],
  ): ReturnType<CommerceRepository["commitFulfillment"]> {
    const compiled = compileFulfillmentOutputPlan(input.plan);
    const actual = validateActualOutputSet(compiled, input.outputs);
    const sql = resolvePlatformTransaction(transaction);
    const clocks = await sql.query<Record<string, unknown> & { committedAt: Date | string }>(
      "SELECT clock_timestamp() AS \"committedAt\"",
    );
    const committedAt = instant(required(clocks[0], "FULFILLMENT_COMMIT_CLOCK_MISSING").committedAt);
    const canonical = canonicalFulfillmentTransaction({
      platformTransactionRef: input.claim.fulfillmentId,
      siteRef: input.claim.source.siteId,
      acquisition: { sourceKind: input.claim.source.sourceType, sourceRef: input.claim.source.sourceRef,
        sourceVersion: input.claim.snapshot.sourceVersion, sourceDigest: input.claim.snapshot.sourceDigest,
        acquiredAt: input.claim.snapshot.acquiredAt },
      program: { fulfillmentProgramRevisionRef: input.claim.snapshot.fulfillmentProgramRevisionRef,
        fulfillmentProgramRevision: input.claim.snapshot.fulfillmentProgramRevision,
        fulfillmentProgramDigest: input.claim.snapshot.fulfillmentProgramDigest },
      outputs: actual.map((output) => ({ kind: committedOutputKind(output.outputKind),
        outputLineId: output.outputLineId, outputOrdinal: output.outputOrdinal, occurrence: output.occurrence,
        outputRef: output.outputRef, templateRevisionRef: output.templateRevision,
        outputVersion: output.outputVersion, outputDigest: output.outputDigest })),
      committedAt,
    });
    const created = await sql.execute(
      `INSERT INTO platform.commerce_fulfillment_transaction
       (fulfillment_id,command_id,site_ref,billing_account_ref,source_type,source_id,purpose,cycle_key,idempotency_key,
        source_version,source_digest,acquired_at,product_version_ref,plan_version_ref,offering_version_ref,
        fulfillment_program_revision_ref,fulfillment_program_revision,fulfillment_program_digest,pricing_snapshot_ref,
        output_set_digest,state,transaction_version,transaction_digest,committed_at)
       VALUES ($1::uuid,$2,$3,$4,$5,$6,$7,$8,$9,$10::bigint,$11,$12::timestamptz,$13,$14,$15,$16,$17::bigint,$18,
               $19,$20,'committed',1,$21,$22::timestamptz)`,
      [input.claim.fulfillmentId, input.claim.commandId, input.claim.source.siteId, input.claim.billingAccountId,
        input.claim.source.sourceType, input.claim.source.sourceRef, input.claim.source.purpose,
        input.claim.source.cycleKey, input.claim.source.idempotencyKey, input.claim.snapshot.sourceVersion,
        input.claim.snapshot.sourceDigest, input.claim.snapshot.acquiredAt, input.claim.snapshot.productVersionRef,
        input.claim.snapshot.planVersionRef, input.claim.snapshot.offeringVersionRef,
        input.claim.snapshot.fulfillmentProgramRevisionRef, input.claim.snapshot.fulfillmentProgramRevision,
        input.claim.snapshot.fulfillmentProgramDigest, input.claim.snapshot.pricingSnapshotRef,
        canonical.outputSetDigest, canonical.transactionDigest, canonical.committedAt],
    );
    if (created !== 1) throw new Error("FULFILLMENT_COMMIT_CONFLICT");
    for (const line of compiled) await sql.execute(
      `INSERT INTO platform.commerce_fulfillment_output_plan
       (fulfillment_id,output_line_id,ordinal,cardinality,template_revision,output_kind,disposition)
       VALUES ($1::uuid,$2,$3,$4,$5,$6,$7)`,
      [input.claim.fulfillmentId, line.outputLineId, line.ordinal, line.cardinality, line.templateRevision,
        line.outputKind, line.disposition],
    );
    const planById = new Map(compiled.map((line) => [line.outputLineId, line]));
    for (const output of actual) {
      const cardinality = planById.get(output.outputLineId)!.cardinality;
      await sql.execute(
        `INSERT INTO platform.commerce_fulfillment_actual_output
         (fulfillment_id,output_line_id,output_ordinal,occurrence,cardinality,template_revision,output_kind,output_ref,
          output_version,output_digest)
         VALUES ($1::uuid,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [input.claim.fulfillmentId, output.outputLineId, output.outputOrdinal, output.occurrence, cardinality,
          output.templateRevision, output.outputKind, output.outputRef, output.outputVersion, output.outputDigest],
      );
    }
    return Object.freeze({ fulfillmentId: input.claim.fulfillmentId, transactionVersion: 1 as const,
      transactionDigest: canonical.transactionDigest, outputSetDigest: canonical.outputSetDigest,
      outputs: canonical.outputs.map((output) => Object.freeze({ kind: output.kind,
        outputLineId: output.outputLineId, outputOrdinal: output.outputOrdinal, occurrence: output.occurrence,
        resourceRef: output.outputRef, templateRevisionRef: output.templateRevisionRef,
        outputVersion: output.outputVersion, outputDigest: output.outputDigest })) });
  }

  async linkOutboxEvent(transaction: Parameters<CommerceRepository["linkOutboxEvent"]>[0], commandId: string, eventId: string): Promise<void> {
    await resolvePlatformTransaction(transaction).execute(
      `INSERT INTO platform.commerce_command_outbox(command_id,event_id) VALUES ($1,$2::uuid)`,
      [commandId, eventId],
    );
  }

  async recordAudit(transaction: Parameters<CommerceRepository["recordAudit"]>[0], input: Parameters<CommerceRepository["recordAudit"]>[1]): Promise<void> {
    assertSha256(input.payloadDigest);
    await resolvePlatformTransaction(transaction).execute(
      `INSERT INTO platform.commerce_audit_entry(audit_id,command_id,site_ref,event_type,payload_digest)
       VALUES ($1::uuid,$2,$3,$4,$5)`,
      [input.auditId, input.commandId, input.siteId, input.eventType, input.payloadDigest],
    );
  }
}

type FulfillmentRow = Record<string, unknown> & {
  fulfillmentId: string;
  siteId: string;
  billingAccountId: string;
  sourceType: "redemption" | "payment" | "admin_grant" | "program_window";
  sourceRef: string;
  purpose: string;
  cycleKey: string;
  idempotencyKey: string;
  productVersionRef: string;
  planVersionRef: string | null;
  offeringVersionRef: string;
  sourceVersion: bigint;
  sourceDigest: string;
  acquiredAt: Date | string;
  fulfillmentProgramRevisionRef: string;
  fulfillmentProgramRevision: bigint;
  fulfillmentProgramDigest: string;
  pricingSnapshotRef: string | null;
  outputSetDigest: string;
  transactionVersion: bigint;
  transactionDigest: string;
  committedAt: Date | string;
};

type FulfillmentOutputReceiptRow = Readonly<{
  kind: FulfillmentOutputReceipt["kind"];
  outputLineId: string;
  outputOrdinal: number;
  occurrence: number;
  resourceRef: string;
  templateRevisionRef: string;
  outputVersion: unknown;
  outputDigest: string;
}>;

function decodeFulfillmentOutputReceiptRow(row: FulfillmentOutputReceiptRow): FulfillmentOutputReceipt {
  const exactNumberOne = typeof row.outputVersion === "number" &&
    Number.isSafeInteger(row.outputVersion) && row.outputVersion === 1;
  if (row.outputVersion !== 1n && row.outputVersion !== "1" && !exactNumberOne) {
    throw new Error("FULFILLMENT_OUTPUT_VERSION_INVALID");
  }
  return Object.freeze({
    kind: row.kind,
    outputLineId: row.outputLineId,
    outputOrdinal: row.outputOrdinal,
    occurrence: row.occurrence,
    resourceRef: row.resourceRef,
    templateRevisionRef: row.templateRevisionRef,
    outputVersion: 1,
    outputDigest: row.outputDigest,
  });
}

function sameFulfillmentClaim(stored: FulfillmentRow, input: ClaimFulfillmentInput): boolean {
  return stored.siteId === input.source.siteId &&
    stored.billingAccountId === input.billingAccountId &&
    stored.sourceType === input.source.sourceType &&
    stored.sourceRef === input.source.sourceRef &&
    stored.purpose === input.source.purpose &&
    stored.cycleKey === input.source.cycleKey &&
    stored.idempotencyKey === input.source.idempotencyKey &&
    stored.productVersionRef === input.snapshot.productVersionRef &&
    stored.planVersionRef === input.snapshot.planVersionRef &&
    stored.offeringVersionRef === input.snapshot.offeringVersionRef &&
    stored.sourceVersion === input.snapshot.sourceVersion && stored.sourceDigest === input.snapshot.sourceDigest &&
    instant(stored.acquiredAt) === input.snapshot.acquiredAt &&
    stored.fulfillmentProgramRevisionRef === input.snapshot.fulfillmentProgramRevisionRef &&
    stored.fulfillmentProgramRevision === input.snapshot.fulfillmentProgramRevision &&
    stored.fulfillmentProgramDigest === input.snapshot.fulfillmentProgramDigest &&
    stored.pricingSnapshotRef === input.snapshot.pricingSnapshotRef;
}

const FULFILLMENT_BY_IDEMPOTENCY_SQL = `
  SELECT fulfillment_id AS "fulfillmentId",site_ref AS "siteId",billing_account_ref AS "billingAccountId",
         source_type AS "sourceType",source_id AS "sourceRef",purpose,cycle_key AS "cycleKey",
         idempotency_key AS "idempotencyKey",product_version_ref AS "productVersionRef",
         plan_version_ref AS "planVersionRef",offering_version_ref AS "offeringVersionRef",
         source_version AS "sourceVersion",source_digest AS "sourceDigest",acquired_at AS "acquiredAt",
         fulfillment_program_revision_ref AS "fulfillmentProgramRevisionRef",
         fulfillment_program_revision AS "fulfillmentProgramRevision",
         fulfillment_program_digest AS "fulfillmentProgramDigest",pricing_snapshot_ref AS "pricingSnapshotRef",
         output_set_digest AS "outputSetDigest",transaction_version AS "transactionVersion",
         transaction_digest AS "transactionDigest",committed_at AS "committedAt"
  FROM platform.commerce_fulfillment_transaction
  WHERE idempotency_key=$1
  `;

const FULFILLMENT_OUTPUT_RECEIPT_SQL = `
  SELECT actual.output_kind AS kind,actual.output_line_id AS "outputLineId",actual.output_ordinal AS "outputOrdinal",
         actual.occurrence,actual.output_ref AS "resourceRef",actual.template_revision AS "templateRevisionRef",
         actual.output_version AS "outputVersion",actual.output_digest AS "outputDigest"
  FROM platform.commerce_fulfillment_actual_output actual
  JOIN platform.commerce_fulfillment_output_plan expected
    ON expected.fulfillment_id=actual.fulfillment_id AND expected.output_line_id=actual.output_line_id
  WHERE actual.fulfillment_id=$1::uuid
  ORDER BY expected.ordinal,actual.occurrence`;

function committedOutputKind(kind: "subscription" | "subscription_term" | "entitlement_grant" | "credit_grant" |
  "credit_program_enrollment") {
  return kind === "subscription" ? "subscription_term" as const : kind;
}

function instant(value: Date | string): string {
  const result = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(result.getTime())) throw new Error("FULFILLMENT_TIME_INVALID");
  return result.toISOString();
}

function required<Value>(value: Value | undefined, code: string): Value {
  if (value === undefined) throw new Error(code);
  return value;
}
