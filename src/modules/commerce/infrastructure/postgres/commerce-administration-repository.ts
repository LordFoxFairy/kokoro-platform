import { createHash, randomUUID } from "node:crypto";
import { CommandReceiptRepository, type JsonValue } from "../../../../shared/outbox-inbox/receipt.js";
import { resolvePlatformTransaction } from "../../../../shared/unit-of-work/platform-transaction.js";
import { commerceCanonicalJson } from "../../domain/canonical-json.js";
import type { CommerceAdministrationRepository, CommerceAdminActor } from "../../application/contracts/commerce-administration-repository.js";

export class PostgresCommerceAdministrationRepository implements CommerceAdministrationRepository {
  constructor(private readonly receipts = new CommandReceiptRepository()) {}

  async publishProgram(transaction: Parameters<CommerceAdministrationRepository["publishProgram"]>[0], input: Parameters<CommerceAdministrationRepository["publishProgram"]>[1]) {
    if (await replayed(this.receipts, transaction, input.command)) return "replayed" as const;
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
    return "committed" as const;
  }

  async issueBatch(transaction: Parameters<CommerceAdministrationRepository["issueBatch"]>[0], input: Parameters<CommerceAdministrationRepository["issueBatch"]>[1]) {
    if (await replayed(this.receipts, transaction, input.command)) return { kind: "replayed" as const, occurredAt: await databaseNow(transaction) };
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
function digest(value: Parameters<typeof commerceCanonicalJson>[0]): string { return createHash("sha256").update(commerceCanonicalJson(value)).digest("hex"); }
async function exactlyOne(changed: number | Promise<number>, code: string): Promise<void> { if (await changed !== 1) throw new Error(code); }
async function exactlyCount(changed: number | Promise<number>, expected: number, code: string): Promise<void> { if (await changed !== expected) throw new Error(code); }
