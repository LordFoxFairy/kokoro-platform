import { resolvePlatformTransaction } from "../../../../shared/unit-of-work/platform-transaction.js";
import type {
  AssetOwnerCommandOperation,
  AssetOwnerQueryRepositoryPort,
  StoredSessionAttachment,
  StoredAssetOwnerReceipt,
  StoredAssetUploadStatus,
  StoredTrustedAssetGrant,
} from "../../application/contracts/asset-owner-query-ports.js";

export class PostgresAssetOwnerQueryRepository implements AssetOwnerQueryRepositoryPort {
  async loadUploadStatus(
    transaction: Parameters<AssetOwnerQueryRepositoryPort["loadUploadStatus"]>[0],
    input: Parameters<AssetOwnerQueryRepositoryPort["loadUploadStatus"]>[1],
  ): Promise<StoredAssetUploadStatus | null> {
    const rows = await resolvePlatformTransaction(transaction).query<UploadStatusRow>(
      `SELECT intent.intent_ref AS "intentRef",session.session_ref AS "sessionRef",
              intent.project_ref AS "projectRef",intent.purpose,
              intent.safe_display_name AS "safeDisplayName",
              intent.client_media_type AS "clientMediaType",intent.expected_size AS "expectedSize",
              session.expected_version AS "expectedVersion",session.state AS "sessionState",
              candidate.state AS "candidateState",promotion.state AS "promotionState",
              rejection.rejection_ref IS NOT NULL AS rejected,
              GREATEST(intent.updated_at,session.updated_at,COALESCE(candidate.updated_at,session.updated_at),
                COALESCE(promotion.updated_at,session.updated_at)) AS "updatedAt",
              resource.asset_ref AS "assetRef",version.asset_version_ref AS "assetVersionRef",
              eligibility.eligibility_ref AS "assetGrantRef",
              eligibility.subject_generation AS "grantSubjectGeneration",
              eligibility.eligibility_epoch AS "eligibilityEpoch",
              version.detected_media_type AS "detectedMediaType",version.size AS "grantSize"
       FROM platform.asset_upload_intent intent
       JOIN platform.asset_upload_session session
         ON session.site_ref=intent.site_ref AND session.intent_ref=intent.intent_ref
       LEFT JOIN platform.asset_blob_candidate candidate
         ON candidate.site_ref=intent.site_ref AND candidate.intent_ref=intent.intent_ref
       LEFT JOIN platform.asset_promotion_intent promotion
         ON promotion.site_ref=intent.site_ref AND promotion.intent_ref=intent.intent_ref
       LEFT JOIN platform.asset_upload_rejection rejection
         ON rejection.site_ref=intent.site_ref AND rejection.intent_ref=intent.intent_ref
       LEFT JOIN platform.asset_version version
         ON version.site_ref=intent.site_ref AND version.source_upload_intent_ref=intent.intent_ref
           AND version.state='ready'
       LEFT JOIN platform.asset_resource resource
         ON resource.site_ref=version.site_ref AND resource.asset_ref=version.asset_ref
           AND resource.state='active'
       LEFT JOIN platform.asset_eligibility_projection eligibility
         ON eligibility.site_ref=version.site_ref AND eligibility.asset_version_ref=version.asset_version_ref
           AND eligibility.subject_ref=intent.subject_ref
           AND eligibility.subject_generation=intent.subject_generation
           AND eligibility.project_ref=intent.project_ref AND eligibility.purpose=intent.purpose
           AND eligibility.state='ready' AND eligibility.eligibility_epoch=version.eligibility_epoch
       WHERE intent.site_ref=$1 AND intent.subject_ref=$2 AND intent.subject_generation=$3::bigint
         AND intent.project_ref=$4 AND intent.intent_ref=$5
         AND intent.workload_identity_id=$6 AND intent.site_release_ref=$7
         AND intent.binding_epoch=$8::bigint`,
      [input.authority.siteRef, input.authority.subjectRef, input.authority.subjectGeneration,
        input.authority.projectRef, input.intentRef, input.authority.workloadIdentityId,
        input.authority.siteReleaseRef, input.authority.bindingEpoch],
    );
    return rows[0] ? status(rows[0]) : null;
  }

  async loadCommand(
    transaction: Parameters<AssetOwnerQueryRepositoryPort["loadCommand"]>[0],
    input: Parameters<AssetOwnerQueryRepositoryPort["loadCommand"]>[1],
  ): Promise<StoredAssetOwnerReceipt | null> {
    const caller = `${input.authority.workloadIdentityId}:${input.authority.subjectRef}:${input.authority.subjectGeneration}`;
    const rows = await resolvePlatformTransaction(transaction).query<CommandRow>(
      `SELECT command_id::text AS "commandId",operation,state,result,
              created_at AS "receivedAt",updated_at AS "updatedAt"
       FROM platform.command_receipt
       WHERE command_id=$1 AND environment=$2 AND region=$3 AND caller_identity=$4
         AND operation IN ('createAssetUploadIntent','completeAssetUpload')
         AND ($5::text IS NULL OR operation=$5)`,
      [input.commandId, input.environment, input.region, caller, input.operation ?? null],
    );
    return rows[0] ? receipt(rows[0]) : null;
  }

  async loadTrustedGrant(
    transaction: Parameters<AssetOwnerQueryRepositoryPort["loadTrustedGrant"]>[0],
    input: Parameters<AssetOwnerQueryRepositoryPort["loadTrustedGrant"]>[1],
  ): Promise<StoredTrustedAssetGrant | null> {
    const rows = await resolvePlatformTransaction(transaction).query<GrantRow>(
      `SELECT resource.asset_ref AS "assetRef",version.asset_version_ref AS "assetVersionRef",
              eligibility.eligibility_ref AS "assetGrantRef",resource.project_ref AS "projectRef",
              resource.purpose,resource.subject_generation AS "subjectGeneration",
              eligibility.eligibility_epoch AS "eligibilityEpoch",
              version.detected_media_type AS "detectedMediaType",version.size
       FROM platform.asset_resource resource
       JOIN platform.asset_version version
         ON version.site_ref=resource.site_ref AND version.asset_ref=resource.asset_ref
       JOIN platform.asset_eligibility_projection eligibility
         ON eligibility.site_ref=version.site_ref AND eligibility.asset_version_ref=version.asset_version_ref
       WHERE resource.site_ref=$1 AND resource.subject_ref=$2
         AND resource.subject_generation=$3::bigint AND resource.project_ref=$4
         AND resource.asset_ref=$5 AND version.asset_version_ref=$6
         AND eligibility.eligibility_ref=$7 AND resource.purpose=$8 AND eligibility.purpose=$8
         AND eligibility.eligibility_epoch=$9::bigint
         AND eligibility.subject_ref=resource.subject_ref
         AND eligibility.subject_generation=resource.subject_generation
         AND eligibility.project_ref=resource.project_ref
         AND version.eligibility_epoch=eligibility.eligibility_epoch
         AND resource.state='active' AND version.state='ready' AND eligibility.state='ready'`,
      [input.authority.siteRef, input.authority.subjectRef, input.authority.subjectGeneration,
        input.authority.projectRef, input.assetRef, input.assetVersionRef, input.assetGrantRef,
        input.purpose, input.eligibilityEpoch],
    );
    return rows[0] ? grant(rows[0]) : null;
  }

  async loadSessionAttachments(
    transaction: Parameters<AssetOwnerQueryRepositoryPort["loadSessionAttachments"]>[0],
    input: Parameters<AssetOwnerQueryRepositoryPort["loadSessionAttachments"]>[1],
  ): ReturnType<AssetOwnerQueryRepositoryPort["loadSessionAttachments"]> {
    if (input.attachments.length === 0) return Object.freeze([]);
    const rows = await resolvePlatformTransaction(transaction).query<SessionAttachmentRow>(
      `WITH requested AS (
         SELECT requested.asset_ref,requested.asset_version_ref,requested.asset_grant_ref,
                requested.ordinal
           FROM unnest($6::text[],$7::text[],$8::text[])
             WITH ORDINALITY AS requested(asset_ref,asset_version_ref,asset_grant_ref,ordinal)
       )
       SELECT requested.ordinal,resource.asset_ref AS "assetRef",
              version.asset_version_ref AS "assetVersionRef",
              eligibility.eligibility_ref AS "assetGrantRef",resource.project_ref AS "projectRef",
              resource.purpose,resource.subject_generation AS "subjectGeneration",
              eligibility.eligibility_epoch AS "eligibilityEpoch",
              version.checksum_sha256 AS "checksumSha256",
              intent.safe_display_name AS "safeDisplayName",
              version.detected_media_type AS "detectedMediaType",version.size
         FROM requested
         JOIN platform.asset_resource resource
           ON resource.site_ref=$1 AND resource.asset_ref=requested.asset_ref
         JOIN platform.asset_version version
           ON version.site_ref=resource.site_ref AND version.asset_ref=resource.asset_ref
          AND version.asset_version_ref=requested.asset_version_ref
         JOIN platform.asset_eligibility_projection eligibility
           ON eligibility.site_ref=version.site_ref
          AND eligibility.asset_version_ref=version.asset_version_ref
          AND eligibility.eligibility_ref=requested.asset_grant_ref
          AND eligibility.subject_ref=resource.subject_ref
          AND eligibility.subject_generation=resource.subject_generation
          AND eligibility.project_ref=resource.project_ref
          AND eligibility.purpose=resource.purpose
          AND eligibility.eligibility_epoch=version.eligibility_epoch
         JOIN platform.asset_upload_intent intent
           ON intent.site_ref=version.site_ref
          AND intent.intent_ref=version.source_upload_intent_ref
          AND intent.subject_ref=resource.subject_ref
          AND intent.subject_generation=resource.subject_generation
          AND intent.project_ref=resource.project_ref
          AND intent.purpose=resource.purpose
        WHERE resource.subject_ref=$2 AND resource.subject_generation=$3::bigint
          AND resource.project_ref=$4 AND resource.purpose=$5
          AND resource.state='active' AND version.state='ready' AND eligibility.state='ready'
        ORDER BY requested.ordinal`,
      [input.authority.siteRef, input.authority.subjectRef, input.authority.subjectGeneration,
        input.authority.projectRef, input.purpose,
        input.attachments.map((attachment) => attachment.assetRef),
        input.attachments.map((attachment) => attachment.assetVersionRef),
        input.attachments.map((attachment) => attachment.assetGrantRef)],
    );
    if (rows.length !== input.attachments.length) return null;
    return Object.freeze(rows.map((row, index) => sessionAttachment(row, input.attachments[index]!, index)));
  }
}

type UploadStatusRow = Omit<StoredAssetUploadStatus, "trustedGrant"> & Readonly<{
  assetRef: string | null;
  assetVersionRef: string | null;
  assetGrantRef: string | null;
  grantSubjectGeneration: bigint | null;
  eligibilityEpoch: bigint | null;
  detectedMediaType: string | null;
  grantSize: bigint | null;
}>;

type CommandRow = Readonly<{
  commandId: string;
  operation: string;
  state: StoredAssetOwnerReceipt["state"];
  result: unknown;
  receivedAt: string;
  updatedAt: string;
}>;

type GrantRow = StoredTrustedAssetGrant & Record<string, unknown>;

type SessionAttachmentRow = StoredSessionAttachment & Readonly<{ ordinal: bigint }> &
  Record<string, unknown>;

function status(row: UploadStatusRow): StoredAssetUploadStatus {
  const ready = row.assetRef !== null && row.assetVersionRef !== null && row.assetGrantRef !== null &&
    row.grantSubjectGeneration !== null && row.eligibilityEpoch !== null &&
    row.detectedMediaType !== null && row.grantSize !== null;
  return Object.freeze({
    intentRef: row.intentRef, sessionRef: row.sessionRef, projectRef: row.projectRef,
    purpose: row.purpose, safeDisplayName: row.safeDisplayName, clientMediaType: row.clientMediaType,
    expectedSize: row.expectedSize, expectedVersion: row.expectedVersion,
    sessionState: row.sessionState, candidateState: row.candidateState,
    promotionState: row.promotionState, rejected: row.rejected, updatedAt: instant(row.updatedAt),
    trustedGrant: ready ? Object.freeze({
      assetRef: row.assetRef!, assetVersionRef: row.assetVersionRef!, assetGrantRef: row.assetGrantRef!,
      projectRef: row.projectRef, purpose: row.purpose, subjectGeneration: row.grantSubjectGeneration!,
      eligibilityEpoch: row.eligibilityEpoch!, detectedMediaType: row.detectedMediaType!, size: row.grantSize!,
    }) : null,
  });
}

function receipt(row: CommandRow): StoredAssetOwnerReceipt {
  if (row.operation !== "createAssetUploadIntent" && row.operation !== "completeAssetUpload") {
    throw new Error("ASSET_COMMAND_RECEIPT_INVALID");
  }
  const result = record(row.result);
  return Object.freeze({
    commandId: row.commandId,
    operation: row.operation as AssetOwnerCommandOperation,
    state: row.state,
    intentRef: text(result?.intentRef),
    sessionRef: text(result?.sessionRef),
    receivedAt: instant(row.receivedAt),
    updatedAt: instant(row.updatedAt),
  });
}

function grant(row: GrantRow): StoredTrustedAssetGrant {
  return Object.freeze({ ...row });
}

function sessionAttachment(
  row: SessionAttachmentRow,
  expected: Readonly<{ assetRef: string; assetVersionRef: string; assetGrantRef: string }>,
  index: number,
): StoredSessionAttachment {
  if (
    row.ordinal !== BigInt(index + 1) || row.assetRef !== expected.assetRef ||
    row.assetVersionRef !== expected.assetVersionRef || row.assetGrantRef !== expected.assetGrantRef ||
    !/^[0-9a-f]{64}$/u.test(row.checksumSha256) ||
    row.safeDisplayName.length < 1 || row.safeDisplayName.length > 512 ||
    row.detectedMediaType.length < 1 || row.detectedMediaType.length > 191 ||
    row.size <= 0n || row.eligibilityEpoch <= 0n
  ) throw new Error("ASSET_OWNER_ATTACHMENT_CORRUPT");
  return Object.freeze({
    assetRef: row.assetRef,
    assetVersionRef: row.assetVersionRef,
    assetGrantRef: row.assetGrantRef,
    projectRef: row.projectRef,
    purpose: row.purpose,
    subjectGeneration: row.subjectGeneration,
    eligibilityEpoch: row.eligibilityEpoch,
    checksumSha256: row.checksumSha256,
    safeDisplayName: row.safeDisplayName,
    detectedMediaType: row.detectedMediaType,
    size: row.size,
  });
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function instant(value: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error("ASSET_OWNER_TIMESTAMP_INVALID");
  return date.toISOString();
}
