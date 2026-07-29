import { assertDigest } from "../../../../shared/outbox-inbox/receipt.js";
import { resolvePlatformTransaction, type PlatformSqlTransaction } from
  "../../../../shared/unit-of-work/platform-transaction.js";
import type {
  AssetCleanupGroupPlan,
  AssetObjectCleanup,
  AssetObjectCleanupRepositoryPort,
} from "../../application/contracts/asset-cleanup-worker-ports.js";

export class PostgresAssetObjectCleanupRepository implements AssetObjectCleanupRepositoryPort {
  async claimCleanupWork(
    transaction: Parameters<AssetObjectCleanupRepositoryPort["claimCleanupWork"]>[0],
    input: Parameters<AssetObjectCleanupRepositoryPort["claimCleanupWork"]>[1],
  ): ReturnType<AssetObjectCleanupRepositoryPort["claimCleanupWork"]> {
    const sql = resolvePlatformTransaction(transaction);
    const rows = await sql.query<CleanupRow>(
      `SELECT ${CLEANUP_COLUMNS}
       FROM platform.asset_object_cleanup
       WHERE site_ref=$1 AND cleanup_ref=$2 AND cleanup_event_id=$3::uuid
       FOR UPDATE`,
      [input.siteRef, input.cleanupRef, input.eventId],
    );
    const row = rows[0];
    if (!row) return Object.freeze({ disposition: "superseded" });
    if (row.state === "completed") return Object.freeze({ disposition: "terminal" });
    if (row.state === "deleting") {
      return Object.freeze({ disposition: "work", cleanup: hydrateCleanup(row) });
    }
    if (row.state === "pending_delete" && row.expectedVersion !== input.expectedVersion) {
      return Object.freeze({ disposition: "superseded" });
    }
    if (row.state !== "pending_delete" && row.state !== "delete_unavailable") {
      return Object.freeze({ disposition: "superseded" });
    }
    const claimed = await sql.query<CleanupRow>(
      `UPDATE platform.asset_object_cleanup
       SET state='deleting',expected_version=expected_version+1,last_error_code=NULL,
           updated_at=now()
       WHERE site_ref=$1 AND cleanup_ref=$2 AND expected_version=$3::bigint
         AND state IN ('pending_delete','delete_unavailable')
       RETURNING ${CLEANUP_COLUMNS}`,
      [input.siteRef, input.cleanupRef, row.expectedVersion],
    );
    return claimed[0]
      ? Object.freeze({ disposition: "work", cleanup: hydrateCleanup(claimed[0]) })
      : Object.freeze({ disposition: "superseded" });
  }

  async markCleanupRetry(
    transaction: Parameters<AssetObjectCleanupRepositoryPort["markCleanupRetry"]>[0],
    input: Parameters<AssetObjectCleanupRepositoryPort["markCleanupRetry"]>[1],
  ): ReturnType<AssetObjectCleanupRepositoryPort["markCleanupRetry"]> {
    const changed = await resolvePlatformTransaction(transaction).execute(
      `UPDATE platform.asset_object_cleanup
       SET state='delete_unavailable',expected_version=expected_version+1,
           last_error_code=$4,updated_at=now()
       WHERE site_ref=$1 AND cleanup_ref=$2 AND expected_version=$3::bigint AND state='deleting'`,
      [input.siteRef, input.cleanupRef, input.expectedVersion, input.reasonCode],
    );
    return changed === 1 ? "committed" : "superseded";
  }

  async completeCleanup(
    transaction: Parameters<AssetObjectCleanupRepositoryPort["completeCleanup"]>[0],
    input: Parameters<AssetObjectCleanupRepositoryPort["completeCleanup"]>[1],
  ): ReturnType<AssetObjectCleanupRepositoryPort["completeCleanup"]> {
    const sql = resolvePlatformTransaction(transaction);
    const groupRows = await sql.query<{
      subjectRef: string;
      purpose: string;
      terminalReservationState: "released" | "promoted";
      state: string;
    }>(
      `SELECT cleanup.subject_ref AS "subjectRef",cleanup.purpose,
              cleanup.terminal_reservation_state AS "terminalReservationState",cleanup.state
       FROM platform.asset_cleanup_group cleanup
       WHERE cleanup.site_ref=$1 AND cleanup.cleanup_group_ref=$2
       FOR UPDATE`,
      [input.cleanup.siteRef, input.cleanup.cleanupGroupRef],
    );
    const group = groupRows[0];
    if (!group) throw new Error("ASSET_CLEANUP_GROUP_NOT_FOUND");
    if (group.state === "completed") return "superseded";
    const completed = await sql.execute(
      `UPDATE platform.asset_object_cleanup
       SET state='completed',expected_version=expected_version+1,last_error_code=NULL,
           completed_at=$4::timestamptz,updated_at=$4::timestamptz
       WHERE site_ref=$1 AND cleanup_ref=$2 AND expected_version=$3::bigint AND state='deleting'`,
      [input.cleanup.siteRef, input.cleanup.cleanupRef, input.expectedCleanupVersion,
        input.deletion.observedAt],
    );
    if (completed !== 1) return "superseded";
    await exactlyOne(sql, `INSERT INTO platform.asset_object_cleanup_receipt
      (receipt_ref,site_ref,cleanup_group_ref,cleanup_ref,storage_tenant_ref,storage_region,
       object_ref,provider_version_ref,retained_bytes,provider_disposition,confirmed_absent_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::bigint,$10,$11::timestamptz)`,
    [input.receiptRef, input.cleanup.siteRef, input.cleanup.cleanupGroupRef,
      input.cleanup.cleanupRef, input.cleanup.storageTenantRef, input.cleanup.storageRegion,
      input.cleanup.objectRef, input.cleanup.providerVersionRef, input.cleanup.retainedBytes,
      input.deletion.providerDisposition, input.deletion.observedAt],
    "ASSET_CLEANUP_RECEIPT_NOT_PERSISTED");
    await exactlyOne(sql, `UPDATE platform.asset_quota_account
      SET trash_retained_bytes=trash_retained_bytes-$4::bigint,
          expected_version=expected_version+1,updated_at=$5::timestamptz
      WHERE site_ref=$1 AND subject_ref=$2 AND purpose=$3
        AND trash_retained_bytes >= $4::bigint`,
    [input.cleanup.siteRef, group.subjectRef, group.purpose, input.cleanup.retainedBytes,
      input.deletion.observedAt], "ASSET_TRASH_QUOTA_RELEASE_CONFLICT");
    const updatedGroups = await sql.query<{ state: "cleaning" | "completed" }>(
      `UPDATE platform.asset_cleanup_group
       SET released_bytes=released_bytes+$3::bigint,
           state=CASE WHEN released_bytes+$3::bigint=retained_bytes THEN 'completed' ELSE 'cleaning' END,
           expected_version=expected_version+1,
           completed_at=CASE WHEN released_bytes+$3::bigint=retained_bytes
             THEN $4::timestamptz ELSE NULL END,
           updated_at=$4::timestamptz
       WHERE site_ref=$1 AND cleanup_group_ref=$2 AND state IN ('pending','cleaning')
         AND released_bytes+$3::bigint <= retained_bytes
       RETURNING state`,
      [input.cleanup.siteRef, input.cleanup.cleanupGroupRef, input.cleanup.retainedBytes,
        input.deletion.observedAt],
    );
    const groupState = updatedGroups[0]?.state;
    if (!groupState) throw new Error("ASSET_CLEANUP_GROUP_RELEASE_CONFLICT");
    if (groupState === "completed") {
      await exactlyOne(sql, `UPDATE platform.asset_quota_reservation
        SET state=$4,release_evidence_ref=$5,updated_at=$6::timestamptz
        WHERE site_ref=$1 AND intent_ref=$2 AND session_ref=$3 AND state='trash_retained'`,
      [input.cleanup.siteRef, input.cleanup.intentRef, input.cleanup.sessionRef,
        group.terminalReservationState, input.cleanup.cleanupGroupRef,
        input.deletion.observedAt], "ASSET_CLEANUP_RESERVATION_RELEASE_CONFLICT");
    }
    return "committed";
  }
}

export async function persistAssetCleanupPlan(
  sql: PlatformSqlTransaction,
  owner: Readonly<{
    siteRef: string;
    subjectRef: string;
    purpose: string;
    intentRef: string;
    sessionRef: string;
    sourceKind: "upload_completion_rejection" | "scan_rejection" |
      "promotion_rejection" | "promotion_success";
    sourceRef: string;
    reasonCode: string;
  }>,
  plan: AssetCleanupGroupPlan,
): Promise<void> {
  if (plan.targets.length < 1 || plan.targets.length > 2) {
    throw new Error("ASSET_CLEANUP_TARGET_COUNT_INVALID");
  }
  const retainedBytes = plan.targets.reduce((total, target) => total + target.retainedBytes, 0n);
  if (retainedBytes < 1n || new Set(plan.targets.map((target) => target.cleanupRef)).size !== plan.targets.length) {
    throw new Error("ASSET_CLEANUP_PLAN_INVALID");
  }
  await exactlyOne(sql, `INSERT INTO platform.asset_cleanup_group
    (cleanup_group_ref,site_ref,subject_ref,purpose,intent_ref,session_ref,source_kind,
     source_ref,reason_code,terminal_reservation_state,retained_bytes,released_bytes,state,
     expected_version)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::bigint,0,'pending',1)`,
  [plan.cleanupGroupRef, owner.siteRef, owner.subjectRef, owner.purpose, owner.intentRef,
    owner.sessionRef, owner.sourceKind, owner.sourceRef, owner.reasonCode,
    plan.terminalReservationState, retainedBytes], "ASSET_CLEANUP_GROUP_NOT_PERSISTED");
  for (const target of plan.targets) {
    assertDigest(target.cleanupEvent.payloadDigest);
    await exactlyOne(sql, `INSERT INTO platform.outbox_event
      (event_id,owner,event_type,aggregate_id,payload,payload_digest,correlation_id,causation_id)
      VALUES ($1::uuid,$2,$3,$4,$5::jsonb,$6,$7,$8)`,
    [target.cleanupEvent.eventId, target.cleanupEvent.owner, target.cleanupEvent.eventType,
      target.cleanupEvent.aggregateId, JSON.stringify(target.cleanupEvent.payload),
      target.cleanupEvent.payloadDigest, target.cleanupEvent.correlationId,
      target.cleanupEvent.causationId], "ASSET_OUTBOX_EVENT_NOT_PERSISTED");
    await exactlyOne(sql, `INSERT INTO platform.asset_object_cleanup
      (cleanup_ref,cleanup_group_ref,site_ref,intent_ref,session_ref,storage_tenant_ref,
       storage_region,object_role,object_ref,provider_version_ref,retained_bytes,state,
       expected_version,cleanup_event_id)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::bigint,'pending_delete',1,$12::uuid)`,
    [target.cleanupRef, plan.cleanupGroupRef, owner.siteRef, owner.intentRef, owner.sessionRef,
      target.storageTenantRef, target.storageRegion, target.objectRole, target.objectRef,
      target.providerVersionRef, target.retainedBytes, target.cleanupEvent.eventId],
    "ASSET_OBJECT_CLEANUP_NOT_PERSISTED");
  }
}

async function exactlyOne(
  sql: PlatformSqlTransaction,
  statement: string,
  values: readonly unknown[],
  code: string,
): Promise<void> {
  if (await sql.execute(statement, values) !== 1) throw new Error(code);
}

const CLEANUP_COLUMNS = `
  cleanup_ref AS "cleanupRef",cleanup_group_ref AS "cleanupGroupRef",site_ref AS "siteRef",
  intent_ref AS "intentRef",session_ref AS "sessionRef",
  storage_tenant_ref AS "storageTenantRef",storage_region AS "storageRegion",
  object_role AS "objectRole",object_ref AS "objectRef",provider_version_ref AS "providerVersionRef",
  retained_bytes AS "retainedBytes",state,expected_version AS "expectedVersion"`;

type CleanupRow = AssetObjectCleanup & Record<string, unknown>;

function hydrateCleanup(row: CleanupRow): AssetObjectCleanup {
  if (row.retainedBytes < 1n || row.expectedVersion < 1n ||
      !new Set(["pending_delete", "deleting", "delete_unavailable", "completed"]).has(row.state) ||
      !new Set(["quarantine", "trusted_copy"]).has(row.objectRole)) {
    throw new Error("ASSET_OBJECT_CLEANUP_INVALID");
  }
  return Object.freeze({
    cleanupRef: row.cleanupRef,
    cleanupGroupRef: row.cleanupGroupRef,
    siteRef: row.siteRef,
    intentRef: row.intentRef,
    sessionRef: row.sessionRef,
    storageTenantRef: row.storageTenantRef,
    storageRegion: row.storageRegion,
    objectRole: row.objectRole,
    objectRef: row.objectRef,
    providerVersionRef: row.providerVersionRef,
    retainedBytes: row.retainedBytes,
    state: row.state,
    expectedVersion: row.expectedVersion,
  });
}
