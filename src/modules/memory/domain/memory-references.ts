import { MemoryDomainError } from "./memory-error.js";
import { containsControlCharacter, isWellFormedUtf16 } from "./text-validation.js";

declare const memoryReferenceBrand: unique symbol;
declare const memoryInt8Brand: unique symbol;
declare const memoryInstantBrand: unique symbol;
declare const memoryDigestBrand: unique symbol;

type MemoryReference<Kind extends string> = string & Readonly<{ [memoryReferenceBrand]: Kind }>;
type MemoryInt8<Kind extends string> = bigint & Readonly<{ [memoryInt8Brand]: Kind }>;

export type MemorySpaceRef = MemoryReference<"space">;
export type MemoryEntryRef = MemoryReference<"entry">;
export type MemoryRevisionRef = MemoryReference<"revision">;
export type MemoryProvenanceRef = MemoryReference<"provenance">;
export type MemoryCommandRef = MemoryReference<"command">;
export type SiteRef = MemoryReference<"site">;
export type SubjectRef = MemoryReference<"subject">;
export type ProjectRef = MemoryReference<"project">;
export type AgentOptionRef = MemoryReference<"agent_option">;
export type ProductSurfaceRef = MemoryReference<"product_surface">;
export type FeaturePolicyRevisionRef = MemoryReference<"feature_policy_revision">;
export type ProtectionKeyRevision = MemoryReference<"protection_key_revision">;

export type AggregateVersion = MemoryInt8<"aggregate_version">;
export type SpaceGeneration = MemoryInt8<"space_generation">;
export type LearningGeneration = MemoryInt8<"learning_generation">;
export type RevocationEpoch = MemoryInt8<"revocation_epoch">;
export type SubjectGeneration = MemoryInt8<"subject_generation">;
export type MembershipEpoch = MemoryInt8<"membership_epoch">;
export type AuthorizationEpoch = MemoryInt8<"authorization_epoch">;
export type MemoryRevisionNumber = MemoryInt8<"revision_number">;
export type SourceOriginSequence = MemoryInt8<"source_origin_sequence">;
export type MemoryInstant = string & Readonly<{ [memoryInstantBrand]: true }>;
export type MemoryDigest = string & Readonly<{ [memoryDigestBrand]: true }>;

const maximumInt8 = 9_223_372_036_854_775_807n;

export function memorySpaceRef(value: unknown): MemorySpaceRef {
  return reference(value) as MemorySpaceRef;
}
export function memoryEntryRef(value: unknown): MemoryEntryRef {
  return reference(value) as MemoryEntryRef;
}
export function memoryRevisionRef(value: unknown): MemoryRevisionRef {
  return reference(value) as MemoryRevisionRef;
}
export function memoryProvenanceRef(value: unknown): MemoryProvenanceRef {
  return reference(value) as MemoryProvenanceRef;
}
export function memoryCommandRef(value: unknown): MemoryCommandRef {
  return reference(value) as MemoryCommandRef;
}
export function memorySiteRef(value: unknown): SiteRef {
  return reference(value) as SiteRef;
}
export function memorySubjectRef(value: unknown): SubjectRef {
  return reference(value) as SubjectRef;
}
export function memoryProjectRef(value: unknown): ProjectRef {
  return reference(value) as ProjectRef;
}
export function memoryAgentOptionRef(value: unknown): AgentOptionRef {
  return reference(value) as AgentOptionRef;
}
export function memoryProductSurfaceRef(value: unknown): ProductSurfaceRef {
  return reference(value) as ProductSurfaceRef;
}
export function memoryFeaturePolicyRevisionRef(value: unknown): FeaturePolicyRevisionRef {
  return reference(value) as FeaturePolicyRevisionRef;
}
export function memoryProtectionKeyRevision(value: unknown): ProtectionKeyRevision {
  return reference(value) as ProtectionKeyRevision;
}

export function memoryAggregateVersion(value: unknown): AggregateVersion {
  return positiveInt8(value) as AggregateVersion;
}
export function memorySpaceGeneration(value: unknown): SpaceGeneration {
  return positiveInt8(value) as SpaceGeneration;
}
export function memoryLearningGeneration(value: unknown): LearningGeneration {
  return positiveInt8(value) as LearningGeneration;
}
export function memoryRevocationEpoch(value: unknown): RevocationEpoch {
  return positiveInt8(value) as RevocationEpoch;
}
export function memorySubjectGeneration(value: unknown): SubjectGeneration {
  return positiveInt8(value) as SubjectGeneration;
}
export function memoryMembershipEpoch(value: unknown): MembershipEpoch {
  return positiveInt8(value) as MembershipEpoch;
}
export function memoryAuthorizationEpoch(value: unknown): AuthorizationEpoch {
  return positiveInt8(value) as AuthorizationEpoch;
}
export function memoryRevisionNumber(value: unknown): MemoryRevisionNumber {
  return positiveInt8(value) as MemoryRevisionNumber;
}
export function memorySourceOriginSequence(value: unknown): SourceOriginSequence {
  return nonNegativeInt8(value) as SourceOriginSequence;
}

export function memoryInstant(value: unknown): MemoryInstant {
  if (typeof value !== "string" || !isWellFormedUtf16(value)) {
    throw new MemoryDomainError("MEMORY_INSTANT_INVALID");
  }
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) {
    throw new MemoryDomainError("MEMORY_INSTANT_INVALID");
  }
  return value as MemoryInstant;
}

export function memoryDigest(value: unknown): MemoryDigest {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) {
    throw new MemoryDomainError("MEMORY_DIGEST_INVALID");
  }
  return value as MemoryDigest;
}

export function incrementMemoryInt8<Kind extends string>(
  value: MemoryInt8<Kind>,
): MemoryInt8<Kind> {
  return positiveInt8(value + 1n) as MemoryInt8<Kind>;
}

function reference(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 256 ||
    !isWellFormedUtf16(value) ||
    containsControlCharacter(value)
  ) throw new MemoryDomainError("MEMORY_REFERENCE_INVALID");
  return value;
}

function positiveInt8(value: unknown): bigint {
  if (typeof value !== "bigint" || value < 1n || value > maximumInt8) {
    throw new MemoryDomainError("MEMORY_INT8_INVALID");
  }
  return value;
}

function nonNegativeInt8(value: unknown): bigint {
  if (typeof value !== "bigint" || value < 0n || value > maximumInt8) {
    throw new MemoryDomainError("MEMORY_INT8_INVALID");
  }
  return value;
}
