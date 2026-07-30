import { resolvePlatformTransaction, type PlatformSqlTransaction } from
  "../../../../shared/unit-of-work/platform-transaction.js";
import type { AssetPromotionWorkerRepositoryPort } from
  "../../application/contracts/asset-promotion-worker-ports.js";
import { verifyAssetPromotionIntent, type AssetPromotionIntent } from
  "../../domain/promotion-intent.js";
import { persistAssetCleanupPlan } from "./asset-cleanup-repository.js";

export class PostgresAssetPromotionRepository implements AssetPromotionWorkerRepositoryPort {
  async claimPromotionWork(
    transaction: Parameters<AssetPromotionWorkerRepositoryPort["claimPromotionWork"]>[0],
    input: Parameters<AssetPromotionWorkerRepositoryPort["claimPromotionWork"]>[1],
  ): ReturnType<AssetPromotionWorkerRepositoryPort["claimPromotionWork"]> {
    const rows = await resolvePlatformTransaction(transaction).query<PromotionRow>(
      `SELECT ${PROMOTION_COLUMNS}
       FROM platform.asset_promotion_intent
       WHERE site_ref=$1 AND promotion_ref=$2 AND promotion_event_id=$3::uuid
       FOR UPDATE`,
      [input.siteRef, input.promotionRef, input.eventId],
    );
    const row = rows[0];
    if (!row) return Object.freeze({ disposition: "superseded" });
    if (row.state === "completed" || row.state === "rejected") {
      return Object.freeze({ disposition: "terminal" });
    }
    if (row.state === "pending_copy" && row.expectedVersion !== input.expectedVersion) {
      return Object.freeze({ disposition: "superseded" });
    }
    return Object.freeze({ disposition: "work", promotion: hydratePromotion(row) });
  }

  async markObserving(
    transaction: Parameters<AssetPromotionWorkerRepositoryPort["markObserving"]>[0],
    input: Parameters<AssetPromotionWorkerRepositoryPort["markObserving"]>[1],
  ): ReturnType<AssetPromotionWorkerRepositoryPort["markObserving"]> {
    const sql = resolvePlatformTransaction(transaction);
    const changed = await sql.execute(
      `UPDATE platform.asset_promotion_intent
       SET state='observing_copy',expected_version=expected_version+1,updated_at=now()
       WHERE site_ref=$1 AND promotion_ref=$2 AND expected_version=$3::bigint AND state='pending_copy'`,
      [input.siteRef, input.promotionRef, input.expectedVersion],
    );
    if (changed === 1) return "committed";
    const rows = await sql.query<{ state: string; expectedVersion: bigint }>(
      `SELECT state,expected_version AS "expectedVersion"
       FROM platform.asset_promotion_intent WHERE site_ref=$1 AND promotion_ref=$2 FOR UPDATE`,
      [input.siteRef, input.promotionRef],
    );
    return rows[0]?.state === "observing_copy" && rows[0].expectedVersion >= input.expectedVersion
      ? "committed" : "superseded";
  }

  async finalizePromotion(
    transaction: Parameters<AssetPromotionWorkerRepositoryPort["finalizePromotion"]>[0],
    input: Parameters<AssetPromotionWorkerRepositoryPort["finalizePromotion"]>[1],
  ): ReturnType<AssetPromotionWorkerRepositoryPort["finalizePromotion"]> {
    const sql = resolvePlatformTransaction(transaction);
    await lockCurrentPromotionAuthority(sql, input.promotion);
    let currentVersion = input.expectedPromotionVersion;
    if (input.promotion.state === "pending_copy") {
      const observing = await sql.execute(
        `UPDATE platform.asset_promotion_intent
         SET state='observing_copy',expected_version=expected_version+1,updated_at=now()
         WHERE site_ref=$1 AND promotion_ref=$2 AND expected_version=$3::bigint AND state='pending_copy'`,
        [input.promotion.siteRef, input.promotion.promotionRef, currentVersion],
      );
      if (observing !== 1) return "superseded";
      currentVersion += 1n;
    }
    if (input.promotion.state !== "ready_to_finalize") {
      const observed = await sql.execute(
        `UPDATE platform.asset_promotion_intent
         SET state='ready_to_finalize',expected_version=expected_version+1,
             copied_provider_version_ref=$4,copied_provider_etag_digest=$5,copied_at=$6::timestamptz,
             updated_at=now()
         WHERE site_ref=$1 AND promotion_ref=$2 AND expected_version=$3::bigint
           AND state='observing_copy'`,
        [input.promotion.siteRef, input.promotion.promotionRef, currentVersion,
          input.observation.providerVersionRef, input.observation.providerEtagDigest,
          input.observation.observedAt],
      );
      if (observed !== 1) return "superseded";
      currentVersion += 1n;
    }
    await insertReadyFacts(sql, input);
    const completed = await sql.execute(
      `UPDATE platform.asset_promotion_intent
       SET state='completed',expected_version=expected_version+1,cleanup_group_ref=$5,
           updated_at=$4::timestamptz
       WHERE site_ref=$1 AND promotion_ref=$2 AND expected_version=$3::bigint
         AND state='ready_to_finalize'`,
      [input.promotion.siteRef, input.promotion.promotionRef, currentVersion, input.completedAt,
        input.cleanupPlan.cleanupGroupRef],
    );
    if (completed !== 1) throw new Error("ASSET_PROMOTION_COMPLETION_CONFLICT");
    return "committed";
  }

  async rejectPromotion(
    transaction: Parameters<AssetPromotionWorkerRepositoryPort["rejectPromotion"]>[0],
    input: Parameters<AssetPromotionWorkerRepositoryPort["rejectPromotion"]>[1],
  ): ReturnType<AssetPromotionWorkerRepositoryPort["rejectPromotion"]> {
    const sql = resolvePlatformTransaction(transaction);
    const ownerRows = await sql.query<{
      subjectRef: string;
      purpose: string;
      intentRef: string;
      sessionRef: string;
      quarantineBytes: bigint;
      storageTenantRef: string;
      storageRegion: string;
      quarantineObjectRef: string;
      quarantineProviderVersionRef: string;
      trustedObjectRef: string;
      state: string;
      expectedVersion: bigint;
    }>(
      `SELECT subject_ref AS "subjectRef",purpose,intent_ref AS "intentRef",
              session_ref AS "sessionRef",size AS "quarantineBytes",
              storage_tenant_ref AS "storageTenantRef",storage_region AS "storageRegion",
              quarantine_object_ref AS "quarantineObjectRef",
              quarantine_provider_version_ref AS "quarantineProviderVersionRef",
              trusted_object_ref AS "trustedObjectRef",state,
              expected_version AS "expectedVersion"
       FROM platform.asset_promotion_intent
       WHERE site_ref=$1 AND promotion_ref=$2 FOR UPDATE`,
      [input.siteRef, input.promotionRef],
    );
    const owner = ownerRows[0];
    if (!owner || owner.expectedVersion !== input.expectedVersion ||
        !new Set(["pending_copy", "observing_copy", "ready_to_finalize"]).has(owner.state)) {
      return "superseded";
    }
    await terminalizeRejectedPromotion(sql, input, owner);
    // The cleanup group must exist before the promotion row points at it because the
    // cleanup_group_ref foreign key is intentionally immediate (not deferred).
    await exactlyOne(sql, `UPDATE platform.asset_promotion_intent
      SET state='rejected',expected_version=expected_version+1,failure_code=$4,
          cleanup_group_ref=$5,updated_at=now()
      WHERE site_ref=$1 AND promotion_ref=$2 AND expected_version=$3::bigint
        AND state IN ('pending_copy','observing_copy','ready_to_finalize')`,
    [input.siteRef, input.promotionRef, input.expectedVersion, input.reasonCode,
      input.cleanupPlan.cleanupGroupRef], "ASSET_PROMOTION_REJECTION_CONFLICT");
    return "committed";
  }
}

async function terminalizeRejectedPromotion(
  sql: PlatformSqlTransaction,
  input: Parameters<AssetPromotionWorkerRepositoryPort["rejectPromotion"]>[1],
  owner: Readonly<{
    subjectRef: string;
    purpose: string;
    intentRef: string;
    sessionRef: string;
    quarantineBytes: bigint;
    storageTenantRef: string;
    storageRegion: string;
    quarantineObjectRef: string;
    quarantineProviderVersionRef: string;
    trustedObjectRef: string;
  }>,
): Promise<void> {
  assertRejectedPromotionCleanupPlan(input, owner);
  await exactlyOne(sql, `UPDATE platform.asset_blob_candidate candidate
    SET state='rejected',expected_version=expected_version+1,updated_at=now()
    FROM platform.asset_promotion_intent promotion
    WHERE promotion.site_ref=$1 AND promotion.promotion_ref=$2
      AND candidate.site_ref=promotion.site_ref AND candidate.candidate_ref=promotion.candidate_ref
      AND candidate.state='promotion_ready'`,
  [input.siteRef, input.promotionRef], "ASSET_BLOB_CANDIDATE_REJECTION_CONFLICT");
  await exactlyOne(sql, `UPDATE platform.asset_upload_session
    SET state='rejected',expected_version=expected_version+1,updated_at=now()
    WHERE site_ref=$1 AND intent_ref=$2 AND session_ref=$3 AND state='validating'`,
  [input.siteRef, owner.intentRef, owner.sessionRef], "ASSET_UPLOAD_SESSION_REJECTION_CONFLICT");
  await exactlyOne(sql, `UPDATE platform.asset_upload_intent
    SET state='rejected',expected_version=expected_version+1,updated_at=now()
    WHERE site_ref=$1 AND intent_ref=$2 AND state='admitted'`,
  [input.siteRef, owner.intentRef], "ASSET_UPLOAD_INTENT_REJECTION_CONFLICT");
  const retained = input.cleanupPlan.targets.reduce((total, target) =>
    total + target.retainedBytes, 0n);
  await exactlyOne(sql, `UPDATE platform.asset_quota_account
    SET quarantine_bytes=quarantine_bytes-$4::bigint,
        trash_retained_bytes=trash_retained_bytes+$5::bigint,
        expected_version=expected_version+1,updated_at=now()
    WHERE site_ref=$1 AND subject_ref=$2 AND purpose=$3 AND quarantine_bytes >= $4::bigint`,
  [input.siteRef, owner.subjectRef, owner.purpose, owner.quarantineBytes, retained],
  "ASSET_QUOTA_RETENTION_CONFLICT");
  await exactlyOne(sql, `UPDATE platform.asset_quota_reservation
    SET state='trash_retained',updated_at=now()
    WHERE site_ref=$1 AND intent_ref=$2 AND session_ref=$3 AND state='committed'`,
  [input.siteRef, owner.intentRef, owner.sessionRef], "ASSET_QUOTA_RETENTION_CONFLICT");
  await persistAssetCleanupPlan(sql, {
    siteRef: input.siteRef,
    subjectRef: owner.subjectRef,
    purpose: owner.purpose,
    intentRef: owner.intentRef,
    sessionRef: owner.sessionRef,
    sourceKind: "promotion_rejection",
    sourceRef: input.promotionRef,
    reasonCode: input.reasonCode,
  }, input.cleanupPlan);
  await exactlyOne(sql, `INSERT INTO platform.asset_upload_rejection
    (rejection_ref,site_ref,intent_ref,session_ref,reason_code,cleanup_group_ref)
    VALUES ($1,$2,$3,$4,$5,$6)`,
  [input.rejectionRef, input.siteRef, owner.intentRef, owner.sessionRef,
    input.reasonCode, input.cleanupPlan.cleanupGroupRef], "ASSET_UPLOAD_REJECTION_NOT_PERSISTED");
}

async function insertReadyFacts(
  sql: PlatformSqlTransaction,
  input: Parameters<AssetPromotionWorkerRepositoryPort["finalizePromotion"]>[1],
): Promise<void> {
  const value = input.promotion;
  assertSuccessfulPromotionCleanupPlan(input);
  await exactlyOne(sql, `INSERT INTO platform.asset_blob
    (blob_ref,site_ref,storage_tenant_ref,storage_region,trusted_object_ref,
     provider_version_ref,provider_etag_digest,checksum_sha256,size,state,created_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::bigint,'ready',$10::timestamptz)`,
  [value.blobRef, value.siteRef, value.storageTenantRef, value.storageRegion,
    value.trustedObjectRef, input.observation.providerVersionRef,
    input.observation.providerEtagDigest, value.checksumSha256, value.size, input.completedAt],
  "ASSET_BLOB_NOT_PERSISTED");
  await exactlyOne(sql, `INSERT INTO platform.asset_resource
    (asset_ref,site_ref,subject_ref,subject_generation,project_ref,purpose,state,
     expected_version,created_at,updated_at)
    VALUES ($1,$2,$3,$4::bigint,$5,$6,'active',1,$7::timestamptz,$7::timestamptz)`,
  [value.assetRef, value.siteRef, value.subjectRef, value.subjectGeneration,
    value.projectRef, value.purpose, input.completedAt], "ASSET_RESOURCE_NOT_PERSISTED");
  await exactlyOne(sql, `INSERT INTO platform.asset_version
    (asset_version_ref,site_ref,asset_ref,blob_ref,source_upload_intent_ref,
     scan_evaluation_ref,policy_revision_ref,detected_media_type,checksum_sha256,size,
     state,eligibility_epoch,created_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::bigint,'ready',1,$11::timestamptz)`,
  [value.assetVersionRef, value.siteRef, value.assetRef, value.blobRef, value.intentRef,
    value.evaluationRef, value.policyRevisionRef, value.detectedMediaType,
    value.checksumSha256, value.size, input.completedAt], "ASSET_VERSION_NOT_PERSISTED");
  await exactlyOne(sql, `INSERT INTO platform.asset_reference
    (reference_ref,site_ref,asset_version_ref,owner_context,resource_ref,
     resource_version,purpose,state,created_at)
    VALUES ($1,$2,$3,'upload_intent',$4,1,$5,'active',$6::timestamptz)`,
  [input.referenceRef, value.siteRef, value.assetVersionRef, value.intentRef,
    value.purpose, input.completedAt], "ASSET_REFERENCE_NOT_PERSISTED");
  await exactlyOne(sql, `INSERT INTO platform.asset_eligibility_projection
    (eligibility_ref,site_ref,asset_version_ref,subject_ref,subject_generation,project_ref,
     purpose,policy_revision_ref,scan_evaluation_ref,eligibility_epoch,state,created_at,updated_at)
    VALUES ($1,$2,$3,$4,$5::bigint,$6,$7,$8,$9,1,'ready',$10::timestamptz,$10::timestamptz)`,
  [input.eligibilityRef, value.siteRef, value.assetVersionRef, value.subjectRef,
    value.subjectGeneration, value.projectRef, value.purpose, value.policyRevisionRef,
    value.evaluationRef, input.completedAt], "ASSET_ELIGIBILITY_NOT_PERSISTED");
  await exactlyOne(sql, `INSERT INTO platform.asset_promotion_receipt
    (receipt_ref,site_ref,promotion_ref,asset_ref,asset_version_ref,blob_ref,
     trusted_provider_version_ref,checksum_sha256,completed_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::timestamptz)`,
  [input.receiptRef, value.siteRef, value.promotionRef, value.assetRef,
    value.assetVersionRef, value.blobRef, input.observation.providerVersionRef,
    value.checksumSha256, input.completedAt], "ASSET_PROMOTION_RECEIPT_NOT_PERSISTED");
  await exactlyOne(sql, `UPDATE platform.asset_quota_account
    SET quarantine_bytes=quarantine_bytes-$4::bigint,ready_asset_bytes=ready_asset_bytes+$4::bigint,
        trash_retained_bytes=trash_retained_bytes+$4::bigint,
        expected_version=expected_version+1,updated_at=$5::timestamptz
    WHERE site_ref=$1 AND subject_ref=$2 AND purpose=$3 AND quarantine_bytes >= $4::bigint`,
  [value.siteRef, value.subjectRef, value.purpose, value.size, input.completedAt],
  "ASSET_READY_QUOTA_TRANSITION_CONFLICT");
  await exactlyOne(sql, `UPDATE platform.asset_quota_reservation
    SET state='trash_retained',updated_at=$4::timestamptz
    WHERE site_ref=$1 AND intent_ref=$2 AND session_ref=$3 AND state='committed'`,
  [value.siteRef, value.intentRef, value.sessionRef, input.completedAt],
  "ASSET_READY_QUOTA_TRANSITION_CONFLICT");
  await exactlyOne(sql, `UPDATE platform.asset_upload_session
    SET state='completed',expected_version=expected_version+1,updated_at=$4::timestamptz
    WHERE site_ref=$1 AND intent_ref=$2 AND session_ref=$3 AND state='validating'`,
  [value.siteRef, value.intentRef, value.sessionRef, input.completedAt],
  "ASSET_UPLOAD_COMPLETION_CONFLICT");
  await exactlyOne(sql, `UPDATE platform.asset_upload_intent
    SET state='completed',expected_version=expected_version+1,updated_at=$3::timestamptz
    WHERE site_ref=$1 AND intent_ref=$2 AND state='admitted'`,
  [value.siteRef, value.intentRef, input.completedAt], "ASSET_UPLOAD_COMPLETION_CONFLICT");
  await persistAssetCleanupPlan(sql, {
    siteRef: value.siteRef,
    subjectRef: value.subjectRef,
    purpose: value.purpose,
    intentRef: value.intentRef,
    sessionRef: value.sessionRef,
    sourceKind: "promotion_success",
    sourceRef: value.promotionRef,
    reasonCode: "ASSET_PROMOTED_QUARANTINE_CLEANUP",
  }, input.cleanupPlan);
}

function assertSuccessfulPromotionCleanupPlan(
  input: Parameters<AssetPromotionWorkerRepositoryPort["finalizePromotion"]>[1],
): void {
  const value = input.promotion;
  const target = input.cleanupPlan.targets[0];
  if (input.cleanupPlan.terminalReservationState !== "promoted" ||
      input.cleanupPlan.targets.length !== 1 || !target || target.objectRole !== "quarantine" ||
      target.storageTenantRef !== value.storageTenantRef ||
      target.storageRegion !== value.storageRegion || target.objectRef !== value.quarantineObjectRef ||
      target.providerVersionRef !== value.quarantineProviderVersionRef ||
      target.retainedBytes !== value.size) {
    throw new Error("ASSET_CLEANUP_PLAN_INVALID");
  }
}

function assertRejectedPromotionCleanupPlan(
  input: Parameters<AssetPromotionWorkerRepositoryPort["rejectPromotion"]>[1],
  owner: Readonly<{
    quarantineBytes: bigint;
    storageTenantRef: string;
    storageRegion: string;
    quarantineObjectRef: string;
    quarantineProviderVersionRef: string;
    trustedObjectRef: string;
  }>,
): void {
  const quarantine = input.cleanupPlan.targets.find((target) => target.objectRole === "quarantine");
  const trusted = input.cleanupPlan.targets.find((target) => target.objectRole === "trusted_copy");
  if (input.cleanupPlan.terminalReservationState !== "released" ||
      input.cleanupPlan.targets.length !== 2 || !quarantine || !trusted ||
      quarantine.storageTenantRef !== owner.storageTenantRef ||
      quarantine.storageRegion !== owner.storageRegion ||
      quarantine.objectRef !== owner.quarantineObjectRef ||
      quarantine.providerVersionRef !== owner.quarantineProviderVersionRef ||
      quarantine.retainedBytes !== owner.quarantineBytes ||
      trusted.storageTenantRef !== owner.storageTenantRef ||
      trusted.storageRegion !== owner.storageRegion || trusted.objectRef !== owner.trustedObjectRef ||
      trusted.providerVersionRef.length < 1 || trusted.retainedBytes < 1n) {
    throw new Error("ASSET_CLEANUP_PLAN_INVALID");
  }
}

async function lockCurrentPromotionAuthority(
  sql: PlatformSqlTransaction,
  value: AssetPromotionIntent,
): Promise<void> {
  const rows = await sql.query<{ allowed: boolean }>(
    `SELECT TRUE AS allowed
     FROM platform.asset_upload_intent intent
     JOIN platform.authorization_product_binding binding
       ON binding.workload_identity_id=intent.workload_identity_id
      AND binding.site_ref=intent.site_ref AND binding.release_ref=intent.site_release_ref
     JOIN platform.authorization_subject subject
       ON subject.subject_ref=intent.subject_ref AND subject.site_ref=intent.site_ref
     JOIN platform.authorization_project project
       ON project.project_ref=intent.project_ref AND project.site_ref=intent.site_ref
     JOIN platform.authorization_project_membership membership
       ON membership.project_ref=project.project_ref AND membership.subject_ref=subject.subject_ref
     WHERE intent.site_ref=$1 AND intent.intent_ref=$2 AND intent.subject_ref=$3
       AND intent.subject_generation=$4::bigint AND intent.project_ref=$5
       AND intent.binding_epoch=binding.binding_epoch AND binding.state='active'
       AND subject.subject_generation=intent.subject_generation AND subject.state='active'
       AND project.state='active' AND membership.state='active'
       AND current_setting('app.operation',true)='asset.promotion.finalize'
       AND current_setting('app.site_id',true)=intent.site_ref
     FOR UPDATE OF intent,binding,subject,project,membership`,
    [value.siteRef, value.intentRef, value.subjectRef, value.subjectGeneration, value.projectRef],
  );
  if (!rows[0]?.allowed) throw new Error("ASSET_PROMOTION_AUTHORITY_STALE");
}

async function exactlyOne(
  sql: PlatformSqlTransaction,
  statement: string,
  values: readonly unknown[],
  code: string,
): Promise<void> {
  if (await sql.execute(statement, values) !== 1) throw new Error(code);
}

const PROMOTION_COLUMNS = `
  promotion_ref AS "promotionRef",site_ref AS "siteRef",subject_ref AS "subjectRef",
  subject_generation AS "subjectGeneration",project_ref AS "projectRef",purpose,
  intent_ref AS "intentRef",session_ref AS "sessionRef",candidate_ref AS "candidateRef",
  evaluation_ref AS "evaluationRef",policy_revision_ref AS "policyRevisionRef",
  asset_ref AS "assetRef",asset_version_ref AS "assetVersionRef",blob_ref AS "blobRef",
  storage_tenant_ref AS "storageTenantRef",storage_region AS "storageRegion",
  quarantine_object_ref AS "quarantineObjectRef",
  quarantine_provider_version_ref AS "quarantineProviderVersionRef",
  trusted_object_ref AS "trustedObjectRef",checksum_sha256 AS "checksumSha256",size,
  detected_media_type AS "detectedMediaType",state,expected_version AS "expectedVersion",
  promotion_event_id AS "promotionEventId",copied_provider_version_ref AS "copiedProviderVersionRef",
  copied_provider_etag_digest AS "copiedProviderEtagDigest",copied_at AS "copiedAt",created_at AS "createdAt"`;

type PromotionRow = Omit<AssetPromotionIntent, "createdAt"> & Readonly<{
  promotionEventId: string;
  copiedProviderVersionRef: string | null;
  copiedProviderEtagDigest: string | null;
  copiedAt: Date | string | null;
  createdAt: Date | string;
}> & Record<string, unknown>;

function hydratePromotion(row: PromotionRow): AssetPromotionIntent {
  return verifyAssetPromotionIntent({ ...row, createdAt: instant(row.createdAt) });
}

function instant(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}
