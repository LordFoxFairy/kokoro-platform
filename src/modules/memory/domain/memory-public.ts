import { createHash } from "node:crypto";
import { MemoryDomainError } from "./memory-error.js";
import { memoryFeaturePolicyRevisionRef, memorySiteRef, memorySubjectGeneration,
  memorySubjectRef, type FeaturePolicyRevisionRef, type SiteRef, type SubjectGeneration,
  type SubjectRef } from "./memory-references.js";
import { snapshotExactMemoryRecord } from "./runtime-validation.js";

export const MEMORY_PUBLIC_MAX_CONTENT_UTF8_BYTES = 16_384;
export const MEMORY_PUBLIC_MAX_RESPONSE_UTF8_BYTES = 262_144;
export const MEMORY_PUBLIC_SNAPSHOT_TTL_MS = 5 * 60 * 1_000;

export type MemoryPublicPersonalContext = Readonly<{
  siteRef: SiteRef;
  subjectRef: SubjectRef;
  subjectGeneration: SubjectGeneration;
  featurePolicyRevisionRef: FeaturePolicyRevisionRef;
}>;

export type MemoryContentAdmissionResult = Readonly<{ kind: "accepted" }> |
  Readonly<{ kind: "rejected"; reason: "policy_rejected" }>;

export interface MemoryContentAdmissionPort {
  admit(input: Readonly<{ category: "profile" | "preference" | "fact"; content: string }> ):
    Promise<MemoryContentAdmissionResult>;
}

const COMMON_SECRET_OR_SENSITIVE_SYNTAX = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/iu,
  /\b(?:api[_ -]?key|access[_ -]?token|refresh[_ -]?token|password|recovery[_ -]?code)\s*[:=]/iu,
  /\bBearer\s+[A-Za-z0-9._~+/-]{12,}={0,2}\b/u,
  /\bAKIA[0-9A-Z]{16}\b/u,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/u,
  /\b(?:diagnosed|medical condition|religion|political affiliation|biometric|sexual orientation|minor child)\b/iu,
] as const;

/**
 * Bounded syntax baseline for policy-classifier implementations and tests.
 * This is intentionally not a production admission authority: composition must inject a
 * policy-owned classifier and keep Memory off when that authority is unavailable.
 */
export function createMemoryContentSyntaxAdmissionBaseline(): MemoryContentAdmissionPort {
  return Object.freeze({
    async admit(input: Readonly<{ category: "profile" | "preference" | "fact"; content: string }>) {
      const bytes = Buffer.byteLength(input.content, "utf8");
      const ordinary = input.content.length > 0 && input.content.trim() === input.content &&
        bytes <= MEMORY_PUBLIC_MAX_CONTENT_UTF8_BYTES && !hasDisallowedControl(input.content);
      return ordinary && !COMMON_SECRET_OR_SENSITIVE_SYNTAX.some((pattern) => pattern.test(input.content))
        ? Object.freeze({ kind: "accepted" as const })
        : Object.freeze({ kind: "rejected" as const, reason: "policy_rejected" as const });
    },
  });
}

function hasDisallowedControl(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0)!;
    if (codePoint === 0 || (codePoint >= 1 && codePoint <= 8) || codePoint === 11 ||
      codePoint === 12 || (codePoint >= 14 && codePoint <= 31) || codePoint === 127) return true;
  }
  return false;
}

export function memoryPublicPersonalContext(value: unknown): MemoryPublicPersonalContext {
  const record = snapshotExactMemoryRecord(value,
    ["siteRef", "subjectRef", "subjectGeneration", "featurePolicyRevisionRef"],
    "MEMORY_SCOPE_INVALID");
  return Object.freeze({ siteRef: memorySiteRef(record.siteRef),
    subjectRef: memorySubjectRef(record.subjectRef),
    subjectGeneration: memorySubjectGeneration(record.subjectGeneration),
    featurePolicyRevisionRef: memoryFeaturePolicyRevisionRef(record.featurePolicyRevisionRef) });
}

export type MemoryCommandFingerprintInput = Readonly<{ operation: string;
  fields: Readonly<Record<string, string | number | bigint | boolean | null>> }>;

export interface MemoryCommandFingerprintPort {
  /** Uses a server-keyed, Memory-command-specific purpose key; never plain SHA over content. */
  fingerprint(input: MemoryCommandFingerprintInput): Promise<Readonly<{
    keyRevision: string; digest: string;
  }>>;
}

export function memoryPublicDerivedRef(kind: "space" | "entry" | "revision" | "provenance",
  context: MemoryPublicPersonalContext, commandRef: string): string {
  if (typeof commandRef !== "string" || commandRef.length < 3 || commandRef.length > 256 ||
      /[\0\r\n]/u.test(commandRef)) throw new MemoryDomainError("MEMORY_REFERENCE_INVALID");
  const digest = createHash("sha256").update(JSON.stringify(["kokoro.memory.public.ref.v1", kind,
    context.siteRef, context.subjectRef, context.subjectGeneration.toString(), commandRef]), "utf8")
    .digest("hex");
  return `memory-${kind}:${digest}`;
}
