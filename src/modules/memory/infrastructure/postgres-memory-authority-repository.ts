import { resolvePlatformTransaction } from
  "../../../shared/unit-of-work/platform-transaction.js";
import type { PlatformTransaction } from "../../../shared/unit-of-work/index.js";
import type { MemoryAuthorityRepository, MemoryCommandReceiptIdentity, MemoryCommandResult,
  MemoryReceiptClaim } from "../application/memory-authority-ports.js";
import { MemoryApplicationError } from "../application/memory-application-error.js";
import { rehydrateMemoryEntry, type MemoryEntry, type MemoryProvenance,
  type MemoryRevision, type RememberedMemory } from "../domain/memory-entry.js";
import {
  memoryAggregateVersion,
  memoryEntryRef,
  memoryFeaturePolicyRevisionRef,
  memoryInstant,
  memoryLearningGeneration,
  memoryRevisionNumber,
  memoryRevisionRef,
  memoryRevocationEpoch,
  memorySourceOriginSequence,
  memorySpaceGeneration,
  memorySpaceRef,
  type AggregateVersion,
  type MemoryEntryRef,
  type MemoryRevisionNumber,
  type MemorySpaceRef,
  type SiteRef,
} from "../domain/memory-references.js";
import { memoryBaseBinding, memoryBindingSiteRef, rehydrateMemoryScopeBinding, rehydrateMemorySpace,
  type MemoryScopeBinding, type MemorySpace } from
  "../domain/memory-space.js";

export class PostgresMemoryAuthorityRepository implements MemoryAuthorityRepository {
  async loadSpaceAuthorityForUpdate(transaction: PlatformTransaction, siteRef: SiteRef,
    spaceRef: MemorySpaceRef, expectedParentSpaceRef?: MemorySpaceRef):
    Promise<Readonly<{ space: MemorySpace | null; parent: MemorySpace | null }>> {
    const sql = resolvePlatformTransaction(transaction);
    const lineage = await sql.query<Readonly<{ parentSpaceRef: unknown }>>(
      `SELECT parent_space_ref AS "parentSpaceRef" FROM platform.memory_space
       WHERE site_ref=$1 AND space_ref=$2`, [siteRef, spaceRef]);
    if (lineage.length > 1) throw new MemoryApplicationError("MEMORY_PERSISTENCE_CONFLICT");
    const storedParent = lineage[0]?.parentSpaceRef;
    if (storedParent !== undefined && storedParent !== null && typeof storedParent !== "string") {
      throw new MemoryApplicationError("MEMORY_PERSISTENCE_CONFLICT");
    }
    const parentRef = typeof storedParent === "string" ? memorySpaceRef(storedParent)
      : expectedParentSpaceRef;
    const parent = parentRef === undefined ? null
      : await this.loadSpaceForUpdate(transaction, siteRef, parentRef);
    const space = await this.loadSpaceForUpdate(transaction, siteRef, spaceRef);
    return Object.freeze({ space, parent });
  }
  async loadSpaceForUpdate(transaction: PlatformTransaction, siteRef: SiteRef,
    spaceRef: MemorySpaceRef): Promise<MemorySpace | null> {
    const rows = await resolvePlatformTransaction(transaction).query<SpaceRow>(
      `SELECT site_ref AS "siteRef",space_ref AS "spaceRef",scope_kind AS "scopeKind",
              parent_space_ref AS "parentSpaceRef",subject_ref AS "subjectRef",
              parent_space_generation::text AS "parentSpaceGeneration",
              parent_learning_generation::text AS "parentLearningGeneration",
              parent_revocation_epoch::text AS "parentRevocationEpoch",
              subject_generation::text AS "subjectGeneration",project_ref AS "projectRef",
              agent_option_ref AS "agentOptionRef",
              product_surface_ref AS "productSurfaceRef",
              feature_policy_revision_ref AS "featurePolicyRevisionRef",version::text AS version,
              space_generation::text AS "spaceGeneration",
              learning_generation::text AS "learningGeneration",
              revocation_epoch::text AS "revocationEpoch",
              minimum_learnable_source_origin_seq::text AS "minimumSourceOriginSequence",
              learning_state AS "learningState",use_state AS "useState",state,
              created_at AS "createdAt",updated_at AS "updatedAt"
       FROM platform.memory_space WHERE site_ref=$1 AND space_ref=$2 FOR UPDATE`,
      [siteRef, spaceRef],
    );
    if (rows.length > 1) throw new MemoryApplicationError("MEMORY_PERSISTENCE_CONFLICT");
    return rows[0] === undefined ? null : decodeSpace(rows[0]);
  }

  async loadEntryForUpdate(transaction: PlatformTransaction, siteRef: SiteRef,
    spaceRef: MemorySpaceRef, entryRef: MemoryEntryRef): Promise<MemoryEntry | null> {
    const rows = await resolvePlatformTransaction(transaction).query<EntryRow>(
      `SELECT site_ref AS "siteRef",space_ref AS "spaceRef",entry_ref AS "entryRef",
              version::text AS version,current_revision::text AS "currentRevision",
              current_revision_ref AS "currentRevisionRef",state,category,
              feature_policy_revision_ref AS "featurePolicyRevisionRef",
              space_generation::text AS "spaceGeneration",
              learning_generation::text AS "learningGeneration",
              revocation_epoch::text AS "revocationEpoch",created_at AS "createdAt",
              updated_at AS "updatedAt",deleted_at AS "deletedAt"
       FROM platform.memory_entry
       WHERE site_ref=$1 AND space_ref=$2 AND entry_ref=$3 FOR UPDATE`,
      [siteRef, spaceRef, entryRef],
    );
    if (rows.length > 1) throw new MemoryApplicationError("MEMORY_PERSISTENCE_CONFLICT");
    return rows[0] === undefined ? null : decodeEntry(rows[0]);
  }

  async claimReceipt(transaction: PlatformTransaction,
    identity: MemoryCommandReceiptIdentity): Promise<MemoryReceiptClaim> {
    const sql = resolvePlatformTransaction(transaction);
    const owner = receiptOwnerColumns(identity);
    await sql.query(
      `SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
         concat_ws(E'\\x1f',$1,$2,$3,COALESCE($4::text,''),COALESCE($5,''),$6),72623859790382856))`,
      [owner.siteRef, owner.ownerScopeKind, owner.ownerSubjectRef,
        owner.ownerSubjectGeneration, owner.ownerProjectRef, identity.commandRef],
    );
    const rows = await sql.query<ReceiptRow>(
      `SELECT operation,request_digest AS "requestDigest",result_kind AS "resultKind",
              result_space_ref AS "resultSpaceRef",result_space_version::text AS "resultSpaceVersion",
              result_entry_ref AS "resultEntryRef",result_entry_version::text AS "resultEntryVersion",
              result_revision_ref AS "resultRevisionRef",result_revision::text AS "resultRevision",
              result_space_generation::text AS "resultSpaceGeneration",
              result_learning_generation::text AS "resultLearningGeneration",
              result_revocation_epoch::text AS "resultRevocationEpoch",
              result_minimum_source_origin_seq::text AS "resultMinimumSourceOriginSequence",
              result_learning_state AS "resultLearningState",result_use_state AS "resultUseState"
              ,result_previous_feature_policy_revision_ref AS "resultPreviousFeaturePolicyRevisionRef"
              ,result_feature_policy_revision_ref AS "resultFeaturePolicyRevisionRef"
       FROM platform.memory_command_receipt
       WHERE site_ref=$1 AND owner_scope_kind=$2
         AND owner_subject_ref IS NOT DISTINCT FROM $3
         AND owner_subject_generation IS NOT DISTINCT FROM $4::bigint
         AND owner_project_ref IS NOT DISTINCT FROM $5 AND command_ref=$6
       FOR UPDATE`,
      [owner.siteRef, owner.ownerScopeKind, owner.ownerSubjectRef,
        owner.ownerSubjectGeneration, owner.ownerProjectRef, identity.commandRef],
    );
    if (rows.length > 1) throw new MemoryApplicationError("MEMORY_RECEIPT_INVALID");
    const row = rows[0];
    if (row === undefined) return Object.freeze({ kind: "claimed" });
    const storedIdentity = decodeReceiptStoredIdentity(row);
    if (storedIdentity.requestDigest !== identity.requestDigest ||
      storedIdentity.operation !== identity.operation) {
      return Object.freeze({ kind: "digest_conflict" });
    }
    const result = decodeReceiptResultSafely(row);
    if (result.kind !== resultKindForOperation(storedIdentity.operation)) {
      throw new MemoryApplicationError("MEMORY_RECEIPT_INVALID");
    }
    return Object.freeze({ kind: "replay", result });
  }

  async completeReceipt(transaction: PlatformTransaction, identity: MemoryCommandReceiptIdentity,
    result: MemoryCommandResult): Promise<void> {
    const owner = receiptOwnerColumns(identity);
    const columns = receiptResultColumns(result);
    const inserted = await resolvePlatformTransaction(transaction).execute(
      `INSERT INTO platform.memory_command_receipt
       (site_ref,owner_scope_kind,owner_subject_ref,owner_subject_generation,owner_project_ref,
        caller_subject_ref,caller_subject_generation,caller_membership_epoch,
        caller_authorization_epoch,command_ref,operation,request_digest,result_kind,
        result_space_ref,result_space_version,
        result_entry_ref,result_entry_version,result_revision_ref,result_revision,
        result_space_generation,result_learning_generation,result_revocation_epoch,
        result_minimum_source_origin_seq,result_learning_state,result_use_state,
        result_previous_feature_policy_revision_ref,result_feature_policy_revision_ref,recorded_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,
         $23,$24,$25,$26,$27,clock_timestamp())`,
      [owner.siteRef, owner.ownerScopeKind, owner.ownerSubjectRef, owner.ownerSubjectGeneration,
        owner.ownerProjectRef, owner.callerSubjectRef, owner.callerSubjectGeneration,
        owner.callerMembershipEpoch, owner.callerAuthorizationEpoch, identity.commandRef,
        identity.operation, identity.requestDigest, columns.resultKind, columns.resultSpaceRef,
        columns.resultSpaceVersion, columns.resultEntryRef, columns.resultEntryVersion,
        columns.resultRevisionRef, columns.resultRevision, columns.resultSpaceGeneration,
        columns.resultLearningGeneration, columns.resultRevocationEpoch,
        columns.resultMinimumSourceOriginSequence, columns.resultLearningState, columns.resultUseState,
        columns.resultPreviousFeaturePolicyRevisionRef, columns.resultFeaturePolicyRevisionRef],
    );
    if (inserted !== 1) throw new MemoryApplicationError("MEMORY_PERSISTENCE_CONFLICT");
  }

  async saveRememberedMemory(transaction: PlatformTransaction, newSpace: MemorySpace | null,
    remembered: RememberedMemory): Promise<void> {
    const sql = resolvePlatformTransaction(transaction);
    if (newSpace !== null) await insertSpace(sql, newSpace);
    const insertedEntry = await sql.execute(
      `INSERT INTO platform.memory_entry
       (site_ref,space_ref,entry_ref,version,current_revision,current_revision_ref,state,category,
        feature_policy_revision_ref,space_generation,learning_generation,revocation_epoch,
        created_at,updated_at,deleted_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::timestamptz,$14::timestamptz,$15::timestamptz)`,
      entryValues(remembered.entry),
    );
    if (insertedEntry !== 1) throw new MemoryApplicationError("MEMORY_PERSISTENCE_CONFLICT");
    await insertRevision(sql, remembered.revision);
    await insertProvenance(sql, remembered.provenance, remembered.revision.revision);
  }

  async saveCorrectedMemory(transaction: PlatformTransaction,
    expected: Readonly<{ entryVersion: AggregateVersion; currentRevision: MemoryRevisionNumber }>,
    corrected: RememberedMemory): Promise<void> {
    const sql = resolvePlatformTransaction(transaction);
    await insertRevision(sql, corrected.revision);
    await insertProvenance(sql, corrected.provenance, corrected.revision.revision);
    const updated = await sql.execute(
      `UPDATE platform.memory_entry
       SET version=$1,current_revision=$2,current_revision_ref=$3,updated_at=$4::timestamptz
       WHERE site_ref=$5 AND space_ref=$6 AND entry_ref=$7
         AND version=$8 AND current_revision=$9 AND state='active'`,
      [corrected.entry.version, corrected.entry.currentRevision, corrected.entry.currentRevisionRef,
        corrected.entry.updatedAt, corrected.entry.siteRef, corrected.entry.spaceRef,
        corrected.entry.entryRef, expected.entryVersion, expected.currentRevision],
    );
    if (updated !== 1) throw new MemoryApplicationError("MEMORY_PERSISTENCE_CONFLICT");
  }

  async saveForgottenMemory(transaction: PlatformTransaction,
    expected: Readonly<{ spaceVersion: AggregateVersion; entryVersion: AggregateVersion }>,
    space: MemorySpace, entry: MemoryEntry): Promise<void> {
    const sql = resolvePlatformTransaction(transaction);
    const spaceUpdated = await updateSpace(sql, expected.spaceVersion, space);
    if (spaceUpdated !== 1) throw new MemoryApplicationError("MEMORY_PERSISTENCE_CONFLICT");
    const entryUpdated = await sql.execute(
      `UPDATE platform.memory_entry
       SET version=$1,state=$2,revocation_epoch=$3,updated_at=$4::timestamptz,
           deleted_at=$5::timestamptz
       WHERE site_ref=$6 AND space_ref=$7 AND entry_ref=$8 AND version=$9 AND state='active'`,
      [entry.version, entry.state, entry.revocationEpoch, entry.updatedAt, entry.deletedAt,
        entry.siteRef, entry.spaceRef, entry.entryRef, expected.entryVersion],
    );
    if (entryUpdated !== 1) throw new MemoryApplicationError("MEMORY_PERSISTENCE_CONFLICT");
  }

  async saveSpace(transaction: PlatformTransaction, expectedVersion: AggregateVersion,
    space: MemorySpace): Promise<void> {
    const updated = await updateSpace(resolvePlatformTransaction(transaction), expectedVersion, space);
    if (updated !== 1) throw new MemoryApplicationError("MEMORY_PERSISTENCE_CONFLICT");
  }

  async saveReboundPolicy(transaction: PlatformTransaction,
    expected: Readonly<{ version: AggregateVersion; featurePolicyRevisionRef: string }>,
    space: MemorySpace): Promise<void> {
    const updated = await resolvePlatformTransaction(transaction).execute(
      `UPDATE platform.memory_space
       SET feature_policy_revision_ref=$1,version=$2,space_generation=$3,learning_generation=$4,
           revocation_epoch=$5,minimum_learnable_source_origin_seq=$6,learning_state=$7,
           use_state=$8,state=$9,updated_at=$10::timestamptz
       WHERE site_ref=$11 AND space_ref=$12 AND version=$13
         AND feature_policy_revision_ref=$14`,
      [space.featurePolicyRevisionRef, space.version, space.spaceGeneration, space.learningGeneration,
        space.revocationEpoch, space.minimumLearnableSourceOriginSequence, space.learningState,
        space.useState, space.state, space.updatedAt, memoryBindingSiteRef(space.binding),
        space.spaceRef, expected.version, expected.featurePolicyRevisionRef],
    );
    if (updated !== 1) throw new MemoryApplicationError("MEMORY_PERSISTENCE_CONFLICT");
  }
}

type Sql = ReturnType<typeof resolvePlatformTransaction>;

async function insertSpace(sql: Sql, space: MemorySpace): Promise<void> {
  const binding = spaceBindingColumns(space.binding);
  const inserted = await sql.execute(
    `INSERT INTO platform.memory_space
     (site_ref,space_ref,scope_kind,parent_space_ref,parent_space_generation,parent_learning_generation,
      parent_revocation_epoch,subject_ref,subject_generation,project_ref,
      agent_option_ref,product_surface_ref,
      feature_policy_revision_ref,version,space_generation,learning_generation,revocation_epoch,
      minimum_learnable_source_origin_seq,learning_state,use_state,state,created_at,updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,
       $22::timestamptz,$23::timestamptz)`,
    [binding.siteRef, space.spaceRef, binding.scopeKind, binding.parentSpaceRef,
      binding.parentSpaceGeneration, binding.parentLearningGeneration, binding.parentRevocationEpoch,
      binding.subjectRef, binding.subjectGeneration, binding.projectRef, binding.agentOptionRef,
      binding.productSurfaceRef,
      space.featurePolicyRevisionRef, space.version, space.spaceGeneration, space.learningGeneration,
      space.revocationEpoch,
      space.minimumLearnableSourceOriginSequence, space.learningState, space.useState, space.state,
      space.createdAt, space.updatedAt],
  );
  if (inserted !== 1) throw new MemoryApplicationError("MEMORY_PERSISTENCE_CONFLICT");
}

async function insertRevision(sql: Sql, revision: MemoryRevision): Promise<void> {
  const inserted = await sql.execute(
    `INSERT INTO platform.memory_revision
     (site_ref,space_ref,entry_ref,revision,revision_ref,reason,supersedes_revision,
      supersedes_revision_ref,feature_policy_revision_ref,recorded_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::timestamptz)`,
    [revision.siteRef, revision.spaceRef, revision.entryRef, revision.revision, revision.revisionRef,
      revision.reason,
      revision.supersedesRevisionRef === null ? null : revision.revision - 1n,
      revision.supersedesRevisionRef, revision.featurePolicyRevisionRef, revision.recordedAt],
  );
  if (inserted !== 1) throw new MemoryApplicationError("MEMORY_PERSISTENCE_CONFLICT");
  const payloadInserted = await sql.execute(
    `INSERT INTO platform.memory_revision_payload
     (site_ref,space_ref,entry_ref,revision,revision_ref,envelope_version,
      protection_key_revision,nonce,protected_ciphertext,authentication_tag,aad_digest,protected_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::timestamptz)`,
    [revision.siteRef, revision.spaceRef, revision.entryRef, revision.revision, revision.revisionRef,
      revision.protectedContent.envelopeVersion, revision.protectedContent.keyRevision,
      Buffer.from(revision.protectedContent.copyNonce()),
      Buffer.from(revision.protectedContent.copyCiphertext()),
      Buffer.from(revision.protectedContent.copyAuthenticationTag()),
      revision.protectedContent.aadDigest, revision.recordedAt],
  );
  if (payloadInserted !== 1) throw new MemoryApplicationError("MEMORY_PERSISTENCE_CONFLICT");
}

async function insertProvenance(sql: Sql, provenance: MemoryProvenance,
  revision: MemoryRevisionNumber): Promise<void> {
  const inserted = await sql.execute(
    `INSERT INTO platform.memory_provenance
     (site_ref,space_ref,entry_ref,revision,revision_ref,provenance_ref,source_kind,source_ref,
      source_digest,actor_subject_ref,actor_subject_generation,actor_project_ref,
      actor_membership_epoch,actor_authorization_epoch,recorded_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::timestamptz)`,
    [provenance.siteRef, provenance.spaceRef, provenance.entryRef, revision, provenance.revisionRef,
      provenance.provenanceRef, provenance.sourceKind, provenance.sourceRef, provenance.sourceDigest,
      provenance.actorSubjectRef, provenance.actorSubjectGeneration, provenance.actorProjectRef,
      provenance.actorMembershipEpoch, provenance.actorAuthorizationEpoch, provenance.recordedAt],
  );
  if (inserted !== 1) throw new MemoryApplicationError("MEMORY_PERSISTENCE_CONFLICT");
}

function updateSpace(sql: Sql, expectedVersion: AggregateVersion, space: MemorySpace): Promise<number> {
  return sql.execute(
    `UPDATE platform.memory_space
     SET version=$1,space_generation=$2,learning_generation=$3,revocation_epoch=$4,
         minimum_learnable_source_origin_seq=$5,learning_state=$6,use_state=$7,state=$8,
         updated_at=$9::timestamptz
     WHERE site_ref=$10 AND space_ref=$11 AND version=$12`,
    [space.version, space.spaceGeneration, space.learningGeneration, space.revocationEpoch,
      space.minimumLearnableSourceOriginSequence, space.learningState, space.useState, space.state,
      space.updatedAt, memoryBindingSiteRef(space.binding), space.spaceRef, expectedVersion],
  );
}

function entryValues(entry: MemoryEntry): readonly unknown[] {
  return [entry.siteRef, entry.spaceRef, entry.entryRef, entry.version, entry.currentRevision,
    entry.currentRevisionRef, entry.state, entry.category, entry.featurePolicyRevisionRef,
    entry.spaceGeneration, entry.learningGeneration, entry.revocationEpoch, entry.createdAt,
    entry.updatedAt, entry.deletedAt];
}

function spaceBindingColumns(binding: MemoryScopeBinding): SpaceBindingColumns {
  const base = memoryBaseBinding(binding);
  return Object.freeze({
    siteRef: base.siteRef,
    scopeKind: binding.kind,
    parentSpaceRef: binding.kind === "agent_product" ? binding.parentSpaceRef : null,
    parentSpaceGeneration: binding.kind === "agent_product" ? binding.parentSpaceGeneration : null,
    parentLearningGeneration: binding.kind === "agent_product" ? binding.parentLearningGeneration : null,
    parentRevocationEpoch: binding.kind === "agent_product" ? binding.parentRevocationEpoch : null,
    subjectRef: base.kind === "user" ? base.subjectRef : null,
    subjectGeneration: base.kind === "user" ? base.subjectGeneration : null,
    projectRef: base.kind === "project" ? base.projectRef : null,
    agentOptionRef: binding.kind === "agent_product" ? binding.agentOptionRef : null,
    productSurfaceRef: binding.kind === "agent_product" ? binding.productSurfaceRef : null,
  });
}

function decodeSpace(row: SpaceRow): MemorySpace {
  const binding = decodeSpaceBinding(row);
  return rehydrateMemorySpace({ spaceRef: row.spaceRef, binding,
    featurePolicyRevisionRef: row.featurePolicyRevisionRef, version: dbInt8(row.version),
    spaceGeneration: dbInt8(row.spaceGeneration), learningGeneration: dbInt8(row.learningGeneration),
    revocationEpoch: dbInt8(row.revocationEpoch),
    minimumLearnableSourceOriginSequence: dbInt8(row.minimumSourceOriginSequence),
    learningState: row.learningState, useState: row.useState, state: row.state,
    createdAt: dbInstant(row.createdAt), updatedAt: dbInstant(row.updatedAt) });
}

function decodeSpaceBinding(row: SpaceRow): MemoryScopeBinding {
  const user = () => ({ kind: "user" as const, siteRef: row.siteRef, subjectRef: row.subjectRef,
    subjectGeneration: persistenceRequiredInt8(row.subjectGeneration) });
  const project = () => ({ kind: "project" as const, siteRef: row.siteRef,
    projectRef: persistenceRequiredString(row.projectRef) });
  switch (row.scopeKind) {
    case "user":
      requirePersistenceNull(row.parentSpaceRef, row.projectRef, row.agentOptionRef,
        row.productSurfaceRef);
      return rehydrateMemoryScopeBinding(user());
    case "project":
      requirePersistenceNull(row.parentSpaceRef, row.subjectRef, row.subjectGeneration,
        row.agentOptionRef, row.productSurfaceRef);
      return rehydrateMemoryScopeBinding(project());
    case "agent_product": {
      const parentBinding = row.projectRef === null
        ? user()
        : (requirePersistenceNull(row.subjectRef, row.subjectGeneration), project());
      return rehydrateMemoryScopeBinding({ kind: "agent_product",
        parentSpaceRef: persistenceRequiredString(row.parentSpaceRef), parentBinding,
        parentSpaceGeneration: persistenceRequiredInt8(row.parentSpaceGeneration),
        parentLearningGeneration: persistenceRequiredInt8(row.parentLearningGeneration),
        parentRevocationEpoch: persistenceRequiredInt8(row.parentRevocationEpoch),
        agentOptionRef: persistenceRequiredString(row.agentOptionRef),
        productSurfaceRef: persistenceRequiredString(row.productSurfaceRef) });
    }
    default: throw new MemoryApplicationError("MEMORY_PERSISTENCE_CONFLICT");
  }
}

function decodeEntry(row: EntryRow): MemoryEntry {
  return rehydrateMemoryEntry({ siteRef: row.siteRef, spaceRef: row.spaceRef, entryRef: row.entryRef,
    version: dbInt8(row.version), currentRevision: dbInt8(row.currentRevision),
    currentRevisionRef: row.currentRevisionRef, state: row.state, category: row.category,
    featurePolicyRevisionRef: row.featurePolicyRevisionRef,
    spaceGeneration: dbInt8(row.spaceGeneration), learningGeneration: dbInt8(row.learningGeneration),
    revocationEpoch: dbInt8(row.revocationEpoch), createdAt: dbInstant(row.createdAt),
    updatedAt: dbInstant(row.updatedAt), deletedAt: row.deletedAt === null ? null : dbInstant(row.deletedAt) });
}

function decodeReceiptResult(row: ReceiptRow): MemoryCommandResult {
  const spaceRef = memorySpaceRef(row.resultSpaceRef);
  const spaceVersion = memoryAggregateVersion(dbInt8(row.resultSpaceVersion));
  switch (row.resultKind) {
    case "remembered":
    case "corrected":
      requireNull(row.resultSpaceGeneration, row.resultLearningGeneration, row.resultRevocationEpoch,
        row.resultMinimumSourceOriginSequence, row.resultLearningState, row.resultUseState,
        row.resultPreviousFeaturePolicyRevisionRef, row.resultFeaturePolicyRevisionRef);
      return Object.freeze({ kind: row.resultKind, spaceRef, spaceVersion,
        entryRef: memoryEntryRef(requiredString(row.resultEntryRef)),
        entryVersion: memoryAggregateVersion(dbRequiredInt8(row.resultEntryVersion)),
        revisionRef: memoryRevisionRef(requiredString(row.resultRevisionRef)),
        revision: memoryRevisionNumber(dbRequiredInt8(row.resultRevision)) });
    case "forgotten":
      requireNull(row.resultRevisionRef, row.resultRevision, row.resultSpaceGeneration,
        row.resultLearningGeneration, row.resultMinimumSourceOriginSequence,
        row.resultLearningState, row.resultUseState, row.resultPreviousFeaturePolicyRevisionRef,
        row.resultFeaturePolicyRevisionRef);
      return Object.freeze({ kind: "forgotten", spaceRef, spaceVersion,
        entryRef: memoryEntryRef(requiredString(row.resultEntryRef)),
        entryVersion: memoryAggregateVersion(dbRequiredInt8(row.resultEntryVersion)),
        revocationEpoch: memoryRevocationEpoch(dbRequiredInt8(row.resultRevocationEpoch)) });
    case "learning_paused":
    case "learning_resumed":
    case "use_paused":
    case "use_resumed":
    case "reset":
      requireNull(row.resultEntryRef, row.resultEntryVersion, row.resultRevisionRef, row.resultRevision,
        row.resultPreviousFeaturePolicyRevisionRef, row.resultFeaturePolicyRevisionRef);
      return Object.freeze({ kind: row.resultKind, spaceRef, spaceVersion,
        spaceGeneration: memorySpaceGeneration(dbRequiredInt8(row.resultSpaceGeneration)),
        learningGeneration: memoryLearningGeneration(dbRequiredInt8(row.resultLearningGeneration)),
        revocationEpoch: memoryRevocationEpoch(dbRequiredInt8(row.resultRevocationEpoch)),
        minimumLearnableSourceOriginSequence:
          memorySourceOriginSequence(dbRequiredInt8(row.resultMinimumSourceOriginSequence)),
        learningState: controlState(row.resultLearningState), useState: controlState(row.resultUseState) });
    case "policy_rebound": {
      requireNull(row.resultEntryRef, row.resultEntryVersion, row.resultRevisionRef, row.resultRevision);
      const previousPolicy = memoryFeaturePolicyRevisionRef(
        requiredString(row.resultPreviousFeaturePolicyRevisionRef));
      const nextPolicy = memoryFeaturePolicyRevisionRef(requiredString(row.resultFeaturePolicyRevisionRef));
      if (previousPolicy === nextPolicy || controlState(row.resultLearningState) !== "paused" ||
        controlState(row.resultUseState) !== "paused") {
        throw new MemoryApplicationError("MEMORY_RECEIPT_INVALID");
      }
      return Object.freeze({ kind: "policy_rebound", spaceRef, spaceVersion,
        previousFeaturePolicyRevisionRef: previousPolicy,
        featurePolicyRevisionRef: nextPolicy,
        spaceGeneration: memorySpaceGeneration(dbRequiredInt8(row.resultSpaceGeneration)),
        learningGeneration: memoryLearningGeneration(dbRequiredInt8(row.resultLearningGeneration)),
        revocationEpoch: memoryRevocationEpoch(dbRequiredInt8(row.resultRevocationEpoch)),
        minimumLearnableSourceOriginSequence:
          memorySourceOriginSequence(dbRequiredInt8(row.resultMinimumSourceOriginSequence)),
        learningState: "paused", useState: "paused" });
    }
    default: throw new MemoryApplicationError("MEMORY_RECEIPT_INVALID");
  }
}

function decodeReceiptResultSafely(row: ReceiptRow): MemoryCommandResult {
  try {
    return decodeReceiptResult(row);
  } catch {
    throw new MemoryApplicationError("MEMORY_RECEIPT_INVALID");
  }
}

function decodeReceiptStoredIdentity(row: ReceiptRow): Readonly<{
  operation: MemoryCommandReceiptIdentity["operation"];
  requestDigest: string;
}> {
  const operations = ["remember", "correct", "forget", "pause_learning", "resume_learning",
    "pause_use", "resume_use", "reset", "rebind_policy"] as const;
  if (typeof row.operation !== "string" ||
    !operations.includes(row.operation as (typeof operations)[number]) ||
    typeof row.requestDigest !== "string" || !/^[a-f0-9]{64}$/u.test(row.requestDigest)) {
    throw new MemoryApplicationError("MEMORY_RECEIPT_INVALID");
  }
  return Object.freeze({ operation: row.operation as (typeof operations)[number],
    requestDigest: row.requestDigest });
}

function resultKindForOperation(
  operation: MemoryCommandReceiptIdentity["operation"],
): MemoryCommandResult["kind"] {
  switch (operation) {
    case "remember": return "remembered";
    case "correct": return "corrected";
    case "forget": return "forgotten";
    case "pause_learning": return "learning_paused";
    case "resume_learning": return "learning_resumed";
    case "pause_use": return "use_paused";
    case "resume_use": return "use_resumed";
    case "reset": return "reset";
    case "rebind_policy": return "policy_rebound";
  }
}

function receiptResultColumns(result: MemoryCommandResult): ReceiptResultColumns {
  switch (result.kind) {
    case "remembered":
    case "corrected": return Object.freeze({ resultKind: result.kind, resultSpaceRef: result.spaceRef,
      resultSpaceVersion: result.spaceVersion, resultEntryRef: result.entryRef,
      resultEntryVersion: result.entryVersion, resultRevisionRef: result.revisionRef,
      resultRevision: result.revision, resultSpaceGeneration: null, resultLearningGeneration: null,
      resultRevocationEpoch: null, resultMinimumSourceOriginSequence: null,
      resultLearningState: null, resultUseState: null,
      resultPreviousFeaturePolicyRevisionRef: null, resultFeaturePolicyRevisionRef: null });
    case "forgotten": return Object.freeze({ resultKind: result.kind, resultSpaceRef: result.spaceRef,
      resultSpaceVersion: result.spaceVersion, resultEntryRef: result.entryRef,
      resultEntryVersion: result.entryVersion, resultRevisionRef: null, resultRevision: null,
      resultSpaceGeneration: null, resultLearningGeneration: null,
      resultRevocationEpoch: result.revocationEpoch, resultMinimumSourceOriginSequence: null,
      resultLearningState: null, resultUseState: null,
      resultPreviousFeaturePolicyRevisionRef: null, resultFeaturePolicyRevisionRef: null });
    case "learning_paused":
    case "learning_resumed":
    case "use_paused":
    case "use_resumed":
    case "reset": return Object.freeze({ resultKind: result.kind, resultSpaceRef: result.spaceRef,
      resultSpaceVersion: result.spaceVersion, resultEntryRef: null, resultEntryVersion: null,
      resultRevisionRef: null, resultRevision: null, resultSpaceGeneration: result.spaceGeneration,
      resultLearningGeneration: result.learningGeneration, resultRevocationEpoch: result.revocationEpoch,
      resultMinimumSourceOriginSequence: result.minimumLearnableSourceOriginSequence,
      resultLearningState: result.learningState, resultUseState: result.useState,
      resultPreviousFeaturePolicyRevisionRef: null, resultFeaturePolicyRevisionRef: null });
    case "policy_rebound": return Object.freeze({ resultKind: result.kind,
      resultSpaceRef: result.spaceRef, resultSpaceVersion: result.spaceVersion,
      resultEntryRef: null, resultEntryVersion: null, resultRevisionRef: null, resultRevision: null,
      resultSpaceGeneration: result.spaceGeneration, resultLearningGeneration: result.learningGeneration,
      resultRevocationEpoch: result.revocationEpoch,
      resultMinimumSourceOriginSequence: result.minimumLearnableSourceOriginSequence,
      resultLearningState: result.learningState, resultUseState: result.useState,
      resultPreviousFeaturePolicyRevisionRef: result.previousFeaturePolicyRevisionRef,
      resultFeaturePolicyRevisionRef: result.featurePolicyRevisionRef });
  }
}

function receiptOwnerColumns(identity: MemoryCommandReceiptIdentity): ReceiptOwnerColumns {
  const actor = identity.actorAuthorization;
  if (identity.owner.kind === "user" && (actor.kind !== "user" ||
    actor.siteRef !== identity.owner.siteRef || actor.subjectRef !== identity.owner.subjectRef ||
    actor.subjectGeneration !== identity.owner.subjectGeneration)) {
    throw new MemoryApplicationError("MEMORY_RECEIPT_INVALID");
  }
  if (identity.owner.kind === "project" && (actor.kind !== "project_member" ||
    actor.siteRef !== identity.owner.siteRef || actor.projectRef !== identity.owner.projectRef)) {
    throw new MemoryApplicationError("MEMORY_RECEIPT_INVALID");
  }
  return identity.owner.kind === "user"
    ? Object.freeze({ siteRef: identity.owner.siteRef, ownerScopeKind: "user" as const,
      ownerSubjectRef: identity.owner.subjectRef,
      ownerSubjectGeneration: identity.owner.subjectGeneration, ownerProjectRef: null,
      callerSubjectRef: actor.subjectRef, callerSubjectGeneration: actor.subjectGeneration,
      callerMembershipEpoch: null, callerAuthorizationEpoch: null })
    : Object.freeze({ siteRef: identity.owner.siteRef, ownerScopeKind: "project" as const,
      ownerSubjectRef: null, ownerSubjectGeneration: null, ownerProjectRef: identity.owner.projectRef,
      callerSubjectRef: actor.subjectRef, callerSubjectGeneration: actor.subjectGeneration,
      callerMembershipEpoch: actor.kind === "project_member" ? actor.membershipEpoch : null,
      callerAuthorizationEpoch: actor.kind === "project_member" ? actor.authorizationEpoch : null });
}

function dbInt8(value: unknown): bigint {
  if (typeof value === "bigint") return value;
  if (typeof value === "string" && /^(?:0|[1-9][0-9]{0,18})$/u.test(value)) {
    const parsed = BigInt(value);
    if (parsed <= 9_223_372_036_854_775_807n) return parsed;
  }
  throw new MemoryApplicationError("MEMORY_PERSISTENCE_CONFLICT");
}
function dbRequiredInt8(value: unknown): bigint {
  if (value === null) throw new MemoryApplicationError("MEMORY_RECEIPT_INVALID");
  return dbInt8(value);
}
function persistenceRequiredInt8(value: unknown): bigint {
  if (value === null) throw new MemoryApplicationError("MEMORY_PERSISTENCE_CONFLICT");
  return dbInt8(value);
}
function dbInstant(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  return memoryInstant(value);
}
function requiredString(value: unknown): string {
  if (typeof value !== "string") throw new MemoryApplicationError("MEMORY_RECEIPT_INVALID");
  return value;
}
function persistenceRequiredString(value: unknown): string {
  if (typeof value !== "string") throw new MemoryApplicationError("MEMORY_PERSISTENCE_CONFLICT");
  return value;
}
function requireNull(...values: readonly unknown[]): void {
  if (values.some((value) => value !== null)) throw new MemoryApplicationError("MEMORY_RECEIPT_INVALID");
}
function requirePersistenceNull(...values: readonly unknown[]): void {
  if (values.some((value) => value !== null)) {
    throw new MemoryApplicationError("MEMORY_PERSISTENCE_CONFLICT");
  }
}
function controlState(value: unknown): "active" | "paused" {
  if (value !== "active" && value !== "paused") {
    throw new MemoryApplicationError("MEMORY_RECEIPT_INVALID");
  }
  return value;
}

type SpaceRow = Readonly<Record<string, unknown> & {
  siteRef: unknown; spaceRef: unknown; scopeKind: unknown; parentSpaceRef: unknown;
  parentSpaceGeneration: unknown; parentLearningGeneration: unknown; parentRevocationEpoch: unknown;
  subjectRef: unknown; subjectGeneration: unknown; projectRef: unknown;
  agentOptionRef: unknown; productSurfaceRef: unknown;
  featurePolicyRevisionRef: unknown; version: unknown; spaceGeneration: unknown;
  learningGeneration: unknown; revocationEpoch: unknown; minimumSourceOriginSequence: unknown;
  learningState: unknown; useState: unknown; state: unknown; createdAt: unknown; updatedAt: unknown;
}>;
type EntryRow = Readonly<Record<string, unknown> & {
  siteRef: unknown; spaceRef: unknown; entryRef: unknown; version: unknown; currentRevision: unknown;
  currentRevisionRef: unknown; state: unknown; category: unknown; featurePolicyRevisionRef: unknown;
  spaceGeneration: unknown; learningGeneration: unknown; revocationEpoch: unknown;
  createdAt: unknown; updatedAt: unknown; deletedAt: unknown;
}>;
type ReceiptRow = Readonly<Record<string, unknown> & {
  operation: unknown; requestDigest: unknown; resultKind: unknown; resultSpaceRef: unknown;
  resultSpaceVersion: unknown;
  resultEntryRef: unknown; resultEntryVersion: unknown; resultRevisionRef: unknown;
  resultRevision: unknown; resultSpaceGeneration: unknown; resultLearningGeneration: unknown;
  resultRevocationEpoch: unknown; resultMinimumSourceOriginSequence: unknown;
  resultLearningState: unknown; resultUseState: unknown;
  resultPreviousFeaturePolicyRevisionRef: unknown; resultFeaturePolicyRevisionRef: unknown;
}>;
type SpaceBindingColumns = Readonly<{
  siteRef: SiteRef; scopeKind: MemoryScopeBinding["kind"]; parentSpaceRef: string | null;
  parentSpaceGeneration: bigint | null; parentLearningGeneration: bigint | null;
  parentRevocationEpoch: bigint | null;
  subjectRef: string | null; subjectGeneration: bigint | null; projectRef: string | null;
  agentOptionRef: string | null; productSurfaceRef: string | null;
}>;
type ReceiptOwnerColumns = Readonly<{
  siteRef: SiteRef; ownerScopeKind: "user" | "project"; ownerSubjectRef: string | null;
  ownerSubjectGeneration: bigint | null; ownerProjectRef: string | null;
  callerSubjectRef: string; callerSubjectGeneration: bigint;
  callerMembershipEpoch: bigint | null; callerAuthorizationEpoch: bigint | null;
}>;
type ReceiptResultColumns = Readonly<{
  resultKind: MemoryCommandResult["kind"]; resultSpaceRef: MemorySpaceRef;
  resultSpaceVersion: bigint; resultEntryRef: string | null; resultEntryVersion: bigint | null;
  resultRevisionRef: string | null; resultRevision: bigint | null;
  resultSpaceGeneration: bigint | null; resultLearningGeneration: bigint | null;
  resultRevocationEpoch: bigint | null; resultMinimumSourceOriginSequence: bigint | null;
  resultLearningState: "active" | "paused" | null; resultUseState: "active" | "paused" | null;
  resultPreviousFeaturePolicyRevisionRef: string | null;
  resultFeaturePolicyRevisionRef: string | null;
}>;
