import { CommandReceiptRepository } from "../../../../shared/outbox-inbox/receipt.js";
import { resolvePlatformTransaction } from "../../../../shared/unit-of-work/platform-transaction.js";
import { assertSha256 } from "../../domain/command-identity.js";
import { compileFulfillmentOutputPlan, validateActualOutputSet } from "../../domain/output-line.js";
import type { CommerceRepository, StartFulfillmentInput } from "../../application/contracts/repository.js";

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
      if (error instanceof Error && error.message === "COMMAND_DIGEST_CONFLICT") throw new Error("IDEMPOTENCY_CONFLICT");
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

  async startFulfillment(transaction: Parameters<CommerceRepository["startFulfillment"]>[0], input: StartFulfillmentInput): Promise<void> {
    assertSha256(input.outputPlanDigest);
    await resolvePlatformTransaction(transaction).execute(
      `INSERT INTO platform.commerce_fulfillment_transaction
       (fulfillment_id,command_id,site_ref,billing_account_ref,source_type,source_id,purpose,cycle_key,
        product_version_ref,plan_version_ref,offering_version_ref,fulfillment_program_version_ref,output_plan_digest,status)
       VALUES ($1::uuid,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'running')`,
      [input.fulfillmentId, input.commandId, input.siteId, input.billingAccountId, input.sourceType,
        input.sourceId, input.purpose, input.cycleKey, input.productVersion, input.planVersion,
        input.offeringVersion, input.fulfillmentProgramVersion, input.outputPlanDigest],
    );
  }

  async recordExpectedOutputPlan(transaction: Parameters<CommerceRepository["recordExpectedOutputPlan"]>[0], fulfillmentId: string, plan: Parameters<CommerceRepository["recordExpectedOutputPlan"]>[2]): Promise<void> {
    const compiled = compileFulfillmentOutputPlan(plan);
    const sql = resolvePlatformTransaction(transaction);
    for (const line of compiled) await sql.execute(
      `INSERT INTO platform.commerce_fulfillment_output_plan
       (fulfillment_id,output_line_id,ordinal,cardinality,template_revision,output_kind,disposition)
       VALUES ($1::uuid,$2,$3,$4,$5,$6,$7)`,
      [fulfillmentId, line.outputLineId, line.ordinal, line.cardinality, line.templateRevision, line.outputKind, line.disposition],
    );
  }

  async recordActualOutputs(transaction: Parameters<CommerceRepository["recordActualOutputs"]>[0], fulfillmentId: string, outputs: Parameters<CommerceRepository["recordActualOutputs"]>[2], plan: Parameters<CommerceRepository["recordActualOutputs"]>[3]): Promise<void> {
    const compiled = compileFulfillmentOutputPlan(plan);
    validateActualOutputSet(compiled, outputs);
    const planById = new Map(compiled.map((line) => [line.outputLineId, line]));
    const sql = resolvePlatformTransaction(transaction);
    for (const output of outputs) {
      const cardinality = planById.get(output.outputLineId)!.cardinality;
      await sql.execute(
        `INSERT INTO platform.commerce_fulfillment_actual_output
         (fulfillment_id,output_line_id,occurrence,cardinality,template_revision,output_kind,output_ref)
         VALUES ($1::uuid,$2,$3,$4,$5,$6,$7)`,
        [fulfillmentId, output.outputLineId, output.occurrence, cardinality, output.templateRevision, output.outputKind, output.outputRef],
      );
    }
  }

  async completeFulfillment(transaction: Parameters<CommerceRepository["completeFulfillment"]>[0], input: Parameters<CommerceRepository["completeFulfillment"]>[1]): Promise<void> {
    assertSha256(input.outputSetDigest); assertSha256(input.resultDigest);
    const changed = await resolvePlatformTransaction(transaction).execute(
      `UPDATE platform.commerce_fulfillment_transaction SET status='succeeded',output_set_digest=$2,result_digest=$3,completed_at=now()
       WHERE fulfillment_id=$1::uuid AND status='running'`,
      [input.fulfillmentId, input.outputSetDigest, input.resultDigest],
    );
    if (changed !== 1) throw new Error("FULFILLMENT_COMPLETION_CONFLICT");
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
