import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import { DurationSchema } from "@bufbuild/protobuf/wkt";
import {
  CreditProgramBucketClass,
  CreditProgramDefinitionSchema,
  CatalogCandidateExposure,
  CreditProgramRevisionTargetSchema,
  CreditProgramRevisionViewSchema,
  CreditProgramRolloverPolicy,
  type CreditProgramDefinition as WireDefinition,
} from "../../../../generated/proto/kokoro/platform/commerce/v1/commerce_catalog_pb.js";
import { CanonicalCreditProgramDefinition, validateDefinition,
  type CreditProgramBucket, type CreditProgramDefinition,
  type PublishedCreditProgramRevision } from "../../domain/credit-program-catalog.js";
import { timestampFromDate } from "@bufbuild/protobuf/wkt";

export function creditProgramDefinitionFromWire(value: WireDefinition): Readonly<{
  definition: CreditProgramDefinition;
  definitionBytes: Uint8Array;
}> {
  const canonical = create(CreditProgramDefinitionSchema, value);
  const definition = validateDefinition({ unit: canonical.unit,
    grants: canonical.grants.map((grant) => ({ bucket: bucketFromWire(grant.bucket),
      amountMinor: grant.amountMinor, burnPriority: grant.burnPriority,
      liabilityMerchantAccountRef: grant.liabilityMerchantAccountRef,
      scopePolicy: { version: required(grant.scope).policyVersion as 1,
        surfaceRefs: required(grant.scope).surfaceRefs,
        capabilityKeys: required(grant.scope).capabilityKeys,
        agentRefs: required(grant.scope).agentRefs,
        allowUnattributedAgent: required(grant.scope).allowUnattributedAgent },
      window: windowFromWire(grant.window) })),
    maximumProgramBalancePerAccountMinor: canonical.maximumProgramBalancePerAccountMinor,
    reservationTtlSeconds: durationSeconds(required(canonical.reservationTtl)),
    reconciliationGraceSeconds: durationSeconds(required(canonical.reconciliationGrace)),
    allowNegativeBalance: canonical.allowNegativeBalance as false,
    accountingPolicyRef: canonical.accountingPolicyRef });
  return Object.freeze({ definition,
    definitionBytes: encodeCreditProgramDefinition(definition) });
}

export function creditProgramDefinitionFromBytes(bytes: Uint8Array): CreditProgramDefinition {
  return canonicalCreditProgramDefinitionFromBytes(bytes).definition;
}

export function canonicalCreditProgramDefinitionFromBytes(
  bytes: Uint8Array,
): CanonicalCreditProgramDefinition {
  return CanonicalCreditProgramDefinition.fromBytes(bytes, decodeCanonicalDefinitionBytes);
}

export function encodeCreditProgramDefinition(value: CreditProgramDefinition): Uint8Array {
  const definition = validateDefinition(value);
  return toBinary(CreditProgramDefinitionSchema, definitionToWire(definition),
    { writeUnknownFields: false });
}

export function definitionToWire(value: CreditProgramDefinition) {
  return create(CreditProgramDefinitionSchema, { unit: value.unit,
    grants: value.grants.map((grant) => ({ bucket: bucketToWire(grant.bucket),
      amountMinor: grant.amountMinor, burnPriority: grant.burnPriority,
      liabilityMerchantAccountRef: grant.liabilityMerchantAccountRef,
      scope: { policyVersion: 1, surfaceRefs: [...grant.scopePolicy.surfaceRefs],
        capabilityKeys: [...grant.scopePolicy.capabilityKeys], agentRefs: [...grant.scopePolicy.agentRefs],
        allowUnattributedAgent: grant.scopePolicy.allowUnattributedAgent },
      window: grant.window.kind === "daily" ? { case: "daily" as const,
        value: { calendarZone: grant.window.calendarZone,
          resetSecondOfDay: grant.window.resetSecondOfDay, rollover: CreditProgramRolloverPolicy.NONE } } :
        grant.window.kind === "period" ? { case: "subscriptionPeriod" as const,
          value: { rollover: CreditProgramRolloverPolicy.NONE } } : { case: "permanent" as const,
          value: { ...(grant.window.expiresAfterSeconds === null ? {} : {
            expiresAfter: create(DurationSchema, { seconds: grant.window.expiresAfterSeconds, nanos: 0 }) }) } } })),
    maximumProgramBalancePerAccountMinor: value.maximumProgramBalancePerAccountMinor,
    reservationTtl: create(DurationSchema, { seconds: value.reservationTtlSeconds, nanos: 0 }),
    reconciliationGrace: create(DurationSchema, { seconds: value.reconciliationGraceSeconds, nanos: 0 }),
    allowNegativeBalance: false,
    accountingPolicyRef: value.accountingPolicyRef });
}

export function creditProgramRevisionMessage(value: PublishedCreditProgramRevision) {
  return create(CreditProgramRevisionViewSchema, {
    target: create(CreditProgramRevisionTargetSchema, value.target),
    definition: definitionToWire(value.definition), exposure: CatalogCandidateExposure.INERT,
    publishedAt: timestampFromDate(new Date(value.publishedAt)),
  });
}

function bucketFromWire(value: CreditProgramBucketClass): CreditProgramBucket {
  if (value === CreditProgramBucketClass.DAILY) return "daily";
  if (value === CreditProgramBucketClass.PERIOD) return "period";
  if (value === CreditProgramBucketClass.PERMANENT) return "permanent";
  throw new Error("CREDIT_PROGRAM_BUCKET_INVALID");
}
function bucketToWire(value: CreditProgramBucket): CreditProgramBucketClass {
  return value === "daily" ? CreditProgramBucketClass.DAILY : value === "period"
    ? CreditProgramBucketClass.PERIOD : CreditProgramBucketClass.PERMANENT;
}
function windowFromWire(value: WireDefinition["grants"][number]["window"]) {
  if (value.case === "daily") return Object.freeze({ kind: "daily" as const,
    calendarZone: value.value.calendarZone, resetSecondOfDay: value.value.resetSecondOfDay,
    rolloverPolicy: rollover(value.value.rollover) });
  if (value.case === "subscriptionPeriod") return Object.freeze({ kind: "period" as const,
    rolloverPolicy: rollover(value.value.rollover) });
  if (value.case === "permanent") return Object.freeze({ kind: "permanent" as const,
    expiresAfterSeconds: value.value.expiresAfter === undefined ? null : durationSeconds(value.value.expiresAfter) });
  throw new Error("CREDIT_PROGRAM_WINDOW_REQUIRED");
}
function rollover(value: CreditProgramRolloverPolicy): "none" {
  if (value !== CreditProgramRolloverPolicy.NONE) throw new Error("CREDIT_PROGRAM_ROLLOVER_INVALID");
  return "none";
}
function durationSeconds(value: Readonly<{ seconds: bigint; nanos: number }>): bigint {
  if (value.nanos !== 0) throw new Error("CREDIT_PROGRAM_DURATION_PRECISION_INVALID");
  return value.seconds;
}
function required<Value>(value: Value | undefined): Value {
  if (value === undefined) throw new Error("CREDIT_PROGRAM_REQUIRED_FIELD_MISSING");
  return value;
}

function decodeCanonicalDefinitionBytes(bytes: Uint8Array): CreditProgramDefinition {
  let wire: WireDefinition;
  try {
    wire = fromBinary(CreditProgramDefinitionSchema, bytes, { readUnknownFields: false });
  } catch {
    throw new Error("CREDIT_PROGRAM_DEFINITION_BYTES_INVALID");
  }
  const decoded = creditProgramDefinitionFromWire(wire);
  if (!sameBytes(bytes, decoded.definitionBytes)) {
    throw new Error("CREDIT_PROGRAM_DEFINITION_BYTES_NON_CANONICAL");
  }
  return decoded.definition;
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  let difference = 0;
  for (let index = 0; index < left.byteLength; index += 1) {
    difference |= (left[index] ?? 0) ^ (right[index] ?? 0);
  }
  return difference === 0;
}
