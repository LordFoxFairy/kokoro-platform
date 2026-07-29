import { assertDigest } from "../../../../shared/outbox-inbox/receipt.js";
import { resolvePlatformTransaction, type PlatformSqlTransaction } from "../../../../shared/unit-of-work/platform-transaction.js";
import type { AssetUploadRepositoryPort, ClaimUploadIntentResult } from "../../application/contracts/asset-upload-ports.js";
import type { AssetUploadCompletionRepositoryPort } from "../../application/contracts/asset-upload-completion-ports.js";
import {
  verifyUploadIntent,
  verifyUploadSession,
  type AssetUploadIntent,
  type AssetUploadSession,
} from "../../domain/upload-intent.js";

export class PostgresAssetUploadRepository implements AssetUploadRepositoryPort, AssetUploadCompletionRepositoryPort {
  async claimUploadIntent(
    transaction: Parameters<AssetUploadRepositoryPort["claimUploadIntent"]>[0],
    input: Parameters<AssetUploadRepositoryPort["claimUploadIntent"]>[1],
  ): Promise<ClaimUploadIntentResult> {
    assertDigest(input.requestDigest);
    if (input.maximumInflightBytes < input.intent.expectedSize) throw new Error("ASSET_QUOTA_POLICY_INVALID");
    const sql = resolvePlatformTransaction(transaction);
    await lockCurrentAuthority(sql, input.intent, "asset.create-upload-intent");
    const inserted = await sql.query<{ intentRef: string }>(
      `INSERT INTO platform.asset_upload_intent
       (intent_ref,site_ref,workload_identity_id,site_release_ref,binding_epoch,subject_ref,
        subject_generation,project_ref,purpose,safe_display_name,client_media_type,expected_size,
        expected_checksum_sha256,policy_revision_ref,idempotency_key,request_digest,state,
        expected_version,expires_at)
       VALUES ($1,$2,$3,$4,$5::bigint,$6,$7::bigint,$8,$9,$10,$11,$12::bigint,$13,$14,
         $15,$16,'admitted',$17::bigint,$18::timestamptz)
       ON CONFLICT (site_ref,subject_ref,subject_generation,idempotency_key) DO NOTHING
       RETURNING intent_ref AS "intentRef"`,
      [input.intent.intentRef, input.intent.siteRef, input.intent.workloadIdentityId,
        input.intent.siteReleaseRef, input.intent.bindingEpoch, input.intent.subjectRef,
        input.intent.subjectGeneration, input.intent.projectRef, input.intent.purpose,
        input.intent.safeDisplayName, input.intent.clientMediaType, input.intent.expectedSize,
        input.intent.expectedChecksumSha256, input.intent.policyRevisionRef, input.idempotencyKey,
        input.requestDigest, input.intent.expectedVersion, input.intent.expiresAt],
    );
    if (inserted.length === 0) {
      const existing = await loadByIdempotency(
        sql,
        input.intent.siteRef,
        input.intent.subjectRef,
        input.intent.subjectGeneration,
        input.idempotencyKey,
      );
      if (existing === null || existing.requestDigest !== input.requestDigest) return Object.freeze({ disposition: "conflict" });
      return Object.freeze({ disposition: "replay", intent: existing.intent, session: existing.session });
    }

    await sql.execute(
      `INSERT INTO platform.asset_quota_account
       (site_ref,subject_ref,purpose,quota_revision_ref,maximum_inflight_bytes,reserved_inflight_bytes)
       VALUES ($1,$2,$3,$4,$5::bigint,0)
       ON CONFLICT (site_ref,subject_ref,purpose) DO NOTHING`,
      [input.intent.siteRef, input.intent.subjectRef, input.intent.purpose,
        input.session.quotaRevisionRef, input.maximumInflightBytes],
    );
    const accounts = await sql.query<QuotaAccountRow>(
      `SELECT quota_revision_ref AS "quotaRevisionRef",
              maximum_inflight_bytes AS "maximumInflightBytes",
              reserved_inflight_bytes AS "reservedInflightBytes"
       FROM platform.asset_quota_account
       WHERE site_ref=$1 AND subject_ref=$2 AND purpose=$3
       FOR UPDATE`,
      [input.intent.siteRef, input.intent.subjectRef, input.intent.purpose],
    );
    const account = accounts[0];
    if (!account) throw new Error("ASSET_QUOTA_ACCOUNT_NOT_FOUND");
    if (account.quotaRevisionRef !== input.session.quotaRevisionRef || account.maximumInflightBytes !== input.maximumInflightBytes) {
      if (account.reservedInflightBytes > input.maximumInflightBytes) throw new Error("ASSET_UPLOAD_QUOTA_EXCEEDED");
      await sql.execute(
        `UPDATE platform.asset_quota_account
         SET quota_revision_ref=$4,maximum_inflight_bytes=$5::bigint,
             expected_version=expected_version+1,updated_at=now()
         WHERE site_ref=$1 AND subject_ref=$2 AND purpose=$3`,
        [input.intent.siteRef, input.intent.subjectRef, input.intent.purpose,
          input.session.quotaRevisionRef, input.maximumInflightBytes],
      );
    }
    if (account.reservedInflightBytes + input.intent.expectedSize > input.maximumInflightBytes) {
      throw new Error("ASSET_UPLOAD_QUOTA_EXCEEDED");
    }
    await sql.execute(
      `UPDATE platform.asset_quota_account
       SET reserved_inflight_bytes=reserved_inflight_bytes+$4::bigint,
           expected_version=expected_version+1,updated_at=now()
       WHERE site_ref=$1 AND subject_ref=$2 AND purpose=$3`,
      [input.intent.siteRef, input.intent.subjectRef, input.intent.purpose, input.intent.expectedSize],
    );
    await insertSession(sql, input.session);
    await sql.execute(
      `INSERT INTO platform.asset_quota_reservation
       (reservation_ref,site_ref,subject_ref,purpose,intent_ref,session_ref,quota_revision_ref,
        reserved_bytes,state,expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8::bigint,'reserved',$9::timestamptz)`,
      [input.session.sessionRef, input.intent.siteRef, input.intent.subjectRef, input.intent.purpose,
        input.intent.intentRef, input.session.sessionRef, input.session.quotaRevisionRef,
        input.intent.expectedSize, input.session.expiresAt],
    );
    return Object.freeze({ disposition: "created", intent: input.intent, session: input.session });
  }

  async markCapabilityIssued(
    transaction: Parameters<AssetUploadRepositoryPort["markCapabilityIssued"]>[0],
    input: Parameters<AssetUploadRepositoryPort["markCapabilityIssued"]>[1],
  ): Promise<AssetUploadSession> {
    const sql = resolvePlatformTransaction(transaction);
    const pair = await loadByIntent(sql, input.siteRef, input.intentRef);
    if (pair === null) throw new Error("ASSET_UPLOAD_INTENT_NOT_FOUND");
    await lockCurrentAuthority(sql, pair.intent, "asset.create-upload-intent");
    const rows = await sql.query<SessionRow>(
      `UPDATE platform.asset_upload_session AS session
       SET capability_epoch=$4::bigint,capability_expires_at=$5::timestamptz,
           state='uploading',expected_version=expected_version+1,updated_at=now()
       WHERE site_ref=$1 AND intent_ref=$2 AND expected_version=$3::bigint
         AND capability_epoch=$4::bigint-1 AND state IN ('awaiting_capability','uploading')
         AND now() < $5::timestamptz AND $5::timestamptz <= expires_at
       RETURNING ${SESSION_COLUMNS}`,
      [input.siteRef, input.intentRef, input.expectedVersion, input.capabilityEpoch, input.expiresAt],
    );
    const session = rows[0];
    if (!session) throw new Error("ASSET_UPLOAD_CAPABILITY_CONFLICT");
    return hydrateSession(session);
  }

  async beginCompletion(
    transaction: Parameters<AssetUploadCompletionRepositoryPort["beginCompletion"]>[0],
    input: Parameters<AssetUploadCompletionRepositoryPort["beginCompletion"]>[1],
  ): Promise<AssetUploadSession> {
    const sql = resolvePlatformTransaction(transaction);
    const pair = await loadByIntent(sql, input.authority.siteRef, input.intentRef);
    if (pair === null || pair.session.sessionRef !== input.sessionRef) {
      throw new Error("ASSET_UPLOAD_SESSION_NOT_FOUND");
    }
    assertAuthority(pair.intent, input.authority);
    await lockCurrentAuthority(sql, pair.intent, "asset.complete-upload");
    const rows = await sql.query<SessionRow>(
      `UPDATE platform.asset_upload_session AS session
       SET state='completing',completion_requested_at=now(),
           expected_version=expected_version+1,updated_at=now()
       WHERE site_ref=$1 AND intent_ref=$2 AND session_ref=$3
         AND expected_version=$4::bigint AND state='uploading' AND now()<expires_at
       RETURNING ${SESSION_COLUMNS}`,
      [input.authority.siteRef, input.intentRef, input.sessionRef, input.expectedVersion],
    );
    const session = rows[0];
    if (!session) throw new Error("ASSET_UPLOAD_COMPLETION_CONFLICT");
    return hydrateSession(session);
  }
}

async function lockCurrentAuthority(
  sql: PlatformSqlTransaction,
  intent: AssetUploadIntent,
  operation: "asset.create-upload-intent" | "asset.complete-upload",
): Promise<void> {
  const rows = await sql.query<{ allowed: boolean }>(
    `SELECT TRUE AS allowed
     FROM platform.authorization_product_binding binding
     JOIN platform.authorization_subject subject
       ON subject.subject_ref=$5 AND subject.site_ref=binding.site_ref
     JOIN platform.authorization_project project
       ON project.project_ref=$7 AND project.site_ref=binding.site_ref
     JOIN platform.authorization_project_membership membership
       ON membership.project_ref=project.project_ref AND membership.subject_ref=subject.subject_ref
     WHERE binding.workload_identity_id=$1 AND binding.site_ref=$2 AND binding.release_ref=$3
       AND binding.binding_epoch=$4::bigint AND binding.state='active'
       AND subject.subject_generation=$6::bigint AND subject.state='active'
       AND project.state='active' AND membership.state='active'
       AND current_setting('app.operation',true)=$8
       AND current_setting('app.site_id',true)=binding.site_ref
       AND current_setting('app.subject_id',true)=subject.subject_ref
       AND current_setting('app.subject_generation',true)=subject.subject_generation::text
       AND current_setting('app.project_id',true)=project.project_ref
     FOR UPDATE OF binding,subject,project,membership`,
    [intent.workloadIdentityId, intent.siteRef, intent.siteReleaseRef, intent.bindingEpoch,
      intent.subjectRef, intent.subjectGeneration, intent.projectRef, operation],
  );
  if (!rows[0]?.allowed) throw new Error("ASSET_UPLOAD_AUTHORITY_STALE");
}

function assertAuthority(
  intent: AssetUploadIntent,
  authority: Parameters<AssetUploadCompletionRepositoryPort["beginCompletion"]>[1]["authority"],
): void {
  if (
    intent.siteRef !== authority.siteRef || intent.workloadIdentityId !== authority.workloadIdentityId ||
    intent.siteReleaseRef !== authority.siteReleaseRef || intent.bindingEpoch !== authority.bindingEpoch ||
    intent.subjectRef !== authority.subjectRef || intent.subjectGeneration !== authority.subjectGeneration ||
    intent.projectRef !== authority.projectRef
  ) throw new Error("ASSET_UPLOAD_AUTHORITY_STALE");
}

async function insertSession(sql: PlatformSqlTransaction, value: AssetUploadSession): Promise<void> {
  await sql.execute(
    `INSERT INTO platform.asset_upload_session
     (session_ref,intent_ref,site_ref,subject_ref,subject_generation,project_ref,purpose,
      quota_revision_ref,storage_tenant_ref,storage_region,quarantine_object_ref,protocol_revision,
      capability_audience,minimum_part_bytes,maximum_part_bytes,capability_lifetime_seconds,
      capability_epoch,capability_expires_at,completion_requested_at,state,expected_version,expires_at)
     VALUES ($1,$2,$3,$4,$5::bigint,$6,$7,$8,$9,$10,$11,$12,$13,$14::bigint,$15::bigint,
       $16,$17::bigint,$18::timestamptz,$19::timestamptz,$20,$21::bigint,$22::timestamptz)`,
    [value.sessionRef, value.intentRef, value.siteRef, value.subjectRef, value.subjectGeneration,
      value.projectRef, value.purpose, value.quotaRevisionRef, value.storageTenantRef,
      value.storageRegion, value.quarantineObjectRef, value.protocolRevision, value.capabilityAudience,
      value.minimumPartBytes, value.maximumPartBytes, value.capabilityLifetimeSeconds,
      value.capabilityEpoch, value.capabilityExpiresAt, value.completionRequestedAt,
      value.state, value.expectedVersion, value.expiresAt],
  );
}

async function loadByIdempotency(
  sql: PlatformSqlTransaction,
  siteRef: string,
  subjectRef: string,
  subjectGeneration: bigint,
  idempotencyKey: string,
): Promise<UploadPair | null> {
  const rows = await sql.query<IntentRow & SessionRow & { requestDigest: string }>(
    `SELECT ${INTENT_COLUMNS},${SESSION_COLUMNS},intent.request_digest AS "requestDigest"
     FROM platform.asset_upload_intent intent
     JOIN platform.asset_upload_session session ON session.intent_ref=intent.intent_ref
     WHERE intent.site_ref=$1 AND intent.subject_ref=$2
       AND intent.subject_generation=$3::bigint AND intent.idempotency_key=$4
     FOR UPDATE OF intent,session`,
    [siteRef, subjectRef, subjectGeneration, idempotencyKey],
  );
  return rows[0] ? hydratePair(rows[0]) : null;
}

async function loadByIntent(sql: PlatformSqlTransaction, siteRef: string, intentRef: string): Promise<UploadPair | null> {
  const rows = await sql.query<IntentRow & SessionRow & { requestDigest: string }>(
    `SELECT ${INTENT_COLUMNS},${SESSION_COLUMNS},intent.request_digest AS "requestDigest"
     FROM platform.asset_upload_intent intent
     JOIN platform.asset_upload_session session ON session.intent_ref=intent.intent_ref
     WHERE intent.site_ref=$1 AND intent.intent_ref=$2
     FOR UPDATE OF intent,session`,
    [siteRef, intentRef],
  );
  return rows[0] ? hydratePair(rows[0]) : null;
}

const INTENT_COLUMNS = `
  intent.intent_ref AS "assetIntentRef",intent.site_ref AS "assetSiteRef",
  intent.workload_identity_id AS "workloadIdentityId",intent.site_release_ref AS "siteReleaseRef",
  intent.binding_epoch AS "bindingEpoch",intent.subject_ref AS "assetSubjectRef",
  intent.subject_generation AS "assetSubjectGeneration",intent.project_ref AS "assetProjectRef",
  intent.purpose AS "assetPurpose",intent.safe_display_name AS "safeDisplayName",
  intent.client_media_type AS "clientMediaType",intent.expected_size AS "expectedSize",
  intent.expected_checksum_sha256 AS "expectedChecksumSha256",
  intent.policy_revision_ref AS "policyRevisionRef",intent.state AS "intentState",
  intent.expected_version AS "intentExpectedVersion",intent.expires_at AS "intentExpiresAt"`;

const SESSION_COLUMNS = `
  session.session_ref AS "sessionRef",session.intent_ref AS "sessionIntentRef",
  session.site_ref AS "sessionSiteRef",session.subject_ref AS "sessionSubjectRef",
  session.subject_generation AS "sessionSubjectGeneration",session.project_ref AS "sessionProjectRef",
  session.purpose AS "sessionPurpose",session.quota_revision_ref AS "quotaRevisionRef",
  session.storage_tenant_ref AS "storageTenantRef",session.storage_region AS "storageRegion",
  session.quarantine_object_ref AS "quarantineObjectRef",session.protocol_revision AS "protocolRevision",
  session.capability_audience AS "capabilityAudience",session.minimum_part_bytes AS "minimumPartBytes",
  session.maximum_part_bytes AS "maximumPartBytes",
  session.capability_lifetime_seconds AS "capabilityLifetimeSeconds",
  session.capability_epoch AS "capabilityEpoch",session.capability_expires_at AS "capabilityExpiresAt",
  session.completion_requested_at AS "completionRequestedAt",
  session.state AS "sessionState",session.expected_version AS "sessionExpectedVersion",
  session.expires_at AS "sessionExpiresAt"`;

type IntentRow = Readonly<{
  assetIntentRef: string; assetSiteRef: string; workloadIdentityId: string; siteReleaseRef: string;
  bindingEpoch: bigint; assetSubjectRef: string; assetSubjectGeneration: bigint; assetProjectRef: string;
  assetPurpose: string; safeDisplayName: string; clientMediaType: string; expectedSize: bigint;
  expectedChecksumSha256: string; policyRevisionRef: string; intentState: AssetUploadIntent["state"];
  intentExpectedVersion: bigint; intentExpiresAt: Date | string;
}>;
type SessionRow = Readonly<{
  sessionRef: string; sessionIntentRef: string; sessionSiteRef: string; sessionSubjectRef: string;
  sessionSubjectGeneration: bigint; sessionProjectRef: string; sessionPurpose: string;
  quotaRevisionRef: string; storageTenantRef: string; storageRegion: string; quarantineObjectRef: string;
  protocolRevision: AssetUploadSession["protocolRevision"]; capabilityAudience: string;
  minimumPartBytes: bigint; maximumPartBytes: bigint; capabilityLifetimeSeconds: number;
  capabilityEpoch: bigint; capabilityExpiresAt: Date | string | null;
  completionRequestedAt: Date | string | null;
  sessionState: AssetUploadSession["state"]; sessionExpectedVersion: bigint; sessionExpiresAt: Date | string;
}>;
type QuotaAccountRow = Readonly<{
  quotaRevisionRef: string; maximumInflightBytes: bigint; reservedInflightBytes: bigint;
}>;
type UploadPair = Readonly<{ intent: AssetUploadIntent; session: AssetUploadSession; requestDigest: string }>;

function hydratePair(row: IntentRow & SessionRow & { requestDigest: string }): UploadPair {
  return Object.freeze({ intent: hydrateIntent(row), session: hydrateSession(row), requestDigest: row.requestDigest });
}

function hydrateIntent(row: IntentRow): AssetUploadIntent {
  return verifyUploadIntent({
    intentRef: row.assetIntentRef, siteRef: row.assetSiteRef, workloadIdentityId: row.workloadIdentityId,
    siteReleaseRef: row.siteReleaseRef, bindingEpoch: row.bindingEpoch, subjectRef: row.assetSubjectRef,
    subjectGeneration: row.assetSubjectGeneration, projectRef: row.assetProjectRef, purpose: row.assetPurpose,
    safeDisplayName: row.safeDisplayName, clientMediaType: row.clientMediaType, expectedSize: row.expectedSize,
    expectedChecksumSha256: row.expectedChecksumSha256, policyRevisionRef: row.policyRevisionRef,
    state: row.intentState, expectedVersion: row.intentExpectedVersion, expiresAt: instant(row.intentExpiresAt),
  });
}

function hydrateSession(row: SessionRow): AssetUploadSession {
  return verifyUploadSession({
    sessionRef: row.sessionRef, intentRef: row.sessionIntentRef, siteRef: row.sessionSiteRef,
    subjectRef: row.sessionSubjectRef, subjectGeneration: row.sessionSubjectGeneration,
    projectRef: row.sessionProjectRef, purpose: row.sessionPurpose, quotaRevisionRef: row.quotaRevisionRef,
    storageTenantRef: row.storageTenantRef, storageRegion: row.storageRegion,
    quarantineObjectRef: row.quarantineObjectRef, protocolRevision: row.protocolRevision,
    capabilityAudience: row.capabilityAudience, minimumPartBytes: row.minimumPartBytes,
    maximumPartBytes: row.maximumPartBytes, capabilityLifetimeSeconds: row.capabilityLifetimeSeconds,
    capabilityEpoch: row.capabilityEpoch,
    capabilityExpiresAt: row.capabilityExpiresAt === null ? null : instant(row.capabilityExpiresAt),
    completionRequestedAt: row.completionRequestedAt === null ? null : instant(row.completionRequestedAt),
    state: row.sessionState, expectedVersion: row.sessionExpectedVersion, expiresAt: instant(row.sessionExpiresAt),
  });
}

function instant(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}
