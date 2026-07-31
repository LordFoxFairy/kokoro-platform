import { createHash } from "node:crypto";
import type {
  StoredMediaChildAllocation,
  StoredParentAllocation,
} from "../../application/contracts/credit-authority-repository.js";
import { parseReturnedMediaChildReceipt } from "../../application/media-child-receipt-codec.js";
import {
  rehydrateBudgetAllocationRevision,
  rehydrateChildAllocationRevision,
  type BudgetAllocationRevision,
  type ChildAllocationRevision,
} from "../../domain/allocation.js";

export function mapParentAllocationRow(row: Record<string, unknown>): StoredParentAllocation {
  return Object.freeze({
    siteId: stringField(row, "siteId", PARENT_CORRUPT),
    billingAccountId: stringField(row, "billingAccountId", PARENT_CORRUPT),
    creditAccountId: stringField(row, "creditAccountId", PARENT_CORRUPT),
    unit: stringField(row, "unit", PARENT_CORRUPT),
    liabilityMerchantAccountId: stringField(row, "liabilityMerchantAccountId", PARENT_CORRUPT),
    executionBudgetRootRef: stringField(row, "executionBudgetRootRef", PARENT_CORRUPT),
    executionBudgetRootState: rootState(field(row, "executionBudgetRootState", PARENT_CORRUPT)),
    creditHoldRef: stringField(row, "creditHoldRef", PARENT_CORRUPT),
    creditHoldState: holdState(field(row, "creditHoldState", PARENT_CORRUPT)),
    creditHoldExpiresAt: instantField(row, "creditHoldExpiresAt", PARENT_CORRUPT),
    ratingPolicyRevisionRef: stringField(row, "ratingPolicyRevisionRef", PARENT_CORRUPT),
    parentAllocationRef: stringField(row, "parentAllocationRef", PARENT_CORRUPT),
    isRoot: booleanField(row, "isRoot", PARENT_CORRUPT),
    audience: audience(field(row, "audience", PARENT_CORRUPT)),
    reservedSegmentStock: nonnegativeBigintField(row, "reservedSegmentStock", PARENT_CORRUPT),
    allocation: allocationRevision(row, {
      revision: "revision", allocationEpoch: "allocationEpoch", creditCeiling: "creditCeiling",
      unassignedStock: "unassignedStock", activeChildReservedStock: "activeChildReservedStock",
      committedStock: "committedStock", capturedCumulative: "capturedCumulative",
      returnedToParentCumulative: "returnedToParentCumulative", state: "allocationState",
    }),
  });
}

export function mapMediaChildAllocationRow(row: Record<string, unknown>): StoredMediaChildAllocation {
  const childAudience = stringField(row, "childAudience", CHILD_CORRUPT);
  const childPurpose = stringField(row, "childPurpose", CHILD_CORRUPT);
  if (childAudience !== "media" || childPurpose !== "media_operation") corrupt(CHILD_CORRUPT);
  const childBase = allocationRevision(row, {
    revision: "childRevision", allocationEpoch: "childAllocationEpoch", creditCeiling: "childCreditCeiling",
    unassignedStock: "childUnassignedStock", activeChildReservedStock: "childActiveChildReservedStock",
    committedStock: "childCommittedStock", capturedCumulative: "childCapturedCumulative",
    returnedToParentCumulative: "childReturnedToParentCumulative", state: "childAllocationState",
  });
  const childAllocation = rehydrateChildAllocationRevision({
    ...childBase,
    terminalReceiptDigest: nullableStringField(row, "terminalReceiptDigest", CHILD_CORRUPT),
    parentAppliedRevision: nullablePositiveInt8Field(row, "parentAppliedRevision", CHILD_CORRUPT),
  });
  const siteId = stringField(row, "siteId", CHILD_CORRUPT);
  const executionBudgetRootRef = stringField(row, "executionBudgetRootRef", CHILD_CORRUPT);
  const parentAllocationRef = stringField(row, "parentAllocationRef", CHILD_CORRUPT);
  const parentAllocation = allocationRevision(row, {
    revision: "parentRevision", allocationEpoch: "parentAllocationEpoch", creditCeiling: "parentCreditCeiling",
    unassignedStock: "parentUnassignedStock", activeChildReservedStock: "parentActiveChildReservedStock",
    committedStock: "parentCommittedStock", capturedCumulative: "parentCapturedCumulative",
    returnedToParentCumulative: "parentReturnedToParentCumulative", state: "parentAllocationState",
  });
  const childAllocationRef = stringField(row, "childAllocationRef", CHILD_CORRUPT);
  const mediaOperationRef = stringField(row, "mediaOperationRef", CHILD_CORRUPT);
  const priorReturn = priorReturnRow(row, {
    siteId, executionBudgetRootRef, parentAllocationRef, parentAllocation,
    childAllocationRef, childAllocation, mediaOperationRef,
  });
  return Object.freeze({
    siteId,
    billingAccountId: stringField(row, "billingAccountId", CHILD_CORRUPT),
    creditAccountId: stringField(row, "creditAccountId", CHILD_CORRUPT),
    unit: stringField(row, "unit", CHILD_CORRUPT),
    liabilityMerchantAccountId: stringField(row, "liabilityMerchantAccountId", CHILD_CORRUPT),
    executionBudgetRootRef,
    executionBudgetRootState: rootState(field(row, "executionBudgetRootState", CHILD_CORRUPT)),
    creditHoldRef: stringField(row, "creditHoldRef", CHILD_CORRUPT),
    creditHoldState: holdState(field(row, "creditHoldState", CHILD_CORRUPT)),
    creditHoldExpiresAt: instantField(row, "creditHoldExpiresAt", CHILD_CORRUPT),
    parentAllocationRef,
    parentAllocation,
    childAllocationRef,
    childAuthorizationSegmentRef: stringField(row, "childAuthorizationSegmentRef", CHILD_CORRUPT),
    executionManifestRef: stringField(row, "executionManifestRef", CHILD_CORRUPT),
    childAudience,
    childPurpose,
    mediaOperationRef,
    consumptionScope: Object.freeze({
      surfaceRef: stringField(row, "surfaceRef", CHILD_CORRUPT),
      capabilityKey: stringField(row, "capabilityKey", CHILD_CORRUPT),
      agentRef: nullableStringField(row, "agentRef", CHILD_CORRUPT),
    }),
    expiresAt: instantField(row, "expiresAt", CHILD_CORRUPT),
    childAllocation,
    authorizationClosure: Object.freeze({
      reserved: nonnegativeBigintField(row, "reservedAuthorizationCount", CHILD_CORRUPT),
      committed: nonnegativeBigintField(row, "committedAuthorizationCount", CHILD_CORRUPT),
      ratingPending: nonnegativeBigintField(row, "ratingPendingCount", CHILD_CORRUPT),
      reconciliationRequired: nonnegativeBigintField(row, "reconciliationRequiredCount", CHILD_CORRUPT),
    }),
    priorReturn,
  });
}

type PriorContext = Readonly<{
  siteId: string;
  executionBudgetRootRef: string;
  parentAllocationRef: string;
  parentAllocation: BudgetAllocationRevision;
  childAllocationRef: string;
  childAllocation: ChildAllocationRevision;
  mediaOperationRef: string;
}>;

function priorReturnRow(
  row: Record<string, unknown>,
  current: PriorContext,
): StoredMediaChildAllocation["priorReturn"] {
  const result = field(row, "priorReturnResult", CHILD_CORRUPT);
  if (result === null) {
    if (PRIOR_RETURN_FIELDS.some((name) => field(row, name, CHILD_CORRUPT) !== null)) corrupt(PRIOR_SCOPE);
    return null;
  }
  const resultDigest = stringField(row, "priorReturnResultDigest", PRIOR_CORRUPT);
  if (!DIGEST.test(resultDigest) || sha256(canonicalJson(result)) !== resultDigest) corrupt(PRIOR_DIGEST);
  const operationKind = stringField(row, "priorReturnOperationKind", PRIOR_CORRUPT);
  const requestDigest = stringField(row, "priorReturnRequestDigest", PRIOR_CORRUPT);
  if (operationKind !== "return_media_child" || !DIGEST.test(requestDigest)) corrupt(PRIOR_SCOPE);
  const operation = Object.freeze({
    siteId: current.siteId,
    operationKind,
    businessOperationKey: stringField(row, "priorReturnBusinessOperationKey", PRIOR_CORRUPT),
    requestDigest,
  });
  const parsed = parseReturnedMediaChildReceipt(result, operation);
  if (stringField(row, "priorReturnExecutionBudgetRootRef", PRIOR_CORRUPT) !== parsed.executionBudgetRootRef ||
      field(row, "priorReturnAuthorizationSegmentRef", PRIOR_CORRUPT) !== null ||
      stringField(row, "priorReturnParentAllocationRef", PRIOR_CORRUPT) !== parsed.parentAllocationRef ||
      stringField(row, "priorReturnChildAllocationRef", PRIOR_CORRUPT) !== parsed.childAllocationRef ||
      nullableNonnegativeInt8Field(row, "priorReturnParentBeforeRevision", PRIOR_CORRUPT) !== parsed.parentRevisionBefore ||
      nullableNonnegativeInt8Field(row, "priorReturnParentAfterRevision", PRIOR_CORRUPT) !== parsed.parentRevisionAfter ||
      nullableNonnegativeInt8Field(row, "priorReturnChildBeforeRevision", PRIOR_CORRUPT) !== parsed.childRevisionBefore ||
      nullableNonnegativeInt8Field(row, "priorReturnChildAfterRevision", PRIOR_CORRUPT) !== parsed.childRevisionAfter ||
      nullableNonnegativeBigintField(row, "priorReturnCreditAmount", PRIOR_CORRUPT) !== parsed.returnedAmount ||
      stringField(row, "priorReturnOwnerClosureEvidenceRef", PRIOR_CORRUPT) !==
        parsed.ownerClosureEvidence.terminalReceiptRef) corrupt(PRIOR_SCOPE);
  if (current.childAllocation.state !== "terminal" ||
      parsed.executionBudgetRootRef !== current.executionBudgetRootRef ||
      parsed.parentAllocationRef !== current.parentAllocationRef ||
      parsed.childAllocationRef !== current.childAllocationRef ||
      parsed.mediaOperationRef !== current.mediaOperationRef ||
      parsed.ownerClosureEvidence.mediaOperationRef !== current.mediaOperationRef ||
      parsed.parentRevisionAfter !== current.parentAllocation.revision ||
      parsed.parentAllocationEpoch !== current.parentAllocation.allocationEpoch ||
      parsed.childRevisionAfter !== current.childAllocation.revision ||
      parsed.childAllocationEpochAfter !== current.childAllocation.allocationEpoch ||
      parsed.returnedAmount !== current.childAllocation.returnedToParentCumulative ||
      parsed.capturedAmount !== current.childAllocation.capturedCumulative ||
      parsed.receiptDigest !== current.childAllocation.terminalReceiptDigest ||
      parsed.parentRevisionAfter !== current.childAllocation.parentAppliedRevision) corrupt(PRIOR_SCOPE);
  return Object.freeze({ operation, value: parsed });
}

type RevisionColumns = Readonly<Record<
  "revision" | "allocationEpoch" | "creditCeiling" | "unassignedStock" | "activeChildReservedStock" |
  "committedStock" | "capturedCumulative" | "returnedToParentCumulative" | "state",
  string
>>;

function allocationRevision(row: Record<string, unknown>, columns: RevisionColumns): BudgetAllocationRevision {
  return rehydrateBudgetAllocationRevision({
    revision: positiveInt8Field(row, columns.revision, REVISION_CORRUPT),
    allocationEpoch: positiveInt8Field(row, columns.allocationEpoch, REVISION_CORRUPT),
    creditCeiling: nonnegativeBigintField(row, columns.creditCeiling, REVISION_CORRUPT),
    unassignedStock: nonnegativeBigintField(row, columns.unassignedStock, REVISION_CORRUPT),
    activeChildReservedStock: nonnegativeBigintField(row, columns.activeChildReservedStock, REVISION_CORRUPT),
    committedStock: nonnegativeBigintField(row, columns.committedStock, REVISION_CORRUPT),
    capturedCumulative: nonnegativeBigintField(row, columns.capturedCumulative, REVISION_CORRUPT),
    returnedToParentCumulative: nonnegativeBigintField(row, columns.returnedToParentCumulative, REVISION_CORRUPT),
    state: allocationState(field(row, columns.state, REVISION_CORRUPT)),
  });
}

function field(row: Record<string, unknown>, key: string, code: string): unknown {
  if (!Object.hasOwn(row, key)) corrupt(code);
  return row[key];
}

function stringField(row: Record<string, unknown>, key: string, code: string): string {
  const value = field(row, key, code);
  if (typeof value !== "string" || hasMalformedUtf16(value)) return corrupt(code);
  return value;
}

function nullableStringField(row: Record<string, unknown>, key: string, code: string): string | null {
  const value = field(row, key, code);
  if (value === null) return null;
  if (typeof value !== "string" || hasMalformedUtf16(value)) return corrupt(code);
  return value;
}

function booleanField(row: Record<string, unknown>, key: string, code: string): boolean {
  const value = field(row, key, code);
  return typeof value === "boolean" ? value : corrupt(code);
}

function nonnegativeBigintField(row: Record<string, unknown>, key: string, code: string): bigint {
  const value = field(row, key, code);
  if (typeof value === "bigint") return value >= 0n ? value : corrupt(code);
  if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/u.test(value)) return corrupt(code);
  return BigInt(value);
}

function positiveInt8Field(row: Record<string, unknown>, key: string, code: string): bigint {
  const value = nonnegativeBigintField(row, key, code);
  return value > 0n && value <= POSTGRES_INT8_MAX ? value : corrupt(code);
}

function nullablePositiveInt8Field(row: Record<string, unknown>, key: string, code: string): bigint | null {
  const value = field(row, key, code);
  if (value === null) return null;
  return positiveInt8Field({ value }, "value", code);
}

function nullableNonnegativeInt8Field(row: Record<string, unknown>, key: string, code: string): bigint | null {
  const value = field(row, key, code);
  if (value === null) return null;
  const parsed = nonnegativeBigintField({ value }, "value", code);
  return parsed <= POSTGRES_INT8_MAX ? parsed : corrupt(code);
}

function nullableNonnegativeBigintField(row: Record<string, unknown>, key: string, code: string): bigint | null {
  const value = field(row, key, code);
  return value === null ? null : nonnegativeBigintField({ value }, "value", code);
}

function instantField(row: Record<string, unknown>, key: string, code: string): string {
  const value = field(row, key, code);
  const result = value instanceof Date ? value.toISOString() : value;
  if (typeof result !== "string") return corrupt(code);
  const parsed = new Date(result);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== result) return corrupt(code);
  return result;
}

function allocationState(value: unknown): BudgetAllocationRevision["state"] {
  return value === "active" || value === "returning" || value === "terminal" ||
    value === "reconciliation_required" ? value : corrupt(REVISION_CORRUPT);
}

function audience(value: unknown): StoredParentAllocation["audience"] {
  return value === "root" || value === "model_gateway" || value === "capability_runtime" || value === "media" ||
    value === "agent_team" || value === "target_runtime" ? value : corrupt(PARENT_CORRUPT);
}

function rootState(value: unknown): StoredParentAllocation["executionBudgetRootState"] {
  return value === "open" || value === "closing" || value === "settled" ||
    value === "reconciliation_required" ? value : corrupt(CHILD_CORRUPT);
}

function holdState(value: unknown): StoredParentAllocation["creditHoldState"] {
  return value === "open" || value === "closing" || value === "settled" || value === "released" ||
    value === "expired" || value === "reconciliation_required" ? value : corrupt(CHILD_CORRUPT);
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(sortJson(value));
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (typeof value === "object" && value !== null) {
    const row = value as Record<string, unknown>;
    return Object.fromEntries(Object.keys(row).sort(codePointCompare).map((key) => [key, sortJson(row[key])]));
  }
  return value;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
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

function codePointCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function corrupt(code: string): never {
  throw new Error(code);
}

const PRIOR_RETURN_FIELDS = [
  "priorReturnResultDigest", "priorReturnOperationKind", "priorReturnBusinessOperationKey",
  "priorReturnRequestDigest", "priorReturnExecutionBudgetRootRef", "priorReturnAuthorizationSegmentRef",
  "priorReturnParentAllocationRef", "priorReturnChildAllocationRef", "priorReturnParentBeforeRevision",
  "priorReturnParentAfterRevision", "priorReturnChildBeforeRevision", "priorReturnChildAfterRevision",
  "priorReturnCreditAmount", "priorReturnOwnerClosureEvidenceRef",
] as const;
const DIGEST = /^[a-f0-9]{64}$/u;
const POSTGRES_INT8_MAX = 9_223_372_036_854_775_807n;
const PARENT_CORRUPT = "CREDIT_PARENT_ALLOCATION_ROW_CORRUPT";
const CHILD_CORRUPT = "CREDIT_MEDIA_CHILD_ROW_CORRUPT";
const REVISION_CORRUPT = "CREDIT_ALLOCATION_REVISION_ROW_CORRUPT";
const PRIOR_CORRUPT = "CREDIT_MEDIA_CHILD_RETURN_RECEIPT_CORRUPT";
const PRIOR_SCOPE = "CREDIT_MEDIA_CHILD_RETURN_RECEIPT_SCOPE_MISMATCH";
const PRIOR_DIGEST = "CREDIT_MEDIA_CHILD_RETURN_RECEIPT_DIGEST_MISMATCH";
