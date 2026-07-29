import { assertDigest } from "../../../../shared/outbox-inbox/receipt.js";
import type { OutboxEvent } from "../../../../shared/outbox-inbox/outbox.js";
import { resolvePlatformTransaction, type PlatformSqlTransaction } from
  "../../../../shared/unit-of-work/platform-transaction.js";
import type {
  AssetScanWorkerRepositoryPort,
  PersistedAssetScanDecision,
} from "../../application/contracts/asset-scan-worker-ports.js";
import { verifyBlobCandidate, type BlobCandidate } from "../../domain/blob-candidate.js";
import type { AssetPromotionIntent } from "../../domain/promotion-intent.js";
import type { AssetScanEvaluation } from "../../domain/scan-evaluation.js";

export class PostgresAssetScanRepository implements AssetScanWorkerRepositoryPort {
  async claimScanWork(
    transaction: Parameters<AssetScanWorkerRepositoryPort["claimScanWork"]>[0],
    input: Parameters<AssetScanWorkerRepositoryPort["claimScanWork"]>[1],
  ): ReturnType<AssetScanWorkerRepositoryPort["claimScanWork"]> {
    const sql = resolvePlatformTransaction(transaction);
    const rows = await sql.query<CandidateRow>(
      `SELECT ${CANDIDATE_COLUMNS}
       FROM platform.asset_blob_candidate
       WHERE site_ref=$1 AND candidate_ref=$2 AND scan_event_id=$3::uuid
       FOR UPDATE`,
      [input.siteRef, input.candidateRef, input.eventId],
    );
    const row = rows[0];
    if (!row) return Object.freeze({ disposition: "superseded" });
    if (row.state === "promotion_ready" || row.state === "rejected") {
      return Object.freeze({ disposition: "terminal" });
    }
    if (row.state === "scanning") {
      return Object.freeze({ disposition: "work", candidate: hydrateCandidate(row) });
    }
    if (row.state !== "checksum_verified" && row.state !== "scan_unavailable") {
      return Object.freeze({ disposition: "superseded" });
    }
    if (row.state === "checksum_verified" && row.expectedVersion !== input.expectedVersion) {
      return Object.freeze({ disposition: "superseded" });
    }
    const claimed = await sql.query<CandidateRow>(
      `UPDATE platform.asset_blob_candidate
       SET state='scanning',expected_version=expected_version+1,updated_at=now()
       WHERE site_ref=$1 AND candidate_ref=$2 AND scan_event_id=$3::uuid
         AND expected_version=$4::bigint AND state IN ('checksum_verified','scan_unavailable')
       RETURNING ${CANDIDATE_COLUMNS}`,
      [input.siteRef, input.candidateRef, input.eventId, row.expectedVersion],
    );
    return claimed[0]
      ? Object.freeze({ disposition: "work", candidate: hydrateCandidate(claimed[0]) })
      : Object.freeze({ disposition: "superseded" });
  }

  async recordDecision(
    transaction: Parameters<AssetScanWorkerRepositoryPort["recordDecision"]>[0],
    input: Parameters<AssetScanWorkerRepositoryPort["recordDecision"]>[1],
  ): ReturnType<AssetScanWorkerRepositoryPort["recordDecision"]> {
    const sql = resolvePlatformTransaction(transaction);
    const decision = input.decision;
    const nextState = decision.disposition === "clean"
      ? "promotion_ready"
      : decision.disposition === "unavailable" ? "scan_unavailable" : "rejected";
    const changed = await sql.execute(
      `UPDATE platform.asset_blob_candidate
       SET state='${nextState}',expected_version=expected_version+1,updated_at=now()
       WHERE site_ref=$1 AND candidate_ref=$2 AND expected_version=$3::bigint AND state='scanning'`,
      [decision.evaluation.siteRef, decision.evaluation.candidateRef, input.expectedCandidateVersion],
    );
    if (changed !== 1) return "superseded";
    await insertEvaluation(sql, decision.evaluation);
    if (decision.disposition === "unavailable") return "committed";
    if (decision.disposition === "clean") {
      await enqueue(sql, decision.promotionEvent);
      await insertPromotion(sql, decision.promotion, decision.promotionEvent.eventId);
      return "committed";
    }
    await rejectUpload(sql, decision);
    return "committed";
  }
}

async function insertEvaluation(sql: PlatformSqlTransaction, value: AssetScanEvaluation): Promise<void> {
  const changed = await sql.execute(
    `INSERT INTO platform.asset_scan_evaluation
     (evaluation_ref,site_ref,candidate_ref,candidate_version,policy_revision_ref,
      scanner_definition_ref,scanner_revision_ref,signature_revision_ref,detected_media_type,
      magic_signature_ref,container_summary_digest,malware_disposition,content_safety_disposition,
      evidence_ref,evidence_digest,outcome,reason_code,occurred_at)
     VALUES ($1,$2,$3,$4::bigint,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18::timestamptz)`,
    [value.evaluationRef, value.siteRef, value.candidateRef, value.candidateVersion,
      value.policyRevisionRef, value.scannerDefinitionRef, value.scannerRevisionRef,
      value.signatureRevisionRef, value.detectedMediaType, value.magicSignatureRef,
      value.containerSummaryDigest, value.malwareDisposition, value.contentSafetyDisposition,
      value.evidenceRef, value.evidenceDigest, value.outcome, value.reasonCode, value.occurredAt],
  );
  if (changed !== 1) throw new Error("ASSET_SCAN_EVALUATION_NOT_PERSISTED");
}

async function insertPromotion(
  sql: PlatformSqlTransaction,
  value: AssetPromotionIntent,
  promotionEventId: string,
): Promise<void> {
  const changed = await sql.execute(
    `INSERT INTO platform.asset_promotion_intent
     (promotion_ref,site_ref,subject_ref,subject_generation,project_ref,purpose,intent_ref,
      session_ref,candidate_ref,evaluation_ref,policy_revision_ref,asset_ref,asset_version_ref,
      blob_ref,storage_tenant_ref,storage_region,quarantine_object_ref,
      quarantine_provider_version_ref,trusted_object_ref,checksum_sha256,size,detected_media_type,
      state,expected_version,promotion_event_id,created_at)
     VALUES ($1,$2,$3,$4::bigint,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,
       $20,$21::bigint,$22,$23,$24::bigint,$25::uuid,$26::timestamptz)`,
    [value.promotionRef, value.siteRef, value.subjectRef, value.subjectGeneration,
      value.projectRef, value.purpose, value.intentRef, value.sessionRef, value.candidateRef,
      value.evaluationRef, value.policyRevisionRef, value.assetRef, value.assetVersionRef,
      value.blobRef, value.storageTenantRef, value.storageRegion, value.quarantineObjectRef,
      value.quarantineProviderVersionRef, value.trustedObjectRef, value.checksumSha256,
      value.size, value.detectedMediaType, value.state, value.expectedVersion,
      promotionEventId, value.createdAt],
  );
  if (changed !== 1) throw new Error("ASSET_PROMOTION_INTENT_NOT_PERSISTED");
}

async function rejectUpload(
  sql: PlatformSqlTransaction,
  decision: Extract<PersistedAssetScanDecision, { disposition: "rejected" }>,
): Promise<void> {
  const reservations = await sql.query<{
    subjectRef: string; purpose: string; reservedBytes: bigint; state: string;
  }>(
    `SELECT subject_ref AS "subjectRef",purpose,reserved_bytes AS "reservedBytes",state
     FROM platform.asset_quota_reservation
     WHERE site_ref=$1 AND intent_ref=(SELECT intent_ref FROM platform.asset_blob_candidate
       WHERE site_ref=$1 AND candidate_ref=$2)
     FOR UPDATE`,
    [decision.evaluation.siteRef, decision.evaluation.candidateRef],
  );
  const reservation = reservations[0];
  if (!reservation || reservation.state !== "committed") throw new Error("ASSET_QUOTA_RESERVATION_INVALID");
  const sessionChanged = await sql.execute(
    `UPDATE platform.asset_upload_session session
     SET state='rejected',expected_version=expected_version+1,updated_at=now()
     FROM platform.asset_blob_candidate candidate
     WHERE candidate.site_ref=$1 AND candidate.candidate_ref=$2
       AND session.site_ref=candidate.site_ref AND session.session_ref=candidate.session_ref
       AND session.state='validating'`,
    [decision.evaluation.siteRef, decision.evaluation.candidateRef],
  );
  if (sessionChanged !== 1) throw new Error("ASSET_UPLOAD_SESSION_REJECTION_CONFLICT");
  const intentChanged = await sql.execute(
    `UPDATE platform.asset_upload_intent intent
     SET state='rejected',expected_version=expected_version+1,updated_at=now()
     FROM platform.asset_blob_candidate candidate
     WHERE candidate.site_ref=$1 AND candidate.candidate_ref=$2
       AND intent.site_ref=candidate.site_ref AND intent.intent_ref=candidate.intent_ref
       AND intent.state='admitted'`,
    [decision.evaluation.siteRef, decision.evaluation.candidateRef],
  );
  if (intentChanged !== 1) throw new Error("ASSET_UPLOAD_INTENT_REJECTION_CONFLICT");
  const quotaChanged = await sql.execute(
    `UPDATE platform.asset_quota_account
     SET quarantine_bytes=quarantine_bytes-$4::bigint,
         expected_version=expected_version+1,updated_at=now()
     WHERE site_ref=$1 AND subject_ref=$2 AND purpose=$3
       AND quarantine_bytes >= $4::bigint`,
    [decision.evaluation.siteRef, reservation.subjectRef, reservation.purpose, reservation.reservedBytes],
  );
  if (quotaChanged !== 1) throw new Error("ASSET_QUOTA_RELEASE_CONFLICT");
  const reservationChanged = await sql.execute(
    `UPDATE platform.asset_quota_reservation reservation
     SET state='released',release_evidence_ref=$3,updated_at=now()
     FROM platform.asset_blob_candidate candidate
     WHERE candidate.site_ref=$1 AND candidate.candidate_ref=$2
       AND reservation.site_ref=candidate.site_ref AND reservation.intent_ref=candidate.intent_ref
       AND reservation.state='committed'`,
    [decision.evaluation.siteRef, decision.evaluation.candidateRef, decision.cleanupEvent.eventId],
  );
  if (reservationChanged !== 1) throw new Error("ASSET_QUOTA_RELEASE_CONFLICT");
  await enqueue(sql, decision.cleanupEvent);
  const rejectionChanged = await sql.execute(
    `INSERT INTO platform.asset_upload_rejection
     (rejection_ref,site_ref,intent_ref,session_ref,reason_code,cleanup_event_id)
     SELECT $3::uuid,candidate.site_ref,candidate.intent_ref,candidate.session_ref,$4,$3::uuid
     FROM platform.asset_blob_candidate candidate
     WHERE candidate.site_ref=$1 AND candidate.candidate_ref=$2`,
    [decision.evaluation.siteRef, decision.evaluation.candidateRef,
      decision.cleanupEvent.eventId, decision.code],
  );
  if (rejectionChanged !== 1) throw new Error("ASSET_UPLOAD_REJECTION_NOT_PERSISTED");
}

async function enqueue(sql: PlatformSqlTransaction, event: OutboxEvent): Promise<void> {
  assertDigest(event.payloadDigest);
  const changed = await sql.execute(
    `INSERT INTO platform.outbox_event
     (event_id,owner,event_type,aggregate_id,payload,payload_digest,correlation_id,causation_id)
     VALUES ($1::uuid,$2,$3,$4,$5::jsonb,$6,$7,$8)`,
    [event.eventId, event.owner, event.eventType, event.aggregateId, JSON.stringify(event.payload),
      event.payloadDigest, event.correlationId, event.causationId],
  );
  if (changed !== 1) throw new Error("ASSET_OUTBOX_EVENT_NOT_PERSISTED");
}

const CANDIDATE_COLUMNS = `
  candidate_ref AS "candidateRef",site_ref AS "siteRef",subject_ref AS "subjectRef",
  subject_generation AS "subjectGeneration",project_ref AS "projectRef",purpose,
  intent_ref AS "intentRef",session_ref AS "sessionRef",storage_tenant_ref AS "storageTenantRef",
  storage_region AS "storageRegion",quarantine_object_ref AS "quarantineObjectRef",
  provider_version_ref AS "providerVersionRef",provider_etag_digest AS "providerEtagDigest",
  observed_size AS "observedSize",checksum_sha256 AS "checksumSha256",
  client_media_type AS "clientMediaType",policy_revision_ref AS "policyRevisionRef",state,
  expected_version AS "expectedVersion",completion_requested_at AS "completionRequestedAt",
  observed_at AS "observedAt",scan_event_id AS "scanEventId"`;

type CandidateRow = Omit<BlobCandidate, "completionRequestedAt" | "observedAt"> & Readonly<{
  completionRequestedAt: Date | string;
  observedAt: Date | string;
  scanEventId: string;
}> & Record<string, unknown>;

function hydrateCandidate(row: CandidateRow): BlobCandidate {
  return verifyBlobCandidate({
    ...row,
    completionRequestedAt: instant(row.completionRequestedAt),
    observedAt: instant(row.observedAt),
  });
}

function instant(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}
