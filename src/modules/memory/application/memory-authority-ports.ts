import type { PlatformTransaction } from "../../../shared/unit-of-work/index.js";
import type { MemoryEntry, RememberedMemory } from "../domain/memory-entry.js";
import type {
  AggregateVersion,
  FeaturePolicyRevisionRef,
  MemoryCommandRef,
  MemoryDigest,
  MemoryEntryRef,
  MemoryRevisionNumber,
  MemoryRevisionRef,
  MemorySpaceRef,
  ProjectRef,
  SiteRef,
  SubjectGeneration,
  SubjectRef,
} from "../domain/memory-references.js";
import type { BaseMemoryScopeBinding, MemoryActorAuthorization, MemoryScopeBinding, MemorySpace } from
  "../domain/memory-space.js";
import type { ProtectedMemoryContent } from "../domain/protected-memory-content.js";

export type MemoryAuthorizationDenialReason =
  | "site_inactive"
  | "subject_inactive"
  | "subject_generation_mismatch"
  | "project_inactive"
  | "membership_inactive"
  | "membership_epoch_mismatch"
  | "authorization_epoch_mismatch"
  | "feature_policy_mismatch";

export type MemoryAuthorizationFactsResult =
  | Readonly<{
      kind: "authorized";
      actorAuthorization: MemoryActorAuthorization;
      featurePolicyRevisionRef: FeaturePolicyRevisionRef;
    }>
  | Readonly<{ kind: "denied"; reason: MemoryAuthorizationDenialReason }>;

export interface MemoryAuthorizationFactsPort {
  /**
   * Resolves the current transaction-bound caller, never a caller-supplied actor snapshot. Project
   * authorization must check the caller's live Subject generation, membership epoch, and authorization
   * epoch and return `denied` on any mismatch or inactive authority row.
   */
  revalidate(
    transaction: PlatformTransaction,
    expected: Readonly<{
      binding: MemoryScopeBinding;
      featurePolicyRevisionRef: FeaturePolicyRevisionRef;
    }>,
  ): Promise<MemoryAuthorizationFactsResult>;
}

export type MemoryReceiptOwner =
  | Readonly<{
      kind: "user";
      siteRef: SiteRef;
      subjectRef: SubjectRef;
      subjectGeneration: SubjectGeneration;
    }>
  | Readonly<{ kind: "project"; siteRef: SiteRef; projectRef: ProjectRef }>;

export type MemoryCommandOperation =
  | "remember"
  | "correct"
  | "forget"
  | "pause_learning"
  | "resume_learning"
  | "pause_use"
  | "resume_use"
  | "reset"
  | "rebind_policy";

export type MemoryCommandReceiptIdentity = Readonly<{
  owner: MemoryReceiptOwner;
  actorAuthorization: MemoryActorAuthorization;
  commandRef: MemoryCommandRef;
  operation: MemoryCommandOperation;
  /** Computed by MemoryAuthorityService from the operation's canonical payload; never caller input. */
  requestDigest: MemoryDigest;
}>;

export type MemoryCommandResult =
  | Readonly<{
      kind: "remembered" | "corrected";
      spaceRef: MemorySpaceRef;
      spaceVersion: AggregateVersion;
      entryRef: MemoryEntryRef;
      entryVersion: AggregateVersion;
      revisionRef: MemoryRevisionRef;
      revision: MemoryRevisionNumber;
    }>
  | Readonly<{
      kind: "forgotten";
      spaceRef: MemorySpaceRef;
      spaceVersion: AggregateVersion;
      entryRef: MemoryEntryRef;
      entryVersion: AggregateVersion;
      revocationEpoch: bigint;
    }>
  | Readonly<{
      kind:
        | "learning_paused"
        | "learning_resumed"
        | "use_paused"
        | "use_resumed"
        | "reset";
      spaceRef: MemorySpaceRef;
      spaceVersion: AggregateVersion;
      spaceGeneration: bigint;
      learningGeneration: bigint;
      revocationEpoch: bigint;
      minimumLearnableSourceOriginSequence: bigint;
      learningState: "active" | "paused";
      useState: "active" | "paused";
    }>
  | Readonly<{
      kind: "policy_rebound";
      spaceRef: MemorySpaceRef;
      spaceVersion: AggregateVersion;
      previousFeaturePolicyRevisionRef: FeaturePolicyRevisionRef;
      featurePolicyRevisionRef: FeaturePolicyRevisionRef;
      spaceGeneration: bigint;
      learningGeneration: bigint;
      revocationEpoch: bigint;
      minimumLearnableSourceOriginSequence: bigint;
      learningState: "paused";
      useState: "paused";
    }>;

export type MemoryReceiptClaim =
  | Readonly<{ kind: "claimed" }>
  | Readonly<{ kind: "digest_conflict" }>
  | Readonly<{ kind: "replay"; result: MemoryCommandResult }>;

export interface MemoryAuthorityRepository {
  loadSpaceAuthorityForUpdate(
    transaction: PlatformTransaction,
    siteRef: SiteRef,
    spaceRef: MemorySpaceRef,
    expectedParentSpaceRef?: MemorySpaceRef,
  ): Promise<Readonly<{ space: MemorySpace | null; parent: MemorySpace | null }>>;
  loadSpaceForUpdate(
    transaction: PlatformTransaction,
    siteRef: SiteRef,
    spaceRef: MemorySpaceRef,
  ): Promise<MemorySpace | null>;
  loadEntryForUpdate(
    transaction: PlatformTransaction,
    siteRef: SiteRef,
    spaceRef: MemorySpaceRef,
    entryRef: MemoryEntryRef,
  ): Promise<MemoryEntry | null>;
  claimReceipt(
    transaction: PlatformTransaction,
    identity: MemoryCommandReceiptIdentity,
  ): Promise<MemoryReceiptClaim>;
  completeReceipt(
    transaction: PlatformTransaction,
    identity: MemoryCommandReceiptIdentity,
    result: MemoryCommandResult,
  ): Promise<void>;
  saveRememberedMemory(
    transaction: PlatformTransaction,
    newSpace: MemorySpace | null,
    remembered: RememberedMemory,
  ): Promise<void>;
  saveCorrectedMemory(
    transaction: PlatformTransaction,
    expected: Readonly<{
      entryVersion: AggregateVersion;
      currentRevision: MemoryRevisionNumber;
    }>,
    corrected: RememberedMemory,
  ): Promise<void>;
  saveForgottenMemory(
    transaction: PlatformTransaction,
    expected: Readonly<{ spaceVersion: AggregateVersion; entryVersion: AggregateVersion }>,
    space: MemorySpace,
    entry: MemoryEntry,
  ): Promise<void>;
  saveSpace(
    transaction: PlatformTransaction,
    expectedVersion: AggregateVersion,
    space: MemorySpace,
  ): Promise<void>;
  saveReboundPolicy(
    transaction: PlatformTransaction,
    expected: Readonly<{ version: AggregateVersion; featurePolicyRevisionRef: FeaturePolicyRevisionRef }>,
    space: MemorySpace,
  ): Promise<void>;
}

/** No transaction argument by design: protection must finish before an authority transaction opens. */
export interface MemoryContentProtectionPort {
  protect(input: Readonly<{ kind: "explicit_memory"; plaintext: string }>):
    Promise<ProtectedMemoryContent>;
}

export function memoryReceiptOwner(binding: MemoryScopeBinding): MemoryReceiptOwner {
  const base: BaseMemoryScopeBinding = binding.kind === "agent_product"
    ? binding.parentBinding
    : binding;
  return base.kind === "user"
    ? Object.freeze({ kind: "user", siteRef: base.siteRef, subjectRef: base.subjectRef,
      subjectGeneration: base.subjectGeneration })
    : Object.freeze({ kind: "project", siteRef: base.siteRef, projectRef: base.projectRef });
}
