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
import type { MemoryCategory, MemoryRevisionReason } from "../domain/memory-entry.js";
import type { MemoryCommandFingerprintPort, MemoryContentAdmissionPort, MemoryPublicPersonalContext } from
  "../domain/memory-public.js";

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
  protect(input: Readonly<{ binding: MemoryPayloadBinding; plaintext: Uint8Array }>):
    Promise<ProtectedMemoryContent>;
  reveal(input: Readonly<{
    binding: MemoryPayloadBinding;
    protectedContent: ProtectedMemoryContent;
  }>): Promise<Uint8Array>;
}

export type MemoryPayloadBinding = Readonly<{
  siteRef: SiteRef;
  spaceRef: MemorySpaceRef;
  entryRef: MemoryEntryRef;
  revisionRef: MemoryRevisionRef;
}>;

export function memoryReceiptOwner(binding: MemoryScopeBinding): MemoryReceiptOwner {
  const base: BaseMemoryScopeBinding = binding.kind === "agent_product"
    ? binding.parentBinding
    : binding;
  return base.kind === "user"
    ? Object.freeze({ kind: "user", siteRef: base.siteRef, subjectRef: base.subjectRef,
      subjectGeneration: base.subjectGeneration })
    : Object.freeze({ kind: "project", siteRef: base.siteRef, projectRef: base.projectRef });
}

export type MemoryPublicOperation = "remember" | "correct" | "restore" | "prioritize" |
  "deprioritize" | "forget" | "reset";

export type MemoryPublicCommand = Readonly<{
  operation: MemoryPublicOperation;
  context: MemoryPublicPersonalContext;
  commandRef: string;
  requestDigest: string;
  requestDigestKeyRevision: string;
  spaceRef: string;
  entryRef: string | null;
  revisionRef: string | null;
  provenanceRef?: string | null;
  category?: MemoryCategory;
  protectedContent?: ProtectedMemoryContent;
  expectedRevision?: number;
  expectedEntryVersion?: bigint;
  restoredFromRevisionRef?: string;
  prioritized?: boolean;
  validFrom?: string | null;
  validTo?: string | null;
  recordedAt: string;
}>;

export type MemoryPublicCommandResult = Readonly<{
  kind: "entry" | "restored" | "purge";
  committedSpaceVersion: bigint;
  entryRef: string | null;
  entryVersion?: bigint;
  revision?: bigint;
  revisionRef?: string;
  restoredFromRevisionRef?: string;
  prioritized?: boolean;
  replayed?: boolean;
}>;

export type MemoryPublicResolvedOwner = Readonly<{
  context: MemoryPublicPersonalContext;
  spaceRef: string;
  spaceVersion: bigint;
}>;

export type MemoryPublicEntryRecord = Readonly<{
  entryRef: string;
  entryVersion: bigint;
  category: MemoryCategory;
  state: "active" | "revoked_purge_pending" | "purged";
  prioritized: boolean;
  revision: bigint;
  currentRevisionRef: string;
  reason: MemoryRevisionReason | "imported" | "restored";
  validFrom: string | null;
  validTo: string | null;
  createdAt: string;
  updatedAt: string;
  protectedContent: ProtectedMemoryContent | null;
  sourceKind: "explicit" | "import";
  sourceState: "current" | "restricted" | "unavailable";
  safeSourceLabel: string;
  purgeReceiptRef?: string;
  revokedAt?: string;
  purgedAt?: string;
}>;

export type MemoryPublicRevisionRecord = Readonly<{
  revision: bigint;
  revisionRef: string;
  reason: MemoryRevisionReason | "imported" | "restored";
  supersedesRevisionRef: string | null;
  restoredFromRevisionRef: string | null;
  validFrom: string | null;
  validTo: string | null;
  recordedAt: string;
  protectedContent: ProtectedMemoryContent | null;
}>;

export interface MemoryPublicRepository {
  executeCommand(transaction: PlatformTransaction, command: MemoryPublicCommand):
    Promise<MemoryPublicCommandResult>;
  resolveOwner(transaction: PlatformTransaction, input: Readonly<{
    context: MemoryPublicPersonalContext;
    operation: "list_entries" | "get_entry" | "list_history" | "restore";
    now: string;
    candidateSpaceRef: string;
  }>): Promise<MemoryPublicResolvedOwner | null>;
  listEntries(transaction: PlatformTransaction, input: Readonly<{
    owner: MemoryPublicResolvedOwner;
    category: MemoryCategory | null;
    source: "explicit" | "import" | null;
    after: Readonly<{ prioritized: boolean; updatedAt: string; entryRef: string }> | null;
    limit: number;
  }>): Promise<readonly MemoryPublicEntryRecord[]>;
  getEntry(transaction: PlatformTransaction, input: Readonly<{
    owner: MemoryPublicResolvedOwner; entryRef: string;
  }>): Promise<MemoryPublicEntryRecord | null>;
  listHistory(transaction: PlatformTransaction, input: Readonly<{
    owner: MemoryPublicResolvedOwner; entryRef: string; revisionBefore: bigint | null; limit: number;
  }>): Promise<Readonly<{ entry: MemoryPublicEntryRecord;
    revisions: readonly MemoryPublicRevisionRecord[] }> | null>;
  getRevisionForRestore?(transaction: PlatformTransaction, input: Readonly<{
    owner: MemoryPublicResolvedOwner; entryRef: string; revisionRef: string; expectedRevision: number;
  }>): Promise<MemoryPublicRevisionRecord | null>;
}

export type MemoryPublicCursor = Readonly<{
  kind: "entries" | "history";
  context: MemoryPublicPersonalContext;
  category: MemoryCategory | null;
  source: "explicit" | "import" | null;
  order: "priority_updated_entry_desc" | "revision_desc";
  spaceVersion: bigint;
  snapshotRef: string;
  prioritized?: boolean;
  updatedAt?: string;
  entryRef: string;
  revision?: bigint;
  expiresAt: string;
}>;

export interface MemoryPublicCursorCodec {
  encode(cursor: MemoryPublicCursor): string;
  decode(value: string): MemoryPublicCursor;
}

export interface MemoryPublicUnitOfWork {
  execute<Result>(fence: Readonly<{ operation: string }>,
    work: (transaction: PlatformTransaction) => Promise<Result>): Promise<Result>;
}

export type { MemoryCommandFingerprintPort, MemoryContentAdmissionPort, MemoryPublicPersonalContext };
