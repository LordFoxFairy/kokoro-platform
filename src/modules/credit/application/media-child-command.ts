import type {
  CreditConsumptionScope,
  MediaOperationClosureEvidence,
  RunBudgetAuthority,
} from "./contracts/run-budget-authority.js";
import { CreditDomainError, type CreditDomainErrorCode } from "../domain/credit-domain-error.js";

export type DeriveMediaChildCommand = Parameters<RunBudgetAuthority["deriveChildAllocation"]>[1];
export type ReturnMediaChildCommand = Parameters<RunBudgetAuthority["returnChildAllocation"]>[1];

export function snapshotChildDerivation(input: unknown): DeriveMediaChildCommand {
  const value = snapshotDataObject(input, [
    "siteId", "executionBudgetRootRef", "parentAllocationRef", "expectedParentRevision",
    "expectedParentAllocationEpoch", "mediaOperationRef", "businessOperationKey", "requestDigest",
    "exactCeiling", "executionManifestRef", "audience", "purpose", "consumptionScope", "expiresAt",
  ], "CREDIT_CHILD_COMMAND_INVALID");
  const command = Object.freeze({
    siteId: stringValue(value.siteId, "CREDIT_REFERENCE_INVALID"),
    executionBudgetRootRef: stringValue(value.executionBudgetRootRef, "CREDIT_UUID_REFERENCE_INVALID"),
    parentAllocationRef: stringValue(value.parentAllocationRef, "CREDIT_UUID_REFERENCE_INVALID"),
    expectedParentRevision: bigintValue(value.expectedParentRevision, "CREDIT_CHILD_PARENT_FENCE_INVALID"),
    expectedParentAllocationEpoch: bigintValue(
      value.expectedParentAllocationEpoch, "CREDIT_CHILD_PARENT_FENCE_INVALID",
    ),
    mediaOperationRef: stringValue(value.mediaOperationRef, "CREDIT_REFERENCE_INVALID"),
    businessOperationKey: stringValue(value.businessOperationKey, "CREDIT_REFERENCE_INVALID"),
    requestDigest: stringValue(value.requestDigest, "CREDIT_REQUEST_DIGEST_INVALID"),
    exactCeiling: bigintValue(value.exactCeiling, "CREDIT_CHILD_CEILING_INVALID"),
    executionManifestRef: stringValue(value.executionManifestRef, "CREDIT_REFERENCE_INVALID"),
    audience: mediaAudience(value.audience),
    purpose: mediaPurpose(value.purpose),
    consumptionScope: snapshotConsumptionScope(value.consumptionScope),
    expiresAt: stringValue(value.expiresAt, "CREDIT_INSTANT_INVALID"),
  });
  validateChildDerivation(command);
  return command;
}

export function snapshotChildReturn(input: unknown): ReturnMediaChildCommand {
  const value = snapshotDataObject(input, [
    "siteId", "executionBudgetRootRef", "parentAllocationRef", "childAllocationRef",
    "expectedParentRevision", "expectedParentAllocationEpoch", "expectedChildRevision",
    "expectedChildAllocationEpoch", "mediaOperationRef", "businessOperationKey", "requestDigest",
    "ownerClosureEvidence",
  ], "CREDIT_CHILD_COMMAND_INVALID");
  const command = Object.freeze({
    siteId: stringValue(value.siteId, "CREDIT_REFERENCE_INVALID"),
    executionBudgetRootRef: stringValue(value.executionBudgetRootRef, "CREDIT_UUID_REFERENCE_INVALID"),
    parentAllocationRef: stringValue(value.parentAllocationRef, "CREDIT_UUID_REFERENCE_INVALID"),
    childAllocationRef: stringValue(value.childAllocationRef, "CREDIT_UUID_REFERENCE_INVALID"),
    expectedParentRevision: bigintValue(value.expectedParentRevision, "CREDIT_CHILD_RETURN_FENCE_INVALID"),
    expectedParentAllocationEpoch: bigintValue(
      value.expectedParentAllocationEpoch, "CREDIT_CHILD_RETURN_FENCE_INVALID",
    ),
    expectedChildRevision: bigintValue(value.expectedChildRevision, "CREDIT_CHILD_RETURN_FENCE_INVALID"),
    expectedChildAllocationEpoch: bigintValue(
      value.expectedChildAllocationEpoch, "CREDIT_CHILD_RETURN_FENCE_INVALID",
    ),
    mediaOperationRef: stringValue(value.mediaOperationRef, "CREDIT_REFERENCE_INVALID"),
    businessOperationKey: stringValue(value.businessOperationKey, "CREDIT_REFERENCE_INVALID"),
    requestDigest: stringValue(value.requestDigest, "CREDIT_REQUEST_DIGEST_INVALID"),
    ownerClosureEvidence: snapshotOwnerClosureEvidence(value.ownerClosureEvidence),
  });
  validateChildReturn(command);
  return command;
}

function validateChildDerivation(input: DeriveMediaChildCommand): void {
  [input.siteId, input.mediaOperationRef, input.businessOperationKey,
    input.executionManifestRef].forEach(strictReference);
  uuidReference(input.executionBudgetRootRef);
  uuidReference(input.parentAllocationRef);
  validateConsumptionScope(input.consumptionScope);
  digestValue(input.requestDigest);
  if (input.audience !== "media" || input.purpose !== "media_operation") {
    throw new CreditDomainError("CREDIT_CHILD_PURPOSE_INVALID");
  }
  if (!positiveInt8(input.expectedParentRevision) || !positiveInt8(input.expectedParentAllocationEpoch)) {
    throw new CreditDomainError("CREDIT_CHILD_PARENT_FENCE_INVALID");
  }
  if (input.exactCeiling <= 0n) throw new CreditDomainError("CREDIT_CHILD_CEILING_INVALID");
  canonicalInstant(input.expiresAt);
}

function validateChildReturn(input: ReturnMediaChildCommand): void {
  [input.siteId, input.mediaOperationRef, input.businessOperationKey, input.ownerClosureEvidence.mediaOperationRef,
    input.ownerClosureEvidence.terminalReceiptRef].forEach(strictReference);
  uuidReference(input.executionBudgetRootRef);
  uuidReference(input.parentAllocationRef);
  uuidReference(input.childAllocationRef);
  digestValue(input.requestDigest);
  if (input.ownerClosureEvidence.kind !== "media_operation_terminal" ||
      !["completed", "partial", "failed", "canceled"].includes(input.ownerClosureEvidence.outcome)) {
    throw new CreditDomainError("CREDIT_CHILD_OWNER_EVIDENCE_INVALID");
  }
  if (!positiveInt8(input.expectedParentRevision) || !positiveInt8(input.expectedParentAllocationEpoch) ||
      !positiveInt8(input.expectedChildRevision) || !positiveInt8(input.expectedChildAllocationEpoch)) {
    throw new CreditDomainError("CREDIT_CHILD_RETURN_FENCE_INVALID");
  }
}

function snapshotConsumptionScope(value: unknown): CreditConsumptionScope {
  const scope = snapshotDataObject(
    value, ["surfaceRef", "capabilityKey", "agentRef"], "CREDIT_CONSUMPTION_SCOPE_INVALID",
  );
  const agentRef = scope.agentRef === null
    ? null : stringValue(scope.agentRef, "CREDIT_CONSUMPTION_SCOPE_INVALID");
  return Object.freeze({
    surfaceRef: stringValue(scope.surfaceRef, "CREDIT_CONSUMPTION_SCOPE_INVALID"),
    capabilityKey: stringValue(scope.capabilityKey, "CREDIT_CONSUMPTION_SCOPE_INVALID"),
    agentRef,
  });
}

function snapshotOwnerClosureEvidence(value: unknown): MediaOperationClosureEvidence {
  const evidence = snapshotDataObject(value, [
    "kind", "mediaOperationRef", "terminalReceiptRef", "outcome",
  ], "CREDIT_CHILD_OWNER_EVIDENCE_INVALID");
  if (evidence.kind !== "media_operation_terminal" ||
      (evidence.outcome !== "completed" && evidence.outcome !== "partial" &&
       evidence.outcome !== "failed" && evidence.outcome !== "canceled")) {
    throw new CreditDomainError("CREDIT_CHILD_OWNER_EVIDENCE_INVALID");
  }
  return Object.freeze({
    kind: "media_operation_terminal",
    mediaOperationRef: stringValue(evidence.mediaOperationRef, "CREDIT_CHILD_OWNER_EVIDENCE_INVALID"),
    terminalReceiptRef: stringValue(evidence.terminalReceiptRef, "CREDIT_CHILD_OWNER_EVIDENCE_INVALID"),
    outcome: evidence.outcome,
  });
}

function snapshotDataObject(
  value: unknown,
  expectedKeys: readonly string[],
  code: CreditDomainErrorCode,
): Readonly<Record<string, unknown>> {
  try {
    if (typeof value !== "object" || value === null || Array.isArray(value)) throw new CreditDomainError(code);
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) throw new CreditDomainError(code);
    const keys = Reflect.ownKeys(value);
    if (keys.some((key) => typeof key !== "string") || keys.length !== expectedKeys.length ||
        expectedKeys.some((key) => !keys.includes(key))) throw new CreditDomainError(code);
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const entries = expectedKeys.map((key) => {
      const descriptor = descriptors[key];
      if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) {
        throw new CreditDomainError(code);
      }
      return [key, descriptor.value] as const;
    });
    return Object.freeze(Object.fromEntries(entries));
  } catch (error) {
    if (error instanceof CreditDomainError && error.code === code) throw error;
    throw new CreditDomainError(code);
  }
}

function stringValue(value: unknown, code: CreditDomainErrorCode): string {
  if (typeof value !== "string") throw new CreditDomainError(code);
  return value;
}

function bigintValue(value: unknown, code: CreditDomainErrorCode): bigint {
  if (typeof value !== "bigint") throw new CreditDomainError(code);
  return value;
}

function mediaAudience(value: unknown): "media" {
  if (value !== "media") throw new CreditDomainError("CREDIT_CHILD_PURPOSE_INVALID");
  return value;
}

function mediaPurpose(value: unknown): "media_operation" {
  if (value !== "media_operation") throw new CreditDomainError("CREDIT_CHILD_PURPOSE_INVALID");
  return value;
}

function validateConsumptionScope(scope: CreditConsumptionScope): void {
  const key = /^[a-z0-9][a-z0-9._:-]{0,255}$/u;
  const reference = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/u;
  if (!key.test(scope.surfaceRef) || !key.test(scope.capabilityKey) ||
      (scope.agentRef !== null && !reference.test(scope.agentRef))) {
    throw new CreditDomainError("CREDIT_CONSUMPTION_SCOPE_INVALID");
  }
}

function strictReference(value: string): void {
  if (value.length < 1 || value.length > 256 || hasControlCharacter(value) || hasMalformedUtf16(value)) {
    throw new CreditDomainError("CREDIT_REFERENCE_INVALID");
  }
}

function uuidReference(value: string): void {
  if (!UUID.test(value)) throw new CreditDomainError("CREDIT_UUID_REFERENCE_INVALID");
}

function digestValue(value: string): void {
  if (!DIGEST.test(value)) throw new CreditDomainError("CREDIT_REQUEST_DIGEST_INVALID");
}

function canonicalInstant(value: string): void {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) {
    throw new CreditDomainError("CREDIT_INSTANT_INVALID");
  }
}

function positiveInt8(value: bigint): boolean {
  return value > 0n && value <= POSTGRES_INT8_MAX;
}

function hasControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0);
    return codePoint !== undefined && (codePoint < 32 || codePoint === 127);
  });
}

function hasMalformedUtf16(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) return true;
  }
  return false;
}

const DIGEST = /^[a-f0-9]{64}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const POSTGRES_INT8_MAX = 9_223_372_036_854_775_807n;
