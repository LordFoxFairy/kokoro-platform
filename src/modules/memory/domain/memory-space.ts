import { MemoryDomainError } from "./memory-error.js";
import {
  incrementMemoryInt8,
  memoryAggregateVersion,
  memoryAgentOptionRef,
  memoryAuthorizationEpoch,
  memoryFeaturePolicyRevisionRef,
  memoryInstant,
  memoryLearningGeneration,
  memoryMembershipEpoch,
  memoryProductSurfaceRef,
  memoryProjectRef,
  memoryRevocationEpoch,
  memorySiteRef,
  memorySourceOriginSequence,
  memorySpaceGeneration,
  memorySpaceRef,
  memorySubjectGeneration,
  memorySubjectRef,
  type AgentOptionRef,
  type AggregateVersion,
  type AuthorizationEpoch,
  type FeaturePolicyRevisionRef,
  type LearningGeneration,
  type MembershipEpoch,
  type MemoryInstant,
  type MemorySpaceRef,
  type ProductSurfaceRef,
  type ProjectRef,
  type RevocationEpoch,
  type SiteRef,
  type SourceOriginSequence,
  type SpaceGeneration,
  type SubjectGeneration,
  type SubjectRef,
} from "./memory-references.js";
import { requireExactMemoryRecord, snapshotExactMemoryRecord, snapshotMemoryRecord,
  type MemoryRecordSnapshot } from
  "./runtime-validation.js";

export type UserMemoryScopeBinding = Readonly<{
  kind: "user";
  siteRef: SiteRef;
  subjectRef: SubjectRef;
  subjectGeneration: SubjectGeneration;
}>;

export type ProjectMemoryScopeBinding = Readonly<{
  kind: "project";
  siteRef: SiteRef;
  projectRef: ProjectRef;
}>;

export type BaseMemoryScopeBinding = UserMemoryScopeBinding | ProjectMemoryScopeBinding;

export type AgentProductMemoryScopeBinding = Readonly<{
  kind: "agent_product";
  parentSpaceRef: MemorySpaceRef;
  parentBinding: BaseMemoryScopeBinding;
  parentSpaceGeneration: SpaceGeneration;
  parentLearningGeneration: LearningGeneration;
  parentRevocationEpoch: RevocationEpoch;
  agentOptionRef: AgentOptionRef;
  productSurfaceRef: ProductSurfaceRef;
}>;

export type MemoryScopeBinding = BaseMemoryScopeBinding | AgentProductMemoryScopeBinding;
export type UserMemoryActorAuthorization = UserMemoryScopeBinding;
export type ProjectMemoryActorAuthorization = Readonly<{
  kind: "project_member";
  siteRef: SiteRef;
  projectRef: ProjectRef;
  subjectRef: SubjectRef;
  subjectGeneration: SubjectGeneration;
  membershipEpoch: MembershipEpoch;
  authorizationEpoch: AuthorizationEpoch;
}>;
export type MemoryActorAuthorization =
  | UserMemoryActorAuthorization
  | ProjectMemoryActorAuthorization;
export type MemoryLearningState = "active" | "paused";
export type MemoryUseState = "active" | "paused";
export type MemorySpaceState = "active" | "deleted";

export type MemorySpace = Readonly<{
  spaceRef: MemorySpaceRef;
  binding: MemoryScopeBinding;
  featurePolicyRevisionRef: FeaturePolicyRevisionRef;
  version: AggregateVersion;
  spaceGeneration: SpaceGeneration;
  learningGeneration: LearningGeneration;
  revocationEpoch: RevocationEpoch;
  minimumLearnableSourceOriginSequence: SourceOriginSequence;
  learningState: MemoryLearningState;
  useState: MemoryUseState;
  state: MemorySpaceState;
  createdAt: MemoryInstant;
  updatedAt: MemoryInstant;
}>;

export function createMemorySpace(value: unknown): MemorySpace {
  const record = snapshotExactMemoryRecord(value,
    ["spaceRef", "binding", "featurePolicyRevisionRef", "recordedAt"], "MEMORY_SPACE_INVALID");
  const recordedAt = memoryInstant(record.recordedAt);
  const binding = rehydrateMemoryScopeBinding(record.binding);
  if (binding.kind === "agent_product") throw new MemoryDomainError("MEMORY_SCOPE_INVALID");
  return rehydrateMemorySpace({
    spaceRef: record.spaceRef,
    binding,
    featurePolicyRevisionRef: record.featurePolicyRevisionRef,
    version: 1n,
    spaceGeneration: 1n,
    learningGeneration: 1n,
    revocationEpoch: 1n,
    minimumLearnableSourceOriginSequence: 1n,
    learningState: "active",
    useState: "active",
    state: "active",
    createdAt: recordedAt,
    updatedAt: recordedAt,
  });
}

export function createAgentProductMemorySpace(value: unknown): MemorySpace {
  const record = snapshotExactMemoryRecord(value,
    ["spaceRef", "binding", "parent", "featurePolicyRevisionRef", "recordedAt"],
    "MEMORY_SPACE_INVALID");
  const parent = rehydrateMemorySpace(record.parent);
  const binding = rehydrateMemoryScopeBinding(record.binding);
  const featurePolicyRevisionRef = memoryFeaturePolicyRevisionRef(record.featurePolicyRevisionRef);
  if (binding.kind !== "agent_product" || parent.binding.kind === "agent_product" ||
    parent.state !== "active" || binding.parentSpaceRef !== parent.spaceRef ||
    !sameMemoryScopeBinding(binding.parentBinding, parent.binding) ||
    binding.parentSpaceGeneration !== parent.spaceGeneration ||
    binding.parentLearningGeneration !== parent.learningGeneration ||
    binding.parentRevocationEpoch !== parent.revocationEpoch ||
    featurePolicyRevisionRef !== parent.featurePolicyRevisionRef) {
    throw new MemoryDomainError("MEMORY_SCOPE_INVALID");
  }
  const recordedAt = memoryInstant(record.recordedAt);
  if (recordedAt < parent.updatedAt) throw new MemoryDomainError("MEMORY_INSTANT_INVALID");
  return rehydrateMemorySpace({ spaceRef: record.spaceRef, binding, featurePolicyRevisionRef,
    version: 1n, spaceGeneration: 1n, learningGeneration: 1n, revocationEpoch: 1n,
    minimumLearnableSourceOriginSequence: parent.minimumLearnableSourceOriginSequence,
    learningState: parent.learningState, useState: parent.useState, state: "active",
    createdAt: recordedAt, updatedAt: recordedAt });
}

export function rehydrateMemorySpace(value: unknown): MemorySpace {
  const record = snapshotExactMemoryRecord(value, ["spaceRef", "binding", "featurePolicyRevisionRef",
    "version", "spaceGeneration", "learningGeneration", "revocationEpoch",
    "minimumLearnableSourceOriginSequence", "learningState", "useState", "state", "createdAt",
    "updatedAt"], "MEMORY_SPACE_INVALID");
  const learningState = memoryLearningState(record.learningState);
  const useState = memoryUseState(record.useState);
  const state = memorySpaceState(record.state);
  const createdAt = memoryInstant(record.createdAt);
  const updatedAt = memoryInstant(record.updatedAt);
  if (updatedAt < createdAt) throw new MemoryDomainError("MEMORY_INSTANT_INVALID");
  return Object.freeze({
    spaceRef: memorySpaceRef(record.spaceRef),
    binding: rehydrateMemoryScopeBinding(record.binding),
    featurePolicyRevisionRef: memoryFeaturePolicyRevisionRef(record.featurePolicyRevisionRef),
    version: memoryAggregateVersion(record.version),
    spaceGeneration: memorySpaceGeneration(record.spaceGeneration),
    learningGeneration: memoryLearningGeneration(record.learningGeneration),
    revocationEpoch: memoryRevocationEpoch(record.revocationEpoch),
    minimumLearnableSourceOriginSequence:
      memorySourceOriginSequence(record.minimumLearnableSourceOriginSequence),
    learningState,
    useState,
    state,
    createdAt,
    updatedAt,
  });
}

export function rehydrateMemoryScopeBinding(value: unknown): MemoryScopeBinding {
  const snapshot = snapshotMemoryRecord(value, "MEMORY_SCOPE_INVALID");
  switch (snapshot.kind) {
    case "user": return userBinding(snapshot);
    case "project": return projectBinding(snapshot);
    case "agent_product": {
      const record = requireExactMemoryRecord(snapshot, ["kind", "parentSpaceRef", "parentBinding",
        "parentSpaceGeneration", "parentLearningGeneration", "parentRevocationEpoch",
        "agentOptionRef", "productSurfaceRef"], "MEMORY_SCOPE_INVALID");
      const parentBinding = rehydrateMemoryScopeBinding(record.parentBinding);
      if (parentBinding.kind === "agent_product") throw new MemoryDomainError("MEMORY_SCOPE_INVALID");
      return Object.freeze({
        kind: "agent_product",
        parentSpaceRef: memorySpaceRef(record.parentSpaceRef),
        parentBinding,
        parentSpaceGeneration: memorySpaceGeneration(record.parentSpaceGeneration),
        parentLearningGeneration: memoryLearningGeneration(record.parentLearningGeneration),
        parentRevocationEpoch: memoryRevocationEpoch(record.parentRevocationEpoch),
        agentOptionRef: memoryAgentOptionRef(record.agentOptionRef),
        productSurfaceRef: memoryProductSurfaceRef(record.productSurfaceRef),
      });
    }
    default: throw new MemoryDomainError("MEMORY_SCOPE_INVALID");
  }
}

export function assertAgentProductParentCurrent(space: MemorySpace, parent: MemorySpace,
  operation?: "resume_learning" | "resume_use"): void {
  if (space.binding.kind !== "agent_product") return;
  const binding = space.binding;
  if (parent.binding.kind === "agent_product" || parent.state !== "active" ||
    binding.parentSpaceRef !== parent.spaceRef ||
    !sameMemoryScopeBinding(binding.parentBinding, parent.binding) ||
    binding.parentSpaceGeneration !== parent.spaceGeneration ||
    binding.parentLearningGeneration !== parent.learningGeneration ||
    binding.parentRevocationEpoch !== parent.revocationEpoch ||
    space.featurePolicyRevisionRef !== parent.featurePolicyRevisionRef ||
    (operation === "resume_learning" && parent.learningState !== "active") ||
    (operation === "resume_use" && parent.useState !== "active")) {
    throw new MemoryDomainError("MEMORY_SCOPE_INVALID");
  }
}

export function rehydrateMemoryActorAuthorization(value: unknown): MemoryActorAuthorization {
  const snapshot = snapshotMemoryRecord(value, "MEMORY_SCOPE_INVALID");
  if (snapshot.kind === "user") return userBinding(snapshot);
  if (snapshot.kind === "project_member") {
    const record = requireExactMemoryRecord(snapshot, ["kind", "siteRef", "projectRef", "subjectRef",
      "subjectGeneration", "membershipEpoch", "authorizationEpoch"], "MEMORY_SCOPE_INVALID");
    return Object.freeze({ kind: "project_member", siteRef: memorySiteRef(record.siteRef),
      projectRef: memoryProjectRef(record.projectRef), subjectRef: memorySubjectRef(record.subjectRef),
      subjectGeneration: memorySubjectGeneration(record.subjectGeneration),
      membershipEpoch: memoryMembershipEpoch(record.membershipEpoch),
      authorizationEpoch: memoryAuthorizationEpoch(record.authorizationEpoch) });
  }
  throw new MemoryDomainError("MEMORY_SCOPE_INVALID");
}

export function memoryActorAuthorizesBinding(actor: MemoryActorAuthorization,
  binding: MemoryScopeBinding): boolean {
  const base = memoryBaseBinding(binding);
  return base.kind === "user"
    ? actor.kind === "user" && sameMemoryScopeBinding(actor, base)
    : actor.kind === "project_member" && actor.siteRef === base.siteRef &&
      actor.projectRef === base.projectRef;
}

export function memoryBaseBinding(binding: MemoryScopeBinding): BaseMemoryScopeBinding {
  return binding.kind === "agent_product" ? binding.parentBinding : binding;
}

export function memoryBindingSiteRef(binding: MemoryScopeBinding): SiteRef {
  return memoryBaseBinding(binding).siteRef;
}

export function sameMemoryScopeBinding(left: MemoryScopeBinding, right: MemoryScopeBinding): boolean {
  return JSON.stringify(serializableBinding(left)) === JSON.stringify(serializableBinding(right));
}

export function pauseMemoryLearning(value: unknown): MemorySpace {
  const { space, expectedVersion, changedAt } = controlInput(value);
  assertMutableSpace(space, expectedVersion);
  if (space.learningState !== "active") throw new MemoryDomainError("MEMORY_LEARNING_STATE_CONFLICT");
  return nextSpace(space, changedAt, {
    learningState: "paused",
    learningGeneration: incrementMemoryInt8(space.learningGeneration),
  });
}

export function resumeMemoryLearning(value: unknown): MemorySpace {
  const record = snapshotExactMemoryRecord(value,
    ["space", "expectedVersion", "resumeCutoffOriginSequence", "changedAt"], "MEMORY_SPACE_INVALID");
  const space = rehydrateMemorySpace(record.space);
  const expectedVersion = memoryAggregateVersion(record.expectedVersion);
  const changedAt = memoryInstant(record.changedAt);
  assertMutableSpace(space, expectedVersion);
  if (space.learningState !== "paused") throw new MemoryDomainError("MEMORY_LEARNING_STATE_CONFLICT");
  const cutoff = memorySourceOriginSequence(record.resumeCutoffOriginSequence);
  const minimum = incrementMemoryInt8(cutoff);
  if (minimum < space.minimumLearnableSourceOriginSequence) {
    throw new MemoryDomainError("MEMORY_INT8_INVALID");
  }
  return nextSpace(space, changedAt, {
    learningState: "active",
    learningGeneration: incrementMemoryInt8(space.learningGeneration),
    minimumLearnableSourceOriginSequence: minimum,
  });
}

export function pauseMemoryUse(value: unknown): MemorySpace {
  const { space, expectedVersion, changedAt } = controlInput(value);
  assertMutableSpace(space, expectedVersion);
  if (space.useState !== "active") throw new MemoryDomainError("MEMORY_USE_STATE_CONFLICT");
  return nextSpace(space, changedAt, { useState: "paused",
    revocationEpoch: incrementMemoryInt8(space.revocationEpoch) });
}

export function resumeMemoryUse(value: unknown): MemorySpace {
  const { space, expectedVersion, changedAt } = controlInput(value);
  assertMutableSpace(space, expectedVersion);
  if (space.useState !== "paused") throw new MemoryDomainError("MEMORY_USE_STATE_CONFLICT");
  return nextSpace(space, changedAt, { useState: "active" });
}

export function resetMemorySpace(value: unknown): MemorySpace {
  const record = snapshotExactMemoryRecord(value,
    ["space", "expectedVersion", "resetCutoffOriginSequence", "changedAt"], "MEMORY_SPACE_INVALID");
  const space = rehydrateMemorySpace(record.space);
  const expectedVersion = memoryAggregateVersion(record.expectedVersion);
  const changedAt = memoryInstant(record.changedAt);
  assertMutableSpace(space, expectedVersion);
  const cutoff = memorySourceOriginSequence(record.resetCutoffOriginSequence);
  const minimum = incrementMemoryInt8(cutoff);
  if (minimum < space.minimumLearnableSourceOriginSequence) {
    throw new MemoryDomainError("MEMORY_INT8_INVALID");
  }
  return nextSpace(space, changedAt, {
    spaceGeneration: incrementMemoryInt8(space.spaceGeneration),
    learningGeneration: incrementMemoryInt8(space.learningGeneration),
    revocationEpoch: incrementMemoryInt8(space.revocationEpoch),
    minimumLearnableSourceOriginSequence: minimum,
    learningState: "paused",
    useState: "paused",
  });
}

export function rebindMemoryFeaturePolicy(value: unknown): MemorySpace {
  const record = snapshotExactMemoryRecord(value, ["space", "expectedVersion",
    "expectedFeaturePolicyRevisionRef", "nextFeaturePolicyRevisionRef",
    "rebindCutoffOriginSequence", "changedAt"], "MEMORY_SPACE_INVALID");
  const space = rehydrateMemorySpace(record.space);
  const expectedVersion = memoryAggregateVersion(record.expectedVersion);
  assertMutableSpace(space, expectedVersion);
  const expectedPolicy = memoryFeaturePolicyRevisionRef(record.expectedFeaturePolicyRevisionRef);
  const nextPolicy = memoryFeaturePolicyRevisionRef(record.nextFeaturePolicyRevisionRef);
  if (space.featurePolicyRevisionRef !== expectedPolicy || nextPolicy === expectedPolicy) {
    throw new MemoryDomainError("MEMORY_FEATURE_POLICY_CONFLICT");
  }
  const cutoff = memorySourceOriginSequence(record.rebindCutoffOriginSequence);
  const minimum = incrementMemoryInt8(cutoff);
  if (minimum < space.minimumLearnableSourceOriginSequence) {
    throw new MemoryDomainError("MEMORY_INT8_INVALID");
  }
  const changedAt = memoryInstant(record.changedAt);
  return nextSpace(space, changedAt, { featurePolicyRevisionRef: nextPolicy,
    spaceGeneration: incrementMemoryInt8(space.spaceGeneration),
    learningGeneration: incrementMemoryInt8(space.learningGeneration),
    revocationEpoch: incrementMemoryInt8(space.revocationEpoch),
    minimumLearnableSourceOriginSequence: minimum, learningState: "paused", useState: "paused" });
}

function userBinding(value: MemoryRecordSnapshot): UserMemoryScopeBinding {
  const record = requireExactMemoryRecord(value,
    ["kind", "siteRef", "subjectRef", "subjectGeneration"], "MEMORY_SCOPE_INVALID");
  if (record.kind !== "user") throw new MemoryDomainError("MEMORY_SCOPE_INVALID");
  return Object.freeze({ kind: "user", siteRef: memorySiteRef(record.siteRef),
    subjectRef: memorySubjectRef(record.subjectRef),
    subjectGeneration: memorySubjectGeneration(record.subjectGeneration) });
}

function projectBinding(value: MemoryRecordSnapshot): ProjectMemoryScopeBinding {
  const record = requireExactMemoryRecord(value,
    ["kind", "siteRef", "projectRef"], "MEMORY_SCOPE_INVALID");
  if (record.kind !== "project") throw new MemoryDomainError("MEMORY_SCOPE_INVALID");
  return Object.freeze({ kind: "project", siteRef: memorySiteRef(record.siteRef),
    projectRef: memoryProjectRef(record.projectRef) });
}

function controlInput(value: unknown): Readonly<{ space: MemorySpace; expectedVersion: AggregateVersion;
  changedAt: MemoryInstant }> {
  const record = snapshotExactMemoryRecord(value, ["space", "expectedVersion", "changedAt"],
    "MEMORY_SPACE_INVALID");
  return Object.freeze({ space: rehydrateMemorySpace(record.space),
    expectedVersion: memoryAggregateVersion(record.expectedVersion), changedAt: memoryInstant(record.changedAt) });
}

function assertMutableSpace(space: MemorySpace, expectedVersion: AggregateVersion): void {
  if (space.version !== expectedVersion) throw new MemoryDomainError("MEMORY_VERSION_CONFLICT");
  if (space.state !== "active") throw new MemoryDomainError("MEMORY_SPACE_STATE_CONFLICT");
}

function nextSpace(space: MemorySpace, changedAt: MemoryInstant,
  changes: Partial<Pick<MemorySpace, "spaceGeneration" | "learningGeneration" | "revocationEpoch" |
    "minimumLearnableSourceOriginSequence" | "learningState" | "useState" |
    "featurePolicyRevisionRef">>): MemorySpace {
  if (changedAt < space.updatedAt) throw new MemoryDomainError("MEMORY_INSTANT_INVALID");
  return rehydrateMemorySpace({ ...space, ...changes,
    version: incrementMemoryInt8(space.version), updatedAt: changedAt });
}

function memoryLearningState(value: unknown): MemoryLearningState {
  if (value !== "active" && value !== "paused") throw new MemoryDomainError("MEMORY_SPACE_INVALID");
  return value;
}
function memoryUseState(value: unknown): MemoryUseState {
  if (value !== "active" && value !== "paused") throw new MemoryDomainError("MEMORY_SPACE_INVALID");
  return value;
}
function memorySpaceState(value: unknown): MemorySpaceState {
  if (value !== "active" && value !== "deleted") throw new MemoryDomainError("MEMORY_SPACE_INVALID");
  return value;
}

function serializableBinding(binding: MemoryScopeBinding): Readonly<Record<string, string>> {
  const base = memoryBaseBinding(binding);
  return Object.freeze({
    kind: binding.kind,
    parentSpaceRef: binding.kind === "agent_product" ? binding.parentSpaceRef : "",
    parentSpaceGeneration: binding.kind === "agent_product" ?
      binding.parentSpaceGeneration.toString() : "",
    parentLearningGeneration: binding.kind === "agent_product" ?
      binding.parentLearningGeneration.toString() : "",
    parentRevocationEpoch: binding.kind === "agent_product" ?
      binding.parentRevocationEpoch.toString() : "",
    siteRef: base.siteRef,
    subjectRef: base.kind === "user" ? base.subjectRef : "",
    subjectGeneration: base.kind === "user" ? base.subjectGeneration.toString() : "",
    projectRef: base.kind === "project" ? base.projectRef : "",
    agentOptionRef: binding.kind === "agent_product" ? binding.agentOptionRef : "",
    productSurfaceRef: binding.kind === "agent_product" ? binding.productSurfaceRef : "",
  });
}
