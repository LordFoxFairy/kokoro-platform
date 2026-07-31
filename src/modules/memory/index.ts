export { MemoryApplicationError, MemoryAuthorityService, MemoryPublicOwner, MemoryPublicReadOwner,
  memoryReceiptOwner } from
  "./application/index.js";
export type {
  MemoryApplicationErrorCode,
  MemoryAuthorizationDenialReason,
  MemoryAuthorizationFactsPort,
  MemoryAuthorizationFactsResult,
  MemoryAuthorityRepository,
  MemoryCommandOperation,
  MemoryCommandReceiptIdentity,
  MemoryCommandResult,
  MemoryContentProtectionPort,
  MemoryPayloadBinding,
  MemoryReceiptClaim,
  MemoryReceiptOwner,
  MemoryPublicCommand,
  MemoryPublicCommandResult,
  MemoryPublicCursor,
  MemoryPublicCursorCodec,
  MemoryPublicEntryRecord,
  MemoryPublicOperation,
  MemoryPublicRepository,
  MemoryPublicResolvedOwner,
  MemoryPublicRevisionRecord,
  MemoryPublicUnitOfWork,
} from "./application/index.js";

export { MemoryDomainError } from "./domain/memory-error.js";
export type { MemoryDomainErrorCode } from "./domain/memory-error.js";

export { createMemoryContentSyntaxAdmissionBaseline, memoryPublicDerivedRef, memoryPublicPersonalContext,
  MEMORY_PUBLIC_MAX_CONTENT_UTF8_BYTES,
  MEMORY_PUBLIC_MAX_RESPONSE_UTF8_BYTES, MEMORY_PUBLIC_SNAPSHOT_TTL_MS } from
  "./domain/memory-public.js";
export type { MemoryCommandFingerprintInput, MemoryCommandFingerprintPort,
  MemoryContentAdmissionPort, MemoryContentAdmissionResult,
  MemoryPublicPersonalContext } from "./domain/memory-public.js";

export { createProtectedMemoryContent } from
  "./domain/protected-memory-content.js";
export type { ProtectedMemoryContent } from "./domain/protected-memory-content.js";

export {
  assertAgentProductParentCurrent,
  createAgentProductMemorySpace,
  createMemorySpace,
  memoryActorAuthorizesBinding,
  memoryBaseBinding,
  memoryBindingSiteRef,
  pauseMemoryLearning,
  pauseMemoryUse,
  rehydrateMemoryActorAuthorization,
  rehydrateMemoryScopeBinding,
  rehydrateMemorySpace,
  rebindMemoryFeaturePolicy,
  resetMemorySpace,
  resumeMemoryLearning,
  resumeMemoryUse,
  sameMemoryScopeBinding,
} from "./domain/memory-space.js";
export type {
  AgentProductMemoryScopeBinding,
  BaseMemoryScopeBinding,
  MemoryActorAuthorization,
  MemoryLearningState,
  MemoryScopeBinding,
  MemorySpace,
  MemorySpaceState,
  MemoryUseState,
  ProjectMemoryScopeBinding,
  ProjectMemoryActorAuthorization,
  UserMemoryScopeBinding,
  UserMemoryActorAuthorization,
} from "./domain/memory-space.js";

export {
  assertCurrentEntryFence,
  correctMemoryEntry,
  createRememberedMemory,
  forgetMemoryEntry,
  rehydrateMemoryEntry,
} from "./domain/memory-entry.js";
export type {
  MemoryCategory,
  MemoryEntry,
  MemoryEntryState,
  MemoryProvenance,
  MemoryRevision,
  MemoryRevisionReason,
  RememberedMemory,
} from "./domain/memory-entry.js";

export {
  memoryAgentOptionRef,
  memoryAggregateVersion,
  memoryAuthorizationEpoch,
  memoryCommandRef,
  memoryDigest,
  memoryEntryRef,
  memoryFeaturePolicyRevisionRef,
  memoryInstant,
  memoryLearningGeneration,
  memoryMembershipEpoch,
  memoryProductSurfaceRef,
  memoryProjectRef,
  memoryProtectionKeyRevision,
  memoryProvenanceRef,
  memoryRevisionNumber,
  memoryRevisionRef,
  memoryRevocationEpoch,
  memorySiteRef,
  memorySourceOriginSequence,
  memorySpaceGeneration,
  memorySpaceRef,
  memorySubjectGeneration,
  memorySubjectRef,
} from "./domain/memory-references.js";
export { createMemoryContentProtector, parseMemoryContentKeyRing } from
  "./infrastructure/crypto/memory-content-protector.js";
export type { MemoryContentKeyRing } from
  "./infrastructure/crypto/memory-content-protector.js";

export { PostgresMemoryAuthorityRepository } from
  "./infrastructure/postgres-memory-authority-repository.js";
export { PostgresMemoryPublicRepository } from
  "./infrastructure/postgres-memory-public-repository.js";
export { MEMORY_DATABASE_ROLE_CONTRACTS, MEMORY_DEPLOYMENT_TYPES } from
  "./infrastructure/memory-role-contract.js";
export type { MemoryDatabaseRoleKind, MemoryDeploymentType } from
  "./infrastructure/memory-role-contract.js";
export type {
  AgentOptionRef,
  AggregateVersion,
  AuthorizationEpoch,
  FeaturePolicyRevisionRef,
  LearningGeneration,
  MembershipEpoch,
  MemoryCommandRef,
  MemoryDigest,
  MemoryEntryRef,
  MemoryInstant,
  MemoryProvenanceRef,
  MemoryRevisionNumber,
  MemoryRevisionRef,
  MemorySpaceRef,
  ProductSurfaceRef,
  ProjectRef,
  ProtectionKeyRevision,
  RevocationEpoch,
  SiteRef,
  SourceOriginSequence,
  SpaceGeneration,
  SubjectGeneration,
  SubjectRef,
} from "./domain/memory-references.js";
