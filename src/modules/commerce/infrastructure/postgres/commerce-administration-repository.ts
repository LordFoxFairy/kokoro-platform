import { createHash, randomUUID } from "node:crypto";
import { CommandReceiptRepository, type JsonValue } from "../../../../shared/outbox-inbox/receipt.js";
import { resolvePlatformTransaction } from "../../../../shared/unit-of-work/platform-transaction.js";
import { commerceCanonicalJson } from "../../domain/canonical-json.js";
import type { CommerceAdministrationRepository, CommerceAdminActor } from "../../application/contracts/commerce-administration-repository.js";

export class PostgresCommerceAdministrationRepository implements CommerceAdministrationRepository {
  constructor(private readonly receipts = new CommandReceiptRepository()) {}

  async publishCreditProgramRevision(
    transaction: Parameters<CommerceAdministrationRepository["publishCreditProgramRevision"]>[0],
    input: Parameters<CommerceAdministrationRepository["publishCreditProgramRevision"]>[1],
  ) {
    if (await replayed(this.receipts, transaction, input.command)) {
      return { kind: "replayed" as const, occurredAt: await publishedAt(transaction,
        "commerce_credit_program_revision", "credit_program_revision_ref",
        input.creditProgramRevisionRef, input.siteId, "COMMERCE_CREDIT_PROGRAM_RECEIPT_MISSING") };
    }
    const sql = resolvePlatformTransaction(transaction); const occurredAt = await databaseNow(transaction);
    await command(sql, input, occurredAt);
    await exactlyOne(sql.execute(
      `INSERT INTO platform.commerce_credit_program_revision
       (credit_program_revision_ref,site_ref,program_ref,revision,ux_bucket_class,unit,amount,
        burn_priority,scope_policy,liability_merchant_account_ref,window_kind,calendar_zone,
        window_anchor,expires_after_seconds,revision_digest,published_at)
       VALUES ($1,$2,$3,$4::bigint,$5,$6,$7::numeric,$8,$9::jsonb,$10,$11,$12,$13,$14::bigint,$15,$16::timestamptz)`,
      [input.creditProgramRevisionRef, input.siteId, input.programRef, input.revision,
        input.uxBucketClass, input.unit, input.amount, input.burnPriority,
        JSON.stringify(input.scopePolicy), input.liabilityMerchantAccountRef, input.windowKind,
        input.calendarZone, input.windowAnchor, input.expiresAfterSeconds, input.revisionDigest, occurredAt],
    ), "COMMERCE_CREDIT_PROGRAM_PERSIST_FAILED");
    await audit(sql, input, "commerce.credit_program.published", input.revisionDigest, occurredAt);
    await complete(this.receipts, transaction, input.command, {
      creditProgramRevisionRef: input.creditProgramRevisionRef, publishedAt: occurredAt,
    });
    return Object.freeze({ kind: "committed" as const, occurredAt });
  }

  async publishEntitlementTemplateRevision(
    transaction: Parameters<CommerceAdministrationRepository["publishEntitlementTemplateRevision"]>[0],
    input: Parameters<CommerceAdministrationRepository["publishEntitlementTemplateRevision"]>[1],
  ) {
    if (await replayed(this.receipts, transaction, input.command)) {
      return { kind: "replayed" as const, occurredAt: await publishedAt(transaction,
        "commerce_entitlement_template_revision", "entitlement_template_revision_ref",
        input.entitlementTemplateRevisionRef, input.siteId,
        "COMMERCE_ENTITLEMENT_TEMPLATE_RECEIPT_MISSING") };
    }
    const sql = resolvePlatformTransaction(transaction); const occurredAt = await databaseNow(transaction);
    await command(sql, input, occurredAt);
    await exactlyOne(sql.execute(
      `INSERT INTO platform.commerce_entitlement_template_revision
       (entitlement_template_revision_ref,site_ref,template_ref,revision,capability_key,safe_label,
        expires_after_seconds,revision_digest,published_at)
       VALUES ($1,$2,$3,$4::bigint,$5,$6,$7::bigint,$8,$9::timestamptz)`,
      [input.entitlementTemplateRevisionRef, input.siteId, input.templateRef, input.revision,
        input.capabilityKey, input.safeLabel, input.expiresAfterSeconds, input.revisionDigest, occurredAt],
    ), "COMMERCE_ENTITLEMENT_TEMPLATE_PERSIST_FAILED");
    await audit(sql, input, "commerce.entitlement_template.published", input.revisionDigest, occurredAt);
    await complete(this.receipts, transaction, input.command, {
      entitlementTemplateRevisionRef: input.entitlementTemplateRevisionRef, publishedAt: occurredAt,
    });
    return Object.freeze({ kind: "committed" as const, occurredAt });
  }

  async publishOffer(transaction: Parameters<CommerceAdministrationRepository["publishOffer"]>[0], input: Parameters<CommerceAdministrationRepository["publishOffer"]>[1]) {
    if (await replayed(this.receipts, transaction, input.command)) {
      return { kind: "replayed" as const, occurredAt: await databaseNow(transaction) };
    }
    const sql = resolvePlatformTransaction(transaction); const occurredAt = await databaseNow(transaction);
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
          stacking_scope,revision_digest,published_at)
         VALUES ($1,$2,$3,$4::bigint,$5,$6,$7::bigint,$8,$9,$10::timestamptz)`,
        [input.planVersion.planVersionRef, input.siteId, input.planVersion.planRef,
          input.planVersion.revision, input.planVersion.safeLabel, input.planVersion.termAction,
          input.planVersion.termSeconds, input.planVersion.stackingScope,
          input.planVersion.revisionDigest, occurredAt],
      ), "COMMERCE_PLAN_VERSION_PERSIST_FAILED");
    }
    await exactlyOne(sql.execute(
      `INSERT INTO platform.commerce_fulfillment_program_revision
       (fulfillment_program_revision_ref,site_ref,program_ref,revision,output_plan_digest,published_at)
       VALUES ($1,$2,$3,$4::bigint,$5,$6::timestamptz)`,
      [input.fulfillmentProgramRevisionRef, input.siteId, input.fulfillmentProgramRef,
        input.fulfillmentProgramRevision, input.outputPlanDigest, occurredAt],
    ), "COMMERCE_FULFILLMENT_PROGRAM_PERSIST_FAILED");
    await exactlyCount(sql.execute(
      `INSERT INTO platform.commerce_fulfillment_program_output
       (fulfillment_program_revision_ref,site_ref,output_line_id,ordinal,cardinality,output_kind,
        plan_version_ref,entitlement_template_revision_ref,credit_program_revision_ref)
       SELECT $1,$2,value.output_line_id,value.ordinal,value.cardinality,value.output_kind,
         CASE WHEN value.output_kind='subscription_term' THEN value.target_revision_ref END,
         CASE WHEN value.output_kind='entitlement_grant' THEN value.target_revision_ref END,
         CASE WHEN value.output_kind='credit_grant' THEN value.target_revision_ref END
       FROM jsonb_to_recordset($3::jsonb) AS value(
         output_line_id TEXT,ordinal INTEGER,cardinality INTEGER,output_kind TEXT,target_revision_ref TEXT
       )`,
      [input.fulfillmentProgramRevisionRef, input.siteId, JSON.stringify(input.outputs.map((output) => ({
        output_line_id: output.outputLineId, ordinal: output.ordinal, cardinality: output.cardinality,
        output_kind: output.outputKind, target_revision_ref: output.targetRevisionRef,
      })))],
    ), input.outputs.length, "COMMERCE_FULFILLMENT_OUTPUTS_PERSIST_FAILED");
    await exactlyOne(sql.execute(
      `INSERT INTO platform.commerce_catalog_product_version
       (product_version_ref,site_ref,product_ref,revision,safe_label,plan_version_ref,
        fulfillment_program_revision_ref,legal_term_refs,revision_digest,published_at)
       VALUES ($1,$2,$3,$4::bigint,$5,$6,$7,$8::text[],$9,$10::timestamptz)`,
      [input.productVersionRef, input.siteId, input.productRef, input.productRevision, input.safeLabel,
        input.planVersion?.planVersionRef ?? null, input.fulfillmentProgramRevisionRef,
        input.legalTermRefs, input.offerDigest, occurredAt],
    ), "COMMERCE_PRODUCT_VERSION_PERSIST_FAILED");
    await audit(sql, input, "commerce.offer.published", input.offerDigest, occurredAt);
    await complete(this.receipts, transaction, input.command, {
      productVersionRef: input.productVersionRef, publishedAt: occurredAt,
    });
    return Object.freeze({ kind: "committed" as const, occurredAt });
  }

  async publishProgram(transaction: Parameters<CommerceAdministrationRepository["publishProgram"]>[0], input: Parameters<CommerceAdministrationRepository["publishProgram"]>[1]) {
    if (await replayed(this.receipts, transaction, input.command)) {
      const rows = await resolvePlatformTransaction(transaction).query<Record<string, unknown> & { publishedAt: Date | string }>(
        `SELECT published_at AS "publishedAt" FROM platform.commerce_redemption_program_revision
         WHERE redemption_program_revision_ref=$1 AND site_ref=$2 LIMIT 1`,
        [input.redemptionProgramRevisionRef, input.siteId],
      );
      const publishedAt = rows[0]?.publishedAt;
      if (publishedAt === undefined) throw new Error("COMMERCE_PROGRAM_RECEIPT_MISSING");
      return { kind: "replayed" as const, occurredAt: new Date(publishedAt).toISOString() };
    }
    const sql = resolvePlatformTransaction(transaction); const occurredAt = await databaseNow(transaction);
    await command(sql, input, occurredAt);
    await exactlyOne(sql.execute(
      `INSERT INTO platform.commerce_redemption_program_revision
       (redemption_program_revision_ref,site_ref,program_ref,revision,product_version_ref,
        fulfillment_program_revision_ref,program_digest,max_redemptions_per_account,published_at)
       VALUES ($1,$2,$3,$4::bigint,$5,$6,$7,$8,$9::timestamptz)`,
      [input.redemptionProgramRevisionRef, input.siteId, input.programRef, input.revision,
        input.productVersionRef, input.fulfillmentProgramRevisionRef, input.programDigest,
        input.maxRedemptionsPerAccount, occurredAt],
    ), "COMMERCE_PROGRAM_PERSIST_FAILED");
    await exactlyOne(sql.execute(
      `INSERT INTO platform.commerce_redemption_program_availability
       (site_ref,redemption_program_revision_ref,state,starts_at,ends_at,availability_epoch,updated_at)
       VALUES ($1,$2,'active',$3::timestamptz,NULL,1,$3::timestamptz)`,
      [input.siteId, input.redemptionProgramRevisionRef, occurredAt],
    ), "COMMERCE_PROGRAM_AVAILABILITY_PERSIST_FAILED");
    await audit(sql, input, "commerce.redemption_program.published", input.programDigest, occurredAt);
    await complete(this.receipts, transaction, input.command, {
      redemptionProgramRevisionRef: input.redemptionProgramRevisionRef, publishedAt: occurredAt,
    });
    return { kind: "committed" as const, occurredAt };
  }

  async issueBatch(transaction: Parameters<CommerceAdministrationRepository["issueBatch"]>[0], input: Parameters<CommerceAdministrationRepository["issueBatch"]>[1]) {
    if (await replayed(this.receipts, transaction, input.command)) {
      const rows = await resolvePlatformTransaction(transaction).query<Record<string, unknown> & { exportedAt: Date | string }>(
        `SELECT exported_at AS "exportedAt" FROM platform.commerce_code_secret_export
         WHERE batch_ref=$1::uuid AND site_ref=$2 AND export_command_id=$3 LIMIT 1`,
        [input.batchRef, input.siteId, input.command.commandId],
      );
      const exportedAt = rows[0]?.exportedAt;
      if (exportedAt === undefined) throw new Error("COMMERCE_CODE_EXPORT_RECEIPT_MISSING");
      return { kind: "replayed" as const, occurredAt: new Date(exportedAt).toISOString() };
    }
    const sql = resolvePlatformTransaction(transaction); const occurredAt = await databaseNow(transaction);
    await command(sql, input, occurredAt);
    await exactlyOne(sql.execute(
      `INSERT INTO platform.commerce_code_batch
       (batch_ref,site_ref,redemption_program_revision_ref,code_lookup_key_revision,batch_selector,
        created_by_subject_ref,state,starts_at,ends_at,inventory_count,created_at)
       VALUES ($1::uuid,$2,$3,$4,$5,$6,'draft',$7::timestamptz,$8::timestamptz,$9,$10::timestamptz)`,
      [input.batchRef, input.siteId, input.redemptionProgramRevisionRef, input.keyRevision,
        input.batchSelector, input.subjectId, input.startsAt, input.endsAt, input.codes.length, occurredAt],
    ), "COMMERCE_CODE_BATCH_PERSIST_FAILED");
    await exactlyCount(sql.execute(
      `INSERT INTO platform.commerce_redeem_code
       (code_ref,batch_ref,site_ref,code_lookup_key_revision,lookup_digest,safe_fingerprint,state,created_at)
       SELECT value.code_ref::uuid,$1::uuid,$2,$3,value.lookup_digest,value.safe_fingerprint,'available',$4::timestamptz
       FROM jsonb_to_recordset($5::jsonb) AS value(code_ref TEXT,lookup_digest TEXT,safe_fingerprint TEXT)`,
      [input.batchRef, input.siteId, input.keyRevision, occurredAt, JSON.stringify(input.codes.map((code) => ({
        code_ref: code.codeRef, lookup_digest: code.lookupDigest, safe_fingerprint: code.safeFingerprint,
      })))],
    ), input.codes.length, "COMMERCE_CODE_INVENTORY_PERSIST_FAILED");
    await exactlyOne(sql.execute(
      `INSERT INTO platform.commerce_code_secret_export
       (batch_ref,site_ref,export_command_id,exported_to_subject_ref,code_count,export_digest,exported_at)
       VALUES ($1::uuid,$2,$3,$4,$5,$6,$7::timestamptz)`,
      [input.batchRef, input.siteId, input.command.commandId, input.subjectId, input.codes.length, input.exportDigest, occurredAt],
    ), "COMMERCE_CODE_EXPORT_PERSIST_FAILED");
    await audit(sql, input, "commerce.code_batch.issued", input.exportDigest, occurredAt);
    await complete(this.receipts, transaction, input.command, {
      batchRef: input.batchRef, codeCount: input.codes.length, exportDigest: input.exportDigest, exportedAt: occurredAt,
    });
    return Object.freeze({ kind: "committed" as const, occurredAt });
  }

  async approveBatch(transaction: Parameters<CommerceAdministrationRepository["approveBatch"]>[0], input: Parameters<CommerceAdministrationRepository["approveBatch"]>[1]) {
    if (await replayed(this.receipts, transaction, input.command)) return "replayed" as const;
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
    await complete(this.receipts, transaction, input.command, { batchRef: input.batchRef, approvedAt: occurredAt });
    return "committed" as const;
  }

  async activateBatch(transaction: Parameters<CommerceAdministrationRepository["activateBatch"]>[0], input: Parameters<CommerceAdministrationRepository["activateBatch"]>[1]) {
    if (await replayed(this.receipts, transaction, input.command)) return "replayed" as const;
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
    await complete(this.receipts, transaction, input.command, { batchRef: input.batchRef, activatedAt: occurredAt });
    return "committed" as const;
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
    if (await replayed(this.receipts, transaction, input.command)) return "replayed" as const;
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
    await complete(this.receipts, transaction, input.command, {
      batchRef: input.batchRef, state: toState, changedAt: occurredAt,
    });
    return "committed" as const;
  }
}

async function replayed(receipts: CommandReceiptRepository, transaction: Parameters<CommerceAdministrationRepository["publishProgram"]>[0], identity: Parameters<CommandReceiptRepository["begin"]>[1]): Promise<boolean> {
  const receipt = await receipts.begin(transaction, identity);
  if (receipt.state === "succeeded") return true;
  if (receipt.state !== "pending") throw new Error("COMMERCE_ADMIN_COMMAND_TERMINAL");
  return false;
}
async function complete(receipts: CommandReceiptRepository, transaction: Parameters<CommerceAdministrationRepository["publishProgram"]>[0], identity: Parameters<CommandReceiptRepository["begin"]>[1], result: JsonValue) {
  const resultDigest = digest(result);
  await receipts.recordOutcome(transaction, identity, { state: "succeeded", result, resultDigest });
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
async function databaseNow(transaction: Parameters<CommerceAdministrationRepository["publishProgram"]>[0]): Promise<string> {
  const rows = await resolvePlatformTransaction(transaction).query<Record<string, unknown> & { occurredAt: Date | string }>(
    `SELECT clock_timestamp() AS "occurredAt"`,
  );
  const value = rows[0]?.occurredAt; if (value === undefined) throw new Error("COMMERCE_ADMIN_CLOCK_UNAVAILABLE");
  const result = new Date(value); if (!Number.isFinite(result.getTime())) throw new Error("COMMERCE_ADMIN_CLOCK_INVALID"); return result.toISOString();
}
async function publishedAt(
  transaction: Parameters<CommerceAdministrationRepository["publishProgram"]>[0],
  table: "commerce_credit_program_revision" | "commerce_entitlement_template_revision",
  referenceColumn: "credit_program_revision_ref" | "entitlement_template_revision_ref",
  reference: string,
  siteId: string,
  missingCode: string,
): Promise<string> {
  const rows = await resolvePlatformTransaction(transaction).query<Record<string, unknown> & {
    publishedAt: Date | string;
  }>(
    `SELECT published_at AS "publishedAt" FROM platform.${table}
     WHERE ${referenceColumn}=$1 AND site_ref=$2 LIMIT 1`,
    [reference, siteId],
  );
  const value = rows[0]?.publishedAt;
  if (value === undefined) throw new Error(missingCode);
  const result = new Date(value);
  if (!Number.isFinite(result.getTime())) throw new Error("COMMERCE_ADMIN_CLOCK_INVALID");
  return result.toISOString();
}
function digest(value: Parameters<typeof commerceCanonicalJson>[0]): string { return createHash("sha256").update(commerceCanonicalJson(value)).digest("hex"); }
async function exactlyOne(changed: number | Promise<number>, code: string): Promise<void> { if (await changed !== 1) throw new Error(code); }
async function exactlyCount(changed: number | Promise<number>, expected: number, code: string): Promise<void> { if (await changed !== expected) throw new Error(code); }
