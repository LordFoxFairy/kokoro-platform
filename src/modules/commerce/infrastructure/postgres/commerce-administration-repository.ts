import { createHash, randomUUID } from "node:crypto";
import { CommandReceiptRepository, type CommandReceipt, type JsonValue } from "../../../../shared/outbox-inbox/receipt.js";
import { resolvePlatformTransaction } from "../../../../shared/unit-of-work/platform-transaction.js";
import { commerceCanonicalJson } from "../../domain/canonical-json.js";
import type { CommerceAdministrationRepository, CommerceAdminActor } from "../../application/contracts/commerce-administration-repository.js";
import type { CreditGrantProgramPort } from "../../../credit/application/contracts/grant-program.js";
import { canonicalFulfillmentProgramDigest } from "../../domain/fulfillment-program.js";

export class PostgresCommerceAdministrationRepository implements CommerceAdministrationRepository {
  constructor(private readonly creditPrograms: CreditGrantProgramPort,
    private readonly receipts = new CommandReceiptRepository()) {}

  async publishCreditProgramRevision(
    transaction: Parameters<CommerceAdministrationRepository["publishCreditProgramRevision"]>[0],
    input: Parameters<CommerceAdministrationRepository["publishCreditProgramRevision"]>[1],
  ) {
    const prior = await replayedReceipt(this.receipts, transaction, input.command);
    if (prior !== null) return adminOutcome("replayed", prior, creditProgramResult(prior));
    const sql = resolvePlatformTransaction(transaction);
    await assertDatabaseCalendarZone(sql, input.calendarZone);
    const catalogEpoch = await allocateCatalogEpoch(sql);
    const occurredAt = await databaseNow(transaction);
    await command(sql, input, occurredAt);
    await this.creditPrograms.publishRevision(transaction, { siteId: input.siteId,
      revisionRef: input.creditProgramRevisionRef, programRef: input.programRef, revision: BigInt(input.revision),
      bucketClass: input.uxBucketClass, unit: input.unit, amount: input.amount, burnPriority: input.burnPriority,
      scopePolicy: input.scopePolicy, liabilityMerchantAccountId: input.liabilityMerchantAccountRef,
      windowKind: input.windowKind, rolloverPolicy: input.rolloverPolicy, calendarZone: input.calendarZone,
      windowAnchor: input.windowAnchor, expiresAfterSeconds: input.expiresAfterSeconds === null ? null : BigInt(input.expiresAfterSeconds),
      revisionDigest: input.revisionDigest, catalogEpoch: BigInt(catalogEpoch), publishedAt: occurredAt });
    await audit(sql, input, "credit.grant_program.published", input.revisionDigest, occurredAt);
    const receipt = await complete(this.receipts, transaction, input.command, {
      creditProgramRevisionRef: input.creditProgramRevisionRef,
      revisionDigest: input.revisionDigest, publishedAt: occurredAt,
    });
    return adminOutcome("committed", receipt, creditProgramResult(receipt));
  }

  async publishEntitlementTemplateRevision(
    transaction: Parameters<CommerceAdministrationRepository["publishEntitlementTemplateRevision"]>[0],
    input: Parameters<CommerceAdministrationRepository["publishEntitlementTemplateRevision"]>[1],
  ) {
    const prior = await replayedReceipt(this.receipts, transaction, input.command);
    if (prior !== null) return adminOutcome("replayed", prior, entitlementTemplateResult(prior));
    const sql = resolvePlatformTransaction(transaction); const catalogEpoch = await allocateCatalogEpoch(sql);
    const occurredAt = await databaseNow(transaction);
    await command(sql, input, occurredAt);
    await exactlyOne(sql.execute(
      `INSERT INTO platform.commerce_entitlement_template_revision
       (entitlement_template_revision_ref,site_ref,template_ref,revision,capability_key,safe_label,
        expires_after_seconds,revision_digest,catalog_epoch,published_at)
       VALUES ($1,$2,$3,$4::bigint,$5,$6,$7::bigint,$8,$9::bigint,$10::timestamptz)`,
      [input.entitlementTemplateRevisionRef, input.siteId, input.templateRef, input.revision,
        input.capabilityKey, input.safeLabel, input.expiresAfterSeconds, input.revisionDigest,
        catalogEpoch, occurredAt],
    ), "COMMERCE_ENTITLEMENT_TEMPLATE_PERSIST_FAILED");
    await audit(sql, input, "commerce.entitlement_template.published", input.revisionDigest, occurredAt);
    const receipt = await complete(this.receipts, transaction, input.command, {
      entitlementTemplateRevisionRef: input.entitlementTemplateRevisionRef,
      revisionDigest: input.revisionDigest, publishedAt: occurredAt,
    });
    return adminOutcome("committed", receipt, entitlementTemplateResult(receipt));
  }

  async publishOffer(transaction: Parameters<CommerceAdministrationRepository["publishOffer"]>[0], input: Parameters<CommerceAdministrationRepository["publishOffer"]>[1]) {
    const prior = await replayedReceipt(this.receipts, transaction, input.command);
    if (prior !== null) return adminOutcome("replayed", prior, offerResult(prior));
    const sql = resolvePlatformTransaction(transaction); const catalogEpoch = await allocateCatalogEpoch(sql);
    const occurredAt = await databaseNow(transaction);
    await command(sql, input, occurredAt);
    await exactlyOne(sql.execute(
      `INSERT INTO platform.commerce_catalog_product(site_ref,product_ref,kind,state,created_at,updated_at)
       VALUES ($1,$2,$3,'active',$4::timestamptz,$4::timestamptz)
       ON CONFLICT (site_ref,product_ref) DO UPDATE SET updated_at=EXCLUDED.updated_at
       WHERE commerce_catalog_product.kind=EXCLUDED.kind AND commerce_catalog_product.state='active'`,
      [input.siteId, input.productRef, input.productKind, occurredAt],
    ), "COMMERCE_PRODUCT_KIND_CONFLICT");
    if (input.planVersion !== null) {
      await exactlyOne(sql.execute(
        `INSERT INTO platform.commerce_catalog_plan(site_ref,plan_ref,state,created_at,updated_at)
         VALUES ($1,$2,'active',$3::timestamptz,$3::timestamptz)
         ON CONFLICT (site_ref,plan_ref) DO UPDATE SET updated_at=EXCLUDED.updated_at
         WHERE commerce_catalog_plan.state='active'`,
        [input.siteId, input.planVersion.planRef, occurredAt],
      ), "COMMERCE_PLAN_NOT_ACTIVE");
      await exactlyOne(sql.execute(
        `INSERT INTO platform.commerce_catalog_plan_version
         (plan_version_ref,site_ref,plan_ref,revision,safe_label,term_action,term_seconds,
          stacking_scope,revision_digest,catalog_epoch,published_at)
         VALUES ($1,$2,$3,$4::bigint,$5,$6,$7::bigint,$8,$9,$10::bigint,$11::timestamptz)`,
        [input.planVersion.planVersionRef, input.siteId, input.planVersion.planRef,
          input.planVersion.revision, input.planVersion.safeLabel, input.planVersion.termAction,
          input.planVersion.termSeconds, input.planVersion.stackingScope,
          input.planVersion.revisionDigest, catalogEpoch, occurredAt],
      ), "COMMERCE_PLAN_VERSION_PERSIST_FAILED");
    }
    const creditRefs = [...new Set(input.outputs.filter((output) => output.outputKind === "credit_grant" ||
      output.outputKind === "credit_program_enrollment")
      .map((output) => output.targetRevisionRef))];
    const creditPrograms = creditRefs.length === 0 ? [] : await this.creditPrograms.resolveRefs(transaction,
      { siteId: input.siteId, revisionRefs: creditRefs });
    const creditByRef = new Map(creditPrograms.map((program) => [program.revisionRef, program]));
    for (const output of input.outputs) {
      if (output.outputKind !== "credit_grant" && output.outputKind !== "credit_program_enrollment") continue;
      const program = creditByRef.get(output.targetRevisionRef);
      if (program === undefined || (output.outputKind === "credit_grant") !== (program.bucketClass === "permanent")) {
        throw new Error("COMMERCE_CREDIT_OUTPUT_KIND_MISMATCH");
      }
    }
    const commerceOwnerRefs = [...new Set(input.outputs.filter((output) => output.outputKind !== "credit_grant" &&
      output.outputKind !== "credit_program_enrollment")
      .map((output) => output.targetRevisionRef))];
    const commerceOwners = commerceOwnerRefs.length === 0 ? [] : await sql.query<Record<string, unknown> & {
      revisionRef: string; revision: bigint; revisionDigest: string;
    }>(
      `SELECT owner.revision_ref AS "revisionRef",owner.revision,owner.revision_digest AS "revisionDigest"
       FROM (
         SELECT plan_version_ref AS revision_ref,revision,revision_digest
         FROM platform.commerce_catalog_plan_version WHERE site_ref=$1
         UNION ALL
         SELECT entitlement_template_revision_ref,revision,revision_digest
         FROM platform.commerce_entitlement_template_revision WHERE site_ref=$1
       ) owner
       WHERE owner.revision_ref=ANY($2::text[])`,
      [input.siteId, commerceOwnerRefs],
    );
    if (commerceOwners.length !== commerceOwnerRefs.length) throw new Error("COMMERCE_OUTPUT_OWNER_TARGET_MISMATCH");
    const commerceByRef = new Map(commerceOwners.map((owner) => [owner.revisionRef, owner]));
    const outputPlanDigest = canonicalFulfillmentProgramDigest({ siteId: input.siteId,
      fulfillmentProgramRevisionRef: input.fulfillmentProgramRevisionRef,
      lines: input.outputs.map((output) => {
        const owner = output.outputKind === "credit_grant" || output.outputKind === "credit_program_enrollment" ?
          creditByRef.get(output.targetRevisionRef) :
          commerceByRef.get(output.targetRevisionRef);
        if (owner === undefined) throw new Error("COMMERCE_OUTPUT_OWNER_TARGET_MISMATCH");
        return { outputLineId: output.outputLineId, outputOrdinal: output.ordinal,
          occurrenceCount: output.cardinality, outputKind: output.outputKind,
          owner: { kind: output.outputKind === "subscription_term" ? "subscription_term_policy" as const :
            output.outputKind === "entitlement_grant" ? "entitlement_template" as const : "credit_program" as const,
          revisionRef: output.targetRevisionRef, revision: BigInt(owner.revision),
          revisionDigest: owner.revisionDigest } };
      }) });
    await exactlyOne(sql.execute(
      `INSERT INTO platform.commerce_fulfillment_program_revision
       (fulfillment_program_revision_ref,site_ref,program_ref,revision,output_plan_digest,catalog_epoch,published_at)
       VALUES ($1,$2,$3,$4::bigint,$5,$6::bigint,$7::timestamptz)`,
      [input.fulfillmentProgramRevisionRef, input.siteId, input.fulfillmentProgramRef,
        input.fulfillmentProgramRevision, outputPlanDigest, catalogEpoch, occurredAt],
    ), "COMMERCE_FULFILLMENT_PROGRAM_PERSIST_FAILED");
    await exactlyCount(sql.execute(
      `INSERT INTO platform.commerce_fulfillment_program_output
       (fulfillment_program_revision_ref,site_ref,output_line_id,ordinal,cardinality,output_kind,
        plan_version_ref,entitlement_template_revision_ref,credit_program_revision_ref,
        credit_program_revision_version,credit_program_revision_digest)
       SELECT $1,$2,value.output_line_id,value.ordinal,value.cardinality,value.output_kind,
         CASE WHEN value.output_kind='subscription_term' THEN value.target_revision_ref END,
         CASE WHEN value.output_kind='entitlement_grant' THEN value.target_revision_ref END,
         CASE WHEN value.output_kind IN ('credit_grant','credit_program_enrollment') THEN value.target_revision_ref END,
         CASE WHEN value.output_kind IN ('credit_grant','credit_program_enrollment') THEN value.target_revision_version END,
         CASE WHEN value.output_kind IN ('credit_grant','credit_program_enrollment') THEN value.target_revision_digest END
       FROM jsonb_to_recordset($3::jsonb) AS value(
         output_line_id TEXT,ordinal INTEGER,cardinality INTEGER,output_kind TEXT,target_revision_ref TEXT,
         target_revision_version BIGINT,target_revision_digest TEXT
       )`,
      [input.fulfillmentProgramRevisionRef, input.siteId, JSON.stringify(input.outputs.map((output) => ({
        output_line_id: output.outputLineId, ordinal: output.ordinal, cardinality: output.cardinality,
        output_kind: output.outputKind, target_revision_ref: output.targetRevisionRef,
        target_revision_version: creditByRef.get(output.targetRevisionRef)?.revision.toString() ?? null,
        target_revision_digest: creditByRef.get(output.targetRevisionRef)?.revisionDigest ?? null,
      })))],
    ), input.outputs.length, "COMMERCE_FULFILLMENT_OUTPUTS_PERSIST_FAILED");
    await exactlyOne(sql.execute(
      `INSERT INTO platform.commerce_catalog_product_version
       (product_version_ref,site_ref,product_ref,revision,safe_label,plan_version_ref,
        fulfillment_program_revision_ref,legal_term_refs,revision_digest,catalog_epoch,published_at)
       VALUES ($1,$2,$3,$4::bigint,$5,$6,$7,$8::text[],$9,$10::bigint,$11::timestamptz)`,
      [input.productVersionRef, input.siteId, input.productRef, input.productRevision, input.safeLabel,
        input.planVersion?.planVersionRef ?? null, input.fulfillmentProgramRevisionRef,
        input.legalTermRefs, input.offerDigest, catalogEpoch, occurredAt],
    ), "COMMERCE_PRODUCT_VERSION_PERSIST_FAILED");
    await audit(sql, input, "commerce.offer.published", input.offerDigest, occurredAt);
    const receipt = await complete(this.receipts, transaction, input.command, {
      productVersionRef: input.productVersionRef, publishedAt: occurredAt,
    });
    return adminOutcome("committed", receipt, offerResult(receipt));
  }

  async publishProgram(transaction: Parameters<CommerceAdministrationRepository["publishProgram"]>[0], input: Parameters<CommerceAdministrationRepository["publishProgram"]>[1]) {
    const prior = await replayedReceipt(this.receipts, transaction, input.command);
    if (prior !== null) return adminOutcome("replayed", prior, programResult(prior));
    const sql = resolvePlatformTransaction(transaction); const catalogEpoch = await allocateCatalogEpoch(sql);
    const occurredAt = await databaseNow(transaction);
    await command(sql, input, occurredAt);
    await exactlyOne(sql.execute(
      `INSERT INTO platform.commerce_redemption_program_revision
       (redemption_program_revision_ref,site_ref,program_ref,revision,product_version_ref,
        fulfillment_program_revision_ref,program_digest,max_redemptions_per_account,catalog_epoch,published_at)
       VALUES ($1,$2,$3,$4::bigint,$5,$6,$7,$8,$9::bigint,$10::timestamptz)`,
      [input.redemptionProgramRevisionRef, input.siteId, input.programRef, input.revision,
        input.productVersionRef, input.fulfillmentProgramRevisionRef, input.programDigest,
        input.maxRedemptionsPerAccount, catalogEpoch, occurredAt],
    ), "COMMERCE_PROGRAM_PERSIST_FAILED");
    await exactlyOne(sql.execute(
      `INSERT INTO platform.commerce_redemption_program_availability
       (site_ref,redemption_program_revision_ref,state,starts_at,ends_at,availability_epoch,updated_at)
       VALUES ($1,$2,'active',$3::timestamptz,NULL,1,$3::timestamptz)`,
      [input.siteId, input.redemptionProgramRevisionRef, occurredAt],
    ), "COMMERCE_PROGRAM_AVAILABILITY_PERSIST_FAILED");
    await audit(sql, input, "commerce.redemption_program.published", input.programDigest, occurredAt);
    const receipt = await complete(this.receipts, transaction, input.command, {
      redemptionProgramRevisionRef: input.redemptionProgramRevisionRef, publishedAt: occurredAt,
    });
    return adminOutcome("committed", receipt, programResult(receipt));
  }

  async issueBatch(transaction: Parameters<CommerceAdministrationRepository["issueBatch"]>[0], input: Parameters<CommerceAdministrationRepository["issueBatch"]>[1]) {
    const prior = await replayedReceipt(this.receipts, transaction, input.command);
    if (prior !== null) return adminOutcome("replayed", prior, issueBatchResult(prior));
    const material = input.issueCodes();
    if (material.codes.length !== input.count || material.rawCodes.length !== input.count) {
      throw new Error("COMMERCE_CODE_ISSUANCE_COUNT_MISMATCH");
    }
    const sql = resolvePlatformTransaction(transaction); const catalogEpoch = await allocateCatalogEpoch(sql);
    const occurredAt = await databaseNow(transaction);
    await command(sql, input, occurredAt);
    await exactlyOne(sql.execute(
      `INSERT INTO platform.commerce_code_batch
       (batch_ref,site_ref,redemption_program_revision_ref,code_lookup_key_revision,batch_selector,
        created_by_subject_ref,state,starts_at,ends_at,inventory_count,catalog_epoch,created_at)
       VALUES ($1::uuid,$2,$3,$4,$5,$6,'draft',$7::timestamptz,$8::timestamptz,$9,$10::bigint,$11::timestamptz)`,
      [input.batchRef, input.siteId, input.redemptionProgramRevisionRef, material.keyRevision,
        material.batchSelector, input.subjectId, input.startsAt, input.endsAt, material.codes.length,
        catalogEpoch, occurredAt],
    ), "COMMERCE_CODE_BATCH_PERSIST_FAILED");
    await exactlyCount(sql.execute(
      `INSERT INTO platform.commerce_redeem_code
       (code_ref,batch_ref,site_ref,code_lookup_key_revision,lookup_digest,safe_fingerprint,state,created_at)
       SELECT value.code_ref::uuid,$1::uuid,$2,$3,value.lookup_digest,value.safe_fingerprint,'available',$4::timestamptz
       FROM jsonb_to_recordset($5::jsonb) AS value(code_ref TEXT,lookup_digest TEXT,safe_fingerprint TEXT)`,
      [input.batchRef, input.siteId, material.keyRevision, occurredAt, JSON.stringify(material.codes.map((code) => ({
        code_ref: code.codeRef, lookup_digest: code.lookupDigest, safe_fingerprint: code.safeFingerprint,
      })))],
    ), material.codes.length, "COMMERCE_CODE_INVENTORY_PERSIST_FAILED");
    await exactlyOne(sql.execute(
      `INSERT INTO platform.commerce_code_secret_export
       (batch_ref,site_ref,export_command_id,exported_to_subject_ref,code_count,export_digest,exported_at)
       VALUES ($1::uuid,$2,$3,$4,$5,$6,$7::timestamptz)`,
      [input.batchRef, input.siteId, input.command.commandId, input.subjectId, material.codes.length,
        material.exportDigest, occurredAt],
    ), "COMMERCE_CODE_EXPORT_PERSIST_FAILED");
    await audit(sql, input, "commerce.code_batch.issued", material.exportDigest, occurredAt);
    const receipt = await complete(this.receipts, transaction, input.command, {
      batchRef: input.batchRef, codeCount: material.codes.length,
      redemptionProgramRevisionRef: input.redemptionProgramRevisionRef,
      createdByOperatorRef: input.subjectId, startsAt: input.startsAt, endsAt: input.endsAt,
      exportedAt: occurredAt,
    });
    return Object.freeze({ ...adminOutcome("committed", receipt, issueBatchResult(receipt)),
      rawCodes: Object.freeze([...material.rawCodes]) });
  }

  async approveBatch(transaction: Parameters<CommerceAdministrationRepository["approveBatch"]>[0], input: Parameters<CommerceAdministrationRepository["approveBatch"]>[1]) {
    const prior = await replayedReceipt(this.receipts, transaction, input.command);
    if (prior !== null) return adminOutcome("replayed", prior, batchMutationResult(prior));
    const sql = resolvePlatformTransaction(transaction); const occurredAt = await databaseNow(transaction);
    await command(sql, input, occurredAt);
    await exactlyOne(sql.execute(
      `INSERT INTO platform.commerce_code_batch_approval
       (batch_ref,site_ref,maker_subject_ref,checker_subject_ref,approval_command_id,approved_at,approval_digest)
       SELECT batch.batch_ref,batch.site_ref,batch.created_by_subject_ref,$3,$4,$5::timestamptz,$6
       FROM platform.commerce_code_batch batch
       WHERE batch.batch_ref=$1::uuid AND batch.site_ref=$2 AND batch.state='draft'
         AND batch.created_by_subject_ref<>$3`,
      [input.batchRef, input.siteId, input.subjectId, input.command.commandId, occurredAt, input.approvalDigest],
    ), "COMMERCE_BATCH_MAKER_CHECKER_REQUIRED");
    await audit(sql, input, "commerce.code_batch.approved", input.approvalDigest, occurredAt);
    const receipt = await complete(this.receipts, transaction, input.command, {
      batchRef: input.batchRef, state: "draft", approvalState: "approved", changedAt: occurredAt,
    });
    return adminOutcome("committed", receipt, batchMutationResult(receipt));
  }

  async activateBatch(transaction: Parameters<CommerceAdministrationRepository["activateBatch"]>[0], input: Parameters<CommerceAdministrationRepository["activateBatch"]>[1]) {
    const prior = await replayedReceipt(this.receipts, transaction, input.command);
    if (prior !== null) return adminOutcome("replayed", prior, batchMutationResult(prior));
    const sql = resolvePlatformTransaction(transaction); const occurredAt = await databaseNow(transaction);
    await command(sql, input, occurredAt);
    await exactlyOne(sql.execute(
      `UPDATE platform.commerce_code_batch batch SET state='active',activated_at=$3::timestamptz
       WHERE batch.batch_ref=$1::uuid AND batch.site_ref=$2 AND batch.state='draft'
         AND (batch.ends_at IS NULL OR batch.ends_at>$3::timestamptz)
         AND EXISTS (SELECT 1 FROM platform.commerce_code_batch_approval approval
           WHERE approval.batch_ref=batch.batch_ref AND approval.site_ref=batch.site_ref)`,
      [input.batchRef, input.siteId, occurredAt],
    ), "COMMERCE_BATCH_APPROVAL_REQUIRED");
    const resultDigest = digest({ version: 1, batchRef: input.batchRef, activatedAt: occurredAt });
    await audit(sql, input, "commerce.code_batch.activated", resultDigest, occurredAt);
    const receipt = await complete(this.receipts, transaction, input.command, {
      batchRef: input.batchRef, state: "active", approvalState: "approved", changedAt: occurredAt,
    });
    return adminOutcome("committed", receipt, batchMutationResult(receipt));
  }

  async abandonBatch(transaction: Parameters<CommerceAdministrationRepository["abandonBatch"]>[0], input: Parameters<CommerceAdministrationRepository["abandonBatch"]>[1]) {
    return this.transitionBatch(transaction, input, ["draft"], "abandoned", true);
  }

  async suspendBatch(transaction: Parameters<CommerceAdministrationRepository["suspendBatch"]>[0], input: Parameters<CommerceAdministrationRepository["suspendBatch"]>[1]) {
    return this.transitionBatch(transaction, input, ["active"], "suspended", false);
  }

  async revokeBatch(transaction: Parameters<CommerceAdministrationRepository["revokeBatch"]>[0], input: Parameters<CommerceAdministrationRepository["revokeBatch"]>[1]) {
    return this.transitionBatch(transaction, input, ["active", "suspended"], "revoked", true);
  }

  private async transitionBatch(
    transaction: Parameters<CommerceAdministrationRepository["abandonBatch"]>[0],
    input: Parameters<CommerceAdministrationRepository["abandonBatch"]>[1],
    fromStates: readonly string[],
    toState: "abandoned" | "suspended" | "revoked",
    voidInventory: boolean,
  ) {
    const prior = await replayedReceipt(this.receipts, transaction, input.command);
    if (prior !== null) return adminOutcome("replayed", prior, batchMutationResult(prior));
    const sql = resolvePlatformTransaction(transaction); const occurredAt = await databaseNow(transaction);
    await command(sql, input, occurredAt);
    await exactlyOne(sql.execute(
      `UPDATE platform.commerce_code_batch SET state=$3
       WHERE batch_ref=$1::uuid AND site_ref=$2 AND state=ANY($4::text[])`,
      [input.batchRef, input.siteId, toState, fromStates],
    ), "COMMERCE_BATCH_TRANSITION_REJECTED");
    if (voidInventory) {
      await sql.execute(
        `UPDATE platform.commerce_redeem_code SET state='void',voided_at=$3::timestamptz
         WHERE batch_ref=$1::uuid AND site_ref=$2 AND state='available'`,
        [input.batchRef, input.siteId, occurredAt],
      );
    }
    await audit(sql, input, `commerce.code_batch.${toState}`, input.reasonDigest, occurredAt);
    const receipt = await complete(this.receipts, transaction, input.command, {
      batchRef: input.batchRef, state: toState,
      ...(toState === "suspended" || toState === "revoked" ? { approvalState: "approved" } : {}),
      changedAt: occurredAt,
    });
    return adminOutcome("committed", receipt, batchMutationResult(receipt));
  }
}
async function replayedReceipt(receipts: CommandReceiptRepository,
  transaction: Parameters<CommerceAdministrationRepository["publishProgram"]>[0],
  identity: Parameters<CommandReceiptRepository["begin"]>[1]): Promise<CommandReceipt | null> {
  const receipt = await receipts.begin(transaction, identity);
  if (receipt.state === "succeeded") return receipt;
  if (receipt.state !== "pending") throw new Error("COMMERCE_ADMIN_COMMAND_TERMINAL");
  return null;
}
async function complete(receipts: CommandReceiptRepository, transaction: Parameters<CommerceAdministrationRepository["publishProgram"]>[0], identity: Parameters<CommandReceiptRepository["begin"]>[1], result: JsonValue) {
  const resultDigest = digest(result);
  return receipts.recordOutcome(transaction, identity, { state: "succeeded", result, resultDigest });
}
async function command(sql: ReturnType<typeof resolvePlatformTransaction>, input: CommerceAdminActor, occurredAt: string) {
  await exactlyOne(sql.execute(
    `INSERT INTO platform.commerce_command
     (command_id,site_ref,actor_kind,actor_subject,authorization_subject_ref,actor_generation,command_version,completed_at,created_at)
     VALUES ($1,$2,'operator',$3,NULL,$4::bigint,'commerce-admin.v1',$5::timestamptz,$5::timestamptz)`,
    [input.command.commandId, input.siteId, input.subjectId, input.subjectGeneration, occurredAt],
  ), "COMMERCE_ADMIN_COMMAND_PERSIST_FAILED");
}
async function audit(sql: ReturnType<typeof resolvePlatformTransaction>, input: CommerceAdminActor, eventType: string, payloadDigest: string, occurredAt: string) {
  await exactlyOne(sql.execute(
    `INSERT INTO platform.commerce_audit_entry(audit_id,command_id,site_ref,event_type,payload_digest,occurred_at)
     VALUES ($1::uuid,$2,$3,$4,$5,$6::timestamptz)`,
    [randomUUID(), input.command.commandId, input.siteId, eventType, payloadDigest, occurredAt],
  ), "COMMERCE_ADMIN_AUDIT_PERSIST_FAILED");
}
async function allocateCatalogEpoch(sql: ReturnType<typeof resolvePlatformTransaction>): Promise<string> {
  const rows = await sql.query<Record<string, unknown> & { catalogEpoch: bigint | string }>(
    `UPDATE platform.commerce_catalog_epoch_authority
     SET current_epoch=current_epoch+1,updated_at=clock_timestamp()
     WHERE singleton=TRUE AND current_epoch<9223372036854775807
     RETURNING current_epoch::text AS "catalogEpoch"`,
  );
  const value = rows[0]?.catalogEpoch;
  if (rows.length !== 1 || value === undefined || !/^[1-9][0-9]*$/u.test(value.toString()) ||
      BigInt(value) > 9_223_372_036_854_775_807n) throw new Error("COMMERCE_CATALOG_EPOCH_UNAVAILABLE");
  return value.toString();
}

async function assertDatabaseCalendarZone(
  sql: ReturnType<typeof resolvePlatformTransaction>,
  calendarZone: string | null,
): Promise<void> {
  if (calendarZone === null) return;
  const rows = await sql.query<{ valid: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM pg_catalog.pg_timezone_names WHERE name=$1
     ) AS valid`,
    [calendarZone],
  );
  if (rows.length !== 1 || rows[0]?.valid !== true) {
    throw new Error("COMMERCE_CREDIT_CALENDAR_ZONE_INVALID");
  }
}
async function databaseNow(transaction: Parameters<CommerceAdministrationRepository["publishProgram"]>[0]): Promise<string> {
  const rows = await resolvePlatformTransaction(transaction).query<Record<string, unknown> & { occurredAt: Date | string }>(
    `SELECT clock_timestamp() AS "occurredAt"`,
  );
  const value = rows[0]?.occurredAt; if (value === undefined) throw new Error("COMMERCE_ADMIN_CLOCK_UNAVAILABLE");
  const result = new Date(value); if (!Number.isFinite(result.getTime())) throw new Error("COMMERCE_ADMIN_CLOCK_INVALID"); return result.toISOString();
}
function commandIdentity(receipt: CommandReceipt) {
  return Object.freeze({ commandId: receipt.commandId, environment: receipt.environment, region: receipt.region,
    callerIdentity: receipt.callerIdentity, operation: receipt.operation,
    idempotencyKey: receipt.idempotencyKey, requestDigest: receipt.requestDigest });
}
function adminOutcome<Kind extends "committed" | "replayed", Result>(kind: Kind,
  receipt: CommandReceipt, result: Readonly<Result>) {
  return Object.freeze({ kind, command: commandIdentity(receipt), recordedAt: receiptRecordedAt(receipt), result });
}
function creditProgramResult(receipt: CommandReceipt) {
  const value = catalogResult(receipt, "creditProgramRevisionRef");
  return Object.freeze({ creditProgramRevisionRef: value.reference,
    revisionDigest: value.revisionDigest, publishedAt: value.publishedAt });
}
function entitlementTemplateResult(receipt: CommandReceipt) {
  const value = catalogResult(receipt, "entitlementTemplateRevisionRef");
  return Object.freeze({ entitlementTemplateRevisionRef: value.reference,
    revisionDigest: value.revisionDigest, publishedAt: value.publishedAt });
}
function catalogResult(receipt: CommandReceipt, referenceKey: string) {
  const result = durableResult(receipt);
  const reference = result[referenceKey]; const revisionDigest = result.revisionDigest;
  const publishedAt = result.publishedAt;
  if (typeof reference !== "string" || reference.length < 1 || reference.length > 256 ||
      typeof revisionDigest !== "string" || !/^[a-f0-9]{64}$/u.test(revisionDigest) ||
      typeof publishedAt !== "string" || !Number.isFinite(Date.parse(publishedAt))) {
    throw new Error("COMMERCE_ADMIN_RECEIPT_CORRUPT");
  }
  return Object.freeze({ reference, revisionDigest, publishedAt: new Date(publishedAt).toISOString() });
}
function offerResult(receipt: CommandReceipt) {
  const result = durableResult(receipt);
  return Object.freeze({ productVersionRef: boundedReceiptRef(result.productVersionRef),
    publishedAt: receiptInstant(result.publishedAt) });
}
function programResult(receipt: CommandReceipt) {
  const result = durableResult(receipt);
  return Object.freeze({ redemptionProgramRevisionRef: boundedReceiptRef(result.redemptionProgramRevisionRef),
    publishedAt: receiptInstant(result.publishedAt) });
}
function issueBatchResult(receipt: CommandReceipt) {
  const result = durableResult(receipt);
  const codeCount = result.codeCount;
  const startsAt = nullableReceiptInstant(result.startsAt); const endsAt = nullableReceiptInstant(result.endsAt);
  if (typeof codeCount !== "number" || !Number.isInteger(codeCount) || codeCount < 1 || codeCount > 1_000) {
    throw new Error("COMMERCE_ADMIN_RECEIPT_CORRUPT");
  }
  return Object.freeze({ batchRef: boundedReceiptRef(result.batchRef), codeCount,
    redemptionProgramRevisionRef: boundedReceiptRef(result.redemptionProgramRevisionRef),
    createdByOperatorRef: boundedReceiptRef(result.createdByOperatorRef), startsAt, endsAt,
    exportedAt: receiptInstant(result.exportedAt) });
}
function batchMutationResult(receipt: CommandReceipt) {
  const result = durableResult(receipt); const state = result.state; const approvalState = result.approvalState;
  if (state !== "draft" && state !== "active" && state !== "abandoned" && state !== "suspended" &&
      state !== "revoked") throw new Error("COMMERCE_ADMIN_RECEIPT_CORRUPT");
  if (approvalState !== undefined && approvalState !== "approved") {
    throw new Error("COMMERCE_ADMIN_RECEIPT_CORRUPT");
  }
  return Object.freeze({ batchRef: boundedReceiptRef(result.batchRef), state,
    ...(approvalState === undefined ? {} : { approvalState }), changedAt: receiptInstant(result.changedAt) });
}
function durableResult(receipt: CommandReceipt): Readonly<Record<string, JsonValue>> {
  if (receipt.result === null || typeof receipt.result !== "object" || Array.isArray(receipt.result) ||
      receipt.resultDigest !== digest(receipt.result) || receipt.recordedAt === undefined ||
      !Number.isFinite(Date.parse(receipt.recordedAt))) {
    throw new Error("COMMERCE_ADMIN_RECEIPT_CORRUPT");
  }
  return receipt.result;
}
function receiptRecordedAt(receipt: CommandReceipt): string {
  if (receipt.recordedAt === undefined || !Number.isFinite(Date.parse(receipt.recordedAt))) {
    throw new Error("COMMERCE_ADMIN_RECEIPT_CORRUPT");
  }
  return new Date(receipt.recordedAt).toISOString();
}
function boundedReceiptRef(value: JsonValue | undefined): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 256) {
    throw new Error("COMMERCE_ADMIN_RECEIPT_CORRUPT");
  }
  return value;
}
function receiptInstant(value: JsonValue | undefined): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    throw new Error("COMMERCE_ADMIN_RECEIPT_CORRUPT");
  }
  return new Date(value).toISOString();
}
function nullableReceiptInstant(value: JsonValue | undefined): string | null {
  if (value === null) return null;
  return receiptInstant(value);
}
function digest(value: Parameters<typeof commerceCanonicalJson>[0]): string { return createHash("sha256").update(commerceCanonicalJson(value)).digest("hex"); }
async function exactlyOne(changed: number | Promise<number>, code: string): Promise<void> { if (await changed !== 1) throw new Error(code); }
async function exactlyCount(changed: number | Promise<number>, expected: number, code: string): Promise<void> { if (await changed !== expected) throw new Error(code); }
