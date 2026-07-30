import { resolvePlatformTransaction } from "../../../../shared/unit-of-work/platform-transaction.js";
import type {
  AssetMultipartRepositoryPort,
  AuthorizedAssetMultipartSnapshot,
  StoredAssetMultipartPart,
  StoredAssetMultipartUpload,
} from "../../application/contracts/asset-multipart-ports.js";
import type { AssetUploadCapabilityClaims } from
  "../../application/contracts/asset-upload-ports.js";
import { digestAssetCommand } from "../../application/asset-digest.js";

export class PostgresAssetMultipartRepository implements AssetMultipartRepositoryPort {
  async readAuthorized(
    transaction: Parameters<AssetMultipartRepositoryPort["readAuthorized"]>[0],
    claims: AssetUploadCapabilityClaims,
    uploadRef?: string,
  ): Promise<AuthorizedAssetMultipartSnapshot | null> {
    const sql = resolvePlatformTransaction(transaction);
    const rows = await sql.query<AuthorityRow>(
      `SELECT intent.site_ref AS "authoritySiteRef",intent.intent_ref AS "authorityIntentRef",
              session.session_ref AS "authoritySessionRef"
       FROM platform.asset_upload_intent intent
       JOIN platform.asset_upload_session session
         ON session.site_ref=intent.site_ref AND session.intent_ref=intent.intent_ref
       JOIN platform.authorization_product_binding binding
         ON binding.workload_identity_id=intent.workload_identity_id
        AND binding.site_ref=intent.site_ref AND binding.release_ref=intent.site_release_ref
       JOIN platform.authorization_subject subject
         ON subject.subject_ref=intent.subject_ref AND subject.site_ref=intent.site_ref
       JOIN platform.authorization_project project
         ON project.project_ref=intent.project_ref AND project.site_ref=intent.site_ref
       JOIN platform.authorization_project_membership membership
         ON membership.project_ref=project.project_ref AND membership.subject_ref=subject.subject_ref
       WHERE intent.site_ref=$1 AND intent.workload_identity_id=$2
         AND intent.site_release_ref=$3 AND intent.binding_epoch=$4::bigint
         AND intent.subject_ref=$5 AND intent.subject_generation=$6::bigint
         AND intent.project_ref=$7 AND intent.purpose=$8 AND intent.intent_ref=$9
         AND intent.expected_size=$10::bigint AND intent.expected_checksum_sha256=$11
         AND session.session_ref=$12 AND session.storage_tenant_ref=$13
         AND session.storage_region=$14 AND session.quarantine_object_ref=$15
         AND session.capability_audience=$16 AND session.capability_epoch=$17::bigint
         AND session.minimum_part_bytes=$18::bigint AND session.maximum_part_bytes=$19::bigint
         AND session.capability_expires_at=$20::timestamptz
         AND (current_setting('app.operation',true)='asset.multipart.status'
           OR (intent.state='admitted' AND session.state='uploading'))
         AND binding.binding_epoch=$4::bigint AND binding.state='active'
         AND subject.subject_generation=$6::bigint AND subject.state='active'
         AND project.state='active' AND membership.state='active'
         AND now()<$20::timestamptz AND now()<intent.expires_at AND now()<session.expires_at
         AND current_setting('app.site_id',true)=$1
         AND current_setting('app.subject_id',true)=$5
         AND current_setting('app.subject_generation',true)=$6
         AND current_setting('app.project_id',true)=$7
         AND current_setting('app.purpose',true)=$8
       FOR UPDATE OF intent,session,binding,subject,project,membership`,
      [claims.siteRef, claims.workloadIdentityId, claims.siteReleaseRef, claims.bindingEpoch,
        claims.subjectRef, claims.subjectGeneration, claims.projectRef, claims.purpose,
        claims.intentRef, claims.expectedSize, claims.expectedChecksumSha256, claims.sessionRef,
        claims.storageTenantRef, claims.storageRegion, claims.quarantineObjectRef, claims.audience,
        claims.capabilityEpoch, claims.minimumPartBytes, claims.maximumPartBytes, claims.expiresAt],
    );
    const row = rows[0];
    if (row === undefined) return null;
    const uploadRows = await sql.query<UploadRow>(
      `SELECT ${UPLOAD_COLUMNS}
       FROM platform.asset_multipart_upload upload
       WHERE upload.site_ref=$1 AND upload.session_ref=$2
         AND ($3::text IS NULL OR upload.upload_ref=$3)
       FOR UPDATE OF upload`,
      [claims.siteRef, claims.sessionRef, uploadRef ?? null],
    );
    const upload = uploadRows[0] === undefined ? null : hydrateUpload(uploadRows[0]);
    const parts = upload === null ? [] : await sql.query<PartRow>(
      `SELECT part_number AS "partNumber",part_receipt AS "partReceipt",
              provider_etag AS "providerEtag",size,checksum_sha256 AS "checksumSha256",
              idempotency_key AS "idempotencyKey",request_digest AS "requestDigest",
              state,expected_version AS "expectedVersion",effect_token AS "effectToken",
              effect_lease_expires_at AS "effectLeaseExpiresAt"
       FROM platform.asset_multipart_part
       WHERE site_ref=$1 AND upload_ref=$2 ORDER BY part_number`,
      [claims.siteRef, upload.uploadRef],
    );
    return Object.freeze({
      claims,
      upload,
      parts: Object.freeze(parts.map(hydratePart)),
    });
  }

  async claimInitiation(
    transaction: Parameters<AssetMultipartRepositoryPort["claimInitiation"]>[0],
    input: Parameters<AssetMultipartRepositoryPort["claimInitiation"]>[1],
  ): Promise<AuthorizedAssetMultipartSnapshot> {
    const before = await this.required(transaction, input.claims);
    const sql = resolvePlatformTransaction(transaction);
    if (before.upload !== null) {
      if (before.upload.clientUploadId !== input.clientUploadId ||
          before.upload.initiationIdempotencyKey !== input.idempotencyKey ||
          before.upload.initiationRequestDigest !== input.requestDigest ||
          before.upload.capabilityEpoch !== BigInt(input.claims.capabilityEpoch)) {
        throw new Error("UPLOAD_STATE_CONFLICT");
      }
      if (before.upload.providerUploadId !== null ||
          !["initiating", "outcome_unknown"].includes(before.upload.state)) return before;
      const changed = await sql.execute(
        `UPDATE platform.asset_multipart_upload
         SET initiation_effect_token=$5,initiation_effect_lease_expires_at=$6::timestamptz,
             expected_version=expected_version+1,updated_at=$7::timestamptz
         WHERE site_ref=$1 AND upload_ref=$2 AND expected_version=$3::bigint
           AND capability_epoch=$4::bigint AND state IN ('initiating','outcome_unknown')
           AND (initiation_effect_token IS NULL OR
                initiation_effect_lease_expires_at<=$7::timestamptz)`,
        [input.claims.siteRef, before.upload.uploadRef, before.upload.expectedVersion,
          input.claims.capabilityEpoch, input.effectToken, input.effectLeaseExpiresAt, input.now],
      );
      return changed === 1
        ? this.required(transaction, input.claims, before.upload.uploadRef)
        : before;
    }
    const changed = await sql.execute(
      `INSERT INTO platform.asset_multipart_upload
       (upload_ref,site_ref,intent_ref,session_ref,client_upload_id,capability_epoch,state,
        expected_version,initiation_idempotency_key,initiation_request_digest,
        initiation_receipt_ref,initiation_effect_token,initiation_effect_lease_expires_at,
        created_at,updated_at)
       VALUES ($1,$2,$3,$4,$5,$6::bigint,'initiating',1,$7,$8,$9,$10,$11::timestamptz,
              $12::timestamptz,$12::timestamptz)
       ON CONFLICT (site_ref,session_ref) DO NOTHING`,
      [input.uploadRef, input.claims.siteRef, input.claims.intentRef, input.claims.sessionRef,
        input.clientUploadId, input.claims.capabilityEpoch, input.idempotencyKey,
        input.requestDigest, input.receiptRef, input.effectToken, input.effectLeaseExpiresAt,
        input.now],
    );
    const snapshot = await this.required(transaction, input.claims);
    if (changed !== 1 && (snapshot.upload?.initiationRequestDigest !== input.requestDigest ||
        snapshot.upload.initiationIdempotencyKey !== input.idempotencyKey)) {
      throw new Error("UPLOAD_STATE_CONFLICT");
    }
    return snapshot;
  }

  async recordInitiated(
    transaction: Parameters<AssetMultipartRepositoryPort["recordInitiated"]>[0],
    input: Parameters<AssetMultipartRepositoryPort["recordInitiated"]>[1],
  ): Promise<AuthorizedAssetMultipartSnapshot> {
    await this.required(transaction, input.claims, input.uploadRef);
    const changed = await resolvePlatformTransaction(transaction).execute(
      `UPDATE platform.asset_multipart_upload
       SET provider_upload_id=$6,state='uploading',outcome_operation=NULL,
           initiation_effect_token=NULL,initiation_effect_lease_expires_at=NULL,
           expected_version=expected_version+1,updated_at=$7::timestamptz
       WHERE site_ref=$1 AND upload_ref=$2 AND expected_version=$3::bigint
         AND capability_epoch=$4::bigint AND initiation_effect_token=$5
         AND state IN ('initiating','outcome_unknown')`,
      [input.claims.siteRef, input.uploadRef, input.expectedVersion,
        input.claims.capabilityEpoch, input.effectToken, input.providerUploadId, input.now],
    );
    if (changed !== 1) throw new Error("UPLOAD_STATE_CONFLICT");
    return this.required(transaction, input.claims, input.uploadRef);
  }

  async recordInitiationUnknown(
    transaction: Parameters<AssetMultipartRepositoryPort["recordInitiationUnknown"]>[0],
    input: Parameters<AssetMultipartRepositoryPort["recordInitiationUnknown"]>[1],
  ): Promise<AuthorizedAssetMultipartSnapshot> {
    await this.required(transaction, input.claims, input.uploadRef);
    const changed = await resolvePlatformTransaction(transaction).execute(
      `UPDATE platform.asset_multipart_upload
       SET state='outcome_unknown',outcome_operation='initiate',
           initiation_effect_token=NULL,initiation_effect_lease_expires_at=NULL,
           expected_version=expected_version+1,updated_at=$6::timestamptz
       WHERE site_ref=$1 AND upload_ref=$2 AND expected_version=$3::bigint
         AND capability_epoch=$4::bigint AND initiation_effect_token=$5
         AND state IN ('initiating','outcome_unknown')`,
      [input.claims.siteRef, input.uploadRef, input.expectedVersion,
        input.claims.capabilityEpoch, input.effectToken, input.now],
    );
    if (changed !== 1) throw new Error("UPLOAD_STATE_CONFLICT");
    return this.required(transaction, input.claims, input.uploadRef);
  }

  async releaseInitiation(
    transaction: Parameters<AssetMultipartRepositoryPort["releaseInitiation"]>[0],
    input: Parameters<AssetMultipartRepositoryPort["releaseInitiation"]>[1],
  ): Promise<AuthorizedAssetMultipartSnapshot> {
    await this.required(transaction, input.claims, input.uploadRef);
    const changed = await resolvePlatformTransaction(transaction).execute(
      `UPDATE platform.asset_multipart_upload
       SET initiation_effect_token=NULL,initiation_effect_lease_expires_at=NULL,
           expected_version=expected_version+1,updated_at=$6::timestamptz
       WHERE site_ref=$1 AND upload_ref=$2 AND expected_version=$3::bigint
         AND capability_epoch=$4::bigint AND initiation_effect_token=$5
         AND state IN ('initiating','outcome_unknown')`,
      [input.claims.siteRef, input.uploadRef, input.expectedVersion,
        input.claims.capabilityEpoch, input.effectToken, input.now],
    );
    if (changed !== 1) throw new Error("UPLOAD_STATE_CONFLICT");
    return this.required(transaction, input.claims, input.uploadRef);
  }

  async claimPart(
    transaction: Parameters<AssetMultipartRepositoryPort["claimPart"]>[0],
    input: Parameters<AssetMultipartRepositoryPort["claimPart"]>[1],
  ): Promise<AuthorizedAssetMultipartSnapshot> {
    const before = await this.required(transaction, input.claims, input.uploadRef);
    const upload = requiredUpload(before);
    if (upload.state !== "uploading") throw new Error("UPLOAD_STATE_CONFLICT");
    const sql = resolvePlatformTransaction(transaction);
    const existing = before.parts.find((part) => part.partNumber === input.partNumber);
    if (existing !== undefined) {
      assertSamePart(existing, input);
      if (existing.state === "committed") return before;
      const changed = await sql.execute(
        `UPDATE platform.asset_multipart_part
         SET effect_token=$5,effect_lease_expires_at=$6::timestamptz,
             state='pending',expected_version=expected_version+1,updated_at=$7::timestamptz
         WHERE site_ref=$1 AND upload_ref=$2 AND part_number=$3
           AND expected_version=$4::bigint AND state IN ('pending','retryable','outcome_unknown')
           AND (effect_token IS NULL OR effect_lease_expires_at<=$7::timestamptz)`,
        [input.claims.siteRef, input.uploadRef, input.partNumber, existing.expectedVersion,
          input.effectToken, input.effectLeaseExpiresAt, input.now],
      );
      return changed === 1
        ? this.required(transaction, input.claims, input.uploadRef)
        : before;
    }
    const changed = await sql.execute(
      `INSERT INTO platform.asset_multipart_part
       (site_ref,upload_ref,part_number,part_receipt,provider_etag,size,checksum_sha256,
        idempotency_key,request_digest,state,expected_version,effect_token,
        effect_lease_expires_at,created_at,updated_at)
       SELECT $1,$2,$3,$4,NULL,$5::bigint,$6,$7,$8,'pending',1,$9,
              $10::timestamptz,$11::timestamptz,$11::timestamptz
       FROM platform.asset_multipart_upload upload
       WHERE upload.site_ref=$1 AND upload.upload_ref=$2 AND upload.expected_version=$12::bigint
         AND upload.capability_epoch=$13::bigint AND upload.state='uploading'
       ON CONFLICT (site_ref,upload_ref,part_number) DO NOTHING`,
      [input.claims.siteRef, upload.uploadRef, input.partNumber, input.partReceipt,
        input.size, input.checksumSha256, input.idempotencyKey, input.requestDigest,
        input.effectToken, input.effectLeaseExpiresAt, input.now, upload.expectedVersion,
        input.claims.capabilityEpoch],
    );
    const after = await this.required(transaction, input.claims, input.uploadRef);
    const claimed = after.parts.find((part) => part.partNumber === input.partNumber);
    if (claimed === undefined) throw new Error("UPLOAD_PART_CONFLICT");
    assertSamePart(claimed, input);
    if (changed !== 1 && claimed.state === "committed") return after;
    return after;
  }

  async finishPart(
    transaction: Parameters<AssetMultipartRepositoryPort["finishPart"]>[0],
    input: Parameters<AssetMultipartRepositoryPort["finishPart"]>[1],
  ): Promise<AuthorizedAssetMultipartSnapshot> {
    const before = await this.required(transaction, input.claims, input.uploadRef);
    const part = before.parts.find((candidate) => candidate.partNumber === input.partNumber);
    if (part === undefined) throw new Error("UPLOAD_PART_CONFLICT");
    if (part.state === "committed") return before;
    if (part.expectedVersion !== input.expectedPartVersion) throw new Error("UPLOAD_PART_CONFLICT");
    const changed = await resolvePlatformTransaction(transaction).execute(
      `UPDATE platform.asset_multipart_part
       SET provider_etag=$7,state=$6,effect_token=NULL,effect_lease_expires_at=NULL,
           expected_version=expected_version+1,updated_at=$8::timestamptz
       WHERE site_ref=$1 AND upload_ref=$2 AND part_number=$3
         AND expected_version=$4::bigint AND effect_token=$5
         AND state IN ('pending','outcome_unknown')`,
      [input.claims.siteRef, input.uploadRef, input.partNumber, input.expectedPartVersion,
        input.effectToken, input.state, input.providerEtag, input.now],
    );
    if (changed !== 1) throw new Error("UPLOAD_PART_CONFLICT");
    return this.required(transaction, input.claims, input.uploadRef);
  }

  async releasePart(
    transaction: Parameters<AssetMultipartRepositoryPort["releasePart"]>[0],
    input: Parameters<AssetMultipartRepositoryPort["releasePart"]>[1],
  ): Promise<AuthorizedAssetMultipartSnapshot> {
    const before = await this.required(transaction, input.claims, input.uploadRef);
    const part = before.parts.find((candidate) => candidate.partNumber === input.partNumber);
    if (part === undefined || part.expectedVersion !== input.expectedPartVersion ||
        part.effectToken !== input.effectToken || part.state !== "pending") {
      throw new Error("UPLOAD_PART_CONFLICT");
    }
    const changed = await resolvePlatformTransaction(transaction).execute(
      `UPDATE platform.asset_multipart_part
       SET provider_etag=NULL,state='retryable',effect_token=NULL,effect_lease_expires_at=NULL,
           expected_version=expected_version+1,updated_at=$6::timestamptz
       WHERE site_ref=$1 AND upload_ref=$2 AND part_number=$3
         AND expected_version=$4::bigint AND effect_token=$5
         AND state='pending'`,
      [input.claims.siteRef, input.uploadRef, input.partNumber, input.expectedPartVersion,
        input.effectToken, input.now],
    );
    if (changed !== 1) throw new Error("UPLOAD_PART_CONFLICT");
    return this.required(transaction, input.claims, input.uploadRef);
  }

  async beginCompletion(
    transaction: Parameters<AssetMultipartRepositoryPort["beginCompletion"]>[0],
    input: Parameters<AssetMultipartRepositoryPort["beginCompletion"]>[1],
  ): Promise<AuthorizedAssetMultipartSnapshot> {
    const before = await this.required(transaction, input.claims, input.uploadRef);
    const upload = requiredUpload(before);
    if (upload.completionRequestDigest !== null) {
      if (upload.completionRequestDigest !== input.requestDigest ||
          upload.completionIdempotencyKey !== input.idempotencyKey) throw new Error("UPLOAD_STATE_CONFLICT");
      return this.claimCompletionEffect(transaction, {
        claims: input.claims,
        uploadRef: input.uploadRef,
        expectedVersion: upload.expectedVersion,
        effectToken: input.effectToken,
        effectLeaseExpiresAt: input.effectLeaseExpiresAt,
        now: input.now,
      });
    }
    expectUpload(before, input.expectedVersion, ["uploading"]);
    if (before.parts.some((part) => part.state !== "committed")) {
      throw new Error("UPLOAD_STATE_CONFLICT");
    }
    await this.updateUpload(transaction, input.claims, input.uploadRef, input.expectedVersion,
      `state='completing',outcome_operation=NULL,completion_idempotency_key=$5,
       completion_request_digest=$6,completion_receipt_ref=$7,
       completion_effect_token=$8,completion_effect_lease_expires_at=$9::timestamptz`,
      [input.idempotencyKey, input.requestDigest, input.receiptRef, input.effectToken,
        input.effectLeaseExpiresAt], input.now, ["uploading"]);
    return this.required(transaction, input.claims, input.uploadRef);
  }

  async claimCompletionEffect(
    transaction: Parameters<AssetMultipartRepositoryPort["claimCompletionEffect"]>[0],
    input: Parameters<AssetMultipartRepositoryPort["claimCompletionEffect"]>[1],
  ): Promise<AuthorizedAssetMultipartSnapshot> {
    const before = await this.required(transaction, input.claims, input.uploadRef);
    const upload = requiredUpload(before);
    if (upload.state === "uploaded" || upload.state === "integrity_rejected") return before;
    if (upload.state !== "completing" &&
        !(upload.state === "outcome_unknown" && upload.outcomeOperation === "complete")) {
      throw new Error("UPLOAD_STATE_CONFLICT");
    }
    const changed = await resolvePlatformTransaction(transaction).execute(
      `UPDATE platform.asset_multipart_upload
       SET completion_effect_token=$5,completion_effect_lease_expires_at=$6::timestamptz,
           expected_version=expected_version+1,updated_at=$7::timestamptz
       WHERE site_ref=$1 AND upload_ref=$2 AND expected_version=$3::bigint
         AND capability_epoch=$4::bigint
         AND (state='completing' OR (state='outcome_unknown' AND outcome_operation='complete'))
         AND (completion_effect_token IS NULL OR
              completion_effect_lease_expires_at<=$7::timestamptz)`,
      [input.claims.siteRef, input.uploadRef, input.expectedVersion,
        input.claims.capabilityEpoch, input.effectToken, input.effectLeaseExpiresAt, input.now],
    );
    return changed === 1
      ? this.required(transaction, input.claims, input.uploadRef)
      : before;
  }

  async releaseCompletionEffect(
    transaction: Parameters<AssetMultipartRepositoryPort["releaseCompletionEffect"]>[0],
    input: Parameters<AssetMultipartRepositoryPort["releaseCompletionEffect"]>[1],
  ): Promise<AuthorizedAssetMultipartSnapshot> {
    await this.required(transaction, input.claims, input.uploadRef);
    const changed = await resolvePlatformTransaction(transaction).execute(
      `UPDATE platform.asset_multipart_upload
       SET completion_effect_token=NULL,completion_effect_lease_expires_at=NULL,
           expected_version=expected_version+1,updated_at=$6::timestamptz
       WHERE site_ref=$1 AND upload_ref=$2 AND expected_version=$3::bigint
         AND capability_epoch=$4::bigint AND completion_effect_token=$5
         AND (state='completing' OR (state='outcome_unknown' AND outcome_operation='complete'))`,
      [input.claims.siteRef, input.uploadRef, input.expectedVersion,
        input.claims.capabilityEpoch, input.effectToken, input.now],
    );
    if (changed !== 1) throw new Error("UPLOAD_STATE_CONFLICT");
    return this.required(transaction, input.claims, input.uploadRef);
  }

  async finishCompletion(
    transaction: Parameters<AssetMultipartRepositoryPort["finishCompletion"]>[0],
    input: Parameters<AssetMultipartRepositoryPort["finishCompletion"]>[1],
  ): Promise<AuthorizedAssetMultipartSnapshot> {
    const before = await this.required(transaction, input.claims, input.uploadRef);
    if ((input.state === "uploaded" && before.upload?.state === "uploaded") ||
        (input.state === "outcome_unknown" && before.upload?.state === "outcome_unknown" &&
          before.upload.outcomeOperation === "complete")) return before;
    const changed = await resolvePlatformTransaction(transaction).execute(
      `UPDATE platform.asset_multipart_upload
       SET state=$6,outcome_operation=$7,completion_effect_token=NULL,
           completion_effect_lease_expires_at=NULL,expected_version=expected_version+1,
           updated_at=$8::timestamptz
       WHERE site_ref=$1 AND upload_ref=$2 AND expected_version=$3::bigint
         AND capability_epoch=$4::bigint AND completion_effect_token=$5
         AND (state='completing' OR (state='outcome_unknown' AND outcome_operation='complete'))`,
      [input.claims.siteRef, input.uploadRef, input.expectedVersion,
        input.claims.capabilityEpoch, input.effectToken, input.state,
        input.state === "outcome_unknown" ? "complete" : null, input.now],
    );
    if (changed !== 1) throw new Error("UPLOAD_STATE_CONFLICT");
    return this.required(transaction, input.claims, input.uploadRef);
  }

  async rejectIntegrity(
    transaction: Parameters<AssetMultipartRepositoryPort["rejectIntegrity"]>[0],
    input: Parameters<AssetMultipartRepositoryPort["rejectIntegrity"]>[1],
  ): Promise<AuthorizedAssetMultipartSnapshot> {
    const before = await this.required(transaction, input.claims, input.uploadRef);
    const upload = expectUpload(before, input.expectedVersion,
      ["completing", "aborting", "outcome_unknown"]);
    if (input.safeReasonCode !== "UPLOAD_PART_INVALID") {
      throw new Error("UPLOAD_PART_INVALID");
    }
    const effectColumn = input.effectOperation === "complete"
      ? "completion_effect_token"
      : "abort_effect_token";
    const activeToken = input.effectOperation === "complete"
      ? upload.completionEffectToken
      : upload.abortEffectToken;
    if (activeToken !== input.effectToken ||
        (upload.state === "outcome_unknown" && upload.outcomeOperation !== input.effectOperation)) {
      throw new Error("UPLOAD_STATE_CONFLICT");
    }
    const sql = resolvePlatformTransaction(transaction);
    const uploads = await sql.query<UploadRow>(
      `UPDATE platform.asset_multipart_upload upload
       SET state='integrity_rejected',outcome_operation=NULL,
           completion_effect_token=NULL,completion_effect_lease_expires_at=NULL,
           abort_effect_token=NULL,abort_effect_lease_expires_at=NULL,
           expected_version=expected_version+1,updated_at=$6::timestamptz
       WHERE upload.site_ref=$1 AND upload.upload_ref=$2
         AND upload.expected_version=$3::bigint AND upload.capability_epoch=$4::bigint
         AND upload.${effectColumn}=$5
         AND upload.state IN ('completing','aborting','outcome_unknown')
       RETURNING ${UPLOAD_COLUMNS}`,
      [input.claims.siteRef, input.uploadRef, input.expectedVersion,
        input.claims.capabilityEpoch, input.effectToken, input.now],
    );
    const terminal = uploads[0];
    if (terminal === undefined) throw new Error("UPLOAD_STATE_CONFLICT");
    const ownerRows = await sql.query<{ expectedVersion: bigint }>(
      `UPDATE platform.asset_upload_session session
       SET state='completing',completion_requested_at=$4::timestamptz,
           expected_version=expected_version+1,updated_at=$4::timestamptz
       WHERE session.site_ref=$1 AND session.intent_ref=$2 AND session.session_ref=$3
         AND session.state='uploading' AND now()<session.expires_at
       RETURNING session.expected_version AS "expectedVersion"`,
      [input.claims.siteRef, input.claims.intentRef, input.claims.sessionRef, input.now],
    );
    const owner = ownerRows[0];
    if (owner !== undefined) {
      const payload = Object.freeze({
        kind: "asset_upload_completion_requested_v1",
        siteRef: input.claims.siteRef,
        intentRef: input.claims.intentRef,
        sessionRef: input.claims.sessionRef,
        expectedVersion: owner.expectedVersion.toString(),
      });
      await sql.query(
        `SELECT platform.enqueue_asset_upload_completion_event(
           $1::uuid,$2,$3::jsonb,$4,$5,$6
         )`,
        [input.eventId, input.claims.sessionRef, JSON.stringify(payload),
          digestAssetCommand(payload), input.correlationId,
          upload.completionReceiptRef ?? upload.uploadRef],
      );
    } else {
      const ownerState = await sql.query<{ state: string }>(
        `SELECT state FROM platform.asset_upload_session
         WHERE site_ref=$1 AND intent_ref=$2 AND session_ref=$3 FOR UPDATE`,
        [input.claims.siteRef, input.claims.intentRef, input.claims.sessionRef],
      );
      if (!ownerState[0] || !["completing", "reconciling_upload", "validating", "completed",
        "rejected"].includes(ownerState[0].state)) {
        throw new Error("UPLOAD_STATE_CONFLICT");
      }
    }
    return Object.freeze({
      claims: input.claims,
      upload: hydrateUpload(terminal),
      parts: before.parts,
    });
  }

  async beginAbort(
    transaction: Parameters<AssetMultipartRepositoryPort["beginAbort"]>[0],
    input: Parameters<AssetMultipartRepositoryPort["beginAbort"]>[1],
  ): Promise<AuthorizedAssetMultipartSnapshot> {
    const before = await this.required(transaction, input.claims, input.uploadRef);
    const upload = requiredUpload(before);
    if (upload.abortRequestDigest !== null) {
      if (upload.abortRequestDigest !== input.requestDigest ||
          upload.abortIdempotencyKey !== input.idempotencyKey) throw new Error("UPLOAD_STATE_CONFLICT");
      return this.claimAbortEffect(transaction, {
        claims: input.claims,
        uploadRef: input.uploadRef,
        expectedVersion: upload.expectedVersion,
        effectToken: input.effectToken,
        effectLeaseExpiresAt: input.effectLeaseExpiresAt,
        now: input.now,
      });
    }
    expectUpload(before, input.expectedVersion, ["uploading"]);
    if (before.parts.some((part) => part.state === "pending")) {
      throw new Error("UPLOAD_STATE_CONFLICT");
    }
    await this.updateUpload(transaction, input.claims, input.uploadRef, input.expectedVersion,
      `state='aborting',outcome_operation=NULL,abort_idempotency_key=$5,
       abort_request_digest=$6,abort_receipt_ref=$7,abort_effect_token=$8,
       abort_effect_lease_expires_at=$9::timestamptz`,
      [input.idempotencyKey, input.requestDigest, input.receiptRef, input.effectToken,
        input.effectLeaseExpiresAt], input.now,
      ["uploading"]);
    return this.required(transaction, input.claims, input.uploadRef);
  }

  async claimAbortEffect(
    transaction: Parameters<AssetMultipartRepositoryPort["claimAbortEffect"]>[0],
    input: Parameters<AssetMultipartRepositoryPort["claimAbortEffect"]>[1],
  ): Promise<AuthorizedAssetMultipartSnapshot> {
    const before = await this.required(transaction, input.claims, input.uploadRef);
    const upload = requiredUpload(before);
    if (upload.state === "aborted") return before;
    if (upload.state !== "aborting" &&
        !(upload.state === "outcome_unknown" && upload.outcomeOperation === "abort")) {
      throw new Error("UPLOAD_STATE_CONFLICT");
    }
    const changed = await resolvePlatformTransaction(transaction).execute(
      `UPDATE platform.asset_multipart_upload
       SET abort_effect_token=$5,abort_effect_lease_expires_at=$6::timestamptz,
           expected_version=expected_version+1,updated_at=$7::timestamptz
       WHERE site_ref=$1 AND upload_ref=$2 AND expected_version=$3::bigint
         AND capability_epoch=$4::bigint
         AND (state='aborting' OR (state='outcome_unknown' AND outcome_operation='abort'))
         AND (abort_effect_token IS NULL OR abort_effect_lease_expires_at<=$7::timestamptz)`,
      [input.claims.siteRef, input.uploadRef, input.expectedVersion,
        input.claims.capabilityEpoch, input.effectToken, input.effectLeaseExpiresAt, input.now],
    );
    return changed === 1
      ? this.required(transaction, input.claims, input.uploadRef)
      : before;
  }

  async releaseAbortEffect(
    transaction: Parameters<AssetMultipartRepositoryPort["releaseAbortEffect"]>[0],
    input: Parameters<AssetMultipartRepositoryPort["releaseAbortEffect"]>[1],
  ): Promise<AuthorizedAssetMultipartSnapshot> {
    await this.required(transaction, input.claims, input.uploadRef);
    const changed = await resolvePlatformTransaction(transaction).execute(
      `UPDATE platform.asset_multipart_upload
       SET abort_effect_token=NULL,abort_effect_lease_expires_at=NULL,
           expected_version=expected_version+1,updated_at=$6::timestamptz
       WHERE site_ref=$1 AND upload_ref=$2 AND expected_version=$3::bigint
         AND capability_epoch=$4::bigint AND abort_effect_token=$5
         AND (state='aborting' OR (state='outcome_unknown' AND outcome_operation='abort'))`,
      [input.claims.siteRef, input.uploadRef, input.expectedVersion,
        input.claims.capabilityEpoch, input.effectToken, input.now],
    );
    if (changed !== 1) throw new Error("UPLOAD_STATE_CONFLICT");
    return this.required(transaction, input.claims, input.uploadRef);
  }

  async finishAbort(
    transaction: Parameters<AssetMultipartRepositoryPort["finishAbort"]>[0],
    input: Parameters<AssetMultipartRepositoryPort["finishAbort"]>[1],
  ): Promise<AuthorizedAssetMultipartSnapshot> {
    const before = await this.required(transaction, input.claims, input.uploadRef);
    if ((input.state === "aborted" && before.upload?.state === "aborted") ||
        (input.state === "uploaded" && before.upload?.state === "uploaded") ||
        (input.state === "outcome_unknown" && before.upload?.state === "outcome_unknown" &&
          before.upload.outcomeOperation === "abort")) return before;
    const changed = await resolvePlatformTransaction(transaction).execute(
      `UPDATE platform.asset_multipart_upload
       SET state=$6,outcome_operation=$7,abort_effect_token=NULL,
           abort_effect_lease_expires_at=NULL,expected_version=expected_version+1,
           updated_at=$8::timestamptz
       WHERE site_ref=$1 AND upload_ref=$2 AND expected_version=$3::bigint
         AND capability_epoch=$4::bigint AND abort_effect_token=$5
         AND (state='aborting' OR (state='outcome_unknown' AND outcome_operation='abort'))`,
      [input.claims.siteRef, input.uploadRef, input.expectedVersion,
        input.claims.capabilityEpoch, input.effectToken, input.state,
        input.state === "outcome_unknown" ? "abort" : null, input.now],
    );
    if (changed !== 1) throw new Error("UPLOAD_STATE_CONFLICT");
    return this.required(transaction, input.claims, input.uploadRef);
  }

  private async required(
    transaction: Parameters<AssetMultipartRepositoryPort["readAuthorized"]>[0],
    claims: AssetUploadCapabilityClaims,
    uploadRef?: string,
  ): Promise<AuthorizedAssetMultipartSnapshot> {
    const value = await this.readAuthorized(transaction, claims, uploadRef);
    if (value === null) throw new Error("UPLOAD_NOT_ACCEPTED");
    return value;
  }

  private async updateUpload(
    transaction: Parameters<AssetMultipartRepositoryPort["readAuthorized"]>[0],
    claims: AssetUploadCapabilityClaims,
    uploadRef: string,
    expectedVersion: bigint,
    assignment: string,
    assignmentValues: readonly unknown[],
    now: string,
    states: readonly string[],
  ): Promise<void> {
    await this.required(transaction, claims, uploadRef);
    const sql = resolvePlatformTransaction(transaction);
    const firstDynamic = 5;
    const stateParameter = firstDynamic + assignmentValues.length;
    const nowParameter = stateParameter + 1;
    const changed = await sql.execute(
      `UPDATE platform.asset_multipart_upload
       SET ${assignment},expected_version=expected_version+1,updated_at=$${nowParameter}::timestamptz
       WHERE site_ref=$1 AND upload_ref=$2 AND expected_version=$3::bigint
         AND capability_epoch=$4::bigint AND state=ANY($${stateParameter}::text[])`,
      [claims.siteRef, uploadRef, expectedVersion, claims.capabilityEpoch,
        ...assignmentValues, states, now],
    );
    if (changed !== 1) throw new Error("UPLOAD_STATE_CONFLICT");
  }
}

type AuthorityRow = Readonly<{
  authoritySiteRef: string;
  authorityIntentRef: string;
  authoritySessionRef: string;
}>;

type UploadRow = Readonly<{
  uploadRef: string | null;
  uploadSiteRef: string | null;
  uploadIntentRef: string | null;
  uploadSessionRef: string | null;
  clientUploadId: string | null;
  providerUploadId: string | null;
  uploadCapabilityEpoch: bigint | null;
  uploadState: StoredAssetMultipartUpload["state"] | null;
  outcomeOperation: StoredAssetMultipartUpload["outcomeOperation"];
  uploadExpectedVersion: bigint | null;
  initiationIdempotencyKey: string | null;
  initiationRequestDigest: string | null;
  initiationReceiptRef: string | null;
  initiationEffectToken: string | null;
  initiationEffectLeaseExpiresAt: Date | string | null;
  completionIdempotencyKey: string | null;
  completionRequestDigest: string | null;
  completionReceiptRef: string | null;
  completionEffectToken: string | null;
  completionEffectLeaseExpiresAt: Date | string | null;
  abortIdempotencyKey: string | null;
  abortRequestDigest: string | null;
  abortReceiptRef: string | null;
  abortEffectToken: string | null;
  abortEffectLeaseExpiresAt: Date | string | null;
  uploadCreatedAt: Date | string | null;
  uploadUpdatedAt: Date | string | null;
}>;

type PartRow = Readonly<{
  partNumber: number;
  partReceipt: string;
  providerEtag: string | null;
  size: bigint;
  checksumSha256: string;
  idempotencyKey: string;
  requestDigest: string;
  state: StoredAssetMultipartPart["state"];
  expectedVersion: bigint;
  effectToken: string | null;
  effectLeaseExpiresAt: Date | string | null;
}>;

function hydrateUpload(row: UploadRow): StoredAssetMultipartUpload {
  if (row.uploadRef === null || row.uploadSiteRef === null || row.uploadIntentRef === null ||
      row.uploadSessionRef === null || row.clientUploadId === null ||
      row.uploadCapabilityEpoch === null || row.uploadState === null ||
      row.uploadExpectedVersion === null || row.initiationIdempotencyKey === null ||
      row.initiationRequestDigest === null || row.initiationReceiptRef === null ||
      row.uploadCreatedAt === null || row.uploadUpdatedAt === null) {
    throw new Error("ASSET_MULTIPART_ROW_INVALID");
  }
  return Object.freeze({
    uploadRef: row.uploadRef,
    siteRef: row.uploadSiteRef,
    intentRef: row.uploadIntentRef,
    sessionRef: row.uploadSessionRef,
    clientUploadId: row.clientUploadId,
    providerUploadId: row.providerUploadId,
    capabilityEpoch: row.uploadCapabilityEpoch,
    state: row.uploadState,
    outcomeOperation: row.outcomeOperation,
    expectedVersion: row.uploadExpectedVersion,
    initiationIdempotencyKey: row.initiationIdempotencyKey,
    initiationRequestDigest: row.initiationRequestDigest,
    initiationReceiptRef: row.initiationReceiptRef,
    initiationEffectToken: row.initiationEffectToken,
    initiationEffectLeaseExpiresAt: row.initiationEffectLeaseExpiresAt === null
      ? null
      : instant(row.initiationEffectLeaseExpiresAt),
    completionIdempotencyKey: row.completionIdempotencyKey,
    completionRequestDigest: row.completionRequestDigest,
    completionReceiptRef: row.completionReceiptRef,
    completionEffectToken: row.completionEffectToken,
    completionEffectLeaseExpiresAt: row.completionEffectLeaseExpiresAt === null
      ? null
      : instant(row.completionEffectLeaseExpiresAt),
    abortIdempotencyKey: row.abortIdempotencyKey,
    abortRequestDigest: row.abortRequestDigest,
    abortReceiptRef: row.abortReceiptRef,
    abortEffectToken: row.abortEffectToken,
    abortEffectLeaseExpiresAt: row.abortEffectLeaseExpiresAt === null
      ? null
      : instant(row.abortEffectLeaseExpiresAt),
    createdAt: instant(row.uploadCreatedAt),
    updatedAt: instant(row.uploadUpdatedAt),
  });
}

function hydratePart(row: PartRow): StoredAssetMultipartPart {
  return Object.freeze({
    ...row,
    effectLeaseExpiresAt: row.effectLeaseExpiresAt === null
      ? null
      : instant(row.effectLeaseExpiresAt),
  });
}

function assertSamePart(
  existing: StoredAssetMultipartPart,
  input: Readonly<{
    idempotencyKey: string;
    requestDigest: string;
    size: bigint;
    checksumSha256: string;
  }>,
): void {
  if (existing.requestDigest !== input.requestDigest ||
      existing.idempotencyKey !== input.idempotencyKey || existing.size !== input.size ||
      existing.checksumSha256 !== input.checksumSha256) {
    throw new Error("UPLOAD_PART_CONFLICT");
  }
}

const UPLOAD_COLUMNS = `
  upload.upload_ref AS "uploadRef",upload.site_ref AS "uploadSiteRef",
  upload.intent_ref AS "uploadIntentRef",upload.session_ref AS "uploadSessionRef",
  upload.client_upload_id AS "clientUploadId",upload.provider_upload_id AS "providerUploadId",
  upload.capability_epoch AS "uploadCapabilityEpoch",upload.state AS "uploadState",
  upload.outcome_operation AS "outcomeOperation",
  upload.expected_version AS "uploadExpectedVersion",
  upload.initiation_idempotency_key AS "initiationIdempotencyKey",
  upload.initiation_request_digest AS "initiationRequestDigest",
  upload.initiation_receipt_ref AS "initiationReceiptRef",
  upload.initiation_effect_token AS "initiationEffectToken",
  upload.initiation_effect_lease_expires_at AS "initiationEffectLeaseExpiresAt",
  upload.completion_idempotency_key AS "completionIdempotencyKey",
  upload.completion_request_digest AS "completionRequestDigest",
  upload.completion_receipt_ref AS "completionReceiptRef",
  upload.completion_effect_token AS "completionEffectToken",
  upload.completion_effect_lease_expires_at AS "completionEffectLeaseExpiresAt",
  upload.abort_idempotency_key AS "abortIdempotencyKey",
  upload.abort_request_digest AS "abortRequestDigest",
  upload.abort_receipt_ref AS "abortReceiptRef",
  upload.abort_effect_token AS "abortEffectToken",
  upload.abort_effect_lease_expires_at AS "abortEffectLeaseExpiresAt",
  upload.created_at AS "uploadCreatedAt",upload.updated_at AS "uploadUpdatedAt"`;

function requiredUpload(value: AuthorizedAssetMultipartSnapshot): StoredAssetMultipartUpload {
  if (value.upload === null) throw new Error("UPLOAD_NOT_ACCEPTED");
  return value.upload;
}

function expectUpload(
  value: AuthorizedAssetMultipartSnapshot,
  expectedVersion: bigint,
  states: readonly StoredAssetMultipartUpload["state"][],
): StoredAssetMultipartUpload {
  const upload = requiredUpload(value);
  if (upload.expectedVersion !== expectedVersion || !states.includes(upload.state)) {
    throw new Error("UPLOAD_STATE_CONFLICT");
  }
  return upload;
}

function instant(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}
