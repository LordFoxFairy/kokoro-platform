import { resolvePlatformTransaction } from
  "../../../shared/unit-of-work/platform-transaction.js";
import type { PlatformTransaction } from "../../../shared/unit-of-work/index.js";
import { MemoryApplicationError } from "../application/memory-application-error.js";
import { MemoryAuthorityService } from "../application/memory-authority-service.js";
import type { MemoryAuthorizationFactsPort, MemoryAuthorityRepository, MemoryCommandReceiptIdentity,
  MemoryCommandResult, MemoryPublicCommand, MemoryPublicCommandResult, MemoryPublicEntryRecord,
  MemoryPublicRecoveryIdentity, MemoryPublicRecoveryResult, MemoryPublicRepository,
  MemoryPublicResolvedOwner, MemoryPublicRevisionRecord, MemoryTransitionAuthorityPort } from
  "../application/memory-authority-ports.js";
import { rehydrateMemoryEntry, type MemoryEntry, type RememberedMemory } from
  "../domain/memory-entry.js";
import { rehydrateMemorySpace, type MemorySpace } from "../domain/memory-space.js";
import { createProtectedMemoryContent } from "../domain/protected-memory-content.js";

const PREPARE_ROUTINE = Object.freeze({
  remember: "memory_public_prepare_remember",
  correct: "memory_public_prepare_correct",
  restore: "memory_public_prepare_restore",
  prioritize: "memory_public_prepare_prioritize",
  deprioritize: "memory_public_prepare_deprioritize",
  forget: "memory_public_prepare_forget",
  reset: "memory_public_prepare_reset",
} as const);
const COMMIT_ROUTINE = Object.freeze({
  remember: "memory_public_commit_remember",
  correct: "memory_public_commit_correct",
  restore: "memory_public_commit_restore",
  prioritize: "memory_public_commit_prioritize",
  deprioritize: "memory_public_commit_deprioritize",
  forget: "memory_public_commit_forget",
  reset: "memory_public_commit_reset",
} as const);

/** Dedicated public adapter. Every statement invokes one operation-specific, fixed-shape routine. */
export class PostgresMemoryPublicRepository implements MemoryPublicRepository {
  constructor(private readonly transitionAuthority: MemoryTransitionAuthorityPort) {}
  async recoverCommand(transaction: PlatformTransaction, identity: MemoryPublicRecoveryIdentity):
    Promise<MemoryPublicRecoveryResult> {
    const decision = await prepareCommand(transaction, identity);
    if (decision.decision === "digest_conflict") {
      return typeof decision.requestDigestKeyRevision === "string"
        ? Object.freeze({ kind: "digest_mismatch" as const,
          requestDigestKeyRevision: string(decision.requestDigestKeyRevision,
            "MEMORY_PUBLIC_COMMAND_RECORD_CORRUPT") })
        : Object.freeze({ kind: "digest_mismatch" as const,
          requestDigestKeyRevision: identity.requestDigestKeyRevision });
    }
    if (decision.decision === "replay") {
      return Object.freeze({ kind: "replay" as const, result: commandResult(decision, true) });
    }
    if (decision.decision !== "claimed") throw corrupt("MEMORY_PUBLIC_COMMAND_RECORD_CORRUPT");
    return Object.freeze({ kind: "continue" as const });
  }

  async resolveOwner(transaction: PlatformTransaction,
    input: Parameters<MemoryPublicRepository["resolveOwner"]>[1]):
    Promise<MemoryPublicResolvedOwner | null> {
    const routine = input.operation === "list_entries" ? "memory_public_list_entries_owner"
      : input.operation === "get_entry" ? "memory_public_get_entry_owner"
      : input.operation === "list_history" ? "memory_public_list_entry_history_owner"
      : "memory_public_restore_owner";
    const rows = await resolvePlatformTransaction(transaction).query<Record<string, unknown>>(
      `SELECT platform.${routine}($1,$2,$3::bigint,$4,$5,$6::timestamptz) AS result`,
      ownerValues(input.context, [input.candidateSpaceRef, input.now]),
    );
    const result = oneResult(rows, "MEMORY_PUBLIC_OWNER_RECORD_CORRUPT");
    return result === null ? null : ownerRecord(input.context, result);
  }

  async listEntries(transaction: PlatformTransaction,
    input: Parameters<MemoryPublicRepository["listEntries"]>[1]):
    Promise<readonly MemoryPublicEntryRecord[]> {
    const after = input.after;
    const rows = await resolvePlatformTransaction(transaction).query<Record<string, unknown>>(
      `SELECT platform.memory_public_list_entries($1,$2,$3::bigint,$4,$5,$6::bigint,$7,$8,
        $9::boolean,$10::timestamptz,$11,$12::integer) AS result`,
      ownerValues(input.owner.context, [input.owner.spaceRef, input.owner.spaceVersion,
        input.category, input.source, after?.prioritized ?? null, after?.updatedAt ?? null,
        after?.entryRef ?? null, input.limit]),
    );
    const result = oneResult(rows, "MEMORY_PUBLIC_ENTRY_RECORD_CORRUPT");
    if (result === null) return Object.freeze([]);
    if (!Array.isArray(result)) throw corrupt("MEMORY_PUBLIC_ENTRY_RECORD_CORRUPT");
    return Object.freeze(result.map(entryRecord));
  }

  async getEntry(transaction: PlatformTransaction,
    input: Parameters<MemoryPublicRepository["getEntry"]>[1]):
    Promise<MemoryPublicEntryRecord | null> {
    const rows = await resolvePlatformTransaction(transaction).query<Record<string, unknown>>(
      `SELECT platform.memory_public_get_entry($1,$2,$3::bigint,$4,$5,$6::bigint,$7) AS result`,
      ownerValues(input.owner.context, [input.owner.spaceRef, input.owner.spaceVersion, input.entryRef]),
    );
    const result = oneResult(rows, "MEMORY_PUBLIC_ENTRY_RECORD_CORRUPT");
    return result === null ? null : entryRecord(result);
  }

  async listHistory(transaction: PlatformTransaction,
    input: Parameters<MemoryPublicRepository["listHistory"]>[1]):
    Promise<Readonly<{ entry: MemoryPublicEntryRecord;
      revisions: readonly MemoryPublicRevisionRecord[] }> | null> {
    const rows = await resolvePlatformTransaction(transaction).query<Record<string, unknown>>(
      `SELECT platform.memory_public_list_entry_history($1,$2,$3::bigint,$4,$5,$6::bigint,$7,
        $8::bigint,$9::integer) AS result`,
      ownerValues(input.owner.context, [input.owner.spaceRef, input.owner.spaceVersion,
        input.entryRef, input.revisionBefore, input.limit]),
    );
    const result = oneResult(rows, "MEMORY_PUBLIC_HISTORY_RECORD_CORRUPT");
    if (result === null) return null;
    const record = object(result, "MEMORY_PUBLIC_HISTORY_RECORD_CORRUPT");
    if (!Array.isArray(record.revisions)) throw corrupt("MEMORY_PUBLIC_HISTORY_RECORD_CORRUPT");
    return Object.freeze({ entry: entryRecord(record.entry),
      revisions: Object.freeze(record.revisions.map(revisionRecord)) });
  }

  async getRevisionForRestore(transaction: PlatformTransaction,
    input: Parameters<NonNullable<MemoryPublicRepository["getRevisionForRestore"]>>[1]):
    Promise<MemoryPublicRevisionRecord | null> {
    const rows = await resolvePlatformTransaction(transaction).query<Record<string, unknown>>(
      `SELECT platform.memory_public_get_restorable_revision($1,$2,$3::bigint,$4,$5,$6::bigint,
        $7,$8,$9::integer) AS result`,
      ownerValues(input.owner.context, [input.owner.spaceRef, input.owner.spaceVersion,
        input.entryRef, input.revisionRef, input.expectedRevision]),
    );
    const result = oneResult(rows, "MEMORY_PUBLIC_HISTORY_RECORD_CORRUPT");
    return result === null ? null : revisionRecord(result);
  }

  async executeCommand(transaction: PlatformTransaction, command: MemoryPublicCommand):
    Promise<MemoryPublicCommandResult> {
    const sql = resolvePlatformTransaction(transaction);
    const decision = await prepareCommand(transaction, command);
    if (decision.decision === "digest_conflict") {
      throw new MemoryApplicationError("MEMORY_COMMAND_DIGEST_CONFLICT");
    }
    if (decision.decision === "replay") return commandResult(decision, true);
    if (decision.decision !== "claimed") throw corrupt("MEMORY_PUBLIC_COMMAND_RECORD_CORRUPT");
    const core = command.operation === "remember" || command.operation === "correct" ||
      command.operation === "forget" || command.operation === "reset";
    const unsignedCommitPayload = core
      ? await validatedCoreCommitPayload(transaction, command, decision)
      : Object.freeze({ command: commandJson(command),
        prepareRef: string(decision.prepareRef, "MEMORY_PUBLIC_COMMAND_RECORD_CORRUPT"),
        expectedStateDigest: string(decision.expectedStateDigest,
          "MEMORY_PUBLIC_COMMAND_RECORD_CORRUPT") });
    const canonicalPayload = canonicalJson(unsignedCommitPayload);
    const authority = await this.transitionAuthority.issue({ canonicalPayload });
    if (!/^[A-Za-z0-9_-]{3,128}$/u.test(authority.keyRevision) ||
      !/^[a-f0-9]{64}$/u.test(authority.digest)) throw corrupt("MEMORY_PUBLIC_COMMAND_RECORD_CORRUPT");
    const commitPayload = Object.freeze({ ...unsignedCommitPayload, authority: Object.freeze({
      keyRevision: authority.keyRevision, canonicalPayload, digest: authority.digest,
    }) });
    const commitRows = await sql.query<Record<string, unknown>>(
      `SELECT platform.${COMMIT_ROUTINE[command.operation]}($1::jsonb) AS result`,
      [JSON.stringify(commitPayload)],
    );
    const committed = oneResult(commitRows, "MEMORY_PUBLIC_COMMAND_RECORD_CORRUPT") ??
      Object.freeze({ ...decision, decision: "committed" });
    return commandResult(object(committed, "MEMORY_PUBLIC_COMMAND_RECORD_CORRUPT"), false, command);
  }
}

async function prepareCommand(transaction: PlatformTransaction, identity: MemoryPublicRecoveryIdentity) {
  const sql = resolvePlatformTransaction(transaction);
  const prepareRows = await sql.query<Record<string, unknown>>(
    `SELECT platform.${PREPARE_ROUTINE[identity.operation]}($1,$2,$3::bigint,$4,$5,$6,$7,$8,$9,$10) AS result`,
    ownerValues(identity.context, [identity.commandRef, identity.requestDigest,
      identity.requestDigestKeyRevision, identity.spaceRef, identity.entryRef, identity.revisionRef]),
  );
  const prepared = oneResult(prepareRows, "MEMORY_PUBLIC_COMMAND_RECORD_CORRUPT") ??
    prepareRows[0] ?? null;
  if (prepared === null) throw new MemoryApplicationError("MEMORY_PUBLIC_NOT_AVAILABLE");
  return exactObject(prepared, ["decision", "kind", "spaceRef", "spaceVersion", "persisted",
    "entryRef", "revisionRef", "prepareRef", "expectedStateDigest", "spaceState", "entryState",
    "committedSpaceVersion", "entryVersion", "revision", "restoredFromRevisionRef", "prioritized",
    "requestDigestKeyRevision"] as const, "MEMORY_PUBLIC_COMMAND_RECORD_CORRUPT");
}

async function validatedCoreCommitPayload(transaction: PlatformTransaction, command: MemoryPublicCommand,
  prepared: Readonly<Record<string, unknown>>) {
  const stage = new StagedMemoryAuthorityRepository(prepared);
  const authority: MemoryAuthorizationFactsPort = {
    revalidate: async (_transaction, expected) => {
      const binding = expected.binding;
      if (binding.kind !== "user" || binding.siteRef !== command.context.siteRef ||
        binding.subjectRef !== command.context.subjectRef ||
        binding.subjectGeneration !== command.context.subjectGeneration ||
        expected.featurePolicyRevisionRef !== command.context.featurePolicyRevisionRef) {
        return { kind: "denied", reason: "feature_policy_mismatch" };
      }
      return { kind: "authorized", actorAuthorization: binding,
        featurePolicyRevisionRef: expected.featurePolicyRevisionRef };
    },
  };
  const service = new MemoryAuthorityService(stage, authority);
  const binding = Object.freeze({ kind: "user" as const, siteRef: command.context.siteRef,
    subjectRef: command.context.subjectRef, subjectGeneration: command.context.subjectGeneration });
  const space = stage.space;
  const entry = stage.entry;
  switch (command.operation) {
    case "remember":
      await service.remember(transaction, { commandRef: command.commandRef, binding,
        spaceRef: command.spaceRef, expectedSpaceVersion: space?.version ?? 0n,
        entryRef: requiredCommandString(command.entryRef),
        revisionRef: requiredCommandString(command.revisionRef),
        provenanceRef: requiredCommandString(command.provenanceRef), sourceDigest: command.requestDigest,
        protectedContent: requiredProtected(command), category: command.category,
        featurePolicyRevisionRef: command.context.featurePolicyRevisionRef,
        recordedAt: command.recordedAt });
      break;
    case "correct":
      if (space === null || entry === null) throw new MemoryApplicationError("MEMORY_PUBLIC_NOT_AVAILABLE");
      await service.correct(transaction, { commandRef: command.commandRef,
        siteRef: command.context.siteRef, spaceRef: command.spaceRef,
        expectedSpaceVersion: space.version, entryRef: requiredCommandString(command.entryRef),
        expectedEntryVersion: entry.version,
        expectedCurrentRevision: BigInt(requiredExpectedRevision(command.expectedRevision)),
        revisionRef: requiredCommandString(command.revisionRef),
        provenanceRef: requiredCommandString(command.provenanceRef), sourceDigest: command.requestDigest,
        protectedContent: requiredProtected(command),
        featurePolicyRevisionRef: command.context.featurePolicyRevisionRef,
        recordedAt: command.recordedAt });
      break;
    case "forget":
      if (space === null || entry === null) throw new MemoryApplicationError("MEMORY_PUBLIC_NOT_AVAILABLE");
      await service.forget(transaction, { commandRef: command.commandRef,
        siteRef: command.context.siteRef, spaceRef: command.spaceRef,
        expectedSpaceVersion: space.version, entryRef: requiredCommandString(command.entryRef),
        expectedEntryVersion: command.expectedEntryVersion,
        featurePolicyRevisionRef: command.context.featurePolicyRevisionRef,
        recordedAt: command.recordedAt });
      break;
    case "reset":
      if (space === null) throw new MemoryApplicationError("MEMORY_PUBLIC_NOT_AVAILABLE");
      await service.reset(transaction, { commandRef: command.commandRef,
        siteRef: command.context.siteRef, spaceRef: command.spaceRef,
        expectedSpaceVersion: space.version,
        featurePolicyRevisionRef: command.context.featurePolicyRevisionRef,
        cutoffOriginSequence: space.minimumLearnableSourceOriginSequence,
        recordedAt: command.recordedAt });
      break;
    default: throw corrupt("MEMORY_PUBLIC_COMMAND_RECORD_CORRUPT");
  }
  return Object.freeze({ command: commandJson(command),
    prepareRef: string(prepared.prepareRef, "MEMORY_PUBLIC_COMMAND_RECORD_CORRUPT"),
    expectedStateDigest: string(prepared.expectedStateDigest,
      "MEMORY_PUBLIC_COMMAND_RECORD_CORRUPT"), transition: stage.serializedTransition() });
}

type StagedTransition =
  | Readonly<{ kind: "remember"; newSpace: MemorySpace | null; remembered: RememberedMemory }>
  | Readonly<{ kind: "correct"; expected: Readonly<{ entryVersion: bigint;
      currentRevision: bigint }>; corrected: RememberedMemory }>
  | Readonly<{ kind: "forget"; expected: Readonly<{ spaceVersion: bigint;
      entryVersion: bigint }>; space: MemorySpace; entry: MemoryEntry }>
  | Readonly<{ kind: "reset"; expectedVersion: bigint; space: MemorySpace }>;

class StagedMemoryAuthorityRepository implements MemoryAuthorityRepository {
  readonly space: MemorySpace | null;
  readonly entry: MemoryEntry | null;
  #transition: StagedTransition | null = null;
  #result: MemoryCommandResult | null = null;

  constructor(prepared: Readonly<Record<string, unknown>>) {
    this.space = prepared.spaceState === null || prepared.spaceState === undefined
      ? null : rehydrateMemorySpace(decodeStagedSpace(prepared.spaceState));
    this.entry = prepared.entryState === null || prepared.entryState === undefined
      ? null : rehydrateMemoryEntry(decodeStagedEntry(prepared.entryState));
  }

  async loadSpaceAuthorityForUpdate(): Promise<Readonly<{ space: MemorySpace | null;
    parent: MemorySpace | null }>> { return Object.freeze({ space: this.space, parent: null }); }
  async loadSpaceForUpdate(): Promise<MemorySpace | null> { return this.space; }
  async loadEntryForUpdate(): Promise<MemoryEntry | null> { return this.entry; }
  async claimReceipt(): Promise<Readonly<{ kind: "claimed" }>> { return Object.freeze({ kind: "claimed" }); }
  async completeReceipt(_transaction: PlatformTransaction, _identity: MemoryCommandReceiptIdentity,
    result: MemoryCommandResult): Promise<void> { this.#result = result; }
  async saveRememberedMemory(_transaction: PlatformTransaction, newSpace: MemorySpace | null,
    remembered: RememberedMemory): Promise<void> {
    this.#set(Object.freeze({ kind: "remember", newSpace, remembered }));
  }
  async saveCorrectedMemory(_transaction: PlatformTransaction,
    expected: Readonly<{ entryVersion: bigint; currentRevision: bigint }>,
    corrected: RememberedMemory): Promise<void> {
    this.#set(Object.freeze({ kind: "correct", expected, corrected }));
  }
  async saveForgottenMemory(_transaction: PlatformTransaction,
    expected: Readonly<{ spaceVersion: bigint; entryVersion: bigint }>,
    space: MemorySpace, entry: MemoryEntry): Promise<void> {
    this.#set(Object.freeze({ kind: "forget", expected, space, entry }));
  }
  async saveSpace(_transaction: PlatformTransaction, expectedVersion: bigint,
    space: MemorySpace): Promise<void> {
    this.#set(Object.freeze({ kind: "reset", expectedVersion, space }));
  }
  async saveReboundPolicy(): Promise<void> { throw corrupt("MEMORY_PUBLIC_COMMAND_RECORD_CORRUPT"); }

  serializedTransition(): Readonly<Record<string, unknown>> {
    if (this.#transition === null || this.#result === null) throw corrupt("MEMORY_PUBLIC_COMMAND_RECORD_CORRUPT");
    return serializeCoreTransition(this.#transition, this.#result, this.space);
  }
  #set(value: StagedTransition) {
    if (this.#transition !== null) throw corrupt("MEMORY_PUBLIC_COMMAND_RECORD_CORRUPT");
    this.#transition = value;
  }
}

function decodeStagedSpace(value: unknown) {
  const row = object(value, "MEMORY_PUBLIC_COMMAND_RECORD_CORRUPT");
  const binding = object(row.binding, "MEMORY_PUBLIC_COMMAND_RECORD_CORRUPT");
  return { ...row, binding: { ...binding, subjectGeneration: positive(binding.subjectGeneration,
    "MEMORY_PUBLIC_COMMAND_RECORD_CORRUPT") },
  version: positive(row.version, "MEMORY_PUBLIC_COMMAND_RECORD_CORRUPT"),
  spaceGeneration: positive(row.spaceGeneration, "MEMORY_PUBLIC_COMMAND_RECORD_CORRUPT"),
  learningGeneration: positive(row.learningGeneration, "MEMORY_PUBLIC_COMMAND_RECORD_CORRUPT"),
  revocationEpoch: positive(row.revocationEpoch, "MEMORY_PUBLIC_COMMAND_RECORD_CORRUPT"),
  minimumLearnableSourceOriginSequence: positive(row.minimumLearnableSourceOriginSequence,
    "MEMORY_PUBLIC_COMMAND_RECORD_CORRUPT") };
}
function decodeStagedEntry(value: unknown) {
  const row = object(value, "MEMORY_PUBLIC_COMMAND_RECORD_CORRUPT");
  return { ...row, version: positive(row.version, "MEMORY_PUBLIC_COMMAND_RECORD_CORRUPT"),
    currentRevision: boundedRevision(row.currentRevision, "MEMORY_PUBLIC_COMMAND_RECORD_CORRUPT"),
    spaceGeneration: positive(row.spaceGeneration, "MEMORY_PUBLIC_COMMAND_RECORD_CORRUPT"),
    learningGeneration: positive(row.learningGeneration, "MEMORY_PUBLIC_COMMAND_RECORD_CORRUPT"),
    revocationEpoch: positive(row.revocationEpoch, "MEMORY_PUBLIC_COMMAND_RECORD_CORRUPT") };
}

function ownerValues(context: MemoryPublicResolvedOwner["context"], tail: readonly unknown[]) {
  return [context.siteRef, context.subjectRef, context.subjectGeneration,
    context.featurePolicyRevisionRef, ...tail];
}

function ownerRecord(context: MemoryPublicResolvedOwner["context"], value: unknown):
  MemoryPublicResolvedOwner {
  const row = exactObject(value, ["spaceRef", "spaceVersion", "persisted"] as const,
    "MEMORY_PUBLIC_OWNER_RECORD_CORRUPT");
  return Object.freeze({ context, spaceRef: string(row.spaceRef, "MEMORY_PUBLIC_OWNER_RECORD_CORRUPT"),
    spaceVersion: positive(row.spaceVersion, "MEMORY_PUBLIC_OWNER_RECORD_CORRUPT") });
}

function entryRecord(value: unknown): MemoryPublicEntryRecord {
  const row = exactObject(value, ["entryRef", "entryVersion", "category", "state", "prioritized",
    "revision", "currentRevisionRef", "reason", "validFrom", "validTo", "createdAt", "updatedAt",
    "protectedContent", "sourceKind", "sourceState", "safeSourceLabel", "purgeReceiptRef",
    "revokedAt", "purgedAt"] as const, "MEMORY_PUBLIC_ENTRY_RECORD_CORRUPT");
  const state = enumeration(row.state, ["active", "revoked_purge_pending", "purged"] as const,
    "MEMORY_PUBLIC_ENTRY_RECORD_CORRUPT");
  const protectedContent = row.protectedContent === null || row.protectedContent === undefined
    ? null : protectedRecord(row.protectedContent);
  return Object.freeze({ entryRef: string(row.entryRef, "MEMORY_PUBLIC_ENTRY_RECORD_CORRUPT"),
    entryVersion: positive(row.entryVersion, "MEMORY_PUBLIC_ENTRY_RECORD_CORRUPT"),
    category: enumeration(row.category, ["profile", "preference", "fact"] as const,
      "MEMORY_PUBLIC_ENTRY_RECORD_CORRUPT"), state,
    prioritized: boolean(row.prioritized, "MEMORY_PUBLIC_ENTRY_RECORD_CORRUPT"),
    revision: boundedRevision(row.revision, "MEMORY_PUBLIC_ENTRY_RECORD_CORRUPT"),
    currentRevisionRef: string(row.currentRevisionRef, "MEMORY_PUBLIC_ENTRY_RECORD_CORRUPT"),
    reason: enumeration(row.reason, ["explicit", "corrected", "imported", "restored"] as const,
      "MEMORY_PUBLIC_ENTRY_RECORD_CORRUPT"), validFrom: nullableInstant(row.validFrom),
    validTo: nullableInstant(row.validTo), createdAt: instant(row.createdAt,
      "MEMORY_PUBLIC_ENTRY_RECORD_CORRUPT"), updatedAt: instant(row.updatedAt,
      "MEMORY_PUBLIC_ENTRY_RECORD_CORRUPT"), protectedContent,
    sourceKind: enumeration(row.sourceKind, ["explicit", "import"] as const,
      "MEMORY_PUBLIC_ENTRY_RECORD_CORRUPT"), sourceState: enumeration(row.sourceState,
      ["current", "restricted", "unavailable"] as const, "MEMORY_PUBLIC_ENTRY_RECORD_CORRUPT"),
    safeSourceLabel: string(row.safeSourceLabel, "MEMORY_PUBLIC_ENTRY_RECORD_CORRUPT"),
    ...(typeof row.purgeReceiptRef === "string" ? { purgeReceiptRef: row.purgeReceiptRef } : {}),
    ...(typeof row.revokedAt === "string" ? { revokedAt: instant(row.revokedAt,
      "MEMORY_PUBLIC_ENTRY_RECORD_CORRUPT") } : {}),
    ...(typeof row.purgedAt === "string" ? { purgedAt: instant(row.purgedAt,
      "MEMORY_PUBLIC_ENTRY_RECORD_CORRUPT") } : {}) });
}

function revisionRecord(value: unknown): MemoryPublicRevisionRecord {
  const row = exactObject(value, ["revision", "revisionRef", "reason", "supersedesRevisionRef",
    "restoredFromRevisionRef", "validFrom", "validTo", "recordedAt", "protectedContent"] as const,
    "MEMORY_PUBLIC_HISTORY_RECORD_CORRUPT");
  return Object.freeze({ revision: boundedRevision(row.revision,
    "MEMORY_PUBLIC_HISTORY_RECORD_CORRUPT"),
    revisionRef: string(row.revisionRef, "MEMORY_PUBLIC_HISTORY_RECORD_CORRUPT"),
    reason: enumeration(row.reason, ["explicit", "corrected", "imported", "restored"] as const,
      "MEMORY_PUBLIC_HISTORY_RECORD_CORRUPT"),
    supersedesRevisionRef: nullableString(row.supersedesRevisionRef),
    restoredFromRevisionRef: nullableString(row.restoredFromRevisionRef),
    validFrom: nullableInstant(row.validFrom), validTo: nullableInstant(row.validTo),
    recordedAt: instant(row.recordedAt, "MEMORY_PUBLIC_HISTORY_RECORD_CORRUPT"),
    protectedContent: row.protectedContent === null || row.protectedContent === undefined
      ? null : protectedRecord(row.protectedContent) });
}

function protectedRecord(value: unknown) {
  const row = exactObject(value, ["envelopeVersion", "keyRevision", "nonce", "ciphertext",
    "authenticationTag", "aadDigest"] as const, "MEMORY_PUBLIC_PROTECTED_CONTENT_CORRUPT");
  return createProtectedMemoryContent({ envelopeVersion: row.envelopeVersion,
    keyRevision: row.keyRevision, nonce: bytes(row.nonce), ciphertext: bytes(row.ciphertext),
    authenticationTag: bytes(row.authenticationTag), aadDigest: row.aadDigest });
}

function commandResult(row: Readonly<Record<string, unknown>>, replayed: boolean,
  fallback?: MemoryPublicCommand): MemoryPublicCommandResult {
  row = exactObject(row, ["decision", "kind", "spaceRef", "committedSpaceVersion", "spaceVersion",
    "entryRef", "entryVersion", "revision", "revisionRef", "restoredFromRevisionRef",
    "prioritized", "changed"] as const, "MEMORY_PUBLIC_COMMAND_RECORD_CORRUPT");
  const storedKind = enumeration(row.kind, ["entry", "restored", "purge"] as const,
    "MEMORY_PUBLIC_COMMAND_RECORD_CORRUPT");
  const expectedKind = fallback === undefined ? storedKind : fallback.operation === "restore" ? "restored"
    : fallback.operation === "forget" || fallback.operation === "reset" ? "purge" : "entry";
  if (storedKind !== expectedKind) throw corrupt("MEMORY_PUBLIC_COMMAND_RECORD_CORRUPT");
  const committed = positive(row.committedSpaceVersion ?? row.spaceVersion,
    "MEMORY_PUBLIC_COMMAND_RECORD_CORRUPT");
  const entryRef = nullableString(row.entryRef ?? fallback?.entryRef ?? null);
  return Object.freeze({ kind: storedKind, committedSpaceVersion: committed, entryRef,
    ...(row.entryVersion === undefined || row.entryVersion === null ? {} : { entryVersion: positive(row.entryVersion,
      "MEMORY_PUBLIC_COMMAND_RECORD_CORRUPT") }),
    ...(row.revision === undefined || row.revision === null ? {} : { revision: boundedRevision(row.revision,
      "MEMORY_PUBLIC_COMMAND_RECORD_CORRUPT") }),
    ...(typeof row.revisionRef === "string" ? { revisionRef: row.revisionRef } :
      fallback?.revisionRef === null || fallback?.revisionRef === undefined ? {} :
        { revisionRef: fallback.revisionRef }),
    ...(typeof row.restoredFromRevisionRef === "string"
      ? { restoredFromRevisionRef: row.restoredFromRevisionRef } : {}),
    ...(typeof row.prioritized === "boolean" ? { prioritized: row.prioritized } : {}),
    ...(replayed ? { replayed: true } : {}) });
}

function serializeCoreTransition(transition: StagedTransition, result: MemoryCommandResult,
  currentSpace: MemorySpace | null): Readonly<Record<string, unknown>> {
  const baseVersion = currentSpace?.version ?? 1n;
  const committedSpaceVersion = transition.kind === "remember" || transition.kind === "correct"
    ? baseVersion + 1n : result.spaceVersion;
  const common = { operation: transition.kind, committedSpaceVersion: committedSpaceVersion.toString(),
    result: serializeCoreResult(result, committedSpaceVersion) };
  switch (transition.kind) {
    case "remember": return Object.freeze({ ...common,
      newSpace: transition.newSpace === null ? null
        : serializeSpace(transition.newSpace, committedSpaceVersion),
      remembered: serializeRemembered(transition.remembered) });
    case "correct": return Object.freeze({ ...common,
      expected: { entryVersion: transition.expected.entryVersion.toString(),
        currentRevision: transition.expected.currentRevision.toString() },
      corrected: serializeRemembered(transition.corrected) });
    case "forget": return Object.freeze({ ...common,
      expected: { spaceVersion: transition.expected.spaceVersion.toString(),
        entryVersion: transition.expected.entryVersion.toString() },
      space: serializeSpace(transition.space), entry: serializeEntry(transition.entry) });
    case "reset": return Object.freeze({ ...common,
      expectedVersion: transition.expectedVersion.toString(), space: serializeSpace(transition.space) });
  }
}

function serializeCoreResult(result: MemoryCommandResult, committedSpaceVersion: bigint) {
  const base = { ...result, spaceVersion: committedSpaceVersion.toString() } as Record<string, unknown>;
  for (const [key, value] of Object.entries(base)) if (typeof value === "bigint") base[key] = value.toString();
  return base;
}

function serializeSpace(space: MemorySpace, version: bigint = space.version) {
  const binding = space.binding;
  if (binding.kind !== "user") throw corrupt("MEMORY_PUBLIC_COMMAND_RECORD_CORRUPT");
  return Object.freeze({ spaceRef: space.spaceRef, binding: { kind: "user", siteRef: binding.siteRef,
    subjectRef: binding.subjectRef, subjectGeneration: binding.subjectGeneration.toString() },
  featurePolicyRevisionRef: space.featurePolicyRevisionRef, version: version.toString(),
  spaceGeneration: space.spaceGeneration.toString(),
  learningGeneration: space.learningGeneration.toString(),
  revocationEpoch: space.revocationEpoch.toString(),
  minimumLearnableSourceOriginSequence: space.minimumLearnableSourceOriginSequence.toString(),
  learningState: space.learningState, useState: space.useState, state: space.state,
  createdAt: space.createdAt, updatedAt: space.updatedAt });
}

function serializeEntry(entry: MemoryEntry) {
  return Object.freeze({ ...entry, version: entry.version.toString(),
    currentRevision: entry.currentRevision.toString(),
    spaceGeneration: entry.spaceGeneration.toString(),
    learningGeneration: entry.learningGeneration.toString(),
    revocationEpoch: entry.revocationEpoch.toString() });
}

function serializeRemembered(remembered: RememberedMemory) {
  const revision = remembered.revision;
  const provenance = remembered.provenance;
  return Object.freeze({ entry: serializeEntry(remembered.entry), revision: {
    ...revision, revision: revision.revision.toString(),
    protectedContent: serializeProtected(revision.protectedContent),
  }, provenance: { ...provenance, actorSubjectGeneration: provenance.actorSubjectGeneration.toString(),
    ...(provenance.actorMembershipEpoch === null ? {} :
      { actorMembershipEpoch: provenance.actorMembershipEpoch.toString() }),
    ...(provenance.actorAuthorizationEpoch === null ? {} :
      { actorAuthorizationEpoch: provenance.actorAuthorizationEpoch.toString() }) } });
}

function serializeProtected(protectedContent: NonNullable<MemoryPublicCommand["protectedContent"]>) {
  return Object.freeze({ envelopeVersion: protectedContent.envelopeVersion,
    keyRevision: protectedContent.keyRevision,
    nonce: Buffer.from(protectedContent.copyNonce()).toString("base64"),
    ciphertext: Buffer.from(protectedContent.copyCiphertext()).toString("base64"),
    authenticationTag: Buffer.from(protectedContent.copyAuthenticationTag()).toString("base64"),
    aadDigest: protectedContent.aadDigest });
}

function requiredProtected(command: MemoryPublicCommand) {
  if (command.protectedContent === undefined) throw corrupt("MEMORY_PUBLIC_COMMAND_RECORD_CORRUPT");
  return command.protectedContent;
}
function requiredCommandString(value: string | null | undefined): string {
  if (typeof value !== "string") throw corrupt("MEMORY_PUBLIC_COMMAND_RECORD_CORRUPT");
  return value;
}
function requiredExpectedRevision(value: number | undefined): number {
  if (value === undefined || !Number.isInteger(value) || value < 1 || value > 2_147_483_647) {
    throw corrupt("MEMORY_PUBLIC_COMMAND_RECORD_CORRUPT");
  }
  return value;
}

function commandJson(command: MemoryPublicCommand): Readonly<Record<string, unknown>> {
  const protectedContent = command.protectedContent;
  return Object.freeze({ ...command, context: { ...command.context,
    subjectGeneration: command.context.subjectGeneration.toString() },
  ...(command.expectedEntryVersion === undefined ? {} :
    { expectedEntryVersion: command.expectedEntryVersion.toString() }),
  ...(protectedContent === undefined ? {} : { protectedContent: serializeProtected(protectedContent) }) });
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw corrupt("MEMORY_PUBLIC_COMMAND_RECORD_CORRUPT");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value !== "object" || value === null) throw corrupt("MEMORY_PUBLIC_COMMAND_RECORD_CORRUPT");
  const record = value as Readonly<Record<string, unknown>>;
  return `{${Object.keys(record).filter((key) => record[key] !== undefined).sort().map((key) =>
    `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
}

function oneResult(rows: readonly Record<string, unknown>[], code: string): unknown | null {
  if (rows.length === 0) return null;
  if (rows.length !== 1) throw corrupt(code);
  return "result" in rows[0]! ? rows[0]!.result : rows[0];
}
function object(value: unknown, code: string): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw corrupt(code);
  return value as Readonly<Record<string, unknown>>;
}
function exactObject<const Keys extends readonly string[]>(value: unknown, allowed: Keys, code: string):
  Readonly<Record<Keys[number], unknown>> {
  const record = object(value, code);
  const allowedSet = new Set<string>(allowed);
  if (Object.keys(record).some((key) => !allowedSet.has(key))) throw corrupt(code);
  return record as Readonly<Record<Keys[number], unknown>>;
}
function string(value: unknown, code: string): string {
  if (typeof value !== "string" || value.length < 1 || /[\0\r\n]/u.test(value)) throw corrupt(code);
  return value;
}
function nullableString(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return string(value, "MEMORY_PUBLIC_RECORD_CORRUPT");
}
function instant(value: unknown, code: string): string {
  const text = string(value, code);
  const parsed = new Date(text);
  if (!Number.isFinite(parsed.getTime())) throw corrupt(code);
  return parsed.toISOString();
}
function nullableInstant(value: unknown): string | null {
  return value === null || value === undefined ? null : instant(value, "MEMORY_PUBLIC_RECORD_CORRUPT");
}
function positive(value: unknown, code: string): bigint {
  const result = typeof value === "bigint" ? value : typeof value === "string" && /^[1-9][0-9]*$/u.test(value)
    ? BigInt(value) : typeof value === "number" && Number.isSafeInteger(value) ? BigInt(value) : 0n;
  if (result < 1n || result > 9_223_372_036_854_775_807n) throw corrupt(code);
  return result;
}
function boundedRevision(value: unknown, code: string): bigint {
  const result = positive(value, code);
  if (result > 2_147_483_647n) throw corrupt(code);
  return result;
}
function boolean(value: unknown, code: string): boolean {
  if (typeof value !== "boolean") throw corrupt(code);
  return value;
}
function enumeration<const Values extends readonly string[]>(value: unknown, values: Values, code: string):
  Values[number] {
  if (typeof value !== "string" || !values.includes(value)) throw corrupt(code);
  return value as Values[number];
}
function bytes(value: unknown): Uint8Array {
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) return new Uint8Array(value);
  if (typeof value !== "string") throw corrupt("MEMORY_PUBLIC_PROTECTED_CONTENT_CORRUPT");
  return new Uint8Array(Buffer.from(value, "base64"));
}
function corrupt(code: string): MemoryApplicationError {
  return new MemoryApplicationError(code.startsWith("MEMORY_PUBLIC")
    ? "MEMORY_PERSISTENCE_CONFLICT" : "MEMORY_PERSISTENCE_CONFLICT");
}
