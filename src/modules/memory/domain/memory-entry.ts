import { MemoryDomainError } from "./memory-error.js";
import {
  incrementMemoryInt8,
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
  memorySiteRef,
  memorySpaceGeneration,
  memorySpaceRef,
  type AggregateVersion,
  type FeaturePolicyRevisionRef,
  type LearningGeneration,
  type MemoryCommandRef,
  type MemoryDigest,
  type MemoryEntryRef,
  type MemoryInstant,
  type MemoryProvenanceRef,
  type MemoryRevisionNumber,
  type MemoryRevisionRef,
  type MemorySpaceRef,
  type MembershipEpoch,
  type AuthorizationEpoch,
  type ProjectRef,
  type RevocationEpoch,
  type SiteRef,
  type SpaceGeneration,
  type SubjectGeneration,
  type SubjectRef,
} from "./memory-references.js";
import { assertProtectedMemoryContent, type ProtectedMemoryContent } from "./protected-memory-content.js";
import { memoryActorAuthorizesBinding, memoryBindingSiteRef, rehydrateMemoryActorAuthorization,
  rehydrateMemorySpace, type MemoryActorAuthorization, type MemorySpace } from "./memory-space.js";
import { snapshotExactMemoryRecord } from "./runtime-validation.js";

const memoryCategories = Object.freeze(["fact", "preference", "profile"] as const);
export type MemoryCategory = (typeof memoryCategories)[number];
export type MemoryEntryState = "active" | "deleted";
export type MemoryRevisionReason = "explicit" | "corrected";

export type MemoryEntry = Readonly<{
  siteRef: SiteRef;
  spaceRef: MemorySpaceRef;
  entryRef: MemoryEntryRef;
  version: AggregateVersion;
  currentRevision: MemoryRevisionNumber;
  currentRevisionRef: MemoryRevisionRef;
  state: MemoryEntryState;
  category: MemoryCategory;
  featurePolicyRevisionRef: FeaturePolicyRevisionRef;
  spaceGeneration: SpaceGeneration;
  learningGeneration: LearningGeneration;
  revocationEpoch: RevocationEpoch;
  createdAt: MemoryInstant;
  updatedAt: MemoryInstant;
  deletedAt: MemoryInstant | null;
}>;

export type MemoryRevision = Readonly<{
  siteRef: SiteRef;
  spaceRef: MemorySpaceRef;
  entryRef: MemoryEntryRef;
  revisionRef: MemoryRevisionRef;
  revision: MemoryRevisionNumber;
  protectedContent: ProtectedMemoryContent;
  reason: MemoryRevisionReason;
  supersedesRevisionRef: MemoryRevisionRef | null;
  featurePolicyRevisionRef: FeaturePolicyRevisionRef;
  recordedAt: MemoryInstant;
}>;

export type MemoryProvenance = Readonly<{
  siteRef: SiteRef;
  spaceRef: MemorySpaceRef;
  entryRef: MemoryEntryRef;
  revisionRef: MemoryRevisionRef;
  provenanceRef: MemoryProvenanceRef;
  sourceKind: "authenticated_user_command";
  sourceRef: MemoryCommandRef;
  sourceDigest: MemoryDigest;
  actorSubjectRef: SubjectRef;
  actorSubjectGeneration: SubjectGeneration;
  actorProjectRef: ProjectRef | null;
  actorMembershipEpoch: MembershipEpoch | null;
  actorAuthorizationEpoch: AuthorizationEpoch | null;
  recordedAt: MemoryInstant;
}>;

export type RememberedMemory = Readonly<{
  entry: MemoryEntry;
  revision: MemoryRevision;
  provenance: MemoryProvenance;
}>;

export function createRememberedMemory(value: unknown): RememberedMemory {
  const record = snapshotExactMemoryRecord(value, ["space", "entryRef", "revisionRef", "provenanceRef",
    "sourceCommandRef", "sourceDigest", "protectedContent", "category", "featurePolicyRevisionRef",
    "actorAuthorization", "recordedAt"], "MEMORY_ENTRY_INVALID");
  const space = rehydrateMemorySpace(record.space);
  assertActiveSpace(space);
  const actorAuthorization = rehydrateMemoryActorAuthorization(record.actorAuthorization);
  if (!memoryActorAuthorizesBinding(actorAuthorization, space.binding)) {
    throw new MemoryDomainError("MEMORY_SCOPE_INVALID");
  }
  const featurePolicyRevisionRef = memoryFeaturePolicyRevisionRef(record.featurePolicyRevisionRef);
  if (featurePolicyRevisionRef !== space.featurePolicyRevisionRef) {
    throw new MemoryDomainError("MEMORY_FEATURE_POLICY_CONFLICT");
  }
  assertProtectedMemoryContent(record.protectedContent);
  const siteRef = memoryBindingSiteRef(space.binding);
  const entryRef = memoryEntryRef(record.entryRef);
  const revisionRef = memoryRevisionRef(record.revisionRef);
  const recordedAt = memoryInstant(record.recordedAt);
  if (recordedAt < space.updatedAt) throw new MemoryDomainError("MEMORY_INSTANT_INVALID");
  const category = memoryCategory(record.category);
  const entry = rehydrateMemoryEntry({
    siteRef, spaceRef: space.spaceRef, entryRef, version: 1n, currentRevision: 1n,
    currentRevisionRef: revisionRef, state: "active", category, featurePolicyRevisionRef,
    spaceGeneration: space.spaceGeneration, learningGeneration: space.learningGeneration,
    revocationEpoch: space.revocationEpoch, createdAt: recordedAt, updatedAt: recordedAt,
    deletedAt: null,
  });
  const revision = Object.freeze({ siteRef, spaceRef: space.spaceRef, entryRef, revisionRef,
    revision: memoryRevisionNumber(1n), protectedContent: record.protectedContent,
    reason: "explicit" as const, supersedesRevisionRef: null, featurePolicyRevisionRef, recordedAt });
  const provenance = provenanceFor(record, actorAuthorization, siteRef, space.spaceRef, entryRef,
    revisionRef, recordedAt);
  return Object.freeze({ entry, revision, provenance });
}

export function rehydrateMemoryEntry(value: unknown): MemoryEntry {
  const record = snapshotExactMemoryRecord(value, ["siteRef", "spaceRef", "entryRef", "version",
    "currentRevision", "currentRevisionRef", "state", "category", "featurePolicyRevisionRef",
    "spaceGeneration", "learningGeneration", "revocationEpoch", "createdAt", "updatedAt", "deletedAt"],
  "MEMORY_ENTRY_INVALID");
  const state = memoryEntryState(record.state);
  const createdAt = memoryInstant(record.createdAt);
  const updatedAt = memoryInstant(record.updatedAt);
  const deletedAt = record.deletedAt === null ? null : memoryInstant(record.deletedAt);
  if (updatedAt < createdAt || (state === "active" && deletedAt !== null) ||
    (state === "deleted" && (deletedAt === null || deletedAt !== updatedAt))) {
    throw new MemoryDomainError("MEMORY_ENTRY_INVALID");
  }
  return Object.freeze({
    siteRef: memorySiteRef(record.siteRef), spaceRef: memorySpaceRef(record.spaceRef),
    entryRef: memoryEntryRef(record.entryRef), version: memoryAggregateVersion(record.version),
    currentRevision: memoryRevisionNumber(record.currentRevision),
    currentRevisionRef: memoryRevisionRef(record.currentRevisionRef), state,
    category: memoryCategory(record.category),
    featurePolicyRevisionRef: memoryFeaturePolicyRevisionRef(record.featurePolicyRevisionRef),
    spaceGeneration: memorySpaceGeneration(record.spaceGeneration),
    learningGeneration: memoryLearningGeneration(record.learningGeneration),
    revocationEpoch: memoryRevocationEpoch(record.revocationEpoch), createdAt, updatedAt, deletedAt,
  });
}

export function correctMemoryEntry(value: unknown): RememberedMemory {
  const record = snapshotExactMemoryRecord(value, ["space", "entry", "expectedVersion",
    "expectedCurrentRevision", "revisionRef", "provenanceRef", "sourceCommandRef", "sourceDigest",
    "protectedContent",
    "featurePolicyRevisionRef", "actorAuthorization", "recordedAt"], "MEMORY_ENTRY_INVALID");
  const space = rehydrateMemorySpace(record.space);
  const entry = rehydrateMemoryEntry(record.entry);
  if (space.state !== "active") throw new MemoryDomainError("MEMORY_SPACE_STATE_CONFLICT");
  if (entry.siteRef !== memoryBindingSiteRef(space.binding) || entry.spaceRef !== space.spaceRef) {
    throw new MemoryDomainError("MEMORY_ENTRY_INVALID");
  }
  if (entry.state !== "active") throw new MemoryDomainError("MEMORY_ENTRY_STATE_CONFLICT");
  assertCurrentEntryFence(space, entry);
  if (entry.version !== memoryAggregateVersion(record.expectedVersion)) {
    throw new MemoryDomainError("MEMORY_VERSION_CONFLICT");
  }
  if (entry.currentRevision !== memoryRevisionNumber(record.expectedCurrentRevision)) {
    throw new MemoryDomainError("MEMORY_REVISION_CONFLICT");
  }
  const featurePolicyRevisionRef = memoryFeaturePolicyRevisionRef(record.featurePolicyRevisionRef);
  if (entry.featurePolicyRevisionRef !== featurePolicyRevisionRef ||
    space.featurePolicyRevisionRef !== featurePolicyRevisionRef) {
    throw new MemoryDomainError("MEMORY_FEATURE_POLICY_CONFLICT");
  }
  assertProtectedMemoryContent(record.protectedContent);
  const actorAuthorization = rehydrateMemoryActorAuthorization(record.actorAuthorization);
  if (!memoryActorAuthorizesBinding(actorAuthorization, space.binding)) {
    throw new MemoryDomainError("MEMORY_SCOPE_INVALID");
  }
  const recordedAt = memoryInstant(record.recordedAt);
  if (recordedAt < entry.updatedAt || recordedAt < space.updatedAt) {
    throw new MemoryDomainError("MEMORY_INSTANT_INVALID");
  }
  const revisionRef = memoryRevisionRef(record.revisionRef);
  if (revisionRef === entry.currentRevisionRef) throw new MemoryDomainError("MEMORY_REVISION_CONFLICT");
  const nextRevision = incrementMemoryInt8(entry.currentRevision);
  const nextEntry = rehydrateMemoryEntry({ ...entry, version: incrementMemoryInt8(entry.version),
    currentRevision: nextRevision, currentRevisionRef: revisionRef, updatedAt: recordedAt });
  const revision = Object.freeze({ siteRef: entry.siteRef, spaceRef: entry.spaceRef,
    entryRef: entry.entryRef, revisionRef, revision: nextRevision,
    protectedContent: record.protectedContent, reason: "corrected" as const,
    supersedesRevisionRef: entry.currentRevisionRef, featurePolicyRevisionRef, recordedAt });
  const provenance = provenanceFor(record, actorAuthorization, entry.siteRef, entry.spaceRef, entry.entryRef,
    revisionRef, recordedAt);
  return Object.freeze({ entry: nextEntry, revision, provenance });
}

export function forgetMemoryEntry(value: unknown): Readonly<{ space: MemorySpace; entry: MemoryEntry }> {
  const record = snapshotExactMemoryRecord(value, ["space", "entry", "expectedSpaceVersion",
    "expectedEntryVersion", "forgottenAt"], "MEMORY_ENTRY_INVALID");
  const space = rehydrateMemorySpace(record.space);
  const entry = rehydrateMemoryEntry(record.entry);
  if (space.state !== "active") throw new MemoryDomainError("MEMORY_SPACE_STATE_CONFLICT");
  if (entry.state !== "active") throw new MemoryDomainError("MEMORY_ENTRY_STATE_CONFLICT");
  if (space.version !== memoryAggregateVersion(record.expectedSpaceVersion) ||
    entry.version !== memoryAggregateVersion(record.expectedEntryVersion)) {
    throw new MemoryDomainError("MEMORY_VERSION_CONFLICT");
  }
  if (entry.siteRef !== memoryBindingSiteRef(space.binding) || entry.spaceRef !== space.spaceRef) {
    throw new MemoryDomainError("MEMORY_ENTRY_INVALID");
  }
  assertCurrentEntryFence(space, entry);
  const forgottenAt = memoryInstant(record.forgottenAt);
  if (forgottenAt < space.updatedAt || forgottenAt < entry.updatedAt) {
    throw new MemoryDomainError("MEMORY_INSTANT_INVALID");
  }
  const nextSpace = rehydrateMemorySpace({ ...space, version: incrementMemoryInt8(space.version),
    revocationEpoch: incrementMemoryInt8(space.revocationEpoch), updatedAt: forgottenAt });
  const nextEntry = rehydrateMemoryEntry({ ...entry, version: incrementMemoryInt8(entry.version),
    revocationEpoch: nextSpace.revocationEpoch, state: "deleted",
    updatedAt: forgottenAt, deletedAt: forgottenAt });
  return Object.freeze({ space: nextSpace, entry: nextEntry });
}

export function assertCurrentEntryFence(space: MemorySpace, entry: MemoryEntry): void {
  if (entry.featurePolicyRevisionRef !== space.featurePolicyRevisionRef ||
    entry.spaceGeneration !== space.spaceGeneration ||
    entry.learningGeneration !== space.learningGeneration ||
    entry.revocationEpoch > space.revocationEpoch) {
    throw new MemoryDomainError("MEMORY_ENTRY_FENCE_CONFLICT");
  }
}

function provenanceFor(record: Readonly<Record<string, unknown>>, actor: MemoryActorAuthorization,
  siteRef: SiteRef,
  spaceRef: MemorySpaceRef, entryRef: MemoryEntryRef, revisionRef: MemoryRevisionRef,
  recordedAt: MemoryInstant): MemoryProvenance {
  return Object.freeze({ siteRef, spaceRef, entryRef, revisionRef,
    provenanceRef: memoryProvenanceRef(record.provenanceRef),
    sourceKind: "authenticated_user_command", sourceRef: memoryCommandRef(record.sourceCommandRef),
    sourceDigest: memoryDigest(record.sourceDigest), actorSubjectRef: actor.subjectRef,
    actorSubjectGeneration: actor.subjectGeneration,
    actorProjectRef: actor.kind === "project_member" ? actor.projectRef : null,
    actorMembershipEpoch: actor.kind === "project_member" ? actor.membershipEpoch : null,
    actorAuthorizationEpoch: actor.kind === "project_member" ? actor.authorizationEpoch : null,
    recordedAt });
}

function assertActiveSpace(space: MemorySpace): void {
  if (space.state !== "active") throw new MemoryDomainError("MEMORY_SPACE_STATE_CONFLICT");
}

function memoryCategory(value: unknown): MemoryCategory {
  if (typeof value !== "string" || !memoryCategories.includes(value as MemoryCategory)) {
    throw new MemoryDomainError("MEMORY_CATEGORY_INVALID");
  }
  return value as MemoryCategory;
}

function memoryEntryState(value: unknown): MemoryEntryState {
  if (value !== "active" && value !== "deleted") throw new MemoryDomainError("MEMORY_ENTRY_INVALID");
  return value;
}
