import { createHash } from "node:crypto";

export type CreditProgramBucket = "daily" | "period" | "permanent";

export interface CreditProgramScopePolicy {
  readonly version: 1;
  readonly surfaceRefs: readonly string[];
  readonly capabilityKeys: readonly string[];
  readonly agentRefs: readonly string[];
  readonly allowUnattributedAgent: boolean;
}

export type CreditProgramWindow =
  | Readonly<{ kind: "daily"; calendarZone: string; resetSecondOfDay: number; rolloverPolicy: "none" }>
  | Readonly<{ kind: "period"; rolloverPolicy: "none" }>
  | Readonly<{ kind: "permanent"; expiresAfterSeconds: bigint | null }>;

export interface CreditProgramGrantRule {
  readonly bucket: CreditProgramBucket;
  readonly amountMinor: bigint;
  readonly burnPriority: number;
  readonly liabilityMerchantAccountRef: string;
  readonly scopePolicy: CreditProgramScopePolicy;
  readonly window: CreditProgramWindow;
}

export interface CreditProgramDefinition {
  readonly unit: string;
  readonly grants: readonly CreditProgramGrantRule[];
  /** Outstanding balance ceiling for this programRef on one account, across every revision. */
  readonly maximumProgramBalancePerAccountMinor: bigint;
  readonly reservationTtlSeconds: bigint;
  readonly reconciliationGraceSeconds: bigint;
  readonly allowNegativeBalance: false;
  readonly accountingPolicyRef: string;
}

export interface CreditProgramRevisionTarget {
  readonly programRef: string;
  readonly revision: bigint;
  readonly revisionDigest: string;
}

export interface PublishedCreditProgramRevision {
  readonly target: CreditProgramRevisionTarget;
  readonly definition: CreditProgramDefinition;
  readonly definitionBytes: Uint8Array;
  readonly exposure: "inert";
  readonly publishedAt: string;
}

export function advanceCreditProgramCatalogSnapshot(previousDigest: string,
  target: CreditProgramRevisionTarget): string {
  if (!/^sha256:[0-9a-f]{64}$/u.test(previousDigest) ||
      !/^sha256:[0-9a-f]{64}$/u.test(target.revisionDigest) ||
      !/^credit-program:[a-z][a-z0-9._-]{1,127}$/u.test(target.programRef)) {
    throw new Error("CREDIT_PROGRAM_SNAPSHOT_INPUT_INVALID");
  }
  positive(target.revision, "CREDIT_PROGRAM_SNAPSHOT_INPUT_INVALID");
  const canonicalEntry = JSON.stringify({
    programRef: target.programRef,
    revision: target.revision.toString(),
    revisionDigest: target.revisionDigest,
  });
  return `sha256:${createHash("sha256")
    .update("kokoro.credit-program-catalog.snapshot.v1\0", "utf8")
    .update(previousDigest, "utf8")
    .update("\0", "utf8")
    .update(canonicalEntry, "utf8")
    .digest("hex")}`;
}

const MAX_UINT64 = 18_446_744_073_709_551_615n;
const MAX_EXPECTED_VERSION = 9_223_372_036_854_775_807n;
const MAX_DURATION_SECONDS = 315_576_000_000n;
const BUCKETS = Object.freeze(["daily", "period", "permanent"] as const);

export function defineCreditProgramRevision(input: Readonly<{
  programRef: string;
  revision: bigint;
  expectedVersion: bigint;
  definition: CreditProgramDefinition;
  definitionBytes: Uint8Array;
  publishedAt: string;
}>): PublishedCreditProgramRevision {
  if (!/^credit-program:[a-z][a-z0-9._-]{1,127}$/u.test(input.programRef)) {
    throw new Error("CREDIT_PROGRAM_REF_INVALID");
  }
  unsigned(input.expectedVersion, MAX_EXPECTED_VERSION, "CREDIT_PROGRAM_EXPECTED_VERSION_INVALID");
  positive(input.revision, "CREDIT_PROGRAM_REVISION_INVALID");
  if (input.revision !== input.expectedVersion + 1n) {
    throw new Error("CREDIT_PROGRAM_REVISION_SEQUENCE_INVALID");
  }
  const definition = validateDefinition(input.definition);
  if (!(input.definitionBytes instanceof Uint8Array) || input.definitionBytes.byteLength < 1) {
    throw new Error("CREDIT_PROGRAM_DEFINITION_BYTES_INVALID");
  }
  const publishedAt = instant(input.publishedAt);
  const revisionDigest = `sha256:${createHash("sha256").update(input.definitionBytes).digest("hex")}`;
  return Object.freeze({
    target: Object.freeze({ programRef: input.programRef, revision: input.revision, revisionDigest }),
    definition,
    definitionBytes: new Uint8Array(input.definitionBytes),
    exposure: "inert",
    publishedAt,
  });
}

export function validateDefinition(value: CreditProgramDefinition): CreditProgramDefinition {
  if (!/^[a-z][a-z0-9._-]{0,63}$/u.test(value.unit)) throw new Error("CREDIT_PROGRAM_UNIT_INVALID");
  if (!Array.isArray(value.grants) || value.grants.length < 1 || value.grants.length > 3) {
    throw new Error("CREDIT_PROGRAM_GRANTS_INVALID");
  }
  const grants = value.grants.map((grant) => {
    if (!BUCKETS.includes(grant.bucket)) throw new Error("CREDIT_PROGRAM_BUCKET_INVALID");
    positive(grant.amountMinor, "CREDIT_PROGRAM_GRANT_AMOUNT_INVALID");
    if (!Number.isInteger(grant.burnPriority) || grant.burnPriority < 1 ||
        grant.burnPriority > 1000) throw new Error("CREDIT_PROGRAM_BURN_PRIORITY_INVALID");
    if (grant.liabilityMerchantAccountRef.length < 3 || grant.liabilityMerchantAccountRef.length > 256 ||
        hasControl(grant.liabilityMerchantAccountRef)) throw new Error("CREDIT_PROGRAM_LIABILITY_INVALID");
    const scopePolicy = validateScopePolicy(grant.scopePolicy);
    const window = validateWindow(grant.bucket, grant.window);
    return Object.freeze({ bucket: grant.bucket, amountMinor: grant.amountMinor,
      burnPriority: grant.burnPriority, liabilityMerchantAccountRef: grant.liabilityMerchantAccountRef,
      scopePolicy, window });
  });
  const grantBuckets = new Set(grants.map(({ bucket }) => bucket));
  if (grantBuckets.size !== grants.length) throw new Error("CREDIT_PROGRAM_BUCKET_DUPLICATE");
  positive(value.maximumProgramBalancePerAccountMinor, "CREDIT_PROGRAM_MAXIMUM_BALANCE_INVALID");
  const totalGrantAmount = grants.reduce((total, { amountMinor }) => total + amountMinor, 0n);
  if (totalGrantAmount > value.maximumProgramBalancePerAccountMinor) {
    throw new Error("CREDIT_PROGRAM_GRANT_EXCEEDS_MAXIMUM_BALANCE");
  }
  duration(value.reservationTtlSeconds, "CREDIT_PROGRAM_RESERVATION_TTL_INVALID");
  duration(value.reconciliationGraceSeconds, "CREDIT_PROGRAM_RECONCILIATION_GRACE_INVALID");
  if (value.reconciliationGraceSeconds < value.reservationTtlSeconds) {
    throw new Error("CREDIT_PROGRAM_RECONCILIATION_GRACE_TOO_SHORT");
  }
  if (value.allowNegativeBalance !== false) throw new Error("CREDIT_PROGRAM_NEGATIVE_BALANCE_FORBIDDEN");
  if (value.accountingPolicyRef.length < 3 || value.accountingPolicyRef.length > 256 ||
      hasControl(value.accountingPolicyRef)) throw new Error("CREDIT_PROGRAM_ACCOUNTING_POLICY_INVALID");
  return Object.freeze({
    unit: value.unit,
    grants: Object.freeze(grants),
    maximumProgramBalancePerAccountMinor: value.maximumProgramBalancePerAccountMinor,
    reservationTtlSeconds: value.reservationTtlSeconds,
    reconciliationGraceSeconds: value.reconciliationGraceSeconds,
    allowNegativeBalance: false,
    accountingPolicyRef: value.accountingPolicyRef,
  });
}

function validateWindow(bucket: CreditProgramBucket, value: CreditProgramWindow): CreditProgramWindow {
  if (value.kind !== bucket) throw new Error("CREDIT_PROGRAM_WINDOW_BUCKET_MISMATCH");
  if (value.kind === "daily") {
    if (value.rolloverPolicy !== "none" || !Number.isInteger(value.resetSecondOfDay) ||
        value.resetSecondOfDay < 0 || value.resetSecondOfDay > 86_399 || !ianaZone(value.calendarZone)) {
      throw new Error("CREDIT_PROGRAM_DAILY_WINDOW_INVALID");
    }
    return Object.freeze({ ...value });
  }
  if (value.kind === "period") {
    if (value.rolloverPolicy !== "none") {
      throw new Error("CREDIT_PROGRAM_PERIOD_WINDOW_INVALID");
    }
    return Object.freeze({ ...value });
  }
  if (value.expiresAfterSeconds !== null) {
    duration(value.expiresAfterSeconds, "CREDIT_PROGRAM_PERMANENT_EXPIRY_INVALID");
  }
  return Object.freeze({ ...value });
}

function validateScopePolicy(value: CreditProgramScopePolicy): CreditProgramScopePolicy {
  if (value.version !== 1) throw new Error("CREDIT_PROGRAM_SCOPE_POLICY_INVALID");
  const surfaceRefs = refs(value.surfaceRefs, true, /^[a-z0-9][a-z0-9._:-]{0,255}$/u);
  const capabilityKeys = refs(value.capabilityKeys, true, /^[a-z0-9][a-z0-9._:-]{0,255}$/u);
  const agentRefs = refs(value.agentRefs, false, /^[\P{Cc}]{1,256}$/u);
  if (!value.allowUnattributedAgent && agentRefs.length === 0) {
    throw new Error("CREDIT_PROGRAM_SCOPE_POLICY_INVALID");
  }
  return Object.freeze({ version: 1, surfaceRefs, capabilityKeys, agentRefs,
    allowUnattributedAgent: value.allowUnattributedAgent });
}

function refs(value: readonly string[], required: boolean, pattern: RegExp): readonly string[] {
  if (!Array.isArray(value) || (required && value.length < 1) || value.length > 64 ||
      value.some((item) => !pattern.test(item)) || new Set(value).size !== value.length) {
    throw new Error("CREDIT_PROGRAM_SCOPE_POLICY_INVALID");
  }
  return Object.freeze([...value]);
}

function ianaZone(value: string): boolean {
  if (value.length < 1 || value.length > 128) return false;
  try { new Intl.DateTimeFormat("en-US", { timeZone: value }).format(0); return true; }
  catch { return false; }
}

function positive(value: bigint, code: string): void {
  if (typeof value !== "bigint" || value < 1n || value > MAX_UINT64) throw new Error(code);
}

function unsigned(value: bigint, maximum: bigint, code: string): void {
  if (typeof value !== "bigint" || value < 0n || value > maximum) throw new Error(code);
}

function duration(value: bigint, code: string): void {
  if (typeof value !== "bigint" || value < 1n || value > MAX_DURATION_SECONDS) throw new Error(code);
}

function instant(value: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== value) {
    throw new Error("CREDIT_PROGRAM_PUBLISHED_AT_INVALID");
  }
  return value;
}

function hasControl(value: string): boolean {
  return [...value].some((character) => {
    const point = character.codePointAt(0) ?? 0;
    return point < 32 || point === 127;
  });
}
