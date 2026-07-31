import { createHash } from "node:crypto";
import { deriveMediaChildReturnReason } from "../domain/allocation.js";
import type { CreditOperationIdentity } from "./contracts/credit-authority-repository.js";
import type {
  CreditConsumptionScope,
  DerivedMediaChildAllocation,
  MediaOperationClosureEvidence,
  ReturnedMediaChildAllocation,
} from "./contracts/run-budget-authority.js";

type DerivedReceiptCore = Omit<DerivedMediaChildAllocation, "receiptDigest">;
type ReturnedReceiptCore = Omit<ReturnedMediaChildAllocation, "receiptDigest">;
type ChildOperationIdentity = Pick<CreditOperationIdentity,
  "siteId" | "operationKind" | "businessOperationKey" | "requestDigest">;

/** Public result fields are persisted and returned to callers. The digest additionally
 * binds the internal operation identity, which is intentionally not duplicated in the
 * returned receipt. Replay parsing supplies that identity from the operation row. */
export function buildDerivedMediaChildReceipt(
  core: DerivedReceiptCore,
  operation: ChildOperationIdentity,
): DerivedMediaChildAllocation {
  const frozenCore = freezeDerivedCore(core);
  return Object.freeze({
    ...frozenCore,
    receiptDigest: digestCanonical(derivedMediaChildReceiptPayload(frozenCore, operation)),
  });
}

export function buildReturnedMediaChildReceipt(
  core: ReturnedReceiptCore,
  operation: ChildOperationIdentity,
): ReturnedMediaChildAllocation {
  const frozenCore = freezeReturnedCore(core);
  return Object.freeze({
    ...frozenCore,
    receiptDigest: digestCanonical(returnedMediaChildReceiptPayload(frozenCore, operation)),
  });
}

export function derivedMediaChildReceiptPayload(
  receipt: DerivedReceiptCore,
  operation: ChildOperationIdentity,
): Readonly<Record<string, unknown>> {
  assertOperation(operation, "derive_media_child");
  return Object.freeze({
    kind: "credit.media_child.derive_receipt.v1",
    operation: operationPayload(operation),
    result: receipt,
  });
}

export function returnedMediaChildReceiptPayload(
  receipt: ReturnedReceiptCore,
  operation: ChildOperationIdentity,
): Readonly<Record<string, unknown>> {
  assertOperation(operation, "return_media_child");
  return Object.freeze({
    kind: "credit.media_child.return_receipt.v1",
    operation: operationPayload(operation),
    result: receipt,
  });
}

export function parseDerivedMediaChildReceipt(
  value: unknown,
  operation: ChildOperationIdentity,
): DerivedMediaChildAllocation {
  const row = dataObject(value);
  strictKeys(row, [
    "allocationReservationReceiptRef", "audience", "childAllocationEpoch", "childAllocationRef",
    "childRevisionAfter", "childRevisionBefore", "consumptionScope", "executionBudgetRootRef",
    "expiresAt", "mediaOperationRef", "observedAt", "parentAllocationEpoch", "parentAllocationRef",
    "parentRevisionAfter", "parentRevisionBefore", "purpose", "receiptDigest", "reservedCeiling", "state",
  ]);
  if (field(row, "state") !== "active" || field(row, "audience") !== "media" ||
      field(row, "purpose") !== "media_operation" || nonnegativeInt8(row, "childRevisionBefore") !== 0n ||
      positiveInt8(row, "childRevisionAfter") !== 1n || positiveInt8(row, "childAllocationEpoch") !== 1n) {
    corrupt();
  }
  const parentRevisionBefore = positiveInt8(row, "parentRevisionBefore");
  const parentRevisionAfter = positiveInt8(row, "parentRevisionAfter");
  if (parentRevisionAfter !== parentRevisionBefore + 1n) corrupt();
  const core = freezeDerivedCore({
    allocationReservationReceiptRef: reference(row, "allocationReservationReceiptRef"),
    executionBudgetRootRef: reference(row, "executionBudgetRootRef"),
    parentAllocationRef: reference(row, "parentAllocationRef"),
    parentRevisionBefore,
    parentRevisionAfter,
    parentAllocationEpoch: positiveInt8(row, "parentAllocationEpoch"),
    childAllocationRef: reference(row, "childAllocationRef"),
    childRevisionBefore: 0n,
    childRevisionAfter: 1n,
    childAllocationEpoch: 1n,
    mediaOperationRef: reference(row, "mediaOperationRef"),
    reservedCeiling: positiveBigint(row, "reservedCeiling"),
    audience: "media",
    purpose: "media_operation",
    consumptionScope: consumptionScope(field(row, "consumptionScope")),
    expiresAt: instant(row, "expiresAt"),
    state: "active",
    observedAt: instant(row, "observedAt"),
  });
  const receiptDigest = digest(row, "receiptDigest");
  const rebuilt = buildDerivedMediaChildReceipt(core, operation);
  if (rebuilt.receiptDigest !== receiptDigest) corrupt();
  return rebuilt;
}

export function parseReturnedMediaChildReceipt(
  value: unknown,
  operation: ChildOperationIdentity,
): ReturnedMediaChildAllocation {
  const row = dataObject(value);
  strictKeys(row, [
    "allocationReturnReceiptRef", "capturedAmount", "childAllocationEpochAfter",
    "childAllocationEpochBefore", "childAllocationRef", "childRevisionAfter", "childRevisionBefore",
    "executionBudgetRootRef", "mediaOperationRef", "observedAt", "ownerClosureEvidence",
    "parentAllocationEpoch", "parentAllocationRef", "parentRevisionAfter", "parentRevisionBefore",
    "reason", "receiptDigest", "returnedAmount", "rootStateAtReturn", "state",
  ]);
  if (field(row, "state") !== "terminal") corrupt();
  const parentRevisionBefore = positiveInt8(row, "parentRevisionBefore");
  const parentRevisionAfter = positiveInt8(row, "parentRevisionAfter");
  const childRevisionBefore = positiveInt8(row, "childRevisionBefore");
  const childRevisionAfter = positiveInt8(row, "childRevisionAfter");
  const childAllocationEpochBefore = positiveInt8(row, "childAllocationEpochBefore");
  const childAllocationEpochAfter = positiveInt8(row, "childAllocationEpochAfter");
  if (parentRevisionAfter !== parentRevisionBefore + 1n || childRevisionAfter !== childRevisionBefore + 1n ||
      childAllocationEpochAfter !== childAllocationEpochBefore + 1n) corrupt();
  const capturedAmount = nonnegativeBigint(row, "capturedAmount");
  const returnedAmount = nonnegativeBigint(row, "returnedAmount");
  const rootStateAtReturn = rootState(field(row, "rootStateAtReturn"));
  const ownerClosureEvidence = closureEvidence(field(row, "ownerClosureEvidence"));
  const mediaOperationRef = reference(row, "mediaOperationRef");
  const reason = returnReason(field(row, "reason"));
  if (ownerClosureEvidence.mediaOperationRef !== mediaOperationRef || deriveMediaChildReturnReason({
    rootState: rootStateAtReturn,
    ownerOutcome: ownerClosureEvidence.outcome,
    capturedAmount,
  }) !== reason) corrupt();
  const core = freezeReturnedCore({
    allocationReturnReceiptRef: reference(row, "allocationReturnReceiptRef"),
    executionBudgetRootRef: reference(row, "executionBudgetRootRef"),
    parentAllocationRef: reference(row, "parentAllocationRef"),
    childAllocationRef: reference(row, "childAllocationRef"),
    parentRevisionBefore,
    parentRevisionAfter,
    parentAllocationEpoch: positiveInt8(row, "parentAllocationEpoch"),
    childRevisionBefore,
    childRevisionAfter,
    childAllocationEpochBefore,
    childAllocationEpochAfter,
    mediaOperationRef,
    returnedAmount,
    capturedAmount,
    reason,
    rootStateAtReturn,
    ownerClosureEvidence,
    state: "terminal",
    observedAt: instant(row, "observedAt"),
  });
  const receiptDigest = digest(row, "receiptDigest");
  const rebuilt = buildReturnedMediaChildReceipt(core, operation);
  if (rebuilt.receiptDigest !== receiptDigest) corrupt();
  return rebuilt;
}

function freezeDerivedCore(core: DerivedReceiptCore): DerivedReceiptCore {
  return Object.freeze({ ...core, consumptionScope: Object.freeze({ ...core.consumptionScope }) });
}

function freezeReturnedCore(core: ReturnedReceiptCore): ReturnedReceiptCore {
  return Object.freeze({ ...core, ownerClosureEvidence: Object.freeze({ ...core.ownerClosureEvidence }) });
}

function operationPayload(operation: ChildOperationIdentity): Readonly<Record<string, string>> {
  return Object.freeze({ siteId: operation.siteId, operationKind: operation.operationKind,
    businessOperationKey: operation.businessOperationKey, requestDigest: operation.requestDigest });
}

function assertOperation(operation: ChildOperationIdentity, kind: "derive_media_child" | "return_media_child"): void {
  if (operation.operationKind !== kind || !DIGEST.test(operation.requestDigest)) corrupt();
  for (const value of [operation.siteId, operation.businessOperationKey]) canonicalReference(value);
}

function consumptionScope(value: unknown): CreditConsumptionScope {
  const row = dataObject(value);
  strictKeys(row, ["agentRef", "capabilityKey", "surfaceRef"]);
  const agentRef = field(row, "agentRef");
  if (agentRef !== null && typeof agentRef !== "string") corrupt();
  return Object.freeze({ surfaceRef: reference(row, "surfaceRef"),
    capabilityKey: reference(row, "capabilityKey"), agentRef: agentRef === null ? null : canonicalReference(agentRef) });
}

function closureEvidence(value: unknown): MediaOperationClosureEvidence {
  const row = dataObject(value);
  strictKeys(row, ["kind", "mediaOperationRef", "outcome", "terminalReceiptRef"]);
  const outcome = field(row, "outcome");
  if (field(row, "kind") !== "media_operation_terminal" ||
      (outcome !== "completed" && outcome !== "partial" && outcome !== "failed" && outcome !== "canceled")) corrupt();
  return Object.freeze({ kind: "media_operation_terminal", mediaOperationRef: reference(row, "mediaOperationRef"),
    terminalReceiptRef: reference(row, "terminalReceiptRef"), outcome });
}

function dataObject(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return corrupt();
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return corrupt();
  return value as Record<string, unknown>;
}

function strictKeys(row: Record<string, unknown>, expected: readonly string[]): void {
  const actual = Object.keys(row).sort(codePointCompare);
  const exact = [...expected].sort(codePointCompare);
  if (actual.length !== exact.length || actual.some((key, index) => key !== exact[index])) corrupt();
}

function field(row: Record<string, unknown>, key: string): unknown {
  if (!Object.hasOwn(row, key)) corrupt();
  return row[key];
}

function reference(row: Record<string, unknown>, key: string): string {
  const value = field(row, key);
  if (typeof value !== "string") return corrupt();
  return canonicalReference(value);
}

function canonicalReference(value: string): string {
  if (value.length < 1 || value.length > 256 || hasControlCharacter(value) || hasMalformedUtf16(value)) corrupt();
  return value;
}

function instant(row: Record<string, unknown>, key: string): string {
  const value = field(row, key);
  if (typeof value !== "string") return corrupt();
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) return corrupt();
  return value;
}

function digest(row: Record<string, unknown>, key: string): string {
  const value = field(row, key);
  if (typeof value !== "string" || !DIGEST.test(value)) return corrupt();
  return value;
}

function nonnegativeBigint(row: Record<string, unknown>, key: string): bigint {
  const value = field(row, key);
  if (typeof value === "bigint") return value >= 0n ? value : corrupt();
  if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/u.test(value)) return corrupt();
  return BigInt(value);
}

function positiveBigint(row: Record<string, unknown>, key: string): bigint {
  const value = nonnegativeBigint(row, key);
  return value > 0n ? value : corrupt();
}

function nonnegativeInt8(row: Record<string, unknown>, key: string): bigint {
  const value = nonnegativeBigint(row, key);
  return value <= POSTGRES_INT8_MAX ? value : corrupt();
}

function positiveInt8(row: Record<string, unknown>, key: string): bigint {
  const value = nonnegativeInt8(row, key);
  return value > 0n ? value : corrupt();
}

function rootState(value: unknown): "open" | "closing" {
  return value === "open" || value === "closing" ? value : corrupt();
}

function returnReason(value: unknown): ReturnedMediaChildAllocation["reason"] {
  return value === "completed" || value === "canceled_before_effect" || value === "fenced_recovery" ||
    value === "root_closing" ? value : corrupt();
}

function digestCanonical(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

function canonicalJson(value: unknown): string {
  if (typeof value === "bigint") return JSON.stringify(value.toString());
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value).sort(([left], [right]) => codePointCompare(left, right));
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
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

function codePointCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function corrupt(): never {
  throw new Error("CREDIT_OPERATION_RECEIPT_CORRUPT");
}

const DIGEST = /^[a-f0-9]{64}$/u;
const POSTGRES_INT8_MAX = 9_223_372_036_854_775_807n;
