import type { PlatformTransaction } from "../../../shared/unit-of-work/index.js";
import { computeCanonicalMemoryCommandDigest, type MemoryCommandDigestField } from
  "../domain/memory-command-digest.js";
import { MemoryDomainError } from "../domain/memory-error.js";
import { assertCurrentEntryFence, correctMemoryEntry, createRememberedMemory, forgetMemoryEntry,
  rehydrateMemoryEntry, restoreMemoryEntry, setMemoryEntryPriority,
  type MemoryEntry, type RememberedMemory } from "../domain/memory-entry.js";
import {
  memoryAggregateVersion,
  memoryCommandRef,
  memoryDigest,
  memoryEntryRef,
  memoryFeaturePolicyRevisionRef,
  memoryInstant,
  memoryLearningGeneration,
  memoryProvenanceRef,
  memoryRevisionNumber,
  memoryRevisionRef,
  memoryRevocationEpoch,
  memorySourceOriginSequence,
  memorySpaceGeneration,
  memorySpaceRef,
  memorySiteRef,
  type AggregateVersion,
  type FeaturePolicyRevisionRef,
  type MemoryEntryRef,
  type MemorySpaceRef,
  type SiteRef,
} from "../domain/memory-references.js";
import {
  assertAgentProductParentCurrent,
  createAgentProductMemorySpace,
  createMemorySpace,
  memoryActorAuthorizesBinding,
  memoryBindingSiteRef,
  pauseMemoryLearning,
  pauseMemoryUse,
  rehydrateMemoryScopeBinding,
  rehydrateMemoryActorAuthorization,
  rehydrateMemorySpace,
  resetMemorySpace,
  rebindMemoryFeaturePolicy,
  resumeMemoryLearning,
  resumeMemoryUse,
  sameMemoryScopeBinding,
  type MemoryActorAuthorization,
  type MemoryScopeBinding,
  type MemorySpace,
} from "../domain/memory-space.js";
import { requireExactMemoryRecord, snapshotExactMemoryRecord, snapshotMemoryRecord } from
  "../domain/runtime-validation.js";
import { protectedMemoryContentDigestMetadata } from "../domain/protected-memory-content.js";
import { MemoryApplicationError } from "./memory-application-error.js";
import {
  memoryReceiptOwner,
  type MemoryAuthorizationFactsPort,
  type MemoryAuthorizationFactsResult,
  type MemoryAuthorityRepository,
  type MemoryCommandOperation,
  type MemoryCommandReceiptIdentity,
  type MemoryCommandResult,
} from "./memory-authority-ports.js";

export class MemoryAuthorityService {
  constructor(
    private readonly repository: MemoryAuthorityRepository,
    private readonly authorization: MemoryAuthorizationFactsPort,
  ) {}

  async remember(transaction: PlatformTransaction, value: unknown): Promise<MemoryCommandResult> {
    const record = snapshotExactMemoryRecord(withDefaultValidity(value), ["commandRef", "binding", "spaceRef",
      "expectedSpaceVersion", "entryRef", "revisionRef", "provenanceRef", "sourceDigest",
      "protectedContent", "category", "featurePolicyRevisionRef", "validFrom", "validTo",
      "recordedAt"],
    "MEMORY_ENTRY_INVALID");
    const binding = rehydrateMemoryScopeBinding(record.binding);
    const siteRef = memoryBindingSiteRef(binding);
    const spaceRef = memorySpaceRef(record.spaceRef);
    const featurePolicyRevisionRef = memoryFeaturePolicyRevisionRef(record.featurePolicyRevisionRef);
    const expectedSpaceVersion = nonNegativeVersion(record.expectedSpaceVersion);
    const authority = await this.repository.loadSpaceAuthorityForUpdate(transaction, siteRef, spaceRef,
      binding.kind === "agent_product" ? binding.parentSpaceRef : undefined);
    const existing = authority.space === null ? null : decodeRepositorySpace(authority.space);
    if (existing !== null && (!sameMemoryScopeBinding(existing.binding, binding) ||
      existing.featurePolicyRevisionRef !== featurePolicyRevisionRef)) {
      throw new MemoryApplicationError("MEMORY_AUTHORIZATION_FACTS_STALE");
    }
    const authoritativeBinding = existing?.binding ?? binding;
    const parent = this.assertParentScope(authoritativeBinding, featurePolicyRevisionRef, authority.parent);
    const actorAuthorization = await this.revalidate(transaction, authoritativeBinding,
      featurePolicyRevisionRef);
    const identity = receiptIdentity(authoritativeBinding, actorAuthorization, "remember", record.commandRef,
      rememberDigest(record, binding, spaceRef, expectedSpaceVersion, featurePolicyRevisionRef));
    const replay = await this.claim(transaction, identity);
    if (replay !== null) return replay;

    let newSpace: MemorySpace | null = null;
    let space: MemorySpace;
    if (existing === null) {
      if (expectedSpaceVersion !== 0n) throw new MemoryApplicationError("MEMORY_SPACE_NOT_FOUND");
      newSpace = binding.kind === "agent_product"
        ? createAgentProductMemorySpace({ spaceRef, binding, parent, featurePolicyRevisionRef,
          recordedAt: record.recordedAt })
        : createMemorySpace({ spaceRef, binding, featurePolicyRevisionRef,
          recordedAt: record.recordedAt });
      space = newSpace;
    } else {
      assertSpaceMatches(existing, binding, featurePolicyRevisionRef, expectedSpaceVersion);
      space = existing;
    }
    const remembered = createRememberedMemory({
      space,
      entryRef: record.entryRef,
      revisionRef: record.revisionRef,
      provenanceRef: record.provenanceRef,
      sourceCommandRef: identity.commandRef,
      sourceDigest: record.sourceDigest,
      protectedContent: record.protectedContent,
      category: record.category,
      featurePolicyRevisionRef,
      validFrom: record.validFrom,
      validTo: record.validTo,
      actorAuthorization,
      recordedAt: record.recordedAt,
    });
    await this.repository.saveRememberedMemory(transaction, newSpace, remembered);
    const result = rememberedResult("remembered", space, remembered);
    await this.repository.completeReceipt(transaction, identity, result);
    return result;
  }

  async correct(transaction: PlatformTransaction, value: unknown): Promise<MemoryCommandResult> {
    const record = snapshotExactMemoryRecord(withDefaultValidity(value), ["commandRef", "siteRef", "spaceRef",
      "expectedSpaceVersion", "entryRef", "expectedEntryVersion", "expectedCurrentRevision", "revisionRef",
      "provenanceRef", "sourceDigest", "protectedContent", "featurePolicyRevisionRef",
      "validFrom", "validTo", "recordedAt"],
    "MEMORY_ENTRY_INVALID");
    const siteRef = memorySiteRef(record.siteRef);
    const spaceRef = memorySpaceRef(record.spaceRef);
    const featurePolicyRevisionRef = memoryFeaturePolicyRevisionRef(record.featurePolicyRevisionRef);
    const space = await this.requiredSpace(transaction, siteRef, spaceRef);
    const entryRef = memoryEntryRef(record.entryRef);
    const entry = await this.requiredEntry(transaction, siteRef, spaceRef, entryRef);
    assertCurrentEntryFence(space, entry);
    const actorAuthorization = await this.revalidate(transaction, space.binding,
      featurePolicyRevisionRef);
    const identity = receiptIdentity(space.binding, actorAuthorization, "correct", record.commandRef,
      correctDigest(record, siteRef, spaceRef, featurePolicyRevisionRef));
    const replay = await this.claim(transaction, identity);
    if (replay !== null) return replay;
    assertSpaceMatches(space, space.binding, featurePolicyRevisionRef,
      positiveVersion(record.expectedSpaceVersion));
    const corrected = correctMemoryEntry({
      space, entry,
      expectedVersion: record.expectedEntryVersion,
      expectedCurrentRevision: record.expectedCurrentRevision,
      revisionRef: record.revisionRef,
      provenanceRef: record.provenanceRef,
      sourceCommandRef: identity.commandRef,
      sourceDigest: record.sourceDigest,
      protectedContent: record.protectedContent,
      featurePolicyRevisionRef,
      validFrom: record.validFrom,
      validTo: record.validTo,
      actorAuthorization,
      recordedAt: record.recordedAt,
    });
    await this.repository.saveCorrectedMemory(transaction, {
      entryVersion: memoryAggregateVersion(record.expectedEntryVersion),
      currentRevision: memoryRevisionNumber(record.expectedCurrentRevision),
    }, corrected);
    const result = rememberedResult("corrected", space, corrected);
    await this.repository.completeReceipt(transaction, identity, result);
    return result;
  }

  async restore(transaction: PlatformTransaction, value: unknown): Promise<MemoryCommandResult> {
    const record = snapshotExactMemoryRecord(value, ["commandRef", "siteRef", "spaceRef",
      "expectedSpaceVersion", "entryRef", "expectedEntryVersion", "expectedCurrentRevision",
      "revisionRef", "restoredFromRevisionRef", "provenanceRef", "sourceDigest",
      "protectedContent", "featurePolicyRevisionRef", "recordedAt"], "MEMORY_ENTRY_INVALID");
    const siteRef = memorySiteRef(record.siteRef);
    const spaceRef = memorySpaceRef(record.spaceRef);
    const entryRef = memoryEntryRef(record.entryRef);
    const restoredFromRevisionRef = memoryRevisionRef(record.restoredFromRevisionRef);
    const featurePolicyRevisionRef = memoryFeaturePolicyRevisionRef(record.featurePolicyRevisionRef);
    const space = await this.requiredSpace(transaction, siteRef, spaceRef);
    const entry = await this.requiredEntry(transaction, siteRef, spaceRef, entryRef);
    const historical = await this.repository.loadRestorableRevisionForUpdate(transaction, siteRef,
      spaceRef, entryRef, restoredFromRevisionRef);
    if (historical === null) throw new MemoryApplicationError("MEMORY_ENTRY_NOT_FOUND");
    assertCurrentEntryFence(space, entry);
    const actorAuthorization = await this.revalidate(transaction, space.binding,
      featurePolicyRevisionRef);
    const identity = receiptIdentity(space.binding, actorAuthorization, "restore", record.commandRef,
      restoreDigest(record, siteRef, spaceRef, featurePolicyRevisionRef));
    const replay = await this.claim(transaction, identity);
    if (replay !== null) return replay;
    assertSpaceMatches(space, space.binding, featurePolicyRevisionRef,
      positiveVersion(record.expectedSpaceVersion));
    const restored = restoreMemoryEntry({ space, entry,
      expectedVersion: record.expectedEntryVersion,
      expectedCurrentRevision: record.expectedCurrentRevision,
      revisionRef: record.revisionRef, restoredFromRevisionRef,
      restoredFromRevision: historical.revision,
      provenanceRef: record.provenanceRef, sourceCommandRef: identity.commandRef,
      sourceDigest: record.sourceDigest, protectedContent: record.protectedContent,
      featurePolicyRevisionRef, actorAuthorization, validFrom: historical.validFrom,
      validTo: historical.validTo, recordedAt: record.recordedAt });
    await this.repository.saveRestoredMemory(transaction, {
      spaceVersion: space.version, entryVersion: entry.version,
      currentRevision: entry.currentRevision,
    }, restored);
    const result = Object.freeze({ ...rememberedResult("restored", space, restored),
      restoredFromRevisionRef });
    await this.repository.completeReceipt(transaction, identity, result);
    return result;
  }

  async setPriority(transaction: PlatformTransaction, value: unknown): Promise<MemoryCommandResult> {
    const record = snapshotExactMemoryRecord(value, ["commandRef", "siteRef", "spaceRef",
      "expectedSpaceVersion", "entryRef", "expectedEntryVersion", "prioritized",
      "featurePolicyRevisionRef", "recordedAt"], "MEMORY_ENTRY_INVALID");
    const siteRef = memorySiteRef(record.siteRef);
    const spaceRef = memorySpaceRef(record.spaceRef);
    const entryRef = memoryEntryRef(record.entryRef);
    const featurePolicyRevisionRef = memoryFeaturePolicyRevisionRef(record.featurePolicyRevisionRef);
    const space = await this.requiredSpace(transaction, siteRef, spaceRef);
    const entry = await this.requiredEntry(transaction, siteRef, spaceRef, entryRef);
    assertCurrentEntryFence(space, entry);
    const actorAuthorization = await this.revalidate(transaction, space.binding,
      featurePolicyRevisionRef);
    const prioritized = record.prioritized === true;
    if (typeof record.prioritized !== "boolean") {
      throw new MemoryApplicationError("MEMORY_PERSISTENCE_CONFLICT");
    }
    const operation = prioritized ? "prioritize" : "deprioritize";
    const identity = receiptIdentity(space.binding, actorAuthorization, operation, record.commandRef,
      priorityDigest(record, siteRef, spaceRef, featurePolicyRevisionRef));
    const replay = await this.claim(transaction, identity);
    if (replay !== null) return replay;
    const changed = setMemoryEntryPriority({ space, entry,
      expectedSpaceVersion: record.expectedSpaceVersion,
      expectedEntryVersion: record.expectedEntryVersion, prioritized,
      changedAt: record.recordedAt });
    if (changed.changed) {
      await this.repository.saveEntryPriority(transaction, {
        spaceVersion: space.version, entryVersion: entry.version,
      }, changed.space, changed.entry);
    }
    const result = Object.freeze({ kind: prioritized ? "prioritized" as const : "deprioritized" as const,
      spaceRef, spaceVersion: changed.space.version, entryRef,
      entryVersion: changed.entry.version, prioritized, changed: changed.changed });
    await this.repository.completeReceipt(transaction, identity, result);
    return result;
  }

  async forget(transaction: PlatformTransaction, value: unknown): Promise<MemoryCommandResult> {
    const record = snapshotExactMemoryRecord(value, ["commandRef", "siteRef", "spaceRef",
      "expectedSpaceVersion", "entryRef", "expectedEntryVersion", "featurePolicyRevisionRef", "recordedAt"],
    "MEMORY_ENTRY_INVALID");
    const siteRef = memorySiteRef(record.siteRef);
    const spaceRef = memorySpaceRef(record.spaceRef);
    const featurePolicyRevisionRef = memoryFeaturePolicyRevisionRef(record.featurePolicyRevisionRef);
    const space = await this.requiredSpace(transaction, siteRef, spaceRef);
    const entry = await this.requiredEntry(transaction, siteRef, spaceRef, memoryEntryRef(record.entryRef));
    assertCurrentEntryFence(space, entry);
    const actorAuthorization = await this.revalidate(transaction, space.binding,
      featurePolicyRevisionRef);
    const identity = receiptIdentity(space.binding, actorAuthorization, "forget", record.commandRef,
      forgetDigest(record, siteRef, spaceRef, featurePolicyRevisionRef));
    const replay = await this.claim(transaction, identity);
    if (replay !== null) return replay;
    assertSpaceMatches(space, space.binding, featurePolicyRevisionRef,
      positiveVersion(record.expectedSpaceVersion));
    const expectedEntryVersion = memoryAggregateVersion(record.expectedEntryVersion);
    const forgotten = forgetMemoryEntry({ space, entry,
      expectedSpaceVersion: record.expectedSpaceVersion,
      expectedEntryVersion, forgottenAt: record.recordedAt });
    await this.repository.saveForgottenMemory(transaction, {
      spaceVersion: space.version, entryVersion: expectedEntryVersion,
    }, forgotten.space, forgotten.entry);
    const result = Object.freeze({ kind: "forgotten" as const, spaceRef: forgotten.space.spaceRef,
      spaceVersion: forgotten.space.version, entryRef: forgotten.entry.entryRef,
      entryVersion: forgotten.entry.version, revocationEpoch: forgotten.space.revocationEpoch });
    await this.repository.completeReceipt(transaction, identity, result);
    return result;
  }

  pauseLearning(transaction: PlatformTransaction, value: unknown): Promise<MemoryCommandResult> {
    return this.control(transaction, value, "pause_learning");
  }
  resumeLearning(transaction: PlatformTransaction, value: unknown): Promise<MemoryCommandResult> {
    return this.control(transaction, value, "resume_learning");
  }
  pauseUse(transaction: PlatformTransaction, value: unknown): Promise<MemoryCommandResult> {
    return this.control(transaction, value, "pause_use");
  }
  resumeUse(transaction: PlatformTransaction, value: unknown): Promise<MemoryCommandResult> {
    return this.control(transaction, value, "resume_use");
  }
  reset(transaction: PlatformTransaction, value: unknown): Promise<MemoryCommandResult> {
    return this.control(transaction, value, "reset");
  }

  async rebindFeaturePolicy(transaction: PlatformTransaction, value: unknown):
    Promise<MemoryCommandResult> {
    const record = snapshotExactMemoryRecord(value, ["commandRef", "siteRef",
      "spaceRef", "expectedSpaceVersion", "expectedFeaturePolicyRevisionRef",
      "nextFeaturePolicyRevisionRef", "cutoffOriginSequence", "recordedAt"], "MEMORY_SPACE_INVALID");
    const siteRef = memorySiteRef(record.siteRef);
    const space = await this.requiredSpace(transaction, siteRef, memorySpaceRef(record.spaceRef));
    if (space.binding.kind === "agent_product") {
      throw new MemoryApplicationError("MEMORY_PARENT_SCOPE_INVALID");
    }
    const nextPolicy = memoryFeaturePolicyRevisionRef(record.nextFeaturePolicyRevisionRef);
    const actor = await this.revalidate(transaction, space.binding, nextPolicy);
    const identity = receiptIdentity(space.binding, actor, "rebind_policy", record.commandRef,
      rebindPolicyDigest(record, siteRef, space.spaceRef));
    const replay = await this.claim(transaction, identity);
    if (replay !== null) return replay;
    const previousPolicy = memoryFeaturePolicyRevisionRef(record.expectedFeaturePolicyRevisionRef);
    const next = rebindMemoryFeaturePolicy({ space,
      expectedVersion: positiveVersion(record.expectedSpaceVersion),
      expectedFeaturePolicyRevisionRef: previousPolicy, nextFeaturePolicyRevisionRef: nextPolicy,
      rebindCutoffOriginSequence: record.cutoffOriginSequence, changedAt: record.recordedAt });
    await this.repository.saveReboundPolicy(transaction,
      { version: space.version, featurePolicyRevisionRef: previousPolicy }, next);
    const result = Object.freeze({ kind: "policy_rebound" as const, spaceRef: next.spaceRef,
      spaceVersion: next.version, previousFeaturePolicyRevisionRef: previousPolicy,
      featurePolicyRevisionRef: next.featurePolicyRevisionRef,
      spaceGeneration: next.spaceGeneration, learningGeneration: next.learningGeneration,
      revocationEpoch: next.revocationEpoch,
      minimumLearnableSourceOriginSequence: next.minimumLearnableSourceOriginSequence,
      learningState: "paused" as const, useState: "paused" as const });
    await this.repository.completeReceipt(transaction, identity, result);
    return result;
  }

  async control(transaction: PlatformTransaction, value: unknown,
    operation: Exclude<MemoryCommandOperation, "remember" | "correct" | "restore" | "prioritize" |
      "deprioritize" | "forget" | "rebind_policy">):
    Promise<MemoryCommandResult> {
    const withCutoff = operation === "resume_learning" || operation === "reset";
    const record = snapshotExactMemoryRecord(value, withCutoff
      ? ["commandRef", "siteRef", "spaceRef", "expectedSpaceVersion",
        "featurePolicyRevisionRef", "cutoffOriginSequence", "recordedAt"]
      : ["commandRef", "siteRef", "spaceRef", "expectedSpaceVersion",
        "featurePolicyRevisionRef", "recordedAt"], "MEMORY_SPACE_INVALID");
    const siteRef = memorySiteRef(record.siteRef);
    const spaceRef = memorySpaceRef(record.spaceRef);
    const featurePolicyRevisionRef = memoryFeaturePolicyRevisionRef(record.featurePolicyRevisionRef);
    const space = await this.requiredSpace(transaction, siteRef, spaceRef,
      operation === "resume_learning" ? "resume_learning"
        : operation === "resume_use" ? "resume_use" : undefined);
    const actorAuthorization = await this.revalidate(transaction, space.binding,
      featurePolicyRevisionRef);
    const identity = receiptIdentity(space.binding, actorAuthorization, operation, record.commandRef,
      controlDigest(operation, record, siteRef, spaceRef, featurePolicyRevisionRef));
    const replay = await this.claim(transaction, identity);
    if (replay !== null) return replay;
    const expectedVersion = positiveVersion(record.expectedSpaceVersion);
    assertSpaceMatches(space, space.binding, featurePolicyRevisionRef, expectedVersion);
    const input = { space, expectedVersion, changedAt: record.recordedAt };
    const next = operation === "pause_learning" ? pauseMemoryLearning(input)
      : operation === "pause_use" ? pauseMemoryUse(input)
      : operation === "resume_use" ? resumeMemoryUse(input)
      : operation === "resume_learning" ? resumeMemoryLearning({ ...input,
        resumeCutoffOriginSequence: record.cutoffOriginSequence })
      : resetMemorySpace({ ...input, resetCutoffOriginSequence: record.cutoffOriginSequence });
    await this.repository.saveSpace(transaction, expectedVersion, next);
    const result = controlResult(operation, next);
    await this.repository.completeReceipt(transaction, identity, result);
    return result;
  }

  private async revalidate(transaction: PlatformTransaction, binding: MemoryScopeBinding,
    featurePolicyRevisionRef: FeaturePolicyRevisionRef): Promise<MemoryActorAuthorization> {
    const result = decodeAuthorizationFacts(await this.authorization.revalidate(transaction,
      Object.freeze({ binding, featurePolicyRevisionRef })));
    if (result.kind === "denied") throw new MemoryApplicationError("MEMORY_AUTHORIZATION_DENIED");
    if (!memoryActorAuthorizesBinding(result.actorAuthorization, binding) ||
      result.featurePolicyRevisionRef !== featurePolicyRevisionRef) {
      throw new MemoryApplicationError("MEMORY_AUTHORIZATION_FACTS_STALE");
    }
    return result.actorAuthorization;
  }

  private assertParentScope(binding: MemoryScopeBinding,
    featurePolicyRevisionRef: FeaturePolicyRevisionRef, parent: MemorySpace | null): MemorySpace | null {
    if (binding.kind !== "agent_product") return null;
    if (parent === null || parent.state !== "active" || parent.binding.kind === "agent_product" ||
      parent.featurePolicyRevisionRef !== featurePolicyRevisionRef ||
      !sameMemoryScopeBinding(parent.binding, binding.parentBinding) ||
      parent.spaceGeneration !== binding.parentSpaceGeneration ||
      parent.learningGeneration !== binding.parentLearningGeneration ||
      parent.revocationEpoch !== binding.parentRevocationEpoch) {
      throw new MemoryApplicationError("MEMORY_PARENT_SCOPE_INVALID");
    }
    return parent;
  }

  private async requiredSpace(transaction: PlatformTransaction, siteRef: SiteRef,
    spaceRef: MemorySpaceRef, parentOperation?: "resume_learning" | "resume_use"):
    Promise<MemorySpace> {
    const authority = await this.repository.loadSpaceAuthorityForUpdate(transaction, siteRef, spaceRef);
    const loaded = authority.space;
    if (loaded === null) throw new MemoryApplicationError("MEMORY_SPACE_NOT_FOUND");
    const space = decodeRepositorySpace(loaded);
    if (memoryBindingSiteRef(space.binding) !== siteRef) {
      throw new MemoryApplicationError("MEMORY_AUTHORIZATION_FACTS_STALE");
    }
    if (space.binding.kind === "agent_product") {
      try {
        if (authority.parent === null) throw new Error("missing parent");
        assertAgentProductParentCurrent(space, authority.parent, parentOperation);
      } catch {
        throw new MemoryApplicationError("MEMORY_PARENT_SCOPE_INVALID");
      }
    }
    return space;
  }

  private async requiredEntry(transaction: PlatformTransaction, siteRef: SiteRef,
    spaceRef: MemorySpaceRef, entryRef: MemoryEntryRef): Promise<MemoryEntry> {
    const loaded = await this.repository.loadEntryForUpdate(transaction, siteRef, spaceRef, entryRef);
    if (loaded === null) throw new MemoryApplicationError("MEMORY_ENTRY_NOT_FOUND");
    try {
      return rehydrateMemoryEntry(loaded);
    } catch {
      throw new MemoryApplicationError("MEMORY_PERSISTENCE_CONFLICT");
    }
  }

  private async claim(transaction: PlatformTransaction,
    identity: MemoryCommandReceiptIdentity): Promise<MemoryCommandResult | null> {
    const rawClaim = await this.repository.claimReceipt(transaction, identity);
    try {
      const snapshot = snapshotMemoryRecord(rawClaim, "MEMORY_ENTRY_INVALID");
      if (snapshot.kind === "claimed") {
        requireExactMemoryRecord(snapshot, ["kind"], "MEMORY_ENTRY_INVALID");
        return null;
      }
      if (snapshot.kind === "digest_conflict") {
        requireExactMemoryRecord(snapshot, ["kind"], "MEMORY_ENTRY_INVALID");
        throw new MemoryApplicationError("MEMORY_COMMAND_DIGEST_CONFLICT");
      }
      if (snapshot.kind !== "replay") throw new MemoryApplicationError("MEMORY_RECEIPT_INVALID");
      const record = requireExactMemoryRecord(snapshot, ["kind", "result"], "MEMORY_ENTRY_INVALID");
      const result = decodeCommandResult(record.result);
      if (result.kind !== resultKindForOperation(identity.operation)) {
        throw new MemoryApplicationError("MEMORY_COMMAND_DIGEST_CONFLICT");
      }
      return result;
    } catch (error) {
      if (error instanceof MemoryApplicationError) throw error;
      throw new MemoryApplicationError("MEMORY_RECEIPT_INVALID");
    }
  }
}

function decodeRepositorySpace(value: unknown): MemorySpace {
  try {
    return rehydrateMemorySpace(value);
  } catch {
    throw new MemoryApplicationError("MEMORY_PERSISTENCE_CONFLICT");
  }
}

function decodeCommandResult(value: unknown): MemoryCommandResult {
  try {
    const snapshot = snapshotMemoryRecord(value, "MEMORY_ENTRY_INVALID");
    if (snapshot.kind === "remembered" || snapshot.kind === "corrected" ||
      snapshot.kind === "restored") {
      const record = requireExactMemoryRecord(snapshot, ["kind", "spaceRef", "spaceVersion",
        "entryRef", "entryVersion", "revisionRef", "revision",
        ...(snapshot.kind === "restored" ? ["restoredFromRevisionRef"] : [])],
      "MEMORY_ENTRY_INVALID");
      return Object.freeze({ kind: snapshot.kind, spaceRef: memorySpaceRef(record.spaceRef),
        spaceVersion: memoryAggregateVersion(record.spaceVersion),
        entryRef: memoryEntryRef(record.entryRef),
        entryVersion: memoryAggregateVersion(record.entryVersion),
        revisionRef: memoryRevisionRef(record.revisionRef),
        revision: memoryRevisionNumber(record.revision),
        ...(snapshot.kind === "restored" ? { restoredFromRevisionRef:
          memoryRevisionRef(record.restoredFromRevisionRef) } : {}) });
    }
    if (snapshot.kind === "prioritized" || snapshot.kind === "deprioritized") {
      const record = requireExactMemoryRecord(snapshot, ["kind", "spaceRef", "spaceVersion",
        "entryRef", "entryVersion", "prioritized", "changed"], "MEMORY_ENTRY_INVALID");
      if (typeof record.prioritized !== "boolean" || typeof record.changed !== "boolean" ||
        record.prioritized !== (snapshot.kind === "prioritized")) {
        throw new MemoryApplicationError("MEMORY_RECEIPT_INVALID");
      }
      return Object.freeze({ kind: snapshot.kind, spaceRef: memorySpaceRef(record.spaceRef),
        spaceVersion: memoryAggregateVersion(record.spaceVersion),
        entryRef: memoryEntryRef(record.entryRef),
        entryVersion: memoryAggregateVersion(record.entryVersion),
        prioritized: record.prioritized, changed: record.changed });
    }
    if (snapshot.kind === "forgotten") {
      const record = requireExactMemoryRecord(snapshot, ["kind", "spaceRef", "spaceVersion",
        "entryRef", "entryVersion", "revocationEpoch"], "MEMORY_ENTRY_INVALID");
      return Object.freeze({ kind: "forgotten" as const, spaceRef: memorySpaceRef(record.spaceRef),
        spaceVersion: memoryAggregateVersion(record.spaceVersion),
        entryRef: memoryEntryRef(record.entryRef),
        entryVersion: memoryAggregateVersion(record.entryVersion),
        revocationEpoch: memoryRevocationEpoch(record.revocationEpoch) });
    }
    if (["learning_paused", "learning_resumed", "use_paused", "use_resumed", "reset"]
      .includes(snapshot.kind as string)) {
      const record = requireExactMemoryRecord(snapshot, ["kind", "spaceRef", "spaceVersion",
        "spaceGeneration", "learningGeneration", "revocationEpoch",
        "minimumLearnableSourceOriginSequence", "learningState", "useState"],
      "MEMORY_ENTRY_INVALID");
      const kind = snapshot.kind as "learning_paused" | "learning_resumed" | "use_paused" |
        "use_resumed" | "reset";
      return Object.freeze({ kind, spaceRef: memorySpaceRef(record.spaceRef),
        spaceVersion: memoryAggregateVersion(record.spaceVersion),
        spaceGeneration: memorySpaceGeneration(record.spaceGeneration),
        learningGeneration: memoryLearningGeneration(record.learningGeneration),
        revocationEpoch: memoryRevocationEpoch(record.revocationEpoch),
        minimumLearnableSourceOriginSequence:
          memorySourceOriginSequence(record.minimumLearnableSourceOriginSequence),
        learningState: memoryControlState(record.learningState),
        useState: memoryControlState(record.useState) });
    }
    if (snapshot.kind === "policy_rebound") {
      const record = requireExactMemoryRecord(snapshot, ["kind", "spaceRef", "spaceVersion",
        "previousFeaturePolicyRevisionRef", "featurePolicyRevisionRef", "spaceGeneration",
        "learningGeneration", "revocationEpoch", "minimumLearnableSourceOriginSequence",
        "learningState", "useState"], "MEMORY_ENTRY_INVALID");
      if (record.learningState !== "paused" || record.useState !== "paused") {
        throw new MemoryApplicationError("MEMORY_RECEIPT_INVALID");
      }
      const previousPolicy = memoryFeaturePolicyRevisionRef(record.previousFeaturePolicyRevisionRef);
      const nextPolicy = memoryFeaturePolicyRevisionRef(record.featurePolicyRevisionRef);
      if (previousPolicy === nextPolicy) throw new MemoryApplicationError("MEMORY_RECEIPT_INVALID");
      return Object.freeze({ kind: "policy_rebound", spaceRef: memorySpaceRef(record.spaceRef),
        spaceVersion: memoryAggregateVersion(record.spaceVersion),
        previousFeaturePolicyRevisionRef: previousPolicy,
        featurePolicyRevisionRef: nextPolicy,
        spaceGeneration: memorySpaceGeneration(record.spaceGeneration),
        learningGeneration: memoryLearningGeneration(record.learningGeneration),
        revocationEpoch: memoryRevocationEpoch(record.revocationEpoch),
        minimumLearnableSourceOriginSequence:
          memorySourceOriginSequence(record.minimumLearnableSourceOriginSequence),
        learningState: "paused", useState: "paused" });
    }
  } catch (error) {
    if (error instanceof MemoryApplicationError) throw error;
    throw new MemoryApplicationError("MEMORY_RECEIPT_INVALID");
  }
  throw new MemoryApplicationError("MEMORY_RECEIPT_INVALID");
}

function resultKindForOperation(operation: MemoryCommandOperation): MemoryCommandResult["kind"] {
  switch (operation) {
    case "remember": return "remembered";
    case "correct": return "corrected";
    case "restore": return "restored";
    case "prioritize": return "prioritized";
    case "deprioritize": return "deprioritized";
    case "forget": return "forgotten";
    case "pause_learning": return "learning_paused";
    case "resume_learning": return "learning_resumed";
    case "pause_use": return "use_paused";
    case "resume_use": return "use_resumed";
    case "reset": return "reset";
    case "rebind_policy": return "policy_rebound";
  }
}

function memoryControlState(value: unknown): "active" | "paused" {
  if (value !== "active" && value !== "paused") {
    throw new MemoryApplicationError("MEMORY_RECEIPT_INVALID");
  }
  return value;
}

function decodeAuthorizationFacts(value: unknown): MemoryAuthorizationFactsResult {
  try {
    const snapshot = snapshotMemoryRecord(value, "MEMORY_SCOPE_INVALID");
    if (snapshot.kind === "authorized") {
      const record = requireExactMemoryRecord(snapshot,
        ["kind", "actorAuthorization", "featurePolicyRevisionRef"], "MEMORY_SCOPE_INVALID");
      return Object.freeze({ kind: "authorized" as const,
        actorAuthorization: rehydrateMemoryActorAuthorization(record.actorAuthorization),
        featurePolicyRevisionRef: memoryFeaturePolicyRevisionRef(record.featurePolicyRevisionRef) });
    }
    if (snapshot.kind === "denied") {
      const record = requireExactMemoryRecord(snapshot, ["kind", "reason"], "MEMORY_SCOPE_INVALID");
      const reasons = ["site_inactive", "subject_inactive", "subject_generation_mismatch",
        "project_inactive", "membership_inactive", "membership_epoch_mismatch",
        "authorization_epoch_mismatch", "feature_policy_mismatch"] as const;
      if (typeof record.reason !== "string" || !reasons.includes(
        record.reason as (typeof reasons)[number])) throw new Error("invalid denial reason");
      return Object.freeze({ kind: "denied" as const,
        reason: record.reason as (typeof reasons)[number] });
    }
  } catch {
    throw new MemoryApplicationError("MEMORY_AUTHORIZATION_FACTS_STALE");
  }
  throw new MemoryApplicationError("MEMORY_AUTHORIZATION_FACTS_STALE");
}

function rememberDigest(record: Readonly<Record<string, unknown>>, binding: MemoryScopeBinding,
  spaceRef: MemorySpaceRef, expectedSpaceVersion: bigint,
  featurePolicyRevisionRef: FeaturePolicyRevisionRef) {
  return computeCanonicalMemoryCommandDigest("remember", [
    ...bindingDigestFields(binding), ["spaceRef", spaceRef],
    ["expectedSpaceVersion", expectedSpaceVersion], ["entryRef", memoryEntryRef(record.entryRef)],
    ["revisionRef", memoryRevisionRef(record.revisionRef)],
    ["provenanceRef", memoryProvenanceRef(record.provenanceRef)],
    ["sourceDigest", memoryDigest(record.sourceDigest)], ...protectedContentDigestFields(record.protectedContent),
    ["category", memoryCategoryForDigest(record.category)],
    ["featurePolicyRevisionRef", featurePolicyRevisionRef],
    ["validFrom", nullableInstantForDigest(record.validFrom)],
    ["validTo", nullableInstantForDigest(record.validTo)],
    ["recordedAt", memoryInstant(record.recordedAt)],
  ]);
}

function correctDigest(record: Readonly<Record<string, unknown>>, siteRef: SiteRef,
  spaceRef: MemorySpaceRef, featurePolicyRevisionRef: FeaturePolicyRevisionRef) {
  return computeCanonicalMemoryCommandDigest("correct", [
    ["siteRef", siteRef], ["spaceRef", spaceRef],
    ["expectedSpaceVersion", memoryAggregateVersion(record.expectedSpaceVersion)],
    ["entryRef", memoryEntryRef(record.entryRef)],
    ["expectedEntryVersion", memoryAggregateVersion(record.expectedEntryVersion)],
    ["expectedCurrentRevision", memoryRevisionNumber(record.expectedCurrentRevision)],
    ["revisionRef", memoryRevisionRef(record.revisionRef)],
    ["provenanceRef", memoryProvenanceRef(record.provenanceRef)],
    ["sourceDigest", memoryDigest(record.sourceDigest)], ...protectedContentDigestFields(record.protectedContent),
    ["featurePolicyRevisionRef", featurePolicyRevisionRef],
    ["validFrom", nullableInstantForDigest(record.validFrom)],
    ["validTo", nullableInstantForDigest(record.validTo)],
    ["recordedAt", memoryInstant(record.recordedAt)],
  ]);
}

function restoreDigest(record: Readonly<Record<string, unknown>>, siteRef: SiteRef,
  spaceRef: MemorySpaceRef, featurePolicyRevisionRef: FeaturePolicyRevisionRef) {
  return computeCanonicalMemoryCommandDigest("restore", [
    ["siteRef", siteRef], ["spaceRef", spaceRef],
    ["expectedSpaceVersion", memoryAggregateVersion(record.expectedSpaceVersion)],
    ["entryRef", memoryEntryRef(record.entryRef)],
    ["expectedEntryVersion", memoryAggregateVersion(record.expectedEntryVersion)],
    ["expectedCurrentRevision", memoryRevisionNumber(record.expectedCurrentRevision)],
    ["revisionRef", memoryRevisionRef(record.revisionRef)],
    ["restoredFromRevisionRef", memoryRevisionRef(record.restoredFromRevisionRef)],
    ["provenanceRef", memoryProvenanceRef(record.provenanceRef)],
    ["sourceDigest", memoryDigest(record.sourceDigest)],
    ...protectedContentDigestFields(record.protectedContent),
    ["featurePolicyRevisionRef", featurePolicyRevisionRef],
    ["recordedAt", memoryInstant(record.recordedAt)],
  ]);
}

function priorityDigest(record: Readonly<Record<string, unknown>>, siteRef: SiteRef,
  spaceRef: MemorySpaceRef, featurePolicyRevisionRef: FeaturePolicyRevisionRef) {
  return computeCanonicalMemoryCommandDigest(record.prioritized === true ? "prioritize" : "deprioritize", [
    ["siteRef", siteRef], ["spaceRef", spaceRef],
    ["expectedSpaceVersion", memoryAggregateVersion(record.expectedSpaceVersion)],
    ["entryRef", memoryEntryRef(record.entryRef)],
    ["expectedEntryVersion", memoryAggregateVersion(record.expectedEntryVersion)],
    ["prioritized", record.prioritized === true ? "true" : "false"],
    ["featurePolicyRevisionRef", featurePolicyRevisionRef],
    ["recordedAt", memoryInstant(record.recordedAt)],
  ]);
}

function forgetDigest(record: Readonly<Record<string, unknown>>, siteRef: SiteRef,
  spaceRef: MemorySpaceRef, featurePolicyRevisionRef: FeaturePolicyRevisionRef) {
  return computeCanonicalMemoryCommandDigest("forget", [
    ["siteRef", siteRef], ["spaceRef", spaceRef],
    ["expectedSpaceVersion", memoryAggregateVersion(record.expectedSpaceVersion)],
    ["entryRef", memoryEntryRef(record.entryRef)],
    ["expectedEntryVersion", memoryAggregateVersion(record.expectedEntryVersion)],
    ["featurePolicyRevisionRef", featurePolicyRevisionRef],
    ["recordedAt", memoryInstant(record.recordedAt)],
  ]);
}

function rebindPolicyDigest(record: Readonly<Record<string, unknown>>, siteRef: SiteRef,
  spaceRef: MemorySpaceRef) {
  return computeCanonicalMemoryCommandDigest("rebind_policy", [
    ["siteRef", siteRef], ["spaceRef", spaceRef],
    ["expectedSpaceVersion", memoryAggregateVersion(record.expectedSpaceVersion)],
    ["expectedFeaturePolicyRevisionRef",
      memoryFeaturePolicyRevisionRef(record.expectedFeaturePolicyRevisionRef)],
    ["nextFeaturePolicyRevisionRef", memoryFeaturePolicyRevisionRef(record.nextFeaturePolicyRevisionRef)],
    ["cutoffOriginSequence", memorySourceOriginSequence(record.cutoffOriginSequence)],
    ["recordedAt", memoryInstant(record.recordedAt)],
  ]);
}

function controlDigest(operation: Exclude<MemoryCommandOperation, "remember" | "correct" | "forget" |
  "rebind_policy">, record: Readonly<Record<string, unknown>>, siteRef: SiteRef,
  spaceRef: MemorySpaceRef, featurePolicyRevisionRef: FeaturePolicyRevisionRef) {
  const fields: MemoryCommandDigestField[] = [["siteRef", siteRef], ["spaceRef", spaceRef],
    ["expectedSpaceVersion", memoryAggregateVersion(record.expectedSpaceVersion)],
    ["featurePolicyRevisionRef", featurePolicyRevisionRef]];
  if (operation === "resume_learning" || operation === "reset") {
    fields.push(["cutoffOriginSequence", memorySourceOriginSequence(record.cutoffOriginSequence)]);
  }
  fields.push(["recordedAt", memoryInstant(record.recordedAt)]);
  return computeCanonicalMemoryCommandDigest(operation, fields);
}

function protectedContentDigestFields(value: unknown): readonly MemoryCommandDigestField[] {
  const metadata = protectedMemoryContentDigestMetadata(value);
  return [["protectedEnvelopeVersion", metadata.envelopeVersion],
    ["protectedKeyRevision", metadata.keyRevision],
    ["protectedAadDigest", metadata.aadDigest],
    ["protectedNonceDigest", metadata.nonceDigest],
    ["protectedCiphertextLength", metadata.ciphertextLength],
    ["protectedCiphertextDigest", metadata.ciphertextDigest],
    ["protectedAuthenticationTagDigest", metadata.authenticationTagDigest]];
}

function bindingDigestFields(binding: MemoryScopeBinding): readonly MemoryCommandDigestField[] {
  const base = binding.kind === "agent_product" ? binding.parentBinding : binding;
  const fields: MemoryCommandDigestField[] = [["bindingKind", binding.kind],
    ["bindingSiteRef", base.siteRef]];
  if (base.kind === "user") {
    fields.push(["bindingSubjectRef", base.subjectRef],
      ["bindingSubjectGeneration", base.subjectGeneration]);
  } else {
    fields.push(["bindingProjectRef", base.projectRef]);
  }
  if (binding.kind === "agent_product") {
    fields.push(["bindingParentSpaceRef", binding.parentSpaceRef],
      ["bindingParentSpaceGeneration", binding.parentSpaceGeneration],
      ["bindingParentLearningGeneration", binding.parentLearningGeneration],
      ["bindingParentRevocationEpoch", binding.parentRevocationEpoch],
      ["bindingAgentOptionRef", binding.agentOptionRef],
      ["bindingProductSurfaceRef", binding.productSurfaceRef]);
  }
  return fields;
}

function memoryCategoryForDigest(value: unknown): string {
  if (value !== "fact" && value !== "preference" && value !== "profile") {
    throw new MemoryDomainError("MEMORY_CATEGORY_INVALID");
  }
  return value;
}

function receiptIdentity(binding: MemoryScopeBinding, actorAuthorization: MemoryActorAuthorization,
  operation: MemoryCommandOperation,
  commandRefValue: unknown, requestDigest: MemoryCommandReceiptIdentity["requestDigest"]):
  MemoryCommandReceiptIdentity {
  return Object.freeze({ owner: memoryReceiptOwner(binding), actorAuthorization,
    commandRef: memoryCommandRef(commandRefValue), operation,
    requestDigest });
}

function assertSpaceMatches(space: MemorySpace, binding: MemoryScopeBinding,
  featurePolicyRevisionRef: FeaturePolicyRevisionRef, expectedVersion: bigint): void {
  if (memoryBindingSiteRef(space.binding) !== memoryBindingSiteRef(binding) ||
    !sameMemoryScopeBinding(space.binding, binding)) {
    throw new MemoryApplicationError("MEMORY_AUTHORIZATION_FACTS_STALE");
  }
  if (space.featurePolicyRevisionRef !== featurePolicyRevisionRef) {
    throw new MemoryApplicationError("MEMORY_AUTHORIZATION_FACTS_STALE");
  }
  if (space.version !== expectedVersion) throw new MemoryApplicationError("MEMORY_PERSISTENCE_CONFLICT");
}

function rememberedResult(kind: "remembered" | "corrected" | "restored", space: MemorySpace,
  remembered: RememberedMemory): MemoryCommandResult {
  return Object.freeze({ kind, spaceRef: space.spaceRef, spaceVersion: space.version,
    entryRef: remembered.entry.entryRef, entryVersion: remembered.entry.version,
    revisionRef: remembered.revision.revisionRef, revision: remembered.revision.revision });
}

function nullableInstantForDigest(value: unknown): string {
  return value === null ? "null" : memoryInstant(value);
}

function withDefaultValidity(value: unknown): Readonly<Record<string, unknown>> {
  const record = snapshotMemoryRecord(value, "MEMORY_ENTRY_INVALID");
  return Object.freeze({ ...record, validFrom: record.validFrom ?? null, validTo: record.validTo ?? null });
}

function controlResult(operation: Exclude<MemoryCommandOperation, "remember" | "correct" | "restore" |
  "prioritize" | "deprioritize" | "forget" | "rebind_policy">,
  space: MemorySpace): MemoryCommandResult {
  const kind = operation === "pause_learning" ? "learning_paused"
    : operation === "resume_learning" ? "learning_resumed"
    : operation === "pause_use" ? "use_paused"
    : operation === "resume_use" ? "use_resumed" : "reset";
  return Object.freeze({ kind, spaceRef: space.spaceRef, spaceVersion: space.version,
    spaceGeneration: space.spaceGeneration, learningGeneration: space.learningGeneration,
    revocationEpoch: space.revocationEpoch,
    minimumLearnableSourceOriginSequence: space.minimumLearnableSourceOriginSequence,
    learningState: space.learningState, useState: space.useState });
}

function positiveVersion(value: unknown): AggregateVersion {
  return memoryAggregateVersion(value);
}

function nonNegativeVersion(value: unknown): bigint {
  if (typeof value !== "bigint" || value < 0n || value > 9_223_372_036_854_775_807n) {
    throw new MemoryApplicationError("MEMORY_PERSISTENCE_CONFLICT");
  }
  return value;
}
